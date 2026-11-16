/**
 * 事件归一化管线（A06）：把 adapter 的 `AdapterUpdate` 与 Claude transcript 归一化成 `SessionEvent`。
 * 口径见 task-6-brief 的 Controller 裁定 R15–R20：
 *
 * - R16 映射：`AdapterUpdate.kind` → `SessionEventType`（见 `KIND_TO_TYPE`），未知 kind / 坏 update 丢弃并 debug 日志，不抛。
 * - R17 幂等：ACP 事件键 `${agent}:${nativeId}:${update.id}`，
 *   transcript 事件键 `${agent}:${nativeId}:transcript:${msg.id}`；
 *   重放靠 `EventStore.append` 的 INSERT OR IGNORE，管线本身不缓存去重。
 * - R18 状态同步：`state` 已经是 `SessionStatus`，管线只透传并调 `SessionRegistry.updateStatus`；
 *   未知会话只记一次 stderr，绝不抛。
 * - R19 transcript 去重：每个会话维护「ACP 已见 messageId」集合，**只记真正落库的 update**，命中即跳过；`ts` 不参与去重。
 * - R20 attach 语义：重复 attach 同一会话先退订旧的；`dispose()` 退订全部；单条事件处理异常不外溢。
 *
 * 该模块不碰 WS / HTTP：广播由上层（Task 8/9 的 server）订阅 `EventStore.subscribe`。
 */
import type { SessionEventType } from "@pi-workbench/shared";

import type { AdapterUpdate, AgentAdapter } from "./adapters/types.ts";
import type { EventStore } from "./events.ts";
import type { SessionRegistry } from "./registry.ts";
import type { UnifiedMessage } from "./transcript/claude.ts";

/** 事件源：ACP adapter 与 AgentDriver 都满足这个结构（B08 M2） */
export type UpdateSource = {
  onUpdate(cb: (update: AdapterUpdate) => void): () => void;
};

/**
 * 管线日志口（可注入；默认写 stderr）。
 * 只用 debug / error 两档：前者是「丢弃了什么」的噪声，后者是必须被看见的问题。
 */
export type PipelineLogger = {
  debug(message: string): void;
  error(message: string): void;
};

const stderrLogger: PipelineLogger = {
  debug: (message) => {
    process.stderr.write("[pi-workbench:pipeline] " + message + "\n");
  },
  error: (message) => {
    process.stderr.write("[pi-workbench:pipeline] " + message + "\n");
  },
};

/** R16：AdapterUpdate.kind → SessionEventType；用 Map 而不是 Record，便于收下未知 kind 的 undefined */
const KIND_TO_TYPE: ReadonlyMap<string, SessionEventType> = new Map<string, SessionEventType>([
  ["text", "token"],
  ["thought", "thought"],
  ["tool_call", "tool_call"],
  ["tool_result", "tool_result"],
  ["state", "state_update"],
  ["permission_request", "permission_request"],
  ["error", "error"],
]);

/** transcript 的 kind → SessionEventType（`UnifiedMessage.kind` 是另一套词汇） */
const TRANSCRIPT_KIND_TO_TYPE: ReadonlyMap<string, SessionEventType> = new Map<string, SessionEventType>([
  ["text", "token"],
  ["thinking", "thought"],
  ["tool_call", "tool_call"],
  ["tool_result", "tool_result"],
  ["notice", "notice"],
]);

type Attachment = {
  /** 退订并从附件表移除自己；幂等，且不会误删后来替换它的订阅 */
  detach(): void;
};

/**
 * 事件归一化管线：一条 ACP update / 一条 transcript 消息 → 一条 `SessionEvent`。
 * 一个实例可服务多个会话；每个会话最多一个订阅（重复 attach 会替换）。
 */
export class EventPipeline {
  readonly #store: EventStore;
  readonly #registry: SessionRegistry;
  readonly #logger: PipelineLogger;
  /** sessionKey → 当前订阅（重 attach 后只保留最新的） */
  readonly #attachments = new Map<string, Attachment>();
  /** sessionKey → ACP 已见 messageId（R19 transcript 去重） */
  readonly #seenAcpIds = new Map<string, Set<string>>();
  /** sessionKey → 该会话已分配的最大 seq（只为算「本次新增几条」，不用于去重） */
  readonly #watermarks = new Map<string, number>();
  /** 已告警过的未知会话（R18：只记一次，不刷屏） */
  readonly #warnedSessions = new Set<string>();

