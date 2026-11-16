/**
 * CodexDriver（0.5-B B03）：把 codex-acp 作为 ACP v2 server 拉起，按原生 thread id 恢复。
 *
 * 关键口径（规格 §8 / §13）：
 * - resume：先 cancel 运行中的本进程会话并等 idle（默认 15s），再 session/resume(threadId)；
 *   quiesce 超时 → E_RESUME_REJECTED，不静默重试；
 * - handoff：只拼原生命令 ["codex","resume",id,"--no-alt-screen"]，mode=resume-tui，不执行；
 * - caps：按 capsOf("codex")，attach/permissions/background=false；
 * - transcript：ACP 新建会话拿不到 rollout 路径（§7.1 lazy resolve），transcriptPath 为空时
 *   see 返回空页 + pending:true；resume/newSession 后尽力解析一次 rollout 路径并缓存。
 *
 * 测试不依赖真实 codex：spawnAdapter / discoverSessions / readTranscript / resolveRolloutPath
 * 都可注入，进程级用例走 test/fixtures/fake-codex-acp-agent.mjs。
 */
import type { SessionCaps, SessionRef, UnifiedMessage } from "@pi-workbench/shared";
import type { CodexAcpSpawnOptions } from "../adapters/codex-acp.ts";
import { spawnCodexAcpAdapter } from "../adapters/codex-acp.ts";
import type { AdapterUpdate, AgentAdapter } from "../adapters/types.ts";
import { capsOf } from "../capabilities.ts";
import type { Config } from "../config.ts";
import { DEFAULT_CODEX_SESSIONS_ROOT, discoverCodexSessions } from "../discover/codex.ts";
import { isWorkbenchError, WorkbenchError } from "../errors.ts";
import { readTranscript } from "../transcript/index.ts";
import type { AgentDriver, DiscoverOptions, HandoffCommand, SeeResult } from "./types.ts";

export { DEFAULT_CODEX_SESSIONS_ROOT };

/** 运行中 resume 的 quiesce 窗口（规格 §8：cancel → idle 15s 超时判 E_RESUME_REJECTED） */
export const DEFAULT_QUIESCE_TIMEOUT_MS = 15_000;

/** 单回合默认上限：与 ClaudeAdapter 对齐，避免真实 Codex 长回合被过早判死 */
export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 120_000;

export type CodexDiscoveryOptions = {
  sessionsRoot: string;
  cwd?: string;
  limit?: number;
  sinceDays?: number;
};

export type CodexDiscovery = (opts: CodexDiscoveryOptions) => Promise<SessionRef[]>;

export type CodexTranscriptPage = {
  messages: UnifiedMessage[];
  nextCursor: string;
  pending: boolean;
  skipped?: number;
};

export type CodexTranscriptReader = (input: {
  agent: "codex";
  path: string;
  cursor: string;
  limit?: number;
}) => CodexTranscriptPage | Promise<CodexTranscriptPage>;

/** 写操作前置门禁：TakeoverEngine 负责租约身份，driver 只负责「拒绝时绝不发 ACP 请求」 */
export type CodexWriteAction = "inject" | "interrupt" | "resume" | "handoff" | "close";

export type CodexDriverOptions = {
  /** 覆盖 ACP 进程启动（测试注入假 adapter；默认 spawnCodexAcpAdapter） */
  spawnAdapter?: (config: Config, options: CodexAcpSpawnOptions) => Promise<AgentAdapter>;
  /** 覆盖发现（默认 T3 的 discoverCodexSessions） */
  discoverSessions?: CodexDiscovery;
  /** 覆盖 transcript 读取（默认 T4 的 readTranscript） */
  readTranscript?: CodexTranscriptReader;
  /** 按 thread id 尽力解析 rollout 文件（默认用发现层扫 sessionsRoot） */
  resolveRolloutPath?: (threadId: string, cwd: string) => Promise<string | undefined>;
  /** 写操作前置断言：传入时 inject/interrupt/resume/handoff/close 先过它 */
  authorizeWrite?: (ref: SessionRef, action: CodexWriteAction) => void;
  /** 测试可缩短 quiesce 窗口；生产保持 15s */
  quiesceTimeoutMs?: number;
  /** adapter 子进程 cwd；默认继承当前进程 */
  cwd?: string;
  /** rollout 扫描根；默认 ~/.codex/sessions */
  sessionsRoot?: string;
};

