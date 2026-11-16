/**
 * Codex rollout transcript 解析器（0.5-B B05-a / T4）。
 *
 * 映射表见 spec §10.3；实测枚举见 docs/evidence/phase-0.5b/codex-records.md。
 * 游标是 UTF-8 字节偏移，语义与 readClaudeTranscript 一致：
 * - 只消费完整行（末尾半行留到下次）；
 * - 坏行/未知 type 跳过并计入 skipped，不抛；
 * - 文件缺失/为空返回 pending 空页。
 */
import type { UnifiedMessage } from "@pi-workbench/shared";

import { asString, isJsonObject, readJsonlPage, stringifyUnknown } from "./jsonl.ts";

/** 单次读取默认上限（条消息，不是行） */
export const DEFAULT_CODEX_TRANSCRIPT_LIMIT = 200;

const DEDUPE_SEP = "\u0000";

/** 一次增量读取的结果；nextCursor 可直接作为下次的 cursor */
export type CodexTranscriptPage = {
  messages: UnifiedMessage[];
  nextCursor: string;
  pending: boolean;
  /** 本次消费但未产出消息的行数（噪声/未知/坏行/developer） */
  skipped: number;
};

type LineState = {
  sessionTimestamp: string;
  /** assistant 文本的去重键（turn_id + 文本），用于 message 与 agent_message 双写去重 */
  assistantKeys: Set<string>;
};

type LineResult = {
  messages: UnifiedMessage[];
  skipped: number;
};

/**
 * 从 cursor（字节偏移）起增量读 Codex rollout。
 * - 文件不存在 / 为空 → { messages: [], nextCursor: "0", pending: true, skipped: 0 }
 * - 没有新数据 → 空页，nextCursor 保持传入值（文件被截断时回退到 0 重读）
 * - 未知 type / 坏行只跳过计数，不抛
 */
export function readCodexTranscript(
  jsonlPath: string,
  cursor: string,
  limit: number = DEFAULT_CODEX_TRANSCRIPT_LIMIT,
): CodexTranscriptPage {
  return readJsonlPage({
    path: jsonlPath,
    cursor,
    limit,
    defaultLimit: DEFAULT_CODEX_TRANSCRIPT_LIMIT,
    noticePrefix: "codex",
    createState: (): LineState => ({ sessionTimestamp: "", assistantKeys: new Set<string>() }),
    normalizeLine,
  });
}

/** 一行 JSONL → 0..n 条 UnifiedMessage + skipped 计数 */
function normalizeLine(record: unknown, lineNumber: number, state: LineState): LineResult {
  if (!isJsonObject(record)) {
    return { messages: [], skipped: 1 }; // 坏行：跳过，不影响后续
  }
  const parsed = record;

  const type = asString(parsed.type);
  const payload = isJsonObject(parsed.payload) ? parsed.payload : undefined;

  if (type === "session_meta") {
    const metaTs = payload === undefined ? undefined : asString(payload.timestamp);
    if (metaTs !== undefined && metaTs.length > 0) {
      state.sessionTimestamp = metaTs;
    }
    return { messages: [], skipped: 0 }; // 元数据只供发现层/时间戳回退，不发消息
  }

  if (type !== "response_item" || payload === undefined) {
    return { messages: [], skipped: 1 };
  }

  const ts =
    asString(parsed.timestamp) ?? asString(payload.timestamp) ?? state.sessionTimestamp ?? "";
  const payloadType = asString(payload.type);

  switch (payloadType) {
    case "message":
      return normalizeMessage(payload, ts, lineNumber, state);
    case "agent_message":
      return normalizeAgentMessage(payload, ts, lineNumber, state);
    case "reasoning":
      return normalizeReasoning(payload, ts, lineNumber);
    case "function_call":
    case "custom_tool_call":
      return normalizeToolCall(payload, ts, lineNumber);
    case "function_call_output":
    case "custom_tool_call_output":
      return normalizeToolResult(payload, ts, lineNumber);
    default:
      return { messages: [], skipped: 1 }; // 未知 payload.type：跳过计数，不抛
  }
}

