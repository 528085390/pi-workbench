/**
 * 子进程登记与退出治理（C04）。
 *
 * 规格：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §7.4。
 */
import { spawnSync } from "node:child_process";

import type { AgentName } from "@pi-workbench/shared";

import type { EventStore } from "./events.ts";
import type { LeaseManager } from "./lease.ts";
import type { SessionRegistry } from "./registry.ts";

export type ProcessInfo = {
  pid: number;
  label: string;
  startedAt: string;
  exited: boolean;
  agent?: AgentName;
  /** 该子进程归属的会话 key；Pi 每个会话一个 RPC 子进程。 */
  sessionKey?: string;
  /** Pi RPC 的 --session 文件路径；无法拿到 sessionKey 时用它匹配 SessionRef.transcriptPath。 */
  sessionPath?: string;
};

export type TrackedChild = {
  pid?: number;
  once(event: "exit", listener: () => void): unknown;
};

export type ProcessKill = (pid: number, signal: NodeJS.Signals) => unknown;
export type ProcessTreeKill = (pid: number, signal: NodeJS.Signals) => unknown;

export type ProcessRegistryOptions = {
  kill?: ProcessKill;
  killTree?: ProcessTreeKill;
  now?: () => number;
  onExit?: (info: ProcessInfo) => void;
  /** 已退出进程的历史上限；默认 100，避免长期运行无限增长。 */
  historyLimit?: number;
};

type Entry = {
  info: ProcessInfo;
  child: TrackedChild;
};

const DEFAULT_HISTORY_LIMIT = 100;
const TREE_KILL_TIMEOUT_MS = 1_000;
/** SIGKILL 之后的短暂等待上限：给内核投递信号 / 回收进程留时间，不让 killAll 立即返回。 */
const SIGKILL_SETTLE_MS = 200;

export class ProcessRegistry {
  readonly #entries = new Map<number, Entry>();
  readonly #history: ProcessInfo[] = [];
  readonly #historyLimit: number;
  readonly #kill: ProcessKill;
  readonly #killTree: ProcessTreeKill;
  readonly #now: () => number;
  #onExit: ((info: ProcessInfo) => void) | null;
  #shuttingDown = false;

  constructor(options: ProcessRegistryOptions = {}) {
    this.#kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.#killTree = options.killTree ?? options.kill ?? defaultTreeKill;
    this.#now = options.now ?? Date.now;
    this.#onExit = options.onExit ?? null;
    this.#historyLimit = positiveInteger(options.historyLimit ?? DEFAULT_HISTORY_LIMIT, "historyLimit");
  }

  setOnExit(handler: ((info: ProcessInfo) => void) | null): void {
    this.#onExit = handler;
  }

  /** shutdown 前调用：之后即使子进程 exit，也不再误发 E_ADAPTER_CRASHED。 */
  beginShutdown(): void {
    this.#shuttingDown = true;
  }

  track(child: TrackedChild, label: string, agent?: AgentName, sessionKey?: string, sessionPath?: string): void {
    const pid = child.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return;
    }
    const previous = this.#entries.get(pid);
    if (previous !== undefined) {
      this.#retire(previous, false);
    }
    const info: ProcessInfo = {
      pid,
      label,
      startedAt: new Date(this.#now()).toISOString(),
      exited: false,
      ...(agent === undefined ? {} : { agent }),
      ...(sessionKey === undefined ? {} : { sessionKey }),
      ...(sessionPath === undefined ? {} : { sessionPath }),
    };
    this.#entries.set(pid, { info, child });
    try {
      child.once("exit", () => {
        this.#markExited(pid);
      });
    } catch {
      // child 已退出时可能不再接受监听；killAll 会兜底。
    }
  }

  list(): ProcessInfo[] {
    const active = [...this.#entries.values()].map((entry) => ({ ...entry.info }));
    return active.concat(this.#history.map((info) => ({ ...info })));
  }

  async killAll(timeoutMs: number): Promise<void> {
    this.beginShutdown();
    const live = [...this.#entries.values()].filter((entry) => !entry.info.exited);
    if (live.length === 0) {
      return;
    }
    // 先固定「原始存活」的 pid：父进程可能被 SIGTERM 杀掉并触发 exit → 从 #entries 退休，
    // 但它派生的孙进程可能仍在同一进程组里；超时后的 SIGKILL 必须按这份快照发，不能只看当前 #entries。
    const originallyLive = live.map((entry) => entry.info.pid);
    for (const entry of live) {
      this.#signalTree(entry, "SIGTERM");
    }
    await this.#waitForExit(originallyLive, timeoutMs);
    for (const entry of live) {
      this.#forceKillGroup(entry);
    }
    // 有界等待，确保 SIGKILL 已投递/进程组已消失后再返回（daemon 随后会自行退出）。
    await delay(SIGKILL_SETTLE_MS);
  }

  /**
   * 超时兜底：无论父进程是否已经退出，都对它原始 pid 的进程组补 SIGKILL。
   * POSIX defaultTreeKill 走 kill(-pid)；Windows 走 taskkill /PID <pid> /T /F。
   * 进程组已消失（ESRCH）/ taskkill 失败 / 无权限一律忽略：shutdown 不能因一个死 pid 抛错。
   * notify=false，绝不向已经退休的进程补发 onExit。
   */
  #forceKillGroup(entry: Entry): void {
    try {
      const result = this.#killTree(entry.info.pid, "SIGKILL");
      if (result === false) {
        this.#signalDirectQuietly(entry.info.pid);
      }
    } catch {
      this.#signalDirectQuietly(entry.info.pid);
    }
    this.#retire(entry, false);
  }

  #signalDirectQuietly(pid: number): void {
    try {
      this.#kill(pid, "SIGKILL");
    } catch {
      // 进程已不存在 / 无权限：killAll 已在 shutdown，忽略。
    }
  }

  #signalTree(entry: Entry, signal: NodeJS.Signals): void {
    try {
      const result = this.#killTree(entry.info.pid, signal);
      if (result === false) {
        this.#signalDirect(entry, signal);
      }
      if (signal === "SIGKILL") {
        this.#retire(entry, false);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        this.#markExited(entry.info.pid);
        return;
      }
      // taskkill 不可用时退回直接 kill。
      this.#signalDirect(entry, signal);
      if (signal === "SIGKILL") {
        this.#retire(entry, false);
      }
    }
  }

