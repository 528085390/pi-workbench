/**
 * 接管原语（A08）：see / inject / interrupt / checkpoint / handoff / handback / dispatch。
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §9；任务：task-7-brief 的 R21–R30。
 *
 * 硬约束（controller 裁定）：
 * - R25 所有写操作（inject / interrupt / checkpoint / handoff / handback）先 leases.assertWriter，
 *   再碰 adapter 或落盘 —— 无租约时绝不产生任何 ACP 请求；
 * - R26 handoff 严格按序：cancel → (waitForTurn) → checkpoint → close → 租约转 human(30min) → 注册表 + 事件；
 * - R27 handback：resume（失败 → E_RESUME_REJECTED）→ 从 checkpoint 游标读 transcript 生成 deltaSummary
 *   → 注册表改回 pi/idle → 租约转回 pi；
 * - R28 dispatch 在引擎里（registry 保持纯存储，不依赖 adapter），幂等靠 events 表的 dispatch:<key> 事件；
 * - 本模块不 import server / fastify，也不 import 任何 HTTP 层。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentName, Checkpoint, SessionRef } from "@pi-workbench/shared";

import type { AgentAdapter } from "./adapters/types.ts";
import { CLAUDE_CAPABILITIES } from "./capabilities.ts";
import { WorkbenchError } from "./errors.ts";
import type { EventStore } from "./events.ts";
import { DEFAULT_LEASE_TTL_MS } from "./lease.ts";
import type { LeaseManager } from "./lease.ts";
import type { SessionRegistry } from "./registry.ts";
import { claudeProjectDir, readClaudeTranscript } from "./transcript/claude.ts";
import type { UnifiedMessage } from "./transcript/claude.ts";

/** handoff 后人类接管的租约窗口（R7 / R26：30 分钟，CLI 心跳续期） */
export const HUMAN_HANDOFF_TTL_MS = 30 * 60 * 1000;

/** see 的缺省游标：从 transcript 开头读 */
export const CURSOR_ZERO = "0";

/** dispatch 事件的幂等键前缀：dispatch:<idempotencyKey>（R28） */
export const DISPATCH_KEY_PREFIX = "dispatch:";

/** deltaSummary 的口径（R27）：每条消息一行，最多 20 条，每条截 120 字 */
const DELTA_MAX_LINES = 20;
const DELTA_MAX_CHARS = 120;

/** checkpoint 游标推进的最大页数（防止异常 reader 造成死循环） */
const MAX_CURSOR_PAGES = 200;

/** 归一化后的 transcript 读物（默认实现是 readClaudeTranscript，测试可注入） */
export type TranscriptReader = (
  path: string,
  cursor?: string,
) => { messages: UnifiedMessage[]; nextCursor: string; pending: boolean };

export type CheckpointInput = {
  summary: string;
  touchedFiles: string[];
  nextStep: string;
};

export type HandoffInput = CheckpointInput;

export type DispatchInput = {
  /**
   * 只有 "claude" 在 v1 支持 dispatch（R28：其余 → E_BAD_REQUEST）。
   * 类型放宽到 AgentName 是为了让「未知 agent」是运行时可测的分支，而不是编译期禁止。
   */
  agent: AgentName;
  task: string;
  cwd?: string;
  idempotencyKey: string;
};

export type TakeoverDeps = {
  store: EventStore;
  leases: LeaseManager;
  registry: SessionRegistry;
  adapter: AgentAdapter;
  /** checkpoint 文件目录，通常是 <home>/handoffs */
  handoffDir: string;
  /** 注入时钟（测试用），默认 Date.now */
  now?: () => number;
  /** 注入 transcript 读取器，默认 readClaudeTranscript */
  readTranscript?: TranscriptReader;
};

