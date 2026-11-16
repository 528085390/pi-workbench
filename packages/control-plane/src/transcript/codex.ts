/**
 * Codex rollout transcript 解析器（0.5-B B05-a / T4）。
 *
 * 映射表见 spec §10.3；实测枚举见 docs/evidence/phase-0.5b/codex-records.md。
 * 游标是 UTF-8 字节偏移，语义与 readClaudeTranscript 一致：
 * - 只消费完整行（末尾半行留到下次）；
 * - 坏行/未知 type 跳过并计入 skipped，不抛；
 * - 文件缺失/为空返回 pending 空页。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type { UnifiedMessage } from "@pi-workbench/shared";

/** 单次读取默认上限（条消息，不是行） */
export const DEFAULT_CODEX_TRANSCRIPT_LIMIT = 200;

const NEWLINE = 0x0a;
const CURSOR_ZERO = "0";
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
  const start = parseCursor(cursor);
  const maxMessages = normalizeLimit(limit);

  let fd: number;
  try {
    fd = openSync(jsonlPath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyPage(CURSOR_ZERO);
    }
    throw err;
  }

  try {
    const size = fstatSync(fd).size;
    if (size === 0) {
      return emptyPage(CURSOR_ZERO);
    }
    // 游标越过文件末尾说明文件被截断/轮转，回退到 0 重新读，并给出 notice（规格 §10.4）
    const reset = start > size;
    const from = reset ? 0 : start;
    if (from === size) {
      return emptyPage(String(from));
    }

    const chunk = readBytes(fd, from, size - from);
    const messages: UnifiedMessage[] = [];
    if (reset) {
      messages.push({
        id: "codex:cursor-reset:" + String(start),
        kind: "notice",
        role: "system",
        text: "transcript 文件比游标短（可能被截断或轮转），已从头重读",
        ts: new Date().toISOString(),
      });
    }
    const state: LineState = { sessionTimestamp: "", assistantKeys: new Set<string>() };
    let consumed = 0;
    let pos = 0;
    let lineNumber = 0;
    let skipped = 0;

    while (pos < chunk.length && messages.length < maxMessages) {
      const newlineAt = chunk.indexOf(NEWLINE, pos);
      if (newlineAt === -1) {
        break; // 末尾半行：不消费，游标停在这里
      }
      const raw = chunk.subarray(pos, newlineAt).toString("utf8");
      consumed = newlineAt + 1;
      pos = newlineAt + 1;
      lineNumber += 1;

      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.trim().length === 0) {
        continue;
      }
      const result = normalizeLine(line, lineNumber, state);
      messages.push(...result.messages);
      skipped += result.skipped;
    }

    return {
      messages,
      nextCursor: String(from + consumed),
      pending: messages.length === 0,
      skipped,
    };
  } finally {
    closeSync(fd);
  }
}

/** 一行 JSONL → 0..n 条 UnifiedMessage + skipped 计数 */
function normalizeLine(line: string, lineNumber: number, state: LineState): LineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { messages: [], skipped: 1 }; // 坏行：跳过，不影响后续
  }
  if (!isJsonObject(parsed)) {
    return { messages: [], skipped: 1 };
  }

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

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** 按字节读完 [from, from+length)；read 可能短读，循环补齐 */
function readBytes(fd: number, from: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, from + read);
    if (n <= 0) {
      break;
    }
    read += n;
  }
  return buffer.subarray(0, read);
}

function emptyPage(nextCursor: string): CodexTranscriptPage {
  return { messages: [], nextCursor, pending: true, skipped: 0 };
}

function parseCursor(cursor: string): number {
  const value = Number(cursor);
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

function normalizeLimit(limit: number): number {
  if (limit === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (!Number.isFinite(limit)) {
    return DEFAULT_CODEX_TRANSCRIPT_LIMIT;
  }
  return Math.max(0, Math.trunc(limit));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
