/**
 * Pi 会话发现（0.5-B B04）。
 *
 * 口径（规格 §7.2）：
 * - 路径：`~/.pi/agent/sessions` 下递归的 `*.jsonl`，文件名形如 `<ISO ts>_<uuid>.jsonl`；
 * - **不推断目录名**：目录 mangle 规则不可靠，cwd / id / version 一律读首行
 *   `{"type":"session","version":3,"id":...,"timestamp":...,"cwd":...}`；
 * - `version !== 3` → 记为 unsupported 并跳过，不猜格式；
 * - 坏 JSON / 非 session 记录 / 缺 id 或 cwd → 记为 skipped 并跳过，不抛异常。
 *
 * 发现层只读文件首行，不解析 transcript 正文；读取失败按跳过处理，不拖垮整次扫描。
 */
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { SessionRef } from "@pi-workbench/shared";

import { capsOf } from "../capabilities.ts";

/** Pi 原生 session 根目录；测试可传 sessionsRoot 覆盖，不依赖真实 HOME。 */
export const DEFAULT_PI_SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

/** 首行元数据（只保留发现需要的字段） */
export type PiSessionHeader = {
  id: string;
  cwd: string;
  timestamp: string;
  version: number;
};

export type PiDiscoveryOptions = {
  /** 覆盖 ~/.pi/agent/sessions（测试用） */
  sessionsRoot?: string;
  /** 精确匹配首行 cwd；Windows 下大小写不敏感、忽略尾部分隔符 */
  cwd?: string;
  /** 条数上限；缺省不限制 */
  limit?: number;
};

export type PiDiscoveryResult = {
  sessions: SessionRef[];
  /** 实际检查过的 .jsonl 文件数 */
  scanned: number;
  /** 坏 JSON / 非 session / 缺字段 */
  skipped: number;
  /** type=session 但 version !== 3 */
  unsupported: number;
};

const FIRST_LINE_MAX_BYTES = 64 * 1024;
const SESSION_VERSION = 3;

/**
 * 扫描并返回 SessionRef[]（AgentDriver.discover 的默认实现）。
 * 公开一个只需要会话列表的入口；统计信息用 scanPiSessions。
 */
export async function discoverPiSessions(opts: PiDiscoveryOptions = {}): Promise<SessionRef[]> {
  const result = await scanPiSessions(opts);
  return result.sessions;
}

/** 扫描 Pi session 根目录；返回会话与跳过计数。 */
export async function scanPiSessions(opts: PiDiscoveryOptions = {}): Promise<PiDiscoveryResult> {
  const root = opts.sessionsRoot ?? DEFAULT_PI_SESSIONS_ROOT;
  const wantedCwd = opts.cwd === undefined ? undefined : normalizeCwd(opts.cwd);

  const files = collectJsonlFiles(root);
  const candidates: Array<{ ref: SessionRef; timestampMs: number; path: string }> = [];
  let skipped = 0;
  let unsupported = 0;

  for (const path of files) {
    const firstLine = readFirstLine(path);
    if (firstLine === null) {
      skipped += 1;
      continue;
    }
    const parsed = parsePiSessionHeader(firstLine);
    if (parsed.kind === "skipped") {
      skipped += 1;
      continue;
    }
    if (parsed.kind === "unsupported") {
      unsupported += 1;
      continue;
    }
    if (wantedCwd !== undefined && normalizeCwd(parsed.header.cwd) !== wantedCwd) {
      continue;
    }
    candidates.push({
      ref: {
        key: `pi:${parsed.header.id}`,
        agent: "pi",
        nativeId: parsed.header.id,
        cwd: parsed.header.cwd,
        transcriptPath: resolve(path),
        status: "unknown",
        driver: "pi",
        capabilities: { ...capsOf("pi") },
        kind: "interactive",
      },
      timestampMs: parseTimestamp(parsed.header.timestamp),
      path,
    });
  }

  candidates.sort((a, b) => b.timestampMs - a.timestampMs || a.path.localeCompare(b.path));
  const limited = opts.limit === undefined ? candidates : candidates.slice(0, normalizeLimit(opts.limit));

  return {
    sessions: limited.map((candidate) => candidate.ref),
    scanned: files.length,
    skipped,
    unsupported,
  };
}

/** 解析首行；type 不是 session / 缺字段 → skipped，version 不是 3 → unsupported。 */
export function parsePiSessionHeader(
  line: string,
): { kind: "ok"; header: PiSessionHeader } | { kind: "unsupported" } | { kind: "skipped" } {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom);
  } catch {
    return { kind: "skipped" };
  }
  if (!isJsonObject(parsed) || parsed.type !== "session") {
    return { kind: "skipped" };
  }
  if (parsed.version !== SESSION_VERSION) {
    return { kind: "unsupported" };
  }
  const id = asNonEmptyString(parsed.id);
  const cwd = asNonEmptyString(parsed.cwd);
  const timestamp = asNonEmptyString(parsed.timestamp);
  if (id === undefined || cwd === undefined) {
    return { kind: "skipped" };
  }
  return {
    kind: "ok",
    header: { id, cwd, timestamp: timestamp ?? "", version: SESSION_VERSION },
  };
}

/** 递归收集 .jsonl；根目录不存在 / 不可读时返回空数组（发现不是致命错误）。 */
function collectJsonlFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(path);
      }
    }
  };
  visit(resolve(root));
  return out;
}

/** 只读首行；文件空 / 读失败返回 null。首行超过 64 KiB 视为坏文件。 */
function readFirstLine(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.allocUnsafe(FIRST_LINE_MAX_BYTES);
    const read = readSync(fd, buffer, 0, FIRST_LINE_MAX_BYTES, 0);
    if (read <= 0) {
      return null;
    }
    const chunk = buffer.subarray(0, read);
    const newlineAt = chunk.indexOf(0x0a);
    if (newlineAt === -1 && read === FIRST_LINE_MAX_BYTES) {
      return null;
    }
    return chunk.subarray(0, newlineAt === -1 ? read : newlineAt).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const absolute = resolve(trimmed.length === 0 ? "." : trimmed);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }
  return Math.trunc(limit);
}

function parseTimestamp(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
