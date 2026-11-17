/**
 * 接管原语（A08）：see / inject / interrupt / checkpoint / handoff / handback / dispatch。
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §9；任务：task-7-brief 的 R21–R30。
 *
 * 硬约束（controller 裁定）：
 * - R25 所有写操作（inject / interrupt / checkpoint / handoff / handback / resume）先 leases.assertWriter，
 *   再碰 adapter 或落盘 —— 无租约时绝不产生任何 ACP 请求；
 * - R26 handoff 严格按序：cancel → (waitForTurn) → checkpoint → close → 租约转 human(30min) → 注册表 + 事件；
 * - R27 handback：resume（失败 → E_RESUME_REJECTED）→ 从 checkpoint 游标读 transcript 生成 deltaSummary
 *   → 注册表改回 pi/idle → 租约转回 pi；
 * - R28 dispatch 在引擎里（registry 保持纯存储，不依赖 adapter），幂等靠 dispatches 表的原子占位
 *   （round 1 起已从「events 表回溯」换成落库预留，本注释同步）；
 * - 本模块不 import server / fastify，也不 import 任何 HTTP 层。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentName, Checkpoint, SessionRef, UnifiedMessage } from "@pi-workbench/shared";

import type { AgentAdapter } from "./adapters/types.ts";
import type { AgentRouter } from "./agents/router.ts";
import type { AdapterCapability, AgentDriver } from "./agents/types.ts";
import type { AuditStore } from "./audit.ts";
import { CLAUDE_CAPABILITIES } from "./capabilities.ts";
import { CHECKPOINT_VERSION } from "./checkpoints.ts";
import type { CheckpointStore, StoredCheckpoint } from "./checkpoints.ts";
import { DEFAULT_DISPATCH_RESERVED_TTL_MS } from "./config.ts";
import type { DispatchRecord, DispatchStore } from "./dispatch-store.ts";
import { isWorkbenchError, WorkbenchError } from "./errors.ts";
import type { EventStore } from "./events.ts";
import { DEFAULT_LEASE_TTL_MS } from "./lease.ts";
import type { LeaseManager } from "./lease.ts";
import type { SessionRegistry } from "./registry.ts";
import { claudeProjectDir } from "./transcript/claude.ts";
import { readTranscript } from "./transcript/index.ts";

/** handoff 后人类接管的租约窗口（R7 / R26：30 分钟，CLI 心跳续期） */
export const HUMAN_HANDOFF_TTL_MS = 30 * 60 * 1000;

/** see 的缺省游标：从 transcript 开头读 */
export const CURSOR_ZERO = "0";

/** dispatch 事件的幂等键前缀：dispatch:<idempotencyKey>（R28） */
export const DISPATCH_KEY_PREFIX = "dispatch:";

/** reserved 状态的等待口径（C1）：每 50ms 复查一次，最多等 5s */
/** 人类接管租约的 clientId 前缀：handoff 时派生，handback 时剥掉还给 pi 侧 */
const HANDOFF_CLIENT_PREFIX = "handoff-";

const DISPATCH_POLL_INTERVAL_MS = 50;
const DISPATCH_POLL_TIMEOUT_MS = 5000;

/** deltaSummary 的口径（R27）：每条消息一行，最多 20 条，每条截 120 字 */
const DELTA_MAX_LINES = 20;
const DELTA_MAX_CHARS = 120;

/** checkpoint 游标推进的最大页数（防止异常 reader 造成死循环） */
const MAX_CURSOR_PAGES = 200;

/** 解析不到 transcript 路径时的负缓存（列表/通知周期内避免反复扫描） */
const TRANSCRIPT_PATH_MISS_TTL_MS = 30_000;

/** 归一化后的 transcript 读物（路径语义；测试可注入，生产由统一 readTranscript 按 agent 分派） */
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

/** 驱动层的扩展入口（不属于 AgentDriver 六方法，Codex/Pi 的 dispatch/handoff 用） */
type DriverRuntime = AgentDriver & {
  newSession?: (cwd: string) => Promise<{ sessionId: string; transcriptPath?: string }>;
  waitForTurn?: (ref: SessionRef, timeoutMs?: number) => Promise<{ stopReason: string }>;
  close?: (ref: SessionRef) => Promise<void>;
  resolveTranscriptPath?: (ref: SessionRef) => Promise<string | undefined>;
  /** 接管出口模式（纯函数，不执行命令）：能力门禁要在 close 之前判断是否走 attach 语义 */
  handoffMode?: (ref: SessionRef) => "resume-tui" | "attach";
};

