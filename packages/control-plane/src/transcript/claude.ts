/**
 * Claude 会话发现与 transcript 归一化（A04）。
 * 口径来自 A00 探针实测：
 * - `claude agents --json --all` 返回 {${sessionId,name?,kind?,cwd?,status?}}[]；
 * - transcript 位于 ~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl，一行一个 JSON 对象；
 * - cwd 的 `:` `/` `\\` 全部替换成 `-` 得到目录名。
 *
 * 设计要点：
 * - 游标是**字节偏移**（UTF-8），不是行号或字符数；
 * - 末尾半行（写入中、不以 `\n` 结尾）不消费，下次从它的起点继续读；
 * - 文件缺失 / 为空时返回 pending 空页，**绝不抛异常**（刚发 prompt 时 transcript 还没落盘）。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { execa } from "execa";
import type { SessionCaps, SessionRef, SessionStatus, UnifiedMessage } from "@pi-workbench/shared";

import { asString, isJsonObject, readJsonlPage, stringifyUnknown } from "./jsonl.ts";

// 0.5-B D4：UnifiedMessage 上移到 @pi-workbench/shared；这里 re-export 保持旧 import 路径兼容。
export type { UnifiedMessage } from "@pi-workbench/shared";

/** 一次增量读取的结果；nextCursor 可直接作为下次的 cursor */
export type ClaudeTranscriptPage = {
  messages: UnifiedMessage[];
  nextCursor: string;
  pending: boolean;
};

/** 可注入的命令执行器（测试用 fake 替换，生产默认走 execa） */
export type ClaudeRunner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

/** 单次读取默认上限（条消息，不是行） */
export const DEFAULT_TRANSCRIPT_LIMIT = 200;

/** 键为 `claude agents --json` 的字段名（探针实测） */
type AgentEntry = Record<string, unknown>;

/**
 * cwd → transcript 所在目录。
 * `E:\pi-workbench\spike\a00-workspace` → `~/.claude/projects/E--pi-workbench-spike-a00-workspace`
 */
export function claudeProjectDir(cwd: string): string {
  const mangled = cwd.replace(/[:/\\]/g, "-");
  return join(homedir(), ".claude", "projects", mangled);
}

/**
 * 从 `cursor`（字节偏移）起增量读 transcript。
 * - 文件不存在 / 为空 → `{ messages: [], nextCursor: "0", pending: true }`
 * - 没有新数据 → 空页，nextCursor 保持传入值（文件被截断时回退到 0 重读）
 * - 损坏行、噪声行（queue-operation / summary 等）跳过，但游标照常推进
 */
export function readClaudeTranscript(
  jsonlPath: string,
  cursor: string,
  limit: number = DEFAULT_TRANSCRIPT_LIMIT,
): ClaudeTranscriptPage {
  const page = readJsonlPage({
    path: jsonlPath,
    cursor,
    limit,
    defaultLimit: DEFAULT_TRANSCRIPT_LIMIT,
    noticePrefix: "claude",
    createState: () => undefined,
    normalizeLine: (record, lineNumber) => ({
      messages: normalizeLine(record, lineNumber),
      skipped: 0,
    }),
  });
  return { messages: page.messages, nextCursor: page.nextCursor, pending: page.pending };
}

/**
 * 列出 Claude 会话：解析 `claude agents --json --all` 并映射成 SessionRef。
 * - `run` 可注入（测试用 fake），默认 execa
 * - `cwd` 可选过滤（Windows 下大小写不敏感、忽略尾部分隔符）
 * - stdout 不是合法数组时返回 []（CLI 可能混入 banner）；命令本身失败则抛出
 */
export async function listClaudeSessions(
  opts: { cwd?: string; run?: ClaudeRunner } = {},
): Promise<SessionRef[]> {
  const run = opts.run ?? execaRunner;
  const { stdout } = await run("claude", ["agents", "--json", "--all"]);

  const wanted = opts.cwd === undefined ? undefined : normalizeCwd(opts.cwd);
  const refs: SessionRef[] = [];
  for (const entry of parseAgentsPayload(stdout)) {
    const sessionId = asString(entry.sessionId);
    if (sessionId === undefined || sessionId.length === 0) {
      continue;
    }
    const cwd = asString(entry.cwd) ?? "";
    if (wanted !== undefined && normalizeCwd(cwd) !== wanted) {
      continue;
    }
    refs.push(toSessionRef(sessionId, cwd, entry));
  }
  return refs;
}