export type SeeResult = { messages: UnifiedMessage[]; cursor: string; pending: boolean };
export type InjectResult = { messageId: string; effective: "now" | "next_turn" };
export type InterruptResult = { stopReason: string };
export type HandoffResult = {
  checkpoint: Checkpoint;
  command: string[];
  mode: "resume-tui" | "attach";
};
export type HandbackResult = { resumed: boolean; deltaSummary: string };

/**
 * 接管原语集合。一个实例服务所有会话；无状态查询走 registry / store，
 * 唯一的内存态是「每个会话最近一次 checkpoint」（handback 需要它的 transcriptCursor）。
 */
export class TakeoverEngine {
  readonly #store: EventStore;
  readonly #leases: LeaseManager;
  readonly #registry: SessionRegistry;
  readonly #adapter: AgentAdapter;
  readonly #handoffDir: string;
  readonly #now: () => number;
  readonly #readTranscript: TranscriptReader;
  /** sessionKey → 最近一次 checkpoint（handoff / handback 在同一进程内配对） */
  readonly #checkpoints = new Map<string, Checkpoint>();
  /** 事件幂等键的进程内序号，避免同一毫秒内多次操作撞键 */
  #eventSeq = 0;

  constructor(deps: TakeoverDeps) {
    this.#store = deps.store;
    this.#leases = deps.leases;
    this.#registry = deps.registry;
    this.#adapter = deps.adapter;
    this.#handoffDir = deps.handoffDir;
    this.#now = deps.now ?? Date.now;
    this.#readTranscript = deps.readTranscript ?? defaultTranscriptReader;
  }

  /**
   * 读会话增量（R30）。只读，不需要租约。
   * transcript 文件不存在时由 reader 返回空页 + pending=true，这里不重写该逻辑。
   */
  see(key: string, after?: string): SeeResult {
    const ref = this.#requireSession(key);
    const cursor = after ?? CURSOR_ZERO;
    const path = ref.transcriptPath;
    if (path === undefined || path.length === 0) {
      return { messages: [], cursor, pending: true };
    }
    const page = this.#readTranscript(path, cursor);
    return { messages: page.messages, cursor: page.nextCursor, pending: page.pending };
  }

  /**
   * 投递一条用户消息。回合进行中（status=running）的注入不改变当前回合，
   * 只在下一个 turn 边界生效 —— 响应据此标 effective: next_turn（spec §11 降级口径）。
   */
  async inject(key: string, text: string, clientId: string): Promise<InjectResult> {
    this.#leases.assertWriter(key, clientId);
    const ref = this.#requireSession(key);
    const { messageId } = await this.#adapter.prompt(ref.nativeId, text);
    return { messageId, effective: ref.status === "running" ? "next_turn" : "now" };
  }

  /** 打断当前回合：cancel → 状态投影回 idle，并落一条 state_update 事件（验收 §10 #4）。 */
  async interrupt(key: string, clientId: string): Promise<InterruptResult> {
    this.#leases.assertWriter(key, clientId);
    const ref = this.#requireSession(key);

    const { stopReason } = await this.#adapter.cancel(ref.nativeId);
    this.#registry.updateStatus(key, "idle");
    this.#appendState(ref, { state: "idle", stopReason, clientId }, "interrupt");
    return { stopReason };
  }

  /**
   * 写 checkpoint（R29）：文件 + 返回对象，不发事件（事件留给 handoff）。
   * 游标取 transcript 当前末尾的字节偏移，handback 从这里读增量。
   */
  checkpoint(key: string, input: CheckpointInput, clientId: string): Checkpoint {
    this.#leases.assertWriter(key, clientId);
    const ref = this.#requireSession(key);
    return this.#writeCheckpoint(ref, input).checkpoint;
  }