export type TakeoverDeps = {
  store: EventStore;
  leases: LeaseManager;
  registry: SessionRegistry;
  adapter: AgentAdapter;
  /** Agent 注册表（0.5-B B01-b）：缺省保持 0.5-A 的 claude-only 行为 */
  router?: AgentRouter;
  /** checkpoints 表（C3：handback 从这里读游标，不靠进程内存） */
  checkpoints: CheckpointStore;
  /** dispatches 表（C1/C2：原子占位保证并发与跨进程幂等） */
  dispatches: DispatchStore;
  /** C03 审计：handoff / handback / checkpoint 每一步都写一条（可选；缺省不审计） */
  audit?: AuditStore;
  /** reserved 预留窗口 TTL（毫秒）；缺省 DEFAULT_DISPATCH_RESERVED_TTL_MS（120s） */
  dispatchReservedTtlMs?: number;
  /** checkpoint 文件目录，通常是 <home>/handoffs */
  handoffDir: string;
  /** 注入时钟（测试用），默认 Date.now */
  now?: () => number;
  /** 注入 transcript 读取器（仅 Claude 旧签名；非 Claude 一律走统一 readTranscript） */
  readTranscript?: TranscriptReader;
  /**
   * PiDriver 的写者身份。必须与 index.ts 构造 PiDriver 时传的 clientId 一致；
   * 缺省 "pi"（与扩展默认 clientId 不同：扩展是 pi:<pid>，引擎在写操作期间临时换租约）。
   */
  piClientId?: string;
  /** 临时换租约时使用的 TTL；缺省 LeaseManager 默认值 */
  piLeaseTtlMs?: number;
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
/** resume：接管成功后统一回到 pi/idle（review r2 P1 把语义下沉到引擎） */
export type ResumeResult = { resumed: true; sessionKey: string };

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
  readonly #router: AgentRouter | undefined;
  readonly #checkpoints: CheckpointStore;
  readonly #dispatches: DispatchStore;
  readonly #audit: AuditStore | undefined;
  readonly #dispatchTtlMs: number;
  readonly #handoffDir: string;
  /** checkpoint 文件序号：同毫秒 / 同 sanitize 结果也不能撞名（Task 8 review） */
  #checkpointSeq = 0;
  readonly #now: () => number;
  readonly #readTranscript: TranscriptReader | undefined;
  readonly #piClientId: string;
  readonly #piLeaseTtlMs: number | undefined;
  /**
   * 事件幂等键的进程内序号（round 2 的 Minor）：只做同毫秒去重，不重置。
   * 重置会让同一毫秒内的两条同类事件拿到同一个幂等键，被 EventStore 合并成一条 —— 代价比
   * 维护一个只增计数器大得多，所以选「把注释改成实话」。
   * 注意作用域：它只在**本进程内**防止撞车，跨进程（重启）没有等价物，UNIQUE 约束也不保证
   * 跨进程唯一（真实行为与代价见类注释）。
   */
  #eventSeq = 0;
  /** transcriptPath 解析失败的时间窗缓存；只缓存非运行中的会话，避免新 rollout 刚落盘时误伤 */
  readonly #transcriptPathMisses = new Map<string, number>();
  /** 同一会话的并发解析去重（列表与通知器可能同时触发） */
  readonly #transcriptPathResolving = new Map<string, Promise<string | undefined>>();

  constructor(deps: TakeoverDeps) {
    this.#store = deps.store;
    this.#leases = deps.leases;
    this.#registry = deps.registry;
    this.#adapter = deps.adapter;
    this.#router = deps.router;
    this.#checkpoints = deps.checkpoints;
    this.#dispatches = deps.dispatches;
    this.#audit = deps.audit;
    this.#dispatchTtlMs = deps.dispatchReservedTtlMs ?? DEFAULT_DISPATCH_RESERVED_TTL_MS;
    this.#handoffDir = deps.handoffDir;
    this.#now = deps.now ?? Date.now;
    this.#readTranscript = deps.readTranscript;
    this.#piClientId = deps.piClientId ?? "pi";
    this.#piLeaseTtlMs = deps.piLeaseTtlMs;
    // 启动时清掉上次进程崩溃遗留的半成品（Task 8 review）
    this.#sweepCheckpointTmp();
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
    const page = this.#readPage(ref, cursor);
    // M5：reader 报 pending 且一条消息都没有时，游标停在调用方给的位置，绝不倒退成 "0"
    const next = page.pending && page.messages.length === 0 ? cursor : page.nextCursor;
    return { messages: page.messages, cursor: next, pending: page.pending };
  }

  /**
   * 懒解析并持久化 transcript 路径。
   *
   * Codex ACP 的 rollout 文件在 session/new 返回后才落盘，dispatch 时的一次性解析会
   * 抢在文件创建前失败；如果只把路径缓存在 driver 内部，sessions 表仍是 NULL，
   * /sessions 的 unread 就会恒为 0，回合结束通知也会被当成「已经读完」丢掉。
   * 这里在读取列表 / 未读 / transcript 前给驱动一次补解析机会，并把结果写回注册表。
   */
  async refreshTranscriptPath(key: string): Promise<string | undefined> {
    const ref = this.#requireSession(key);
    const existing = ref.transcriptPath;
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const missUntil = this.#transcriptPathMisses.get(key);
    if (missUntil !== undefined && missUntil > this.#now()) {
      return undefined;
    }
    const resolving = this.#transcriptPathResolving.get(key);
    if (resolving !== undefined) {
      return await resolving;
    }
    const promise = this.#resolveTranscriptPath(ref);
    this.#transcriptPathResolving.set(key, promise);
    try {
      return await promise;
    } finally {
      this.#transcriptPathResolving.delete(key);
    }
  }

  async #resolveTranscriptPath(ref: SessionRef): Promise<string | undefined> {
    const driver = this.#driverOf(ref);
    if (driver === null) {
      return undefined;
    }
    const resolve = (driver as DriverRuntime).resolveTranscriptPath;
    if (resolve === undefined) {
      return undefined;
    }
    try {
      const path = await resolve.call(driver, ref);
      if (path === undefined || path.trim().length === 0) {
        this.#rememberTranscriptPathMiss(ref);
        return undefined;
      }
      const normalized = path.trim();
      this.#transcriptPathMisses.delete(ref.key);
      const current = this.#registry.get(ref.key);
      if (current !== null && (current.transcriptPath === undefined || current.transcriptPath.length === 0)) {
        this.#registry.upsert({ ...current, transcriptPath: normalized });
      }
      return normalized;
    } catch {
      this.#rememberTranscriptPathMiss(ref);
      return undefined;
    }
  }

  /** 运行中的新会话不缓存 miss：rollout 可能几十毫秒后才落盘。 */
  #rememberTranscriptPathMiss(ref: SessionRef): void {
    if (ref.status !== "running" && ref.status !== "starting") {
      this.#transcriptPathMisses.set(ref.key, this.#now() + TRANSCRIPT_PATH_MISS_TTL_MS);
    }
  }

  /**
   * 投递一条用户消息。回合进行中（status=running）的注入不改变当前回合，
   * 只在下一个 turn 边界生效 —— 响应据此标 effective: next_turn（spec §11 降级口径）。
   */
  async inject(key: string, text: string, clientId: string): Promise<InjectResult> {
    this.#leases.assertWriter(key, clientId);
    const ref = this.#requireSession(key);
    const driver = this.#driverOf(ref);
    if (driver !== null) {
      this.#assertDriverCap(driver, "inject");
      return await this.#driverWrite(ref, clientId, () => driver.inject(ref, text));
    }
    const { messageId } = await this.#adapter.prompt(ref.nativeId, text);
    return { messageId, effective: ref.status === "running" ? "next_turn" : "now" };
  }

  /** 打断当前回合：cancel → 状态投影回 idle，并落一条 state_update 事件（验收 §10 #4）。 */
  async interrupt(key: string, clientId: string): Promise<InterruptResult> {
    this.#leases.assertWriter(key, clientId);
    const ref = this.#requireSession(key);
    const driver = this.#driverOf(ref);

    let stopReason: string;
    if (driver !== null) {
      this.#assertDriverCap(driver, "interrupt");
      ({ stopReason } = await this.#driverWrite(ref, clientId, () => driver.interrupt(ref)));
    } else {
      ({ stopReason } = await this.#adapter.cancel(ref.nativeId));
    }
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
    const startedAt = this.#now();
    try {
      const checkpoint = this.#writeCheckpoint(ref, input).checkpoint;
      this.#auditStep(clientId, "checkpoint", ref, "checkpoint", startedAt, "ok", null, {
        cursor: checkpoint.transcriptCursor,
      });
      return checkpoint;
    } catch (err) {
      this.#auditStep(clientId, "checkpoint", ref, "checkpoint", startedAt, "error", this.#errorCodeOf(err));
      throw err;
    }
  }

  /**
   * 交给人（或交给另一个 pi 客户端）：R26 七步严格按序。
   * 第 4 个参数是 checkpoint 内容；省略时给一份最小可用的默认值（保持 R25 的三参签名可用）。
   */
  async handoff(key: string, to: "human" | "pi", clientId: string, input?: HandoffInput): Promise<HandoffResult> {
    this.#leases.assertWriter(key, clientId);
    const ref = this.#requireSession(key);
    const driver = this.#driverOf(ref);

    // 2. quiesce：运行中先 cancel 并等回合结束（adapter 没有 waitForTurn 就跳过）
    // I4：cancel / close 失败必须留痕 —— 否则租约还指着 pi、状态还是 running，却一条事件都没有
    const quiesceStartedAt = this.#now();
    try {
      if (ref.status === "running") {
        if (driver !== null) {
          this.#assertDriverCap(driver, "interrupt");
          await this.#driverWrite(ref, clientId, () => driver.interrupt(ref));
        } else {
          await this.#adapter.cancel(ref.nativeId);
        }
        await this.#waitForTurn(ref, driver);
      }
    } catch (err) {
      this.#auditStep(clientId, "handoff", ref, "cancel", quiesceStartedAt, "error", "E_HANDOFF_FAILED");
      // spec §7.3 补偿表：cancel 失败 → 会话状态不变、租约归还调用方
      throw this.#handoffFailed(ref, "cancel", err);
    }
    this.#auditStep(clientId, "handoff", ref, "cancel", quiesceStartedAt, "ok", null, {
      skipped: ref.status !== "running",
    });

    // 3. checkpoint（文件 + checkpoints 表）。写失败抛 E_CHECKPOINT_FAILED：状态不变、租约不动。
    const checkpointStartedAt = this.#now();
    let checkpoint: Checkpoint;
    let path: string;
    try {
      ({ checkpoint, path } = this.#writeCheckpoint(ref, input ?? defaultHandoffInput(to)));
    } catch (err) {
      this.#auditStep(clientId, "handoff", ref, "checkpoint", checkpointStartedAt, "error", this.#errorCodeOf(err));
      throw err;
    }
    this.#auditStep(clientId, "handoff", ref, "checkpoint", checkpointStartedAt, "ok", null, {
      cursor: checkpoint.transcriptCursor,
    });

    // 4. 接管模式的能力门禁（review P2-5）：必须在破坏性的 close 之前。
    //    只看 driver 声明的模式（纯函数，不执行命令），能力不足的 driver 不得先关控制通道再回 422；
    //    否则调用方拿到「422 但控制通道已关」的假失败，后续 inject 会打到已关闭的会话。
    this.#assertHandoffMode(ref, driver);

    // 5. 释放控制通道里的会话，交给原生终端（没有 close 的 driver，如 Pi，保持原生会话不动）
    const closeStartedAt = this.#now();
    try {
      if (driver !== null) {
        await this.#closeDriverRef(ref, driver, clientId);
      } else {
        await this.#adapter.close(ref.nativeId);
      }
    } catch (err) {
      this.#auditStep(clientId, "handoff", ref, "close", closeStartedAt, "error", "E_HANDOFF_FAILED");
      // spec §7.3 补偿表：close 失败 → 回滚为原状态（此前未改注册表）、租约归还调用方
      throw this.#handoffFailed(ref, "close", err);
    }
    this.#auditStep(clientId, "handoff", ref, "close", closeStartedAt, "ok", null);

    // 6. 接管命令由 driver.handoff(ref) 决定（Claude：background attach / interactive --resume；
    //    Codex：codex resume <id> --no-alt-screen；Pi：pi --session <file>）。
    //    放在 checkpoint / close 之后：handoff 只拼命令，不执行，也不依赖 adapter 仍存活。
    let exit: { command: string[]; mode: "resume-tui" | "attach" };
    const commandStartedAt = this.#now();
    try {
      exit = await this.#handoffCommand(ref, driver, clientId);
    } catch (err) {
      const capabilityError =
        isWorkbenchError(err) && (err.code === "E_CAP_UNSUPPORTED" || err.code === "E_AGENT_UNAVAILABLE");
      this.#auditStep(
        clientId,
        "handoff",
        ref,
        "handoff",
        commandStartedAt,
        "error",
        capabilityError && isWorkbenchError(err) ? err.code : "E_HANDOFF_FAILED",
      );
      // 能力门禁 / Agent 不可用是请求级 422，不能被 handoff 的止损包装成 503
      if (capabilityError) {
        throw err;
      }
      // spec §7.3：命令拼接失败 → 会话 exited、租约释放，detail 带 checkpointPath
      try {
        this.#leases.release(key, clientId);
      } catch {
        // 租约已不在调用方名下（理论上不会发生）：仍按失败返回，不覆盖原始原因
      }
      throw this.#handoffFailed(ref, "handoff", err, { checkpointPath: path });
    }
    this.#auditStep(clientId, "handoff", ref, "handoff", commandStartedAt, "ok", null, { mode: exit.mode });

    // 7. 租约转给接管的 driver，人类窗口固定 30 分钟
    this.#leases.release(key, clientId);
    this.#leases.acquire(key, to, HANDOFF_CLIENT_PREFIX + clientId, HUMAN_HANDOFF_TTL_MS);

    // 8. 注册表 + 事件
    const next: SessionRef = { ...ref, driver: to, status: "handoff" };
    this.#registry.upsert(next);
    this.#appendState(next, { state: "handoff", driver: to, checkpointPath: path, to }, "handoff");

    return { checkpoint, command: exit.command, mode: exit.mode };
  }

  /**
   * 从人类手里接回（R27）：resume → 读 delta → 注册表改回 pi/idle → 租约转回 pi。
   * resume 被拒立即 E_RESUME_REJECTED，不改注册表、不动租约。
   */
  async handback(key: string, clientId: string): Promise<HandbackResult> {
    // I4：handoff 把租约派生成 "handoff-<piClientId>"，而 Pi 侧 handback 用的是自己的身份
    // （pi:<pid>）。两种写法都要认：先看当前租约持有人是不是 handoff-<去前缀后的 id>，
    // 是就按那个 id 校验，否则按传入的 id 校验（兼容直接传 handoff-<id> 的调用方）。
    const piClientId = clientId.startsWith(HANDOFF_CLIENT_PREFIX)
      ? clientId.slice(HANDOFF_CLIENT_PREFIX.length)
      : clientId;
    const holder = this.#leases.current(key);
    const writerId =
      holder !== null && holder.clientId === HANDOFF_CLIENT_PREFIX + piClientId ? holder.clientId : clientId;
    this.#leases.assertWriter(key, writerId);
    const ref = this.#requireSession(key);
    const driver = this.#driverOf(ref);

    const resumeStartedAt = this.#now();
    try {
      if (driver !== null) {
        this.#assertDriverCap(driver, "resume");
        await this.#driverWrite(ref, writerId, () => driver.resume(ref));
      } else {
        await this.#adapter.resume(ref.nativeId, ref.cwd);
      }
    } catch (err) {
      this.#auditStep(clientId, "handback", ref, "resume", resumeStartedAt, "error", "E_RESUME_REJECTED");
      throw new WorkbenchError("E_RESUME_REJECTED", "恢复会话被拒绝：" + key, {
        sessionKey: key,
        nativeId: ref.nativeId,
        step: "resume",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    this.#auditStep(clientId, "handback", ref, "resume", resumeStartedAt, "ok", null);

    // C3：游标以库里的最新 checkpoint 为准 —— 进程重启后 handback 仍从正确位置读增量
    const latest = this.#checkpoints.latest(key);
    const cursor = latest === null ? CURSOR_ZERO : latest.transcriptCursor;
    const deltaSummary = this.#deltaSummary(ref, cursor);

    const next: SessionRef = { ...ref, driver: "pi", status: "idle" };
    this.#registry.upsert(next);
    this.#appendState(next, { state: "idle", driver: "pi", clientId }, "handback");

    // 租约交还给 **pi 侧身份**：handback 的语义是「控制权回到 pi 驱动」。人类租约的 id 是
    // handoff 时派生的 "handoff-<piClientId>"（见 handoff），所以要剥掉这层前缀再发回去，
    // 否则 Pi 扩展用原来的 clientId 写会立刻 E_NO_LEASE。
    this.#leases.release(key, writerId);
    this.#leases.acquire(key, "pi", piClientId, DEFAULT_LEASE_TTL_MS);
    return { resumed: true, deltaSummary };
  }

  /**
   * 接管已存在的原生会话（review r2 P1）：形状与 handback 对齐 —— 租约门禁 → #driverWrite →
   * driver.resume → 注册表/事件。三个 Agent 的行为因此一致，Pi 在 resume 内部 #claim 抢走的
   * "pi" 租约也会被 #driverWrite 还原给调用方（否则紧接着 inject 会 E_NO_LEASE）。
   *
   * 判定顺序是「状态 → 租约 → driver」：human handoff / running 是「这个会话现在不该 resume」，
   * 与调用方有没有租约无关；状态门禁必须在 assertWriter 之前。
   * resume 被拒立即 E_RESUME_REJECTED，不改注册表、不动租约。
   */
  async resume(key: string, clientId: string): Promise<ResumeResult> {
    const ref = this.#requireSession(key);
    if (ref.driver === "human" || ref.status === "handoff") {
      throw new WorkbenchError("E_RESUME_REJECTED", "会话处于 human handoff，请用 handback 接回", {
        sessionKey: key,
        reason: "handoff",
      });
    }
    if (ref.status === "running" || ref.status === "starting") {
      throw new WorkbenchError("E_SESSION_BUSY", "会话正在运行，暂不能 resume：" + key, {
        sessionKey: key,
        status: ref.status,
      });
    }
    this.#leases.assertWriter(key, clientId);

    const driver = this.#driverOf(ref);
    if (driver === null) {
      throw new WorkbenchError("E_AGENT_UNAVAILABLE", "Agent 未注册或不可用：" + ref.agent, {
        agent: ref.agent,
        cap: "resume",
      });
    }
    this.#assertDriverCap(driver, "resume");

    const startedAt = this.#now();
    try {
      await this.#driverWrite(ref, clientId, () => driver.resume(ref));
    } catch (err) {
      this.#auditStep(clientId, "resume", ref, "resume", startedAt, "error", this.#errorCodeOf(err));
      if (isWorkbenchError(err)) {
        throw err;
      }
      throw new WorkbenchError("E_RESUME_REJECTED", "恢复会话被拒绝：" + key, {
        sessionKey: key,
        nativeId: ref.nativeId,
        step: "resume",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    this.#auditStep(clientId, "resume", ref, "resume", startedAt, "ok", null);

    const next: SessionRef = { ...ref, driver: "pi", status: "idle" };
    this.#registry.upsert(next);
    this.#appendState(next, { state: "idle", driver: "pi", clientId }, "resume");
    return { resumed: true, sessionKey: key };
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
    // 0.5-B B01-b：传了注册表就按注册表判可用（未注册 → E_AGENT_UNAVAILABLE）；
    // 不传 router 的旧调用保持 0.5-A 的 claude-only 口径（E_BAD_REQUEST），避免破坏既有调用方。
    const driver = this.#router?.get(input.agent) ?? null;
    if (this.#router === undefined && input.agent !== "claude") {
      throw new WorkbenchError("E_BAD_REQUEST", "v1 只支持 dispatch claude 会话：" + String(input.agent), {
        agent: input.agent,
      });
    }
    if (this.#router !== undefined && driver === null) {
      throw new WorkbenchError("E_AGENT_UNAVAILABLE", "Agent 未注册或不可用：" + String(input.agent), {
        agent: input.agent,
      });
    }
    if (this.#router !== undefined && driver !== null) {
      const status = this.#router.list().find((item) => item.agent === input.agent);
      if (status !== undefined && !status.available) {
        throw new WorkbenchError(
          "E_AGENT_UNAVAILABLE",
          "Agent 不可用：" + String(input.agent) + (status.reason === undefined ? "" : "（" + status.reason + "）"),
          { agent: input.agent, reason: status.reason ?? null },
        );
      }
      // 能力门禁在 reserve 之前：能力不足时绝不写幂等记录、绝不拉起 ACP/RPC 子进程
      this.#assertDriverCap(driver, "inject");
      if (input.agent !== "claude" && (driver as DriverRuntime).newSession === undefined) {
        throw new WorkbenchError("E_CAP_UNSUPPORTED", "Agent " + String(input.agent) + " 不支持新建会话", {
          agent: input.agent,
          cap: "inject",
        });
      }
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
    // 普通预留的 claimToken 为 null；回收赢家会从记录里拿到新换发的 claim token。
    let claimToken: string | null = record.sessionKey;
    if (!created) {
      const outcome = await this.#resolveReserved(record, hash, idempotencyKey);
      if (outcome.kind === "ref") {
        return outcome.ref;
      }
      // kind === "retry"：本调用赢下超时回收，继续走下面的 newSession 路径
      claimToken = outcome.claimToken;
    }

    // C02：newSession 可能超过 reserved TTL；按 TTL/3 续约，避免被并发调用回收后重复执行。
    const renew = setInterval(() => {
      try {
        this.#dispatches.touch(idempotencyKey, new Date(this.#now()), claimToken ?? undefined);
      } catch {
        // 续约失败下个周期重试；真丢了预留会被 complete/fail 的 fencing 拦住
      }
    }, Math.max(1, Math.floor(this.#dispatchTtlMs / 3)));
    renew.unref();

    let sessionId: string;
    let openedTranscriptPath: string | undefined;
    try {
      if (driver !== null && input.agent !== "claude") {
        const opener = (driver as DriverRuntime).newSession;
        if (opener === undefined) {
          throw new WorkbenchError("E_CAP_UNSUPPORTED", "Agent " + String(input.agent) + " 不支持新建会话", {
            agent: input.agent,
          });
        }
        const opened = await opener.call(driver, resolvedCwd);
        sessionId = opened.sessionId;
        openedTranscriptPath = opened.transcriptPath;
      } else {
        const opened = await this.#adapter.newSession(resolvedCwd);
        sessionId = opened.sessionId;
      }
    } catch (err) {
      throw this.#dispatchFailed(idempotencyKey, "newSession", err, claimToken ?? undefined);
    } finally {
      clearInterval(renew);
    }

    const ref: SessionRef = {
      key: input.agent + ":" + sessionId,
      agent: input.agent,
      nativeId: sessionId,
      acpSessionId: sessionId,
      cwd: resolvedCwd,
      // 只有 Claude 的会话文件路径能由 cwd 推导；Codex/Pi 由各自发现层补写
      ...(input.agent === "claude"
        ? { transcriptPath: join(claudeProjectDir(resolvedCwd), sessionId + ".jsonl") }
        : openedTranscriptPath === undefined
          ? {}
          : { transcriptPath: openedTranscriptPath }),
      status: "running",
      driver: "pi",
      capabilities: driver === null ? CLAUDE_CAPABILITIES : driver.caps,
      kind: "interactive",
    };

    // Codex 的 rollout 路径在 newSession 后可能已落盘：尽力解析一次并写进 ref（失败保持 pending）
    if (driver !== null) {
      const resolve = (driver as DriverRuntime).resolveTranscriptPath;
      if (resolve !== undefined) {
        try {
          const resolvedPath = await resolve.call(driver, ref);
          if (resolvedPath !== undefined && resolvedPath.length > 0) {
            ref.transcriptPath = resolvedPath;
          }
        } catch {
          // rollout 未落盘：transcriptPath 保持 undefined，see 返回 pending
        }
      }
    }

    // Minor（round 2）：newSession 已经成功，之后任一步失败都必须先回收 adapter 侧会话，
    // 再把幂等键标成 failed —— 否则会话泄漏在 adapter 里，且这个 key 永远停在 reserved。
    try {
      // C02 fix 2：落库前再确认一次预留归属。旧 owner 被回收后没有 claim token，必须在
      // 写 registry / sessions.dispatch_key 之前退出；否则它会先占用唯一索引，导致回收赢家撞键。
      if (!this.#dispatches.touch(idempotencyKey, new Date(this.#now()), claimToken ?? undefined)) {
        throw new WorkbenchError(
          "E_DISPATCH_IN_PROGRESS",
          "dispatch 预留已被回收，拒绝落库： " + idempotencyKey,
          { idempotencyKey },
        );
      }
      this.#registry.upsert(ref);
      // C02：先写 dispatch_key（唯一索引兜底防双会话），等待方（并发 / 重启 / 回收）才能按 key 复用。
      this.#registry.setDispatchKey(ref.key, idempotencyKey, new Date(this.#now()));

      this.#store.append({
        sessionKey: ref.key,
        type: "notice",
        payload: { kind: "dispatch", idempotencyKey, hash, task, cwd: resolvedCwd },
        source: ref.agent,
        idempotencyKey: DISPATCH_KEY_PREFIX + idempotencyKey,
      });
      // M6：dispatch 让会话进入 running，除 notice 外再发一条 state_update，按状态分发的消费者才看得到
      this.#appendState(ref, { state: "running", driver: "pi", kind: "dispatch", idempotencyKey }, "dispatch");

      // C02 fix 2：事件落库成功后才标 done。若 append/appendState 抛错，记录仍是 reserved，
      // 失败路径才能落 failed，重试不会拿到指向已关闭会话的 done 记录。
      if (!this.#dispatches.complete(idempotencyKey, ref.key, new Date(this.#now()), claimToken ?? undefined)) {
        throw new WorkbenchError(
          "E_DISPATCH_IN_PROGRESS",
          "dispatch 预留已被回收，拒绝覆盖： " + idempotencyKey,
          { idempotencyKey },
        );
      }
    } catch (err) {
      await this.#discardRef(ref, driver);
      // Minor（round 3 / N1）：adapter 会话已经关掉，会话行不能继续停在 running 指向它 ——
      // dispatches.fail 只把 session_key 置空，不碰 sessions 表，于是留下僵尸行。
      // 尽力而为：upsert 本身就是失败点时内存里没有这行（updateStatus 对未知 key 返回 null），
      // 回收抛错也不覆盖原始失败原因，因为 dispatches.fail 必须照常落库。
      try {
        // C02：complete 失败（预留已被回收）时 dispatch_key 可能已经写上；不清掉会挡住同 key 重试。
        this.#registry.clearDispatchKey(ref.key, new Date(this.#now()));
        this.#registry.updateStatus(ref.key, "idle");
      } catch {
        // 状态回收失败不影响止损：幂等记录仍会被标成 failed
      }
      throw this.#dispatchFailed(idempotencyKey, "upsert/attach", err, claimToken ?? undefined);
    }

    try {
      if (driver !== null && input.agent !== "claude") {
        await this.#driverWrite(ref, this.#piClientId, () => driver.inject(ref, task));
      } else {
        await this.#adapter.prompt(sessionId, task);
      }
    } catch {
      // R28：投递失败不影响 dispatch 返回；回合结果通过事件流观察
    } finally {
      // dispatch 的内部 pi 租约只覆盖本次投递；返回后释放，否则普通 clientId 无法
      // acquire 租约，后续 cp_inject / interrupt / checkpoint 会直接 409。
      if (driver !== null && input.agent !== "claude") {
        const holder = this.#leases.current(ref.key);
        if (holder !== null && holder.clientId === this.#piClientId) {
          this.#leases.release(ref.key, this.#piClientId);
        }
      }
    }
    return ref;
  }

  #driverOf(ref: SessionRef): AgentDriver | null {
    return this.#router?.get(ref.agent) ?? null;
  }

  /**
   * 接管模式的能力门禁（review P2-5）：在破坏性的 close 之前执行。
   * 模式来自 driver.handoffMode（纯函数）；未实现的 driver 按会话 kind 推导
   * （background → attach，其余 → resume-tui，与 0.5-A 的 fallback 口径一致）。
   */
  #assertHandoffMode(ref: SessionRef, driver: AgentDriver | null): void {
    if (driver === null) {
      return;
    }
    const runtime = driver as DriverRuntime;
    const mode = runtime.handoffMode?.(ref) ?? (ref.kind === "background" ? "attach" : "resume-tui");
    if (mode === "attach" && driver.agent !== "claude" && !driver.caps.attach) {
      throw new WorkbenchError(
        "E_CAP_UNSUPPORTED",
        "Agent " + String(driver.agent) + " 不支持 attach 语义",
        { agent: driver.agent, cap: "attach" },
      );
    }
  }

  /** 能力门禁：读 driver.caps 的实时值（router.list() 是注册时快照，不能用于运行时降级） */
  #assertDriverCap(driver: AgentDriver, cap: AdapterCapability): void {
    const supported = cap === "see" ? driver.caps.transcript : driver.caps[cap];
    if (!supported) {
      throw new WorkbenchError(
        "E_CAP_UNSUPPORTED",
        "Agent " + String(driver.agent) + " 不支持能力 " + cap,
        { agent: driver.agent, cap },
      );
    }
  }

  /**
   * Driver 写操作的租约身份适配：扩展的 clientId 是 pi:<pid>，而 Codex/Pi driver 的
   * 写守卫使用引擎固定身份 "pi"（index.ts 的 PI_AGENT_CLIENT_ID）。写操作期间把租约
   * 临时换成 driver 身份，完成后原样还给调用方 —— 同一个 LeaseManager，不会出现
   * E_LEASE_CONFLICT。Claude / 无 driver / 无租约 / 租约本来就在 driver 名下时直接执行。
   */
  async #driverWrite<T>(ref: SessionRef, clientId: string, fn: () => Promise<T> | T): Promise<T> {
    const driver = this.#driverOf(ref);
    if (driver === null || driver.agent === "claude") {
      return await fn();
    }
    const holder = this.#leases.current(ref.key);
    if (holder === null || holder.clientId === this.#piClientId || holder.clientId !== clientId) {
      return await fn();
    }
    this.#leases.release(ref.key, clientId);
    this.#leases.acquire(ref.key, "pi", this.#piClientId, this.#piLeaseTtlMs);
    try {
      return await fn();
    } finally {
      this.#leases.release(ref.key, this.#piClientId);
      this.#leases.acquire(ref.key, "pi", clientId, this.#piLeaseTtlMs);
    }
  }

  /** 尽力关闭 driver 侧会话（dispatch 落库失败回收 / handoff 第 4 步） */
  async #discardRef(ref: SessionRef, driver: AgentDriver | null): Promise<void> {
    try {
      if (driver !== null) {
        await this.#closeDriverRef(ref, driver, this.#piClientId);
      } else {
        await this.#adapter.close(ref.nativeId);
      }
    } catch {
      // 回收只是止损：adapter / driver 已断时忽略，不覆盖原始失败原因
    }
  }

  /**
   * 关闭控制通道：Claude 走既有 adapter.close；Codex / Pi 走各自的 close。
   * Pi 的 close 会停掉 --mode rpc 子进程 —— 否则 handoff 给原生终端后，
   * daemon 与人类终端会同时写同一个 session jsonl（A11 实测 Pi 无文件锁）。
   */
  async #closeDriverRef(ref: SessionRef, driver: AgentDriver, clientId: string): Promise<void> {
    if (driver.agent === "claude") {
      await this.#adapter.close(ref.nativeId);
      return;
    }
    const close = (driver as DriverRuntime).close;
    if (close === undefined) {
      return;
    }
    await this.#driverWrite(ref, clientId, () => close.call(driver, ref));
  }

  /** 等回合结束；driver/adapter 未实现 waitForTurn 或超时都不阻断 handoff（quiesce 尽力而为） */
  async #waitForTurn(ref: SessionRef, driver: AgentDriver | null): Promise<void> {
    if (driver !== null) {
      const wait = (driver as DriverRuntime).waitForTurn;
      if (wait === undefined) {
        return;
      }
      try {
        await wait.call(driver, ref);
      } catch {
        // turn timeout / driver 已在关闭：close 仍要继续
      }
      return;
    }
    const wait = this.#adapter.waitForTurn;
    if (wait === undefined) {
      return;
    }
    try {
      await wait.call(this.#adapter, ref.nativeId);
    } catch {
      // turn timeout / adapter 已在关闭：close 仍要继续，否则会话就漏在 adapter 里
    }
  }

  /** handoff 命令：注册了 driver 就委托，否则保持 0.5-A 的 claude 口径 */
  async #handoffCommand(
    ref: SessionRef,
    driver: AgentDriver | null,
    clientId: string,
  ): Promise<{ command: string[]; mode: "resume-tui" | "attach" }> {
    if (driver !== null) {
      const exit = await this.#driverWrite(ref, clientId, () => driver.handoff(ref));
      // handoff 本身是分流（resume-tui 可用），但若 driver 实际要求 attach 语义，
      // 仍必须过 caps.attach。Claude 后台会话的 attach 能力按 kind 存在 ref.capabilities，
      // 且 0.5-A 的 fallback 路径保持原行为，故这里只拦非 Claude driver。
      if (exit.mode === "attach" && driver.agent !== "claude" && !driver.caps.attach) {
        throw new WorkbenchError(
          "E_CAP_UNSUPPORTED",
          "Agent " + String(driver.agent) + " 不支持 attach 语义",
          { agent: driver.agent, cap: "attach" },
        );
      }
      return exit;
    }
    const background = ref.kind === "background";
    return {
      command: background ? ["claude", "attach", ref.nativeId] : ["claude", "--resume", ref.nativeId],
      mode: background ? "attach" : "resume-tui",
    };
  }

  /** 统一读路径：Claude 保留注入 reader（0.5-A 测试的字节游标口径），其余走 readTranscript(agent, ...) */
  #readPage(ref: SessionRef, cursor: string): { messages: UnifiedMessage[]; nextCursor: string; pending: boolean } {
    const path = ref.transcriptPath;
    if (path === undefined || path.length === 0) {
      return { messages: [], nextCursor: cursor, pending: true };
    }
    if (this.#readTranscript !== undefined && ref.agent === "claude") {
      return this.#readTranscript(path, cursor);
    }
    return readTranscript(ref.agent, path, cursor);
  }

  /**
   * 落 checkpoint 文件 + 落库，返回对象与文件路径（C3 / spec §7.3）。
   * 原子写：先写 `<path>.tmp`，再 `renameSync` 覆盖正式文件；任一步失败都清理半成品并抛
   * `E_CHECKPOINT_FAILED`（500），调用方看到的永远是完整文件或旧文件。
   */
  #writeCheckpoint(ref: SessionRef, input: CheckpointInput): { checkpoint: StoredCheckpoint; path: string } {
    const nowMs = this.#now();
    const checkpoint: Checkpoint = {
      sessionKey: ref.key,
      summary: input.summary,
      touchedFiles: [...input.touchedFiles],
      nextStep: input.nextStep,
      transcriptCursor: ref.transcriptPath === undefined ? CURSOR_ZERO : this.#cursorAtEnd(ref),
      createdAt: new Date(nowMs).toISOString(),
      version: CHECKPOINT_VERSION,
    };

    // 文件名必须同时带「原始 key 的短哈希」和「进程内自增序号」：
    // - 不同 key 经 sanitizeKey 后可能相同（claude:sess/1 与 claude:sess-1 → claude-sess-1）；
    // - 固定时钟或极快连续写会出现同毫秒。
    // 只靠 sanitizeKey + 时间戳会让两次写指向同一个文件：后写覆盖前写、两行 DB 共用一个 path。
    const keyHash = createHash("sha256").update(ref.key).digest("hex").slice(0, 8);
    const seq = (this.#checkpointSeq += 1);
    const base = sanitizeKey(ref.key) + "-" + isoForFile(nowMs) + "-" + keyHash + "-" + seq;
    const path = join(this.#handoffDir, base + ".md");
    // tmp 同样唯一：即使崩溃遗留，也不会被下一次写误用
    const tmp = join(this.#handoffDir, base + ".tmp");
    try {
      mkdirSync(this.#handoffDir, { recursive: true });
      writeFileSync(tmp, renderCheckpoint(checkpoint), "utf8");
      renameSync(tmp, path);
    } catch (err) {
      // 崩溃窗口的清理：tmp 没被 rename 就失败时不能留在目录里被误读成检查点
      this.#removeQuietly(tmp);
      throw this.#checkpointFailed(ref, path, err);
    }

    // C3：文件之外必须落库，否则进程重启后 handback 拿不到游标
    const stored: StoredCheckpoint = { ...checkpoint, path };
    try {
      this.#checkpoints.save(stored);
    } catch (err) {
      // 落库失败同样不能留半文件：删掉刚 rename 的文件，保持「失败无副作用」
      this.#removeQuietly(path);
      throw this.#checkpointFailed(ref, path, err);
    }
    return { checkpoint: stored, path };
  }

  /** 清理半成品：ENOENT 静默；其他错误写 stderr，但都不覆盖原始失败原因 */
  #removeQuietly(path: string): void {
    try {
      unlinkSync(path);
    } catch (err) {
      // 清理只是止损：ENOENT 说明本来就没有；其余错误留痕，方便排查残留半成品
      if ((err as { code?: string }).code !== "ENOENT") {
        console.error("[takeover] 清理临时文件失败：" + path + " — " + (err instanceof Error ? err.message : String(err)));
      }
    }
  }

  /** 启动时清掉上次进程崩溃遗留的 <handoffDir>/*.tmp（Task 8 review） */
  #sweepCheckpointTmp(): void {
    let names: string[];
    try {
      names = readdirSync(this.#handoffDir);
    } catch {
      return; // 目录还不存在：首次写 checkpoint 时会 mkdir
    }
    for (const name of names) {
      if (name.endsWith(".tmp")) {
        this.#removeQuietly(join(this.#handoffDir, name));
      }
    }
  }

  /** checkpoint 写文件 / 落库失败 → 500 E_CHECKPOINT_FAILED（spec §7.3 / §8） */
  #checkpointFailed(ref: SessionRef, path: string, err: unknown): WorkbenchError {
    const message = err instanceof Error ? err.message : String(err);
    return new WorkbenchError("E_CHECKPOINT_FAILED", "写检查点失败：" + ref.key + " — " + message, {
      sessionKey: ref.key,
      nativeId: ref.nativeId,
      path,
      step: "checkpoint",
      action: "checkpoint",
      cause: message,
    });
  }

  /** 把 transcript 游标推进到当前末尾（handback 从该偏移读人类接管期间的增量） */
  #cursorAtEnd(ref: SessionRef): string {
    let cursor = CURSOR_ZERO;
    for (let page = 0; page < MAX_CURSOR_PAGES; page += 1) {
      let result: { messages: UnifiedMessage[]; nextCursor: string; pending: boolean };
      try {
        result = this.#readPage(ref, cursor);
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
      return buildDeltaSummary(this.#readPage(ref, cursor).messages);
    } catch {
      return "";
    }
  }

  /**
   * 幂等键已被占用（created=false，C1）：按记录状态复用 / 等待 / 报错。
   * 顺序固定为 hash 比对 → failed → done → reserved 轮询。
   */
  async #resolveReserved(
    record: DispatchRecord,
    hash: string,
    idempotencyKey: string,
  ): Promise<{ kind: "ref"; ref: SessionRef } | { kind: "retry"; claimToken: string | null }> {
    if (record.payloadHash !== hash) {
      throw new WorkbenchError("E_IDEMPOTENCY_CONFLICT", "幂等键已用于另一个任务：" + idempotencyKey, {
        idempotencyKey,
        sessionKey: record.sessionKey,
      });
    }
    let current = record;
    if (current.status === "failed") {
      // C02：failed + 同 payload 允许原子重试（failed→reserved，清 session_key/error、重置时间戳）。
      if (this.#dispatches.retryFailed(idempotencyKey, new Date(this.#now()))) {
        return this.#retryOutcome(idempotencyKey);
      }
      const latest = this.#dispatches.get(idempotencyKey);
      if (latest === null) {
        throw new WorkbenchError("E_ADAPTER_DOWN", "dispatch 的失败记录在重试前消失： " + idempotencyKey, {
          idempotencyKey,
        });
      }
      if (latest.payloadHash !== hash) {
        throw new WorkbenchError("E_IDEMPOTENCY_CONFLICT", "幂等键已用于另一个任务： " + idempotencyKey, {
          idempotencyKey,
          sessionKey: latest.sessionKey,
        });
      }
      if (latest.status === "failed") {
        throw dispatchFailedError(idempotencyKey, latest.error);
      }
      if (latest.status === "done") {
        return { kind: "ref", ref: this.#refOf(latest, idempotencyKey) };
      }
      current = latest;
    }
    if (current.status === "done") {
      return { kind: "ref", ref: this.#refOf(current, idempotencyKey) };
    }

    // C02 回收前必查：上次可能已经建好会话（registry.upsert + dispatch_key 成功，但 complete 没落），
    // 命中就直接补记 done 并返回，绝不重复 newSession。
    const linked = this.#registry.findByDispatchKey(idempotencyKey);
    if (linked !== null) {
      // C02 fix 2：补记 done 也必须过 fencing；false 说明预留已被回收/改属，不能返回旧会话。
      if (
        this.#dispatches.complete(
          idempotencyKey,
          linked.key,
          new Date(this.#now()),
          current.sessionKey ?? undefined,
        )
      ) {
        return { kind: "ref", ref: linked };
      }
      const latest = this.#dispatches.get(idempotencyKey);
      if (latest === null) {
        throw new WorkbenchError("E_ADAPTER_DOWN", "dispatch 的预留记录在补记时消失： " + idempotencyKey, {
          idempotencyKey,
        });
      }
      if (latest.payloadHash !== hash) {
        throw new WorkbenchError("E_IDEMPOTENCY_CONFLICT", "幂等键已用于另一个任务： " + idempotencyKey, {
          idempotencyKey,
          sessionKey: latest.sessionKey,
        });
      }
      if (latest.status === "done") {
        return { kind: "ref", ref: this.#refOf(latest, idempotencyKey) };
      }
      if (latest.status === "failed") {
        throw dispatchFailedError(idempotencyKey, latest.error);
      }
      throw new WorkbenchError(
        "E_DISPATCH_IN_PROGRESS",
        "dispatch 预留已被回收，拒绝复用旧会话： " + idempotencyKey,
        { idempotencyKey },
      );
    }

    // reserved：另一个调用方正在跑 newSession；只有超 TTL 的预留才允许回收（C02）。
    if (this.#dispatches.reclaim(idempotencyKey, this.#dispatchTtlMs, new Date(this.#now()))) {
      return this.#retryOutcome(idempotencyKey);
    }
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
        return { kind: "ref", ref: this.#refOf(current, idempotencyKey) };
      }
      // 等待期间预留可能刚好过期：再抢一次，赢家继续 newSession
      if (this.#dispatches.reclaim(idempotencyKey, this.#dispatchTtlMs, new Date(this.#now()))) {
        return this.#retryOutcome(idempotencyKey);
      }
    }
    throw new WorkbenchError("E_DISPATCH_IN_PROGRESS", "dispatch 仍在进行中：" + idempotencyKey, { idempotencyKey });
  }

  /** 回收/重试赢家重新读取 claim token（reclaim 会换发；retryFailed 清空为 null）。 */
  #retryOutcome(idempotencyKey: string): { kind: "retry"; claimToken: string | null } {
    const record = this.#dispatches.get(idempotencyKey);
    if (record === null) {
      throw new WorkbenchError("E_ADAPTER_DOWN", "dispatch 的预留记录在回收后消失： " + idempotencyKey, {
        idempotencyKey,
      });
    }
    return { kind: "retry", claimToken: record.sessionKey };
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
  #dispatchFailed(
    idempotencyKey: string,
    where: string,
    err: unknown,
    claimToken?: string,
  ): WorkbenchError {
    const message = err instanceof Error ? err.message : String(err);
    const marked = this.#dispatches.fail(
      idempotencyKey,
      where + "：" + message,
      new Date(this.#now()),
      claimToken,
    );
    if (!marked) {
      return new WorkbenchError(
        "E_DISPATCH_IN_PROGRESS",
        "dispatch 预留已失效，失败未落库（" + where + "）： " + message,
        { idempotencyKey, cause: message },
      );
    }
    if (isWorkbenchError(err)) {
      return err;
    }
    return new WorkbenchError("E_ADAPTER_DOWN", "dispatch 新建会话失败（" + where + "）：" + message, {
      idempotencyKey,
      cause: message,
    });
  }

  /** C03：每一步审计（成功/失败都写；durationMs 由注入时钟测量）。审计失败绝不阻断主流程。 */
  #auditStep(
    actor: string,
    action: "handoff" | "handback" | "checkpoint" | "resume",
    ref: SessionRef,
    step: string,
    startedAt: number,
    outcome: "ok" | "error",
    errorCode: string | null,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      this.#audit?.record({
        actor,
        action,
        sessionKey: ref.key,
        outcome,
        errorCode,
        detail: {
          step,
          durationMs: Math.max(0, this.#now() - startedAt),
          ...(errorCode === null ? {} : { errorCode }),
          ...extra,
        },
      });
    } catch {
      // AuditStore.record 已内部吞异常；这里再兜一层，防止替代实现把审计故障传回业务
    }
  }

  #errorCodeOf(err: unknown): string {
    return isWorkbenchError(err) ? err.code : "E_INTERNAL";
  }

  /**
   * handoff 失败补偿（spec §7.3）：
   * - cancel / close：会话状态保持不变，租约仍在调用方；
   * - handoff（命令拼接）：控制通道已 close，会话置 `exited`，租约已由调用方释放。
   * 统一抛 503 `E_HANDOFF_FAILED`，details.step 指明失败步骤（action 留给审计提取层）。
   */
  #handoffFailed(
    ref: SessionRef,
    step: "cancel" | "close" | "handoff",
    err: unknown,
    extra: Record<string, unknown> = {},
  ): never {
    const message = err instanceof Error ? err.message : String(err);
    this.#appendError(ref, message, "handoff-" + step);
    if (step === "handoff") {
      this.#registry.updateStatus(ref.key, "exited");
    }
    throw new WorkbenchError("E_HANDOFF_FAILED", "handoff 失败（" + step + "）：" + ref.key + " — " + message, {
      sessionKey: ref.key,
      nativeId: ref.nativeId,
      step,
      action: step,
      cause: message,
      ...extra,
    });
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
  const colon = checkpoint.sessionKey.indexOf(":");
  const agent = colon > 0 ? checkpoint.sessionKey.slice(0, colon) : checkpoint.sessionKey;
  return [
    "---",
    "pi-workbench-checkpoint: " + String(checkpoint.version ?? CHECKPOINT_VERSION),
    "session: " + checkpoint.sessionKey,
    "created: " + checkpoint.createdAt,
    "cursor: " + JSON.stringify(checkpoint.transcriptCursor),
    "agent: " + agent,
    "---",
    "",
    "# 检查点",
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