const execaRunner: ClaudeRunner = async (cmd, args) => {
  const result = await execa(cmd, args);
  return { stdout: result.stdout };
};

function toSessionRef(sessionId: string, cwd: string, entry: AgentEntry): SessionRef {
  const kind = entry.kind === "background" || entry.kind === "interactive" ? entry.kind : "unknown";
  const background = kind === "background";
  const capabilities: SessionCaps = {
    stream: true,
    inject: true,
    interrupt: true,
    attach: background,
    resume: true,
    transcript: true,
    permissions: true,
    background,
  };

  return {
    key: `claude:${sessionId}`,
    agent: "claude",
    nativeId: sessionId,
    cwd,
    transcriptPath: join(claudeProjectDir(cwd), `${sessionId}.jsonl`),
    status: mapStatus(entry.status),
    driver: "none",
    capabilities,
    kind,
  };
}

/** `claude agents` 的 status 只有 busy / idle 两态（缺省视为未知） */
function mapStatus(status: unknown): SessionStatus {
  if (status === "busy") {
    return "running";
  }
  if (status === "idle") {
    return "idle";
  }
  return "unknown";
}

/** 解析 stdout；不是数组、元素不是对象都直接丢掉，不抛异常 */
function parseAgentsPayload(stdout: string): AgentEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isJsonObject);
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const absolute = resolve(trimmed.length === 0 ? "" : trimmed);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * 一行 JSONL → 0..n 条 UnifiedMessage。
 * 只处理 type=user / assistant；其余（queue-operation、summary、system 初始化等）全部跳过。
 */
function normalizeLine(record: unknown, lineNumber: number): UnifiedMessage[] {
  if (!isJsonObject(record)) {
    return []; // 损坏行：跳过，不影响后续
  }
  const parsed = record;
  const type = parsed.type;
  if (type !== "user" && type !== "assistant") {
    return [];
  }
  const message = parsed.message;
  if (!isJsonObject(message)) {
    return [];
  }

  const role = type;
  const uuid = asString(parsed.uuid) ?? `line-${lineNumber}`;
  const ts = asString(parsed.timestamp) ?? "";
  const content = message.content;

  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ id: uuid, role, kind: "text", text: content, ts }];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const messages: UnifiedMessage[] = [];
  content.forEach((block, index) => {
    const normalized = normalizeBlock(block, role, ts, `${uuid}:${index}`);
    if (normalized !== null) {
      messages.push(normalized);
    }
  });
  return messages;
}

function normalizeBlock(
  block: unknown,
  role: "user" | "assistant",
  ts: string,
  id: string,
): UnifiedMessage | null {
  if (!isJsonObject(block)) {
    return null;
  }
  const blockType = block.type;

  if (blockType === "text") {
    const text = asString(block.text) ?? "";
    return text.length === 0 ? null : { id, role, kind: "text", text, ts };
  }
  if (blockType === "thinking") {
    const text = asString(block.thinking) ?? asString(block.text) ?? "";
    return text.length === 0 ? null : { id, role, kind: "thinking", text, ts };
  }
  if (blockType === "tool_use") {
    const toolName = asString(block.name);
    const text = stringifyUnknown(block.input);
    return toolName === undefined
      ? { id, role, kind: "tool_call", text, ts }
      : { id, role, kind: "tool_call", text, ts, toolName };
  }
  if (blockType === "tool_result") {
    // 工具结果是 user 侧消息；content 可能是字符串，也可能是 block 数组
    return { id, role, kind: "tool_result", text: flattenToolResult(block.content), ts };
  }
  return null;
}

function flattenToolResult(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (isJsonObject(block) && typeof block.text === "string") {
          return block.text;
        }
        return stringifyUnknown(block);
      })
      .join("\n");
  }
  return stringifyUnknown(content);
}
