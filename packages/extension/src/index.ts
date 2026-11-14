import type { AgentName, SessionCaps, SessionRef } from "@pi-workbench/shared";

/**
 * Pi 扩展入口（Phase 0.5-A 的 A09 才接 cp_* 工具）。
 *
 * 这里只放薄层占位：真正的控制面逻辑在 packages/control-plane，
 * 扩展只负责把 Pi LLM 的工具调用转发到 daemon 的 /api/cp/*。
 */

/** A09 要注册给 Pi LLM 的工具名（实现前不注册，避免 LLM 调到不存在的能力）。 */
export const WORKBENCH_TOOL_NAMES = [
  "cp_dispatch",
  "cp_sessions",
  "cp_see",
  "cp_inject",
  "cp_interrupt",
  "cp_handoff",
  "cp_checkpoint",
] as const;

export interface WorkbenchClientOptions {
  baseUrl?: string;
  token?: string;
}

export interface WorkbenchApi {
  sessions(): Promise<SessionRef[]>;
  agents(): Promise<Array<{ agent: AgentName; capabilities: SessionCaps }>>;
}

/** 与 daemon 的 HTTP 契约（A09 用）。 */
export function createWorkbenchClient(options: WorkbenchClientOptions = {}): WorkbenchApi {
  const baseUrl = options.baseUrl ?? process.env.PI_WORKBENCH_URL ?? "http://127.0.0.1:7331";
  const headers: Record<string, string> = options.token ? { authorization: `Bearer ${options.token}` } : {};

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(new URL(path, baseUrl), { headers });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    sessions: () => get<SessionRef[]>("/api/cp/sessions"),
    agents: () => get<Array<{ agent: AgentName; capabilities: SessionCaps }>>("/api/cp/agents"),
  };
}