  /**
   * 交给人（或交给另一个 pi 客户端）：R26 七步严格按序。
   * 第 4 个参数是 checkpoint 内容；省略时给一份最小可用的默认值（保持 R25 的三参签名可用）。
   */
  async handoff(key: string, to: "human" | "pi", clientId: string, input?: HandoffInput): Promise<HandoffResult> {
    this.#leases.assertWriter(key, clientId);
    const ref = this.#requireSession(key);

    // 2. quiesce：运行中先 cancel 并等回合结束（adapter 没有 waitForTurn 就跳过）
    if (ref.status === "running") {
      await this.#adapter.cancel(ref.nativeId);
      await this.#waitForTurn(ref.nativeId);
    }

    // 3. checkpoint（文件 + 内存态）
    const { checkpoint, path } = this.#writeCheckpoint(ref, input ?? defaultHandoffInput(to));

    // 4. 释放 adapter 里的会话，交给原生终端
    await this.#adapter.close(ref.nativeId);

    // 5. 租约转给接管的 driver，人类窗口固定 30 分钟
    this.#leases.release(key, clientId);
    this.#leases.acquire(key, to, "handoff-" + clientId, HUMAN_HANDOFF_TTL_MS);

    // 6. 注册表 + 事件
    const next: SessionRef = { ...ref, driver: to, status: "handoff" };
    this.#registry.upsert(next);
    this.#appendState(next, { state: "handoff", driver: to, checkpointPath: path, to }, "handoff");

    // 7. 接管命令：background 走 attach，interactive 走 --resume
    const background = ref.kind === "background";
    return {
      checkpoint,
      command: background ? ["claude", "attach", ref.nativeId] : ["claude", "--resume", ref.nativeId],
      mode: background ? "attach" : "resume-tui",
    };
  }

