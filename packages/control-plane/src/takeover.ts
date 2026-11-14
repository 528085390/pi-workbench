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
 * - R28 dispatch 在引擎里（registry 保持纯存储，不依赖 adapter），幂等靠 dispatches 表的原子占位
 *   （round 1 起已从「events 表回溯」换成落库预留，本注释同步）；
 * - 本模块不 import server / fastify，也不 import 任何 HTTP 层。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentName, Checkpoint, SessionRef } from "@pi-workbench/shared";

import type { AgentAdapter } from "./adapters/types.ts";
import { CLAUDE_CAPABILITIES } from "./capabilities.ts";
import type { CheckpointStore, StoredCheckpoint } from "./checkpoints.ts";
import type { DispatchRecord, DispatchStore } from "./dispatch-store.ts";
import { isWorkbenchError, WorkbenchError } from "./errors.ts";
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

/** reserved 状态的等待口径（C1）：每 50ms 复查一次，最多等 5s */
const DISPATCH_POLL_INTERVAL_MS = 50;
const DISPATCH_POLL_TIMEOUT_MS = 5000;

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
  /** checkpoints 表（C3：handback 从这里读游标，不靠进程内存） */
  checkpoints: CheckpointStore;
  /** dispatches 表（C1/C2：原子占位保证并发与跨进程幂等） */
  dispatches: DispatchStore;
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
 * 接管原语集合。一个实例服务所有会话；业务状态（会话 / 游标 / 幂等预留）全部走
 * registry / store / checkpoints / dispatches 表，引擎不缓存任何业务态 ——
 * 重启后 handback 仍能从库里拿到 checkpoint 游标。
 *
 * 唯一的进程内字段是 `#eventSeq`：只用于给同一毫秒内的 state_update / error 事件生成不撞车的
 * 幂等键，不参与任何业务判定，也不影响重启后的行为 —— round 2 选了「改这条注释」而不是
 * 「每次调用重置」。
 *
 * 幂等键的真实边界（round 3 更正）：`events.idempotency_key` 的 UNIQUE 约束只在**同一个库内**
 * 去重，**不构成跨进程唯一性** —— 键里没有进程启动标识。所以「重启到同一毫秒 + 同一会话 + 同一
 * action」仍可能撞键：INSERT OR IGNORE 会把第二条**静默合并**进第一条，调用方拿回旧事件，消费者
 * 看不到这次 state_update（丢一条事件的已知代价；窗口极窄，但要承认它存在）。
 * round 2 / round 3 都选「把注释改成实话」而不是「换键格式」：加进程 nonce 会改掉历史键的形状，
 * 让已落库事件的幂等重放与按 key 排查的口径一起漂移，代价大于这条窄窗口。
 */
export class TakeoverEngine {
  readonly #store: EventStore;
  readonly #leases: LeaseManager;
  readonly #registry: SessionRegistry;
  readonly #adapter: AgentAdapter;
  readonly #checkpoints: CheckpointStore;
  readonly #dispatches: DispatchStore;
  readonly #handoffDir: string;
  readonly #now: () => number;
  readonly #readTranscript: TranscriptReader;
  /**
   * 事件幂等键的进程内序号（round 2 的 Minor）：只做同毫秒去重，不重置。
   * 重置会让同一毫秒内的两条同类事件拿到同一个幂等键，被 EventStore 合并成一条 —— 代价比
   * 维护一个只增计数器大得多，所以选「把注释改成实话」。
   * 注意作用域：它只在**本进程内**防止撞车，跨进程（重启）没有等价物，UNIQUE 约束也不保证
   * 跨进程唯一（真实行为与代价见类注释）。
   */
  #eventSeq = 0;

