/**
 * 三个原生 transcript 解析器共用的 JSONL 读取层（C08）。
 *
 * 只负责「打开文件 / 按字节读取 / 切完整行 / 解析 JSON / 维护游标」，
 * 记录到 UnifiedMessage 的映射仍留在 claude.ts / codex.ts / pi.ts。
 * 语义与 0.5-B 三个解析器完全一致：
 * - 游标是 UTF-8 字节偏移，不是行号或字符数；
 * - 末尾半行（写入中、不以 \n 结尾）不消费，下次从它的起点继续；
 * - 文件缺失 / 为空返回 pending 空页，绝不抛异常（刚发 prompt 时还没落盘）；
 * - 游标越过文件末尾视为截断/轮转，回退到 0 重读并由解析器插入 notice。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type { UnifiedMessage } from "@pi-workbench/shared";

const NEWLINE = 0x0a;

export const CURSOR_ZERO = "0";

/** scanJsonl 的结果；nextCursor 是绝对字节偏移 */
export type JsonlScanResult = {
  nextCursor: number;
  /**
   * 是否还有未消费的字节：末尾半行、因上限提前停止，或文件暂不可读。
   * 注意解析器页面的 pending 仍按「本页没有消息」计算，保持 0.5-B 行为。
   */
  pending: boolean;
};

export type JsonlScanOptions = {
  /** 返回 false 时在下一行前停止（消息上限已到） */
  shouldContinue?: () => boolean;
  /** fromByte 越过文件末尾（截断/轮转）时调用，早于任何行回调 */
  onReset?: (resetFrom: number) => void;
};

/** 解析游标：非法 / 负数 / 空值一律回 0，小数向下取整 */
export function parseCursor(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

/** 按字节读完 [from, from+length)；read 可能短读，循环补齐 */
export function readBytes(fd: number, from: number, length: number): Buffer {
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

/** pending 空页；nextCursor 原样带回 */
export function emptyPage(
  nextCursor: string = CURSOR_ZERO,
): { messages: never[]; nextCursor: string; pending: true } {
  return { messages: [], nextCursor, pending: true };
}

/**
 * 从 fromByte 起扫描 JSONL。
 * - 只对完整行调用 onRecord；空行跳过；CRLF 按 \n 切后去掉 \r；
 * - 坏 JSON 以 undefined 回调，由解析器决定如何计数；
 * - 文件不存在 / 为空返回 { nextCursor: 0, pending: true }。
 */
export function scanJsonl(
  path: string,
  fromByte: number,
  onRecord: (record: unknown, nextByte: number, lineNumber: number) => void,
  options: JsonlScanOptions = {},
): JsonlScanResult {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { nextCursor: 0, pending: true };
    }
    throw err;
  }

  try {
    const size = fstatSync(fd).size;
    if (size === 0) {
      return { nextCursor: 0, pending: true };
    }

    const reset = fromByte > size;
    const from = reset ? 0 : fromByte;
    if (from === size) {
      return { nextCursor: from, pending: true };
    }
    if (reset) {
      options.onReset?.(fromByte);
    }

    const chunk = readBytes(fd, from, size - from);
    let consumed = 0;
    let pos = 0;
    let lineNumber = 0;

    while (pos < chunk.length) {
      if (options.shouldContinue !== undefined && !options.shouldContinue()) {
        break;
      }
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

      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        record = undefined; // 坏行：交给解析器跳过/计数
      }
      onRecord(record, from + consumed, lineNumber);
    }

    return { nextCursor: from + consumed, pending: pos < chunk.length };
  } finally {
    closeSync(fd);
  }
}

/** 三解析器共用的一行映射结果 */
export type JsonlLineResult = {
  messages: UnifiedMessage[];
  skipped: number;
};

export type JsonlPage = {
  messages: UnifiedMessage[];
  nextCursor: string;
  pending: boolean;
  skipped: number;
};

export type JsonlPageOptions<TState> = {
  path: string;
  cursor: string;
  limit: number;
  defaultLimit: number;
  /** notice id 前缀：claude / codex / pi */
  noticePrefix: string;
  createState: () => TState;
  normalizeLine: (record: unknown, lineNumber: number, state: TState) => JsonlLineResult;
};

/**
 * 通用增量读页：三个解析器只提供 normalizeLine 映射。
 * 页面 pending 保持旧口径（本页没有消息），与 0.5-B 测试一致。
 */
export function readJsonlPage<TState>(options: JsonlPageOptions<TState>): JsonlPage {
  const start = parseCursor(options.cursor);
  const maxMessages = normalizeLimit(options.limit, options.defaultLimit);
  const messages: UnifiedMessage[] = [];
  const state = options.createState();
  let skipped = 0;

  const scan = scanJsonl(
    options.path,
    start,
    (record, _nextByte, lineNumber) => {
      const result = options.normalizeLine(record, lineNumber, state);
      messages.push(...result.messages);
      skipped += result.skipped;
    },
    {
      shouldContinue: () => messages.length < maxMessages,
      onReset: (resetFrom) => {
        messages.push(cursorResetNotice(options.noticePrefix, resetFrom));
      },
    },
  );

  return {
    messages,
    nextCursor: String(scan.nextCursor),
    pending: messages.length === 0,
    skipped,
  };
}

/** 文件比游标短（截断/轮转）时插入的 notice，文案与 0.5-B 一致 */
export function cursorResetNotice(prefix: string, resetFrom: number): UnifiedMessage {
  return {
    id: prefix + ":cursor-reset:" + String(resetFrom),
    kind: "notice",
    role: "system",
    text: "transcript 文件比游标短（可能被截断或轮转），已从头重读",
    ts: new Date().toISOString(),
  };
}

/** 单页消息上限归一化；Infinity 表示读到底 */
export function normalizeLimit(limit: number, fallback: number): number {
  if (limit === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (!Number.isFinite(limit)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(limit));
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function stringifyUnknown(value: unknown): string {
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
