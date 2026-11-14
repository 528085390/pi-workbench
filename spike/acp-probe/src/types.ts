export type AgentName = "claude" | "codex";

export interface ProbeEvent {
  seq: number;
  ts: string;
  agent: AgentName;
  kind: string;
  sessionId?: string;
  data: unknown;
}

export interface ProbeSummary {
  agent: AgentName;
  flow: string;
  protocolVersion?: number;
  sessionId?: string;
  updates: number;
  text: string;
  idle: boolean;
  listed: string[];
  resumed: boolean;
  closed: boolean;
  error?: string;
}
