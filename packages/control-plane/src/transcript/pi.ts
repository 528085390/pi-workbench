/**
 * Pi session transcript 解析器（0.5-B B05-b / T7）。
 *
 * 映射表见 spec §10.3，实测枚举见 docs/evidence/phase-0.5b/pi-records.md：
 * - 首行 `type=session` 只提供元数据（timestamp 作为缺省 ts），不发消息；
 * - `type=message` 按 `message.role` 分派：user → text、assistant → content block
 *   拆分（text / thinking / toolCall）、toolResult → tool_result、system → 跳过；
 * - thinking_level_change / model_change / custom_message / 未知 type → 跳过计数，不抛；
 * - 游标是 UTF-8 字节偏移，语义与 readCodexTranscript 一致：只消费完整行，
 *   坏行跳过，文件缺失 / 为空返回 pending 空页。
 *
 * 注：UnifiedMessage 没有 toolCallId / isError 字段；Pi toolResult 的这两个
 * 源字段保留在运行时对象的附加属性上（PiToolResultMessage），统一契约不变。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type { UnifiedMessage } from "@pi-workbench/shared";

/** 单次读取默认上限（条消息，不是行） */
export const DEFAULT_PI_TRANSCRIPT_LIMIT = 200;

const NEWLINE = 0x0a;
const CURSOR_ZERO = "0";

/** 一次增量读取的结果；nextCursor 可直接作为下次的 cursor */
export type PiTranscriptPage = {
  messages: UnifiedMessage[];
  nextCursor: string;
  pending: boolean;
  /** 本次消费但未产出消息的行数（system / 噪声 / 未知 / 坏行） */
  skipped: number;
};

/** Pi toolResult 的附加元数据；统一契约未定义这两个字段，仅运行时保留 */
export type PiToolResultMessage = UnifiedMessage & {
  toolCallId?: string;
  isError?: boolean;
};

type LineState = {
  /** 首行 session.timestamp，作为记录/消息自身没有时间戳时的回退 */
  sessionTimestamp: string;
};

type LineResult = {
  messages: UnifiedMessage[];
  skipped: number;
};

/**
 * 从 cursor（字节偏移）起增量读 Pi session transcript。
 * - 文件不存在 / 为空 → { messages: [], nextCursor: "0", pending: true, skipped: 0 }
 * - 没有新数据 → 空页，nextCursor 保持传入值（文件被截断时回退到 0 重读）
 * - 未知 type / 坏行只跳过计数，不抛
 */
export function readPiTranscript(
  jsonlPath: string,
  cursor: string,
  limit: number = DEFAULT_PI_TRANSCRIPT_LIMIT,
): PiTranscriptPage {
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
        id: "pi:cursor-reset:" + String(start),
        kind: "notice",
        role: "system",
        text: "transcript 文件比游标短（可能被截断或轮转），已从头重读",
        ts: new Date().toISOString(),
      });
    }
    const state: LineState = { sessionTimestamp: "" };
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
  if (type === "session") {
    const metaTs = asString(parsed.timestamp);
    if (metaTs !== undefined && metaTs.length > 0) {
      state.sessionTimestamp = metaTs;
    }
    return { messages: [], skipped: 0 }; // 首行元数据，不发消息
  }

  if (type !== "message") {
    // model_change / thinking_level_change / custom_message / 未来未知 type
    return { messages: [], skipped: 1 };
  }

  const message = isJsonObject(parsed.message) ? parsed.message : undefined;
  if (message === undefined) {
    return { messages: [], skipped: 1 };
  }

  const ts = readTimestamp(parsed, message, state);

  switch (asString(message.role)) {
    case "user":
      return normalizeUser(message, ts, lineNumber);
    case "assistant":
      return normalizeAssistant(message, ts, lineNumber);
    case "toolResult":
      return normalizeToolResult(message, ts, lineNumber);
    case "system":
      return { messages: [], skipped: 1 }; // 系统提示词，不是对话
    default:
      return { messages: [], skipped: 1 };
  }
}