  constructor(deps: TakeoverDeps) {
    this.#store = deps.store;
    this.#leases = deps.leases;
    this.#registry = deps.registry;
    this.#adapter = deps.adapter;
    this.#checkpoints = deps.checkpoints;
    this.#dispatches = deps.dispatches;
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
    // M5：reader 报 pending 且一条消息都没有时，游标停在调用方给的位置，绝不倒退成 "0"
    const next = page.pending && page.messages.length === 0 ? cursor : page.nextCursor;
    return { messages: page.messages, cursor: next, pending: page.pending };
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
    // I4：cancel / close 失败必须留痕 —— 否则租约还指着 pi、状态还是 running，却一条事件都没有
    try {
      if (ref.status === "running") {
        await this.#adapter.cancel(ref.nativeId);
        await this.#waitForTurn(ref.nativeId);
      }
    } catch (err) {
      throw this.#handoffAborted(ref, "cancel", err);
    }

    // 3. checkpoint（文件 + checkpoints 表）
    const { checkpoint, path } = this.#writeCheckpoint(ref, input ?? defaultHandoffInput(to));

    // 4. 释放 adapter 里的会话，交给原生终端
    try {
      await this.#adapter.close(ref.nativeId);
    } catch (err) {
      throw this.#handoffAborted(ref, "close", err);
    }

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

    // C3：游标以库里的最新 checkpoint 为准 —— 进程重启后 handback 仍从正确位置读增量
    const latest = this.#checkpoints.latest(key);
    const cursor = latest === null ? CURSOR_ZERO : latest.transcriptCursor;
    const deltaSummary = this.#deltaSummary(ref, cursor);

    const next: SessionRef = { ...ref, driver: "pi", status: "idle" };
    this.#registry.upsert(next);
    this.#appendState(next, { state: "idle", driver: "pi", clientId }, "handback");

    this.#leases.release(key, clientId);
    this.#leases.acquire(key, "pi", "handback-" + clientId, DEFAULT_LEASE_TTL_MS);
    return { resumed: true, deltaSummary };
  }

  /**
   * 起一个新会话（R28 / C1 / C2）。幂等与并发都由 dispatches 表的原子占位保证：
   * reserve 的赢家负责 newSession → complete，输家按记录的 hash / 状态复用、等待或报错。
   * prompt 只负责投递，不等回合结束，投递失败也不影响本次返回。
   *
   * 迁移口径（round 3 / N3）：payload hash 含 cwd；`cwd` 省略时取 daemon 的
   * `process.cwd()`，因此换个目录重启 daemon，同一个逻辑 dispatch 会算出另一个 hash。
   * - 调用方 **SHOULD** 显式传 `cwd`：否则幂等会随 daemon 启动目录漂移（同 key 同任务被判成
   *   `E_IDEMPOTENCY_CONFLICT`）。
   * - pre-release 期间按旧口径（`cwd: null` 进 hash）建的行，升级后同 key 同任务必然冲突；
   *   这些行**不做迁移**——本仓库 pre-1.0，历史幂等记录没有需要保留的业务数据，直接换一个
   *   新的 idempotencyKey 重新 dispatch 即可。
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

    // Minor（round 2）：cwd 只解析一次 —— hash / SessionRef / newSession 必须用同一个值。
    // 之前 hash 取 input.cwd ?? null、会话行写 process.cwd()，于是「省略 cwd」与「显式传同一个
    // cwd」会算出不同 hash，被误判成 E_IDEMPOTENCY_CONFLICT。
    const resolvedCwd = input.cwd ?? process.cwd();
    const hash = hashOf({ agent: input.agent, task, cwd: resolvedCwd });

    // C1 / C2：INSERT OR IGNORE 原子占位，同 key 并发只有一个赢家
    const { record, created } = this.#dispatches.reserve(idempotencyKey, hash, new Date(this.#now()));
    if (!created) {
      return await this.#resolveReserved(record, hash, idempotencyKey);
    }

    let sessionId: string;
    try {
      const opened = await this.#adapter.newSession(resolvedCwd);
      sessionId = opened.sessionId;
    } catch (err) {
      throw this.#dispatchFailed(idempotencyKey, "newSession", err);
    }

    const ref: SessionRef = {
      key: "claude:" + sessionId,
      agent: "claude",
      nativeId: sessionId,
      acpSessionId: sessionId,
      cwd: resolvedCwd,
      transcriptPath: join(claudeProjectDir(resolvedCwd), sessionId + ".jsonl"),
      status: "running",
      driver: "pi",
      capabilities: CLAUDE_CAPABILITIES,
      kind: "interactive",
    };

    // Minor（round 2）：newSession 已经成功，之后任一步失败都必须先回收 adapter 侧会话，
    // 再把幂等键标成 failed —— 否则会话泄漏在 adapter 里，且这个 key 永远停在 reserved。
    try {
      this.#registry.upsert(ref);
      // 会话已落库：先把幂等记录标成 done，等待方（并发 / 重启）才能按 key 复用它
      this.#dispatches.complete(idempotencyKey, ref.key, new Date(this.#now()));

      this.#store.append({
        sessionKey: ref.key,
        type: "notice",
        payload: { kind: "dispatch", idempotencyKey, hash, task, cwd: resolvedCwd },
        source: "claude",
        idempotencyKey: DISPATCH_KEY_PREFIX + idempotencyKey,
      });
      // M6：dispatch 让会话进入 running，除 notice 外再发一条 state_update，按状态分发的消费者才看得到
      this.#appendState(ref, { state: "running", driver: "pi", kind: "dispatch", idempotencyKey }, "dispatch");
    } catch (err) {
      await this.#discardSession(sessionId);
      // Minor（round 3 / N1）：adapter 会话已经关掉，会话行不能继续停在 running 指向它 ——
      // dispatches.fail 只把 session_key 置空，不碰 sessions 表，于是留下僵尸行。
      // 尽力而为：upsert 本身就是失败点时内存里没有这行（updateStatus 对未知 key 返回 null），
      // 回收抛错也不覆盖原始失败原因，因为 dispatches.fail 必须照常落库。
      try {
        this.#registry.updateStatus(ref.key, "idle");
      } catch {
        // 状态回收失败不影响止损：幂等记录仍会被标成 failed
      }
      throw this.#dispatchFailed(idempotencyKey, "upsert/attach", err);
    }

    try {
      await this.#adapter.prompt(sessionId, task);
    } catch {
      // R28：投递失败不影响 dispatch 返回；回合结果通过事件流观察
    }
    return ref;
  }

  /**
   * 尽力关闭 adapter 侧会话（round 2：newSession 成功但后续落库失败时的回收）。
   * close 自己失败也不抛出 —— 原始失败原因更重要，回收只是止损。
   */
  async #discardSession(sessionId: string): Promise<void> {
    try {
      await this.#adapter.close(sessionId);
    } catch {
      // adapter 已断（shared 进程退出 / IPC 断开）时 close 也会失败，忽略即可
    }
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

