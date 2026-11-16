/**
 * Codex 原生会话发现（0.5-B B02 / T3）。
 *
 * 数据源只有一个：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl。
 * 每个 rollout 的首行 session_meta.payload 已含发现所需全部字段，
 * 因此这里只读首行，不解析全文；坏文件/半行跳过而不是崩。
 *
 * 口径（probe-findings 实测补充，2026-11-16）：
 * - 不按 thread_source 过滤：ACP session/new 落盘的 rollout 可能缺该字段；
 * - cwd 一律取首行 payload.cwd，不从目录名推断；
 * - native id 取 payload.id（thread id，rollout 文件名后缀）；缺失时回退 session_id；
 * - ~/.codex/archived_sessions 默认不列，includeArchived 才扫。
 */
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { SessionRef } from "@pi-workbench/shared";

import { capsOf } from "../capabilities.ts";

/** ~/.codex/sessions（测试可注入 sessionsRoot 覆盖） */
export const DEFAULT_CODEX_SESSIONS_ROOT = join(homedir(), ".codex", "sessions");

/** 首扫默认只看最近 30 天（规格 §7.1） */
export const DEFAULT_CODEX_SINCE_DAYS = 30;

/** 首行可能包含 base_instructions，实测 ~23KB；给 1MB 上限防异常文件 */
const MAX_FIRST_LINE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;
const DAY_MS = 86_400_000;

export type DiscoverCodexOptions = {
  /** rollout 根目录；缺省 ~/.codex/sessions */
  sessionsRoot?: string;
  /** 归档根目录；缺省为 sessionsRoot 的兄弟目录 archived_sessions */
  archivedRoot?: string;
  /** 只列该 cwd 的会话（Windows 大小写不敏感、忽略尾部分隔符） */
  cwd?: string;
  /** 时间窗（天），默认 30；Infinity 表示不设窗口 */
  sinceDays?: number;
  /** 是否扫 ~/.codex/archived_sessions，默认 false */
  includeArchived?: boolean;
  /** 返回条数上限；缺省不截断 */
  limit?: number;
  /** 测试注入的时钟 */
  now?: () => number;
};

type RolloutMeta = {
  nativeId: string;
  sessionId: string;
  cwd: string;
  timestamp: string;
  threadSource?: string;
  originator?: string;
};

type Candidate = {
  ref: SessionRef;
  timestampMs: number;
  fileMtimeMs: number;
};

/**
 * 扫 rollout 文件并映射为 SessionRef[]（按 timestamp 倒序，最新在前）。
 * 任何单文件错误（缺失、坏首行、无权限）都只跳过该文件，不向外抛。
 */
export async function discoverCodexSessions(opts: DiscoverCodexOptions = {}): Promise<SessionRef[]> {
  const sessionsRoot = resolve(opts.sessionsRoot ?? DEFAULT_CODEX_SESSIONS_ROOT);
  const roots = [sessionsRoot];
  if (opts.includeArchived === true) {
    roots.push(resolve(opts.archivedRoot ?? join(dirname(sessionsRoot), "archived_sessions")));
  }

  const now = opts.now ?? Date.now;
  const sinceDays = opts.sinceDays ?? DEFAULT_CODEX_SINCE_DAYS;
  const cutoff = Number.isFinite(sinceDays) ? now() - sinceDays * DAY_MS : Number.NEGATIVE_INFINITY;
  const wantedCwd = opts.cwd === undefined ? undefined : normalizeCwd(opts.cwd);

  const byNativeId = new Map<string, Candidate>();
  for (const root of roots) {
    for (const file of collectRolloutFiles(root)) {
      const meta = readRolloutMeta(file);
      if (meta === null) {
        continue;
      }
      if (wantedCwd !== undefined && normalizeCwd(meta.cwd) !== wantedCwd) {
        continue;
      }
      const fileMtimeMs = fileMtime(file);
      const timestampMs = parseTimestamp(meta.timestamp) ?? fileMtimeMs;
      if (timestampMs < cutoff) {
        continue;
      }
      const candidate: Candidate = { ref: toSessionRef(meta, file), timestampMs, fileMtimeMs };
      const existing = byNativeId.get(meta.nativeId);
      if (existing === undefined || isNewer(candidate, existing)) {
        byNativeId.set(meta.nativeId, candidate);
      }
    }
  }

  const sorted = [...byNativeId.values()].sort(
    (a, b) =>
      b.timestampMs - a.timestampMs ||
      b.fileMtimeMs - a.fileMtimeMs ||
      a.ref.key.localeCompare(b.ref.key),
  );
  const limited = opts.limit === undefined ? sorted : sorted.slice(0, Math.max(0, Math.trunc(opts.limit)));
  return limited.map((candidate) => candidate.ref);
}

function toSessionRef(meta: RolloutMeta, transcriptPath: string): SessionRef {
  return {
    key: "codex:" + meta.nativeId,
    agent: "codex",
    nativeId: meta.nativeId,
    acpSessionId: meta.nativeId,
    cwd: meta.cwd,
    transcriptPath,
    status: "unknown",
    driver: "none",
    capabilities: capsOf("codex"),
    kind: "interactive",
  };
}

/** 递归收集 rollout-*.jsonl；目录不存在/无权限直接返回空 */
function collectRolloutFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(root, 0);
  files.sort();
  return files;
}

/** 只读首行；解析失败、非 session_meta、缺 id 都返回 null */
function readRolloutMeta(path: string): RolloutMeta | null {
  const firstLine = readFirstLine(path);
  if (firstLine === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(firstLine));
  } catch {
    return null;
  }
  if (!isJsonObject(parsed) || parsed.type !== "session_meta" || !isJsonObject(parsed.payload)) {
    return null;
  }
  const payload = parsed.payload;
  const nativeId = asString(payload.id) ?? asString(payload.session_id);
  if (nativeId === undefined || nativeId.length === 0) {
    return null;
  }
  return {
    nativeId,
    sessionId: asString(payload.session_id) ?? nativeId,
    cwd: asString(payload.cwd) ?? "",
    timestamp: asString(payload.timestamp) ?? "",
    threadSource: asString(payload.thread_source),
    originator: asString(payload.originator),
  };
}

/** 读文件第一行（不含换行）；空文件/读失败返回 null */
function readFirstLine(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) {
      return null;
    }
    const length = Math.min(size, MAX_FIRST_LINE_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    const chunk = buffer.subarray(0, read);
    const newlineAt = chunk.indexOf(NEWLINE);
    const line = newlineAt === -1 ? chunk : chunk.subarray(0, newlineAt);
    return line.length === 0 ? null : line.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function isNewer(candidate: Candidate, existing: Candidate): boolean {
  if (candidate.timestampMs !== existing.timestampMs) {
    return candidate.timestampMs > existing.timestampMs;
  }
  return candidate.fileMtimeMs > existing.fileMtimeMs;
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const absolute = resolve(trimmed.length === 0 ? "" : trimmed);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function parseTimestamp(value: string): number | undefined {
  if (value.length === 0) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