  #signalDirect(entry: Entry, signal: NodeJS.Signals): void {
    try {
      this.#kill(entry.info.pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        this.#markExited(entry.info.pid);
      }
    }
  }

  #markExited(pid: number): void {
    const entry = this.#entries.get(pid);
    if (entry === undefined || entry.info.exited) {
      return;
    }
    this.#retire(entry, true);
  }

  #retire(entry: Entry, notify: boolean): void {
    if (entry.info.exited) {
      return;
    }
    entry.info.exited = true;
    this.#entries.delete(entry.info.pid);
    this.#history.push({ ...entry.info });
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit);
    }
    if (!notify || this.#shuttingDown || this.#onExit === null) {
      return;
    }
    try {
      this.#onExit({ ...entry.info });
    } catch (err) {
      process.stderr.write("[pi-workbench] 子进程退出回调失败（已忽略）：" + String(err) + "\n");
    }
  }

  async #waitForExit(pids: readonly number[], timeoutMs: number): Promise<void> {
    const budget = Number.isFinite(timeoutMs) ? Math.max(0, Math.trunc(timeoutMs)) : 0;
    const deadline = this.#now() + budget;
    const wallDeadline = Date.now() + budget + 100;
    while (this.#now() < deadline && Date.now() < wallDeadline) {
      const stillRunning = pids.some((pid) => {
        const entry = this.#entries.get(pid);
        return entry !== undefined && !entry.info.exited;
      });
      if (!stillRunning) {
        return;
      }
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(10, Math.max(1, remaining)));
      });
    }
  }
}

export type DriverExitDeps = {
  agent: AgentName;
  sessions: Pick<SessionRegistry, "list" | "updateStatus">;
  events: Pick<EventStore, "append">;
  leases: Pick<LeaseManager, "current" | "release">;
};

export function createDriverExitHandler(deps: DriverExitDeps): (info: ProcessInfo) => void {
  return (info: ProcessInfo): void => {
    const running = deps.sessions.list({ agent: deps.agent, status: "running" });
    const owned = info.sessionKey !== undefined
      ? running.filter((session) => session.key === info.sessionKey)
      : info.sessionPath !== undefined
        ? running.filter((session) => session.transcriptPath === info.sessionPath)
        : running;
    for (const session of owned) {
      try {
        deps.events.append({
          sessionKey: session.key,
          type: "error",
          payload: {
            code: "E_ADAPTER_CRASHED",
            message: "adapter 子进程异常退出（pid " + String(info.pid) + "，" + info.label + "）",
            pid: info.pid,
            label: info.label,
          },
          source: deps.agent,
          idempotencyKey: "adapter-crashed:" + String(info.pid) + ":" + session.key + ":" + info.startedAt,
        });
      } catch {
        // 事件写失败不阻断租约释放与状态收尾。
      }
      const lease = deps.leases.current(session.key);
      if (lease !== null && lease.driver !== "human") {
        try {
          deps.leases.release(session.key, lease.clientId);
        } catch {
          // 已释放 / 过期：继续置 exited。
        }
      }
      try {
        deps.sessions.updateStatus(session.key, "exited");
      } catch {
        // 未知 key 等边界由 SessionRegistry 自行处理。
      }
    }
  };
}

function defaultTreeKill(pid: number, signal: NodeJS.Signals): unknown {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const result = spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore", timeout: TREE_KILL_TIMEOUT_MS });
    if (result.error !== undefined || (result.status !== 0 && result.status !== 128)) {
      return process.kill(pid, signal);
    }
    return true;
  }
  // POSIX：子进程以 detached:true 启动，pid 即进程组组长，负 pid 一次杀整组；
  // 老调用方/测试里未分组的子进程退回直接杀，避免 kill(-pid) 的 ESRCH 变成静默失败。
  try {
    return process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    return process.kill(pid, signal);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("ProcessRegistry: " + name + " 必须是正整数");
  }
  return value;
}