  /** 落 checkpoint 文件 + 落库，返回对象与文件路径（C3） */
  #writeCheckpoint(ref: SessionRef, input: CheckpointInput): { checkpoint: StoredCheckpoint; path: string } {
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

    // C3：文件之外必须落库，否则进程重启后 handback 拿不到游标
    const stored: StoredCheckpoint = { ...checkpoint, path };
    this.#checkpoints.save(stored);
    return { checkpoint: stored, path };
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

  /**
   * 幂等键已被占用（created=false，C1）：按记录状态复用 / 等待 / 报错。
   * 顺序固定为 hash 比对 → failed → done → reserved 轮询。
   */
  async #resolveReserved(record: DispatchRecord, hash: string, idempotencyKey: string): Promise<SessionRef> {
    if (record.payloadHash !== hash) {
      throw new WorkbenchError("E_IDEMPOTENCY_CONFLICT", "幂等键已用于另一个任务：" + idempotencyKey, {
        idempotencyKey,
        sessionKey: record.sessionKey,
      });
    }
    if (record.status === "failed") {
      throw dispatchFailedError(idempotencyKey, record.error);
    }
    if (record.status === "done") {
      return this.#refOf(record, idempotencyKey);
    }

    // reserved：另一个调用方正在跑 newSession，轮询到它落定（C1）
    // Minor（round 2）：不再用墙钟 Date.now 算截止时间 —— 改成「次数 × 间隔」封顶，
    // 时间源就只剩 deps.now，注入固定时钟时这个循环也不会永远退不出去。
    const maxPolls = Math.ceil(DISPATCH_POLL_TIMEOUT_MS / DISPATCH_POLL_INTERVAL_MS);
    for (let poll = 0; poll < maxPolls; poll += 1) {
      await delay(DISPATCH_POLL_INTERVAL_MS);
      const current = this.#dispatches.get(idempotencyKey);
      if (current === null) {
        throw new WorkbenchError("E_ADAPTER_DOWN", "dispatch 的预留记录在等待中消失：" + idempotencyKey, {
          idempotencyKey,
        });
      }
      if (current.payloadHash !== hash) {
        throw new WorkbenchError("E_IDEMPOTENCY_CONFLICT", "幂等键已用于另一个任务：" + idempotencyKey, {
          idempotencyKey,
          sessionKey: current.sessionKey,
        });
      }
      if (current.status === "failed") {
        throw dispatchFailedError(idempotencyKey, current.error);
      }
      if (current.status === "done") {
        return this.#refOf(current, idempotencyKey);
      }
    }
    throw new WorkbenchError("E_ADAPTER_DOWN", "dispatch 仍在进行中：" + idempotencyKey, { idempotencyKey });
  }

  /** 幂等命中：会话必须仍在注册表里，否则是库与注册表不一致（C1） */
  #refOf(record: DispatchRecord, idempotencyKey: string): SessionRef {
    const sessionKey = record.sessionKey;
    if (sessionKey === null) {
      throw new WorkbenchError("E_SESSION_NOT_FOUND", "dispatch 记录缺少会话 key（幂等键 " + idempotencyKey + "）", {
        idempotencyKey,
      });
    }
    const ref = this.#registry.get(sessionKey);
    if (ref === null) {
      throw new WorkbenchError(
        "E_SESSION_NOT_FOUND",
        "dispatch 幂等命中，但会话不在注册表：" + sessionKey + "（sessions 表被清空？需要重新 dispatch）",
        { idempotencyKey, sessionKey },
      );
    }
    return ref;
  }

  /** newSession / upsert 失败：先落 failed 记录再抛（C1），同键后续调用不会永远停在 reserved */
  #dispatchFailed(idempotencyKey: string, where: string, err: unknown): WorkbenchError {
    const message = err instanceof Error ? err.message : String(err);
    this.#dispatches.fail(idempotencyKey, where + "：" + message, new Date(this.#now()));
    if (isWorkbenchError(err)) {
      return err;
    }
    return new WorkbenchError("E_ADAPTER_DOWN", "dispatch 新建会话失败（" + where + "）：" + message, {
      idempotencyKey,
      cause: message,
    });
  }

  /** I4：cancel / close 失败 → 写 error 事件 + 状态回 idle，再抛 E_ADAPTER_DOWN（带原因文本） */
  #handoffAborted(ref: SessionRef, where: string, err: unknown): never {
    const message = err instanceof Error ? err.message : String(err);
    this.#appendError(ref, message, "handoff-" + where);
    this.#registry.updateStatus(ref.key, "idle");
    throw new WorkbenchError(
      "E_ADAPTER_DOWN",
      "handoff 无法停止/关闭会话（" + where + "）：" + ref.key + " — " + message,
      { sessionKey: ref.key, nativeId: ref.nativeId, action: where, cause: message },
    );
  }

  /** 失败留痕：error 事件（payload.message），避免「租约还在、状态 running、却没有任何事件」 */
  #appendError(ref: SessionRef, message: string, action: string): void {
    this.#eventSeq += 1;
    this.#store.append({
      sessionKey: ref.key,
      type: "error",
      payload: { message, action },
      source: ref.agent,
      idempotencyKey:
        ref.agent + ":" + ref.nativeId + ":" + action + ":error:" + String(this.#now()) + ":" + String(this.#eventSeq),
    });
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

function hashOf(value: { agent: string; task: string; cwd: string | null }): string {
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

/** dispatch 记录了失败原因时，后续同键调用按 E_ADAPTER_DOWN 报出来 */
function dispatchFailedError(idempotencyKey: string, error: string | null): WorkbenchError {
  return new WorkbenchError("E_ADAPTER_DOWN", "该幂等键上一次 dispatch 失败：" + (error ?? "未知原因"), {
    idempotencyKey,
    reason: error,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
