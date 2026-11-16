/**
 * 统一 transcript 入口（0.5-B B05-a / T4）。
 *
 * readTranscript({ agent, path, cursor, limit }) 按 agent 分派到各解析器；
 * 游标仍是文件字节偏移字符串（read_cursors 表结构不变）。
 * 新解析器通过 registerTranscriptParser 注册（Pi 在 T7 接）。
 */
import type { AgentName, UnifiedMessage } from "@pi-workbench/shared";

import { WorkbenchError } from "../errors.ts";
import { readClaudeTranscript } from "./claude.ts";
import { readCodexTranscript } from "./codex.ts";
import { readPiTranscript } from "./pi.ts";

/** 解析器返回的统一页结构；skipped 缺省按 0 处理（Claude 解析器尚无该口径） */
export type TranscriptPage = {
  messages: UnifiedMessage[];
  nextCursor: string;
  pending: boolean;
  skipped?: number;
};

export type TranscriptParser = (path: string, cursor: string, limit?: number) => TranscriptPage;

export type ReadTranscriptInput = {
  agent: AgentName;
  path: string;
  cursor: string;
  limit?: number;
};

export type ReadTranscriptResult = {
  messages: UnifiedMessage[];
  nextCursor: string;
  pending: boolean;
  skipped: number;
};

const parsers = new Map<string, TranscriptParser>();
parsers.set("claude", readClaudeTranscript);
parsers.set("codex", readCodexTranscript);
registerTranscriptParser("pi", readPiTranscript);

/** 注册/覆盖某 Agent 的解析器（T7 的 pi 解析器从这里接） */
export function registerTranscriptParser(agent: AgentName, parser: TranscriptParser): void {
  parsers.set(agent, parser);
}

export function readTranscript(input: ReadTranscriptInput): ReadTranscriptResult;
export function readTranscript(
  agent: AgentName,
  path: string,
  cursor: string,
  limit?: number,
): ReadTranscriptResult;
export function readTranscript(
  inputOrAgent: ReadTranscriptInput | AgentName,
  path?: string,
  cursor?: string,
  limit?: number,
): ReadTranscriptResult {
  const input: ReadTranscriptInput =
    typeof inputOrAgent === "string"
      ? { agent: inputOrAgent, path: path ?? "", cursor: cursor ?? "0", limit }
      : inputOrAgent;

  const parser = parsers.get(input.agent);
  if (parser === undefined) {
    throw new WorkbenchError(
      "E_BAD_REQUEST",
      "E_BAD_REQUEST: 未注册 " + input.agent + " 的 transcript 解析器",
    );
  }

  const page = parser(input.path, input.cursor, input.limit);
  return {
    messages: page.messages,
    nextCursor: page.nextCursor,
    pending: page.pending,
    skipped: page.skipped ?? 0,
  };
}