function normalizeUser(
  message: Record<string, unknown>,
  ts: string,
  lineNumber: number,
): LineResult {
  const texts = extractTexts(message.content);
  if (texts.length === 0) {
    return { messages: [], skipped: 1 };
  }
  const baseId = asString(message.id) ?? "line-" + lineNumber;
  return {
    messages: texts.map((text, index): UnifiedMessage => ({
      id: baseId + ":" + index,
      role: "user",
      kind: "text",
      text,
      ts,
    })),
    skipped: 0,
  };
}

/** assistant content[] 内嵌 text / thinking / toolCall，按块拆分 */
function normalizeAssistant(
  message: Record<string, unknown>,
  ts: string,
  lineNumber: number,
): LineResult {
  const baseId = asString(message.id) ?? "line-" + lineNumber;

  if (typeof message.content === "string") {
    return message.content.length === 0
      ? { messages: [], skipped: 1 }
      : {
          messages: [{ id: baseId + ":0", role: "assistant", kind: "text", text: message.content, ts }],
          skipped: 0,
        };
  }
  if (!Array.isArray(message.content)) {
    return { messages: [], skipped: 1 };
  }

  const messages: UnifiedMessage[] = [];
  message.content.forEach((block, index) => {
    if (!isJsonObject(block)) {
      return;
    }
    const blockType = asString(block.type);
    if (blockType === "text") {
      const text = asString(block.text);
      if (text !== undefined && text.length > 0) {
        messages.push({ id: baseId + ":" + index, role: "assistant", kind: "text", text, ts });
      }
      return;
    }
    if (blockType === "thinking") {
      const text = asString(block.thinking) ?? asString(block.text);
      if (text !== undefined && text.length > 0) {
        messages.push({ id: baseId + ":" + index, role: "assistant", kind: "thinking", text, ts });
      }
      return;
    }
    if (blockType === "toolCall") {
      const toolName = asString(block.name);
      const callId = asString(block.id);
      const toolMessage: UnifiedMessage = {
        id: callId ?? baseId + ":" + index,
        role: "assistant",
        kind: "tool_call",
        text: stringifyUnknown(block.arguments),
        ts,
      };
      if (toolName !== undefined) {
        toolMessage.toolName = toolName;
      }
      messages.push(toolMessage);
    }
    // 未知 block type：跳过该块；整条没有任何可映射块时下面计 skipped
  });

  if (messages.length === 0) {
    return { messages: [], skipped: 1 }; // 例如 402 错误回合的 content: []
  }
  return { messages, skipped: 0 };
}

/** toolResult 是独立 message（不内嵌在 assistant content 里） */
function normalizeToolResult(
  message: Record<string, unknown>,
  ts: string,
  lineNumber: number,
): LineResult {
  const toolCallId = asString(message.toolCallId);
  const toolName = asString(message.toolName);
  const result: PiToolResultMessage = {
    id: toolCallId === undefined ? "line-" + lineNumber : "tool-result:" + toolCallId,
    role: "user",
    kind: "tool_result",
    text: flattenContent(message.content),
    ts,
    isError: message.isError === true,
  };
  if (toolCallId !== undefined) {
    result.toolCallId = toolCallId;
  }
  if (toolName !== undefined) {
    result.toolName = toolName;
  }
  return { messages: [result], skipped: 0 };
}

/** 记录级 timestamp 优先；缺省回退 message.timestamp / session.timestamp */
function readTimestamp(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  state: LineState,
): string {
  const recordTs = asString(record.timestamp);
  if (recordTs !== undefined && recordTs.length > 0) {
    return recordTs;
  }
  const messageTs = asString(message.timestamp);
  if (messageTs !== undefined && messageTs.length > 0) {
    return messageTs;
  }
  return state.sessionTimestamp;
}

/** user content：数组取 type=text 的块，裸字符串直接返回 */
function extractTexts(content: unknown): string[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!isJsonObject(block) || asString(block.type) !== "text") {
      continue;
    }
    const text = asString(block.text);
    if (text !== undefined && text.length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

/** toolResult content 通常是 [{type:"text",text}]，也兼容裸字符串 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
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
  return stringifyUnknown(content);
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

function emptyPage(nextCursor: string): PiTranscriptPage {
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
    return DEFAULT_PI_TRANSCRIPT_LIMIT;
  }
  return Math.max(0, Math.trunc(limit));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