  /**
   * 从人类手里接回（R27）：resume → 读 delta → 注册表改回 pi/idle → 租约转回 pi。
   * resume 被拒立即 E_RESUME_REJECTED，不改注册表、不动租约。
   */
  async handback(key: string, clientId: string): Promise<HandbackResult> {
    this.#leases.assertWriter(key, clientId);
    const ref = this.#requireSession(key);

    try {
      await this.#adapter.resume(ref.nativeId, ref.cwd);
    } catch (err) {
      throw new WorkbenchError("E_RESUME_REJECTED", "恢复会话被拒绝：" + key, {
        sessionKey: key,
        nativeId: ref.nativeId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const cursor = this.#checkpoints.get(key)?.transcriptCursor ?? CURSOR_ZERO;
    const deltaSummary = this.#deltaSummary(ref, cursor);

    const next: SessionRef = { ...ref, driver: "pi", status: "idle" };
    this.#registry.upsert(next);
    this.#appendState(next, { state: "idle", driver: "pi", clientId }, "handback");

    this.#leases.release(key, clientId);
    this.#leases.acquire(key, "pi", "handback-" + clientId, DEFAULT_LEASE_TTL_MS);
    return { resumed: true, deltaSummary };
  }

  /**
   * 起一个新会话（R28）。幂等：同 idempotencyKey 且 payload 一致 → 返回原 SessionRef，
   * 不再调 adapter.newSession；payload 不一致 → E_IDEMPOTENCY_CONFLICT。
   * prompt 只负责投递，不等回合结束，投递失败也不影响本次返回。
   */
  async dispatch(input: DispatchInput): Promise<SessionRef> {
    if (input.agent !== "claude") {
      throw new WorkbenchError("E_BAD_REQUEST", "v1 只支持 dispatch claude 会话：" + String(input.agent), {
        agent: input.agent,
      });
    }
    const task = input.task.trim();
    if (task.length === 0) {
      throw new WorkbenchError("E_BAD_REQUEST", "dispatch 的 task 不能为空", { agent: input.agent });
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length === 0) {
      throw new WorkbenchError("E_BAD_REQUEST", "dispatch 的 idempotencyKey 不能为空", { agent: input.agent });
    }

    const cwd = input.cwd ?? process.cwd();
    const hash = hashOf({ agent: input.agent, task, cwd });

    const existing = this.#findDispatch(idempotencyKey);
    if (existing !== null) {
      if (existing.hash !== hash) {
        throw new WorkbenchError("E_IDEMPOTENCY_CONFLICT", "幂等键已用于另一个任务：" + idempotencyKey, {
          idempotencyKey,
          sessionKey: existing.ref.key,
        });
      }
      return existing.ref;
    }

    const { sessionId } = await this.#adapter.newSession(cwd);
    const ref: SessionRef = {
      key: "claude:" + sessionId,
      agent: "claude",
      nativeId: sessionId,
      acpSessionId: sessionId,
      cwd,
      transcriptPath: join(claudeProjectDir(cwd), sessionId + ".jsonl"),
      status: "running",
      driver: "pi",
      capabilities: CLAUDE_CAPABILITIES,
      kind: "interactive",
    };

    this.#registry.upsert(ref);
    this.#store.append({
      sessionKey: ref.key,
      type: "notice",
      payload: { kind: "dispatch", idempotencyKey, hash, task, cwd, ref },
      source: "claude",
      idempotencyKey: DISPATCH_KEY_PREFIX + idempotencyKey,
    });

    try {
      await this.#adapter.prompt(sessionId, task);
    } catch {
      // R28：投递失败不影响 dispatch 返回；回合结果通过事件流观察
    }
    return ref;
  }

  /** 等回合结束；adapter 未实现 waitForTurn 或超时都不阻断 handoff（quiesce 尽力而为） */
  async #waitForTurn(nativeId: string): Promise<void> {
    const wait = this.#adapter.waitForTurn;
    if (wait === undefined) {
      return;
    }
    try {
      await wait.call(this.#adapter, nativeId);
    } catch {
      // turn timeout / adapter 已在关闭：close 仍要继续，否则会话就漏在 adapter 里
    }
  }

  /** 落 checkpoint 文件 + 记内存态，返回对象与文件路径 */
  #writeCheckpoint(ref: SessionRef, input: CheckpointInput): { checkpoint: Checkpoint; path: string } {
    const nowMs = this.#now();
    const checkpoint: Checkpoint = {
      sessionKey: ref.key,
      summary: input.summary,
      touchedFiles: [...input.touchedFiles],
      nextStep: input.nextStep,
      transcriptCursor: ref.transcriptPath === undefined ? CURSOR_ZERO : this.#cursorAtEnd(ref.transcriptPath),
      createdAt: new Date(nowMs).toISOString(),
    };

    const path = join(this.#handoffDir, sanitizeKey(ref.key) + "-" + isoForFile(nowMs) + ".md");
    mkdirSync(this.#handoffDir, { recursive: true });
    writeFileSync(path, renderCheckpoint(checkpoint), "utf8");
    this.#checkpoints.set(ref.key, checkpoint);
    return { checkpoint, path };
  }

  /** 把 transcript 游标推进到当前末尾（handback 从该偏移读人类接管期间的增量） */
  #cursorAtEnd(path: string): string {
    let cursor = CURSOR_ZERO;
    for (let page = 0; page < MAX_CURSOR_PAGES; page += 1) {
      let result: { messages: UnifiedMessage[]; nextCursor: string; pending: boolean };
      try {
        result = this.#readTranscript(path, cursor);
      } catch {
        return cursor;
      }
      // 游标不前进 = 已到末尾（含文件不存在时 reader 原样返回 cursor 的情况）
      if (result.nextCursor === cursor || result.pending) {
        return result.nextCursor;
      }
      cursor = result.nextCursor;
    }
    return cursor;
  }

  /** 人类接管期间的变化摘要：每条一行 role: 前 120 字，最多 20 条，超出注明总数（R27） */
  #deltaSummary(ref: SessionRef, cursor: string): string {
    const path = ref.transcriptPath;
    if (path === undefined || path.length === 0) {
      return "";
    }
    try {
      return buildDeltaSummary(this.#readTranscript(path, cursor).messages);
    } catch {
      return "";
    }
  }

  /** 按 dispatch:<idempotencyKey> 事件回溯幂等记录（R28：不新增表） */
  #findDispatch(idempotencyKey: string): { ref: SessionRef; hash: string } | null {
    const wanted = DISPATCH_KEY_PREFIX + idempotencyKey;
    for (const ref of this.#registry.list()) {
      for (const event of this.#store.list(ref.key)) {
        if (event.idempotencyKey !== wanted) {
          continue;
        }
        const payload = event.payload;
        if (!isRecord(payload)) {
          continue;
        }
        const hash = payload["hash"];
        const stored = payload["ref"];
        if (typeof hash !== "string" || !isSessionRef(stored)) {
          continue;
        }
        return { ref: stored, hash };
      }
    }
    return null;
  }

