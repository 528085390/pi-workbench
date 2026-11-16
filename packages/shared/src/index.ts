/**
 * 共享类型：控制面的最小公共契约。
 * 字段口径见 docs/PRD.md §3.0 与 docs/agent-control-plane-v0.3.md §5.2。
 */

export const WORKBENCH_VERSION = "0.0.1";

/** 控制面默认端口（PRD FR-5.3） */
export const DEFAULT_PORT = 7331;

export type AgentName = "pi" | "claude" | "codex" | "dsh" | (string & {});

export type SessionStatus =
  | "starting"
  | "running"
  | "needs-input"
  | "idle"
  | "handoff"
  | "exited"
  | "unknown";

export type Driver = "pi" | "human" | "none";

/** 统一消息模型（Phase 0.5-B D4：从 transcript/claude.ts 上移，三解析器共用） */
export type UnifiedRole = "user" | "assistant" | "system";
export type UnifiedKind = "text" | "thinking" | "tool_call" | "tool_result" | "notice";
export interface UnifiedMessage {
  id: string;
  role: UnifiedRole;
  kind: UnifiedKind;
  text: string;
  ts: string;
  toolName?: string;
}

/**
 * 能力矩阵按实测声明，未实现的能力不注册工具、不显示按钮（PRD FR-0.6）。
 * attach 与 resume 必须分开：Claude 的 ACP 会话 attach=false、resume=true。
 */
export interface SessionCaps {
  stream: boolean;
  inject: boolean;
  interrupt: boolean;
  attach: boolean;
  resume: boolean;
  transcript: boolean;
  permissions: boolean;
  background?: boolean;
}

export interface SessionRef {
  /** 全局唯一：`${agent}:${nativeId}` */
  key: string;
  agent: AgentName;
  nativeId: string;
  /** Claude 的原生 sessionId 与 ACP sessionId 一致；Codex 为 thread id */
  acpSessionId?: string;
  cwd: string;
  transcriptPath?: string;
  status: SessionStatus;
  driver: Driver;
  capabilities: SessionCaps;
  /** ACP 会话为 interactive；claude --bg 为 background。决定 handoff 出口。 */
  kind?: "interactive" | "background" | "unknown";
  lineage?: { parent?: string; forkedFrom?: string };
}

export type SessionEventType =
  | "token"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "permission_request"
  | "plan"
  | "state_update"
  | "session_status"
  | "needs_input"
  | "lease_changed"
  | "error"
  | "notice";

export interface SessionEvent {
  seq: number;
  sessionKey: string;
  type: SessionEventType;
  payload: unknown;
  source: AgentName;
  ts: string;
  idempotencyKey: string;
}

export interface Lease {
  sessionKey: string;
  driver: Driver;
  clientId: string;
  /** 租约归属的 daemon 实例 id（schema v4 `leases.instance_id`；空串 = 历史 / 未归属）。 */
  instanceId: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface Checkpoint {
  sessionKey: string;
  summary: string;
  touchedFiles: string[];
  nextStep: string;
  transcriptCursor: string;
  createdAt: string;
}