  constructor(store: EventStore, registry: SessionRegistry, logger: PipelineLogger = stderrLogger) {
    this.#store = store;
    this.#registry = registry;
    this.#logger = logger;
  }

  /**
   * 订阅 adapter 的 update 流（R20）。
   * 同一 sessionKey 重复 attach 会先退订旧的，避免两条链同时写同一会话。
   * 返回只退订本次订阅的函数（可重复调用）。
   */
  attach(source: UpdateSource, sessionKey: string): () => void {
    this.#attachments.get(sessionKey)?.detach();

    const unsubscribe = source.onUpdate((update: AdapterUpdate) => {
      this.#handleUpdate(sessionKey, update);
    });

    let attached = true;
    const attachment: Attachment = {
      detach: () => {
        if (!attached) {
          return;
        }
        attached = false;
        unsubscribe();
        if (this.#attachments.get(sessionKey) === attachment) {
          this.#attachments.delete(sessionKey);
        }
      },
    };
    this.#attachments.set(sessionKey, attachment);
    return attachment.detach;
  }

  /**
   * 落一批 transcript 消息，返回**本次新增**的事件条数。
   * - 已被 ACP 覆盖的 `msg.id` 直接跳过（R19），命中幂等键的重复消息由 store 忽略、不计入返回值；
   * - 会话未登记时返回 0 并只告警一次（transcript 的消息没有来源信息，无法凭空造 source）。
   */
  ingestTranscript(sessionKey: string, msgs: UnifiedMessage[]): number {
    const ref = this.#registry.get(sessionKey);
    if (ref === null) {
      this.#warnUnknownSession(sessionKey);
      return 0;
    }

    const seenAcp = this.#seenAcpIds.get(sessionKey);
    let added = 0;

    for (const msg of msgs) {
      // R20 的同款要求：单条坏消息不得中断整批
      try {
        if (seenAcp !== undefined && seenAcp.has(msg.id)) {
          this.#logger.debug("transcript 消息 " + msg.id + " 已由 ACP 覆盖，跳过（会话 " + sessionKey + "）");
          continue;
        }
        const type = TRANSCRIPT_KIND_TO_TYPE.get(msg.kind);
        if (type === undefined) {
          this.#logger.debug("未知 transcript kind=" + String(msg.kind) + "（会话 " + sessionKey + "），已丢弃");
          continue;
        }
        if (msg.id.length === 0) {
          this.#logger.debug("transcript 消息缺少 id（会话 " + sessionKey + "），已丢弃");
          continue;
        }

        const watermark = this.#watermark(sessionKey);
        const event = this.#store.append({
          sessionKey,
          type,
          payload: toTranscriptPayload(msg),
          source: ref.agent,
          idempotencyKey: ref.agent + ":" + ref.nativeId + ":transcript:" + msg.id,
        });
        // AUTOINCREMENT 单调：新插入的行 seq 必大于该会话已有最大 seq；幂等命中则返回旧行。
        if (event.seq > watermark) {
          added += 1;
          this.#watermarks.set(sessionKey, event.seq);
        }
      } catch (err) {
        this.#logger.error("transcript 事件写入失败（会话 " + sessionKey + "）：" + String(err));
      }
    }

    return added;
  }

  /** 退订所有 adapter 订阅（幂等）；dispose 之后仍可重新 attach。 */
  dispose(): void {
    for (const attachment of [...this.#attachments.values()]) {
      attachment.detach();
    }
    this.#attachments.clear();
  }

  #handleUpdate(sessionKey: string, update: AdapterUpdate): void {
    try {
      const type = KIND_TO_TYPE.get(update.kind);
      if (type === undefined) {
        this.#logger.debug("未知 AdapterUpdate.kind=" + String(update.kind) + "（会话 " + sessionKey + "），已丢弃");
        return;
      }

      // source 一律取 SessionRef.agent（R16）；未知会话无从取值，丢弃并告警一次
      const ref = this.#registry.get(sessionKey);
      if (ref === null) {
        this.#warnUnknownSession(sessionKey);
        return;
      }

      // ACP 一个 adapter 进程可能服务多个会话；事件必须按来源 sessionId 过滤，
      // 否则 A 会话的 token/tool_call 会被写进 B 会话，制造假未读和重复唤醒。
      if (update.sessionId !== undefined && update.sessionId !== ref.nativeId) {
        this.#logger.debug(
          "AdapterUpdate 属于其他会话（" + update.sessionId + "），已从 " + sessionKey + " 丢弃",
        );
        return;
      }

      if (update.id.length === 0) {
        this.#logger.debug("AdapterUpdate 缺少 id（会话 " + sessionKey + "），已丢弃");
        return;
      }
      // R18：state 已由 adapter 映射成 SessionStatus；缺 state 的 update 无法投影，丢弃
      if (update.kind === "state" && update.state === undefined) {
        this.#logger.debug("state update 缺少 state（会话 " + sessionKey + "），已丢弃");
        return;
      }

      this.#store.append({
        sessionKey,
        type,
        payload: toPayload(update),
        source: ref.agent,
        idempotencyKey: ref.agent + ":" + ref.nativeId + ":" + update.id,
      });

      // R19：只有**真正落库**的 update 才把 messageId 记入去重集合（取不到就不记）。
      // 提前记账会让被丢弃的 update（坏 id / state 缺 state / store 抛错）毒化集合，
      // 使后续携带同一 messageId 的 transcript 消息被静默跳过。
      const messageId = extractMessageId(update.raw);
      if (messageId !== undefined) {
        this.#seenAcp(sessionKey).add(messageId);
      }

      // R18：状态投影（落内存 + sessions 表）；这里只透传，不猜字符串
      if (update.kind === "state" && update.state !== undefined) {
        if (this.#registry.updateStatus(sessionKey, update.state) === null) {
          this.#warnUnknownSession(sessionKey);
        }
      }
    } catch (err) {
      // R20：单条事件处理失败必须被吞掉，不能影响后续 update
      this.#logger.error("事件管线处理 update 失败（会话 " + sessionKey + "）：" + String(err));
    }
  }

  #seenAcp(sessionKey: string): Set<string> {
    let set = this.#seenAcpIds.get(sessionKey);
    if (set === undefined) {
      set = new Set<string>();
      this.#seenAcpIds.set(sessionKey, set);
    }
    return set;
  }

  /**
   * 该会话已分配的最大 seq（首次使用时从库里一次性读出，之后跟着写入走）。
   * 只用于区分「新写入」与「幂等命中」，去重仍然只由 INSERT OR IGNORE 决定（R17）。
   */
  #watermark(sessionKey: string): number {
    const known = this.#watermarks.get(sessionKey);
    if (known !== undefined) {
      return known;
    }
    let max = 0;
    for (const event of this.#store.list(sessionKey)) {
      if (event.seq > max) {
        max = event.seq;
      }
    }
    this.#watermarks.set(sessionKey, max);
    return max;
  }

  #warnUnknownSession(sessionKey: string): void {
    if (this.#warnedSessions.has(sessionKey)) {
      return;
    }
    this.#warnedSessions.add(sessionKey);
    this.#logger.error("事件管线：会话 " + sessionKey + " 未在注册表中，事件已丢弃");
  }
}

/** R16 payload 形状；缺省字段交给 JSON.stringify 落下（不会写成 "undefined"） */
function toPayload(update: AdapterUpdate): unknown {
  switch (update.kind) {
    case "text":
    case "thought":
      return { text: update.text ?? "" };
    case "tool_call":
    case "tool_result":
      return { toolName: update.toolName, raw: update.raw };
    case "state":
      return { state: update.state, raw: update.raw };
    case "permission_request":
      return { raw: update.raw };
    case "error":
      return { message: update.text ?? "", raw: update.raw };
    default:
      return { raw: update.raw };
  }
}

/** transcript 的消息本身已是纯文本，不再套一层 raw，只留可读字段 */
function toTranscriptPayload(msg: UnifiedMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = { text: msg.text };
  if (msg.toolName !== undefined) {
    payload["toolName"] = msg.toolName;
  }
  return payload;
}

/** 从原始 ACP 负载里取 messageId / message.id（R19） */
function extractMessageId(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const direct = asNonEmptyString(raw["messageId"]);
  if (direct !== undefined) {
    return direct;
  }
  const message = raw["message"];
  return isRecord(message) ? asNonEmptyString(message["id"]) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