  #requireSession(key: string): SessionRef {
    const ref = this.#registry.get(key);
    if (ref === null) {
      throw new WorkbenchError("E_SESSION_NOT_FOUND", "会话不存在：" + key, { sessionKey: key });
    }
    return ref;
  }

  #appendState(ref: SessionRef, payload: Record<string, unknown>, action: string): void {
    this.#eventSeq += 1;
    this.#store.append({
      sessionKey: ref.key,
      type: "state_update",
      payload,
      source: ref.agent,
      idempotencyKey:
        ref.agent + ":" + ref.nativeId + ":" + action + ":" + String(this.#now()) + ":" + String(this.#eventSeq),
    });
  }
}
const defaultTranscriptReader: TranscriptReader = (path, cursor) =>
  readClaudeTranscript(path, cursor ?? CURSOR_ZERO);

function defaultHandoffInput(to: "human" | "pi"): CheckpointInput {
  return { summary: "handoff to " + to, touchedFiles: [], nextStep: "" };
}

function hashOf(value: { agent: string; task: string; cwd: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ agent: value.agent, task: value.task, cwd: value.cwd }))
    .digest("hex");
}

/** 文件名里只保留安全字符：claude:sess/1 → claude-sess-1 */
function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** ISO8601 里 Windows 不允许的冒号换成连字符（R29） */
function isoForFile(ms: number): string {
  return new Date(ms).toISOString().replace(/:/g, "-");
}

/** checkpoint 文件四段：摘要 / 触碰文件 / 下一步 / 游标 */
function renderCheckpoint(checkpoint: Checkpoint): string {
  const files =
    checkpoint.touchedFiles.length === 0 ? "- （无）" : checkpoint.touchedFiles.map((file) => "- " + file).join("\n");
  return [
    "# Checkpoint：" + checkpoint.sessionKey,
    "生成时间：" + checkpoint.createdAt,
    "",
    "## 摘要",
    checkpoint.summary,
    "",
    "## 触碰文件",
    files,
    "",
    "## 下一步",
    checkpoint.nextStep,
    "",
    "## 游标",
    checkpoint.transcriptCursor,
    "",
  ].join("\n");
}

function buildDeltaSummary(messages: UnifiedMessage[]): string {
  const lines: string[] = [];
  for (const message of messages.slice(0, DELTA_MAX_LINES)) {
    const oneLine = message.text.replace(/\s+/g, " ").trim();
    const text = oneLine.length > DELTA_MAX_CHARS ? oneLine.slice(0, DELTA_MAX_CHARS) + "…" : oneLine;
    lines.push(message.role + ": " + text);
  }
  if (messages.length > DELTA_MAX_LINES) {
    lines.push("…（共 " + String(messages.length) + " 条）");
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** dispatch 事件里的 ref 经过 JSON 往返，这里只校验关键字段是否存在 */
function isSessionRef(value: unknown): value is SessionRef {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["key"] === "string" &&
    typeof value["agent"] === "string" &&
    typeof value["nativeId"] === "string" &&
    typeof value["cwd"] === "string" &&
    typeof value["status"] === "string" &&
    typeof value["driver"] === "string" &&
    isRecord(value["capabilities"])
  );
}