function normalizeMessage(
  payload: Record<string, unknown>,
  ts: string,
  lineNumber: number,
  state: LineState,
): LineResult {
  const role = asString(payload.role);
  if (role === "developer") {
    return { messages: [], skipped: 1 }; // 系统提示词，不是对话
  }
  if (role !== "user" && role !== "assistant") {
    return { messages: [], skipped: 1 };
  }

  const texts = extractTexts(payload.content, role === "user" ? ["input_text", "text"] : ["output_text", "text"]);
  if (texts.length === 0) {
    return { messages: [], skipped: 1 };
  }

  const baseId = asString(payload.id) ?? "line-" + lineNumber;
  const messages = texts.map((text, index): UnifiedMessage => ({
    id: baseId + ":" + index,
    role,
    kind: "text",
    text,
    ts,
  }));

  if (role === "assistant") {
    const turnId = readTurnId(payload);
    for (const text of texts) {
      state.assistantKeys.add(turnId + DEDUPE_SEP + text);
    }
  }
  return { messages, skipped: 0 };
}

/** agent_message 实测会和 message(role=assistant) 同轮双写：按 turn_id + 文本去重 */
function normalizeAgentMessage(
  payload: Record<string, unknown>,
  ts: string,
  lineNumber: number,
  state: LineState,
): LineResult {
  const texts = extractTexts(payload.content, ["input_text", "output_text", "text"]);
  if (texts.length === 0) {
    return { messages: [], skipped: 1 };
  }
  const turnId = readTurnId(payload);
  const fresh = texts.filter((text) => !state.assistantKeys.has(turnId + DEDUPE_SEP + text));
  if (fresh.length === 0) {
    return { messages: [], skipped: 1 };
  }

  const baseId = asString(payload.id) ?? "line-" + lineNumber;
  const messages = fresh.map((text, index): UnifiedMessage => ({
    id: baseId + ":" + index,
    role: "assistant",
    kind: "text",
    text,
    ts,
  }));
  return { messages, skipped: 0 };
}

function normalizeReasoning(
  payload: Record<string, unknown>,
  ts: string,
  lineNumber: number,
): LineResult {
  // 实测 summary[] 是主载体；兼容规格写的 content[]（两者都可能出现 summary_text）
  const items = Array.isArray(payload.summary)
    ? payload.summary
    : Array.isArray(payload.content)
      ? payload.content
      : [];
  const texts = extractTexts(items, ["summary_text", "text"]);
  if (texts.length === 0) {
    return { messages: [], skipped: 1 };
  }
  const baseId = asString(payload.id) ?? "line-" + lineNumber;
  const messages = texts.map((text, index): UnifiedMessage => ({
    id: baseId + ":" + index,
    role: "assistant",
    kind: "thinking",
    text,
    ts,
  }));
  return { messages, skipped: 0 };
}

function normalizeToolCall(
  payload: Record<string, unknown>,
  ts: string,
  lineNumber: number,
): LineResult {
  const toolName = asString(payload.name);
  const text = stringifyUnknown(payload.arguments ?? payload.input);
  if (toolName === undefined && text.length === 0) {
    return { messages: [], skipped: 1 };
  }
  const id = asString(payload.id) ?? asString(payload.call_id) ?? "line-" + lineNumber;
  const message: UnifiedMessage = { id, role: "assistant", kind: "tool_call", text, ts };
  if (toolName !== undefined) {
    message.toolName = toolName;
  }
  return { messages: [message], skipped: 0 };
}

function normalizeToolResult(
  payload: Record<string, unknown>,
  ts: string,
  lineNumber: number,
): LineResult {
  if (payload.output === undefined) {
    return { messages: [], skipped: 1 };
  }
  const id = asString(payload.id) ?? asString(payload.call_id) ?? "line-" + lineNumber;
  return {
    messages: [{ id, role: "user", kind: "tool_result", text: flattenOutput(payload.output), ts }],
    skipped: 0,
  };
}

function readTurnId(payload: Record<string, unknown>): string {
  const meta = isJsonObject(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : undefined;
  return asString(meta?.turn_id) ?? asString(payload.turn_id) ?? "";
}

/** 按块类型抽文本；content 也可能是裸字符串 */
function extractTexts(content: unknown, allowed: string[]): string[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!isJsonObject(block)) {
      continue;
    }
    const blockType = asString(block.type);
    if (blockType !== undefined && blockType !== "text" && !allowed.includes(blockType)) {
      continue;
    }
    const text = asString(block.text);
    if (text !== undefined && text.length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

function flattenOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (isJsonObject(item)) {
          return asString(item.text) ?? stringifyUnknown(item);
        }
        return stringifyUnknown(item);
      })
      .join("\n");
  }
  return stringifyUnknown(output);
}
