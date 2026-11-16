/**
 * 子进程登记与退出治理（C04）。
 *
 * 规格：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §7.4。
 */
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
};

export type TrackedChild = {
  pid?: number;
  once(event: "exit", listener: () => void): unknown;
};

export type ProcessKill = (pid: number, signal: NodeJS.Signals) => unknown;

export type ProcessRegistryOptions = {
  kill?: ProcessKill;
  now?: () => number;
  onExit?: (info: ProcessInfo) => void;
};

type Entry = {
  info: ProcessInfo;
  child: TrackedChild;
};

export class ProcessRegistry {
  readonly #entries = new Map<number, Entry>();
  readonly #kill: ProcessKill;
  readonly #now: () => number;
  #onExit: ((info: ProcessInfo) => void) | null;

  constructor(options: ProcessRegistryOptions = {}) {
    this.#kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.#now = options.now ?? Date.now;
    this.#onExit = options.onExit ?? null;
  }

  setOnExit(handler: ((info: ProcessInfo) => void) | null): void {
    this.#onExit = handler;
  }

  track(child: TrackedChild, label: string, agent?: AgentName): void {
    const pid = child.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return;
    }
    const info: ProcessInfo = {
      pid,
      label,
      startedAt: new Date(this.#now()).toISOString(),
      exited: false,
      ...(agent === undefined ? {} : { agent }),
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
    return [...this.#entries.values()].map((entry) => ({ ...entry.info }));
  }

  async killAll(timeoutMs: number): Promise<void> {
    const live = [...this.#entries.values()].filter((entry) => !entry.info.exited);
    if (live.length === 0) {
      return;
    }
    for (const entry of live) {
      this.#signal(entry, "SIGTERM");
    }
    await this.#waitForExit(
      live.map((entry) => entry.info.pid),
      timeoutMs,
    );
    for (const entry of live) {
      if (entry.info.exited) {
        continue;
      }
      this.#signal(entry, "SIGKILL");
    }
  }

  #signal(entry: Entry, signal: NodeJS.Signals): void {
    try {
      const result = this.#kill(entry.info.pid, signal);
      if (result !== false && signal === "SIGKILL") {
        entry.info.exited = true;
      }
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
    entry.info.exited = true;
    const snapshot: ProcessInfo = { ...entry.info };
    try {
      this.#onExit?.(snapshot);
    } catch (err) {
      process.stderr.write("[pi-workbench] 子进程退出回调失败（已忽略）：" + String(err) + "\n");
    }
  }

  async #waitForExit(pids: readonly number[], timeoutMs: number): Promise<void> {
    const budget = Number.isFinite(timeoutMs) ? Math.max(0, Math.trunc(timeoutMs)) : 0;
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      const stillRunning = pids.some((pid) => {
        const entry = this.#entries.get(pid);
        return entry !== undefined && !entry.info.exited;
      });
      if (!stillRunning) {
        return;
      }
      const remaining = deadline - Date.now();
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
    for (const session of running) {
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
