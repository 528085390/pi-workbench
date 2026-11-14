import type { ProbeEvent } from "./types.js";

export function summarizeUpdate(update: unknown): {
  kind: string;
  text?: string;
  state?: string;
  stopReason?: string;
  toolCallId?: string;
} {
  const u = update as Record<string, any>;
  const out: any = { kind: String(u?.sessionUpdate ?? "unknown") };
  const content = u?.content;
  if (content?.type === "text" && typeof content.text === "string") out.text = content.text;
  if (typeof u?.state === "string") out.state = u.state;
  if (typeof u?.stopReason === "string") out.stopReason = u.stopReason;
  if (typeof u?.toolCallId === "string") out.toolCallId = u.toolCallId;
  return out;
}

export function makeEvent(seq: number, agent: "claude" | "codex", kind: string, data: unknown): ProbeEvent {
  return { seq, ts: new Date().toISOString(), agent, kind, data };
}