const TIMEOUT = Symbol("codex-driver-timeout");
type Timeout = typeof TIMEOUT;

export class CodexDriver implements AgentDriver {
  readonly agent = "codex";
  readonly caps: SessionCaps = capsOf("codex");

  readonly #config: Config;
  readonly #spawnAdapter: (config: Config, options: CodexAcpSpawnOptions) => Promise<AgentAdapter>;
  readonly #resolvePath: (threadId: string, cwd: string) => Promise<string | undefined>;
  readonly #authorizeWrite: ((ref: SessionRef, action: CodexWriteAction) => void) | undefined;
  readonly #sessionsRoot: string;
  readonly #quiesceTimeoutMs: number;
  readonly #cwd: string | undefined;
  readonly #listeners = new Set<(update: AdapterUpdate) => void>();
  readonly #activeSessions = new Set<string>();
  readonly #rolloutPaths = new Map<string, string>();

  #discoverSessions: CodexDiscovery;
  #readTranscript: CodexTranscriptReader;
  #adapter: AgentAdapter | null = null;
  #spawnPromise: Promise<AgentAdapter> | null = null;
  #adapterUnsubscribe: (() => void) | null = null;
  #disposed = false;

  constructor(config: Config, options: CodexDriverOptions = {}) {
    this.#config = config;
    this.#spawnAdapter = options.spawnAdapter ?? spawnCodexAcpAdapter;
    this.#discoverSessions = options.discoverSessions ?? discoverCodexSessions;
    this.#readTranscript = options.readTranscript ?? ((input) => readTranscript(input));
    this.#authorizeWrite = options.authorizeWrite;
    this.#sessionsRoot = options.sessionsRoot ?? DEFAULT_CODEX_SESSIONS_ROOT;
    this.#quiesceTimeoutMs = options.quiesceTimeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
    this.#cwd = options.cwd;
    this.#resolvePath =
      options.resolveRolloutPath ?? ((threadId, cwd) => this.#discoverRolloutPath(threadId, cwd));
  }

  async discover(opts: DiscoverOptions = {}): Promise<SessionRef[]> {
    this.#assertLive("discover");
    return await this.#discoverSessions({
      sessionsRoot: this.#sessionsRoot,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      sinceDays: 30,
    });
  }

  /** Codex 没有 attach 语义（caps.attach=false）：明确拒绝，不产生任何子进程调用 */
  async attach(_ref: SessionRef): Promise<void> {
    throw new WorkbenchError(
      "E_CAP_UNSUPPORTED",
      "Codex 不支持 attach（caps.attach=false）；请用 resume 或原生 handoff",
      { agent: "codex" },
    );
  }

  async see(ref: SessionRef, cursor: string, limit?: number): Promise<SeeResult> {
    const inline = ref.transcriptPath;
    let path = inline !== undefined && inline.trim().length > 0 ? inline : this.#rolloutPaths.get(ref.nativeId);
    if (path === undefined || path.trim().length === 0) {
      // 规格 §7.1 lazy resolve：ACP 新会话的 rollout 通常在 newSession 之后几秒才落盘，
      // 首次 see 时补解析一次；解析不到才返回 pending（不报错、不 spawn adapter）。
      try {
        await this.resolveTranscriptPath(ref);
      } catch {
        // 解析失败按「尚未落盘」处理
      }
      path = this.#rolloutPaths.get(ref.nativeId);
    }
    if (path === undefined || path.trim().length === 0) {
      return { messages: [], nextCursor: cursor, pending: true };
    }
    const page = await this.#readTranscript({
      agent: "codex",
      path,
      cursor,
      ...(limit === undefined ? {} : { limit }),
    });
    return { messages: page.messages, nextCursor: page.nextCursor, pending: page.pending };
  }

  async inject(ref: SessionRef, text: string): Promise<{ messageId: string; effective: "now" | "next_turn" }> {
    this.#assertLive("inject");
    this.#authorize(ref, "inject");
    const adapter = await this.#ensureAdapter();
    if (!this.#activeSessions.has(ref.nativeId)) {
      await adapter.resume(ref.nativeId, ref.cwd);
      this.#activeSessions.add(ref.nativeId);
      await this.resolveTranscriptPath(ref);
    }
    const { messageId } = await adapter.prompt(ref.nativeId, text);
    return { messageId, effective: ref.status === "running" ? "next_turn" : "now" };
  }

  async interrupt(ref: SessionRef): Promise<{ stopReason: string }> {
    this.#assertLive("interrupt");
    this.#authorize(ref, "interrupt");
    const adapter = await this.#ensureAdapter();
    return await adapter.cancel(ref.nativeId);
  }

  /**
   * 接管已存在会话：运行中先 cancel 等 idle（15s），再 ACP session/resume(threadId)。
   * 按规格 §8 的保守策略，只要 ref.status=running 就 quiesce；cancel 失败或超时
   * 一律 E_RESUME_REJECTED，不静默重试、不新建会话。
   */
  async resume(ref: SessionRef): Promise<void> {
    this.#assertLive("resume");
    this.#authorize(ref, "resume");
    const adapter = await this.#ensureAdapter();
    if (ref.status === "running") {
      await this.#quiesce(adapter, ref);
    }
    try {
      await adapter.resume(ref.nativeId, ref.cwd);
    } catch (error) {
      if (isWorkbenchError(error) && (error.code === "E_RESUME_REJECTED" || error.code === "E_ADAPTER_DOWN")) {
        throw error;
      }
      const reason = describeError(error);
      throw new WorkbenchError("E_RESUME_REJECTED", "Codex 恢复会话被拒：" + ref.nativeId, {
        threadId: ref.nativeId,
        cause: reason,
      });
    }
    this.#activeSessions.add(ref.nativeId);
    await this.resolveTranscriptPath(ref);
  }

  /** 原生 TUI 出口：只拼命令，不执行；adapter 起不来也照样能交给人 */
  async handoff(ref: SessionRef): Promise<HandoffCommand> {
    this.#authorize(ref, "handoff");
    return {
      command: ["codex", "resume", ref.nativeId, "--no-alt-screen"],
      mode: "resume-tui",
    };
  }

  onUpdate(cb: (update: AdapterUpdate) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#listeners.clear();
    this.#activeSessions.clear();
    this.#rolloutPaths.clear();
    if (this.#adapterUnsubscribe !== null) {
      this.#adapterUnsubscribe();
      this.#adapterUnsubscribe = null;
    }
    let adapter = this.#adapter;
    if (adapter === null && this.#spawnPromise !== null) {
      try {
        adapter = await this.#spawnPromise;
      } catch {
        adapter = null;
      }
    }
    this.#adapter = null;
    this.#spawnPromise = null;
    if (adapter !== null) {
      try {
        await adapter.dispose();
      } catch {
        // 释放失败不掩盖调用方的原始错误
      }
    }
  }

  // ---- 供 T8 / e2e 使用的扩展入口（不属于 AgentDriver 六方法，但同属 Codex 驱动能力） ----

  /** 让 T8 的 dispatch 路径能开 ACP 新会话；返回 codex 原生 thread id */
  async newSession(cwd: string): Promise<{ sessionId: string }> {
    this.#assertLive("newSession");
    const adapter = await this.#ensureAdapter();
    const { sessionId } = await adapter.newSession(cwd);
    this.#activeSessions.add(sessionId);
    await this.resolveTranscriptPath({
      key: "codex:" + sessionId,
      agent: "codex",
      nativeId: sessionId,
      cwd,
      status: "idle",
      driver: "pi",
      capabilities: this.caps,
      kind: "interactive",
    });
    return { sessionId };
  }

  async waitForTurn(ref: SessionRef, timeoutMs: number = DEFAULT_CODEX_TURN_TIMEOUT_MS): Promise<{ stopReason: string }> {
    this.#assertLive("waitForTurn");
    const adapter = await this.#ensureAdapter();
    if (adapter.waitForTurn === undefined) {
      return { stopReason: "unknown" };
    }
    return await adapter.waitForTurn(ref.nativeId, timeoutMs);
  }

  async close(ref: SessionRef): Promise<void> {
    this.#assertLive("close");
    this.#authorize(ref, "close");
    const adapter = await this.#ensureAdapter();
    await adapter.close(ref.nativeId);
    this.#activeSessions.delete(ref.nativeId);
  }

  /**
   * 尽力解析 rollout 路径：ref.transcriptPath 优先；否则按 thread id 查发现层一次并缓存。
   * 失败不抛（ACP 新会话可能还没落盘），see 会按 pending 处理。
   */
  async resolveTranscriptPath(ref: SessionRef): Promise<string | undefined> {
    const inline = ref.transcriptPath;
    if (inline !== undefined && inline.trim().length > 0) {
      return inline;
    }
    const cached = this.#rolloutPaths.get(ref.nativeId);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const resolved = await this.#resolvePath(ref.nativeId, ref.cwd);
      if (resolved !== undefined && resolved.trim().length > 0) {
        const path = resolved.trim();
        this.#rolloutPaths.set(ref.nativeId, path);
        return path;
      }
    } catch {
      // 发现层未就绪 / rollout 未落盘：按 pending 处理
    }
    return undefined;
  }

  // ---- private ----

  async #ensureAdapter(): Promise<AgentAdapter> {
    this.#assertLive("adapter");
    if (this.#adapter !== null) {
      // B08 S5：ACP 子进程退出后重建，而不是让 codex 永久 E_ADAPTER_DOWN 到 daemon 重启。
      if (this.#adapter.isAlive === undefined || this.#adapter.isAlive()) {
        return this.#adapter;
      }
      const dead = this.#adapter;
      this.#adapter = null;
      this.#adapterUnsubscribe?.();
      this.#adapterUnsubscribe = null;
      void dead.dispose().catch(() => undefined);
    }
    if (this.#spawnPromise === null) {
      this.#spawnPromise = this.#spawnAdapter(this.#config, {
        adapterCmd: this.#config.codex.adapterCmd,
        ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      }).then(
        (adapter) => {
          this.#adapter = adapter;
          this.#adapterUnsubscribe = adapter.onUpdate((update) => {
            this.#emit(update);
          });
          return adapter;
        },
        (error: unknown) => {
          this.#spawnPromise = null;
          throw agentUnavailable(error);
        },
      );
    }
    return await this.#spawnPromise;
  }

  async #quiesce(adapter: AgentAdapter, ref: SessionRef): Promise<void> {
    let outcome: { stopReason: string } | Timeout;
    try {
      outcome = await raceWithTimeout(adapter.cancel(ref.nativeId), this.#quiesceTimeoutMs);
    } catch (error) {
      if (isWorkbenchError(error) && error.code === "E_ADAPTER_DOWN") {
        throw error;
      }
      const reason = describeError(error);
      throw new WorkbenchError("E_RESUME_REJECTED", "Codex 运行中取消失败，拒绝 resume：" + reason, {
        threadId: ref.nativeId,
        cause: reason,
      });
    }
    if (outcome === TIMEOUT) {
      throw new WorkbenchError(
        "E_RESUME_REJECTED",
        "Codex 运行中 cancel 后 " + String(this.#quiesceTimeoutMs) + "ms 内未 idle，拒绝 resume",
        { threadId: ref.nativeId, timeoutMs: this.#quiesceTimeoutMs, reason: "quiesce_timeout" },
      );
    }
  }

  async #discoverRolloutPath(threadId: string, cwd: string): Promise<string | undefined> {
    const refs = await this.#discoverSessions({ sessionsRoot: this.#sessionsRoot, cwd, sinceDays: 30, limit: 1000 });
    const hit = refs.find((ref) => ref.nativeId === threadId || ref.key === "codex:" + threadId);
    return hit?.transcriptPath;
  }

  #authorize(ref: SessionRef, action: CodexWriteAction): void {
    this.#authorizeWrite?.(ref, action);
  }

  #emit(update: AdapterUpdate): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(update);
      } catch {
        // 单个监听器抛错不影响其它监听器与 adapter 生命周期
      }
    }
  }

  #assertLive(label: string): void {
    if (this.#disposed) {
      throw new WorkbenchError("E_ADAPTER_DOWN", "CodexDriver 已释放，无法执行 " + label, {
        reason: "disposed",
        label,
      });
    }
  }
}

function agentUnavailable(error: unknown): WorkbenchError {
  if (isWorkbenchError(error) && error.code === "E_AGENT_UNAVAILABLE") {
    return error;
  }
  const reason = describeError(error);
  return new WorkbenchError("E_AGENT_UNAVAILABLE", "E_AGENT_UNAVAILABLE: codex-acp 启动失败（" + reason + "）", {
    agent: "codex",
    reason,
  });
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | Timeout> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Timeout>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMEOUT);
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


