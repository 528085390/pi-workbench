/**
 * 会话注册表（A04）：SessionRef 双写 —— 内存 map + sessions 表。
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §5。
 *
 * 内存用于快速 list/get（避免每次扫描都查库），库里保留跨进程可见的持久态。
 * 写库用 `INSERT ... ON CONFLICT(key) DO UPDATE`：同 key 只更新，不新增行，且 created_at 不被覆盖。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { SessionCaps, SessionRef, SessionStatus } from "@pi-workbench/shared";

/** list 的过滤条件；两个字段可组合，值为精确匹配 */
export type SessionFilter = {
  agent?: string;
  status?: string;
};

type MemoryEntry = {
  ref: SessionRef;
  updatedAt: string;
};

/** `sessions` 表的一行（冷启动恢复用，R34） */
type SessionRow = {
  key: string;
  agent: string;
  native_id: string;
  acp_session_id: string | null;
  cwd: string;
  kind: string;
  status: string;
  driver: string;
  caps_json: string;
  transcript_path: string | null;
  created_at: string;
  updated_at: string;
};

const SESSION_COLUMNS =
  "key, agent, native_id, acp_session_id, cwd, kind, status, driver, caps_json, transcript_path, created_at, updated_at";

/** caps_json 损坏时的兜底：宁可少声明能力，也不凭空放开 */
const NO_CAPABILITIES: SessionCaps = {
  stream: false,
  inject: false,
  interrupt: false,
  attach: false,
  resume: false,
  transcript: false,
  permissions: false,
};

const UPSERT_SQL = `INSERT INTO sessions (
  key, agent, native_id, acp_session_id, cwd, kind, status, driver, caps_json, transcript_path, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  agent = excluded.agent,
  native_id = excluded.native_id,
  acp_session_id = excluded.acp_session_id,
  cwd = excluded.cwd,
  kind = excluded.kind,
  status = excluded.status,
  driver = excluded.driver,
  caps_json = excluded.caps_json,
  transcript_path = excluded.transcript_path,
  updated_at = excluded.updated_at`;

export class SessionRegistry {
  readonly #db: DatabaseSync;
  readonly #memory = new Map<string, MemoryEntry>();
  #upsertStmt: StatementSync | null = null;
  #updateStatusStmt: StatementSync | null = null;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 写内存 + 落库（同 key 覆盖为最新状态） */
  upsert(ref: SessionRef): void {
    const updatedAt = new Date().toISOString();
    this.#upsert().run(
      ref.key,
      ref.agent,
      ref.nativeId,
      ref.acpSessionId ?? null,
      ref.cwd,
      ref.kind ?? "unknown",
      ref.status,
      ref.driver,
      JSON.stringify(ref.capabilities),
      ref.transcriptPath ?? null,
      updatedAt,
      updatedAt,
    );
    this.#memory.set(ref.key, { ref, updatedAt });
  }

  /**
   * 发现/登记入口（B08 P1-1）：同 key 已存在时绝不覆盖 status/driver/kind/caps，
   * 只允许补缺失的 transcriptPath；控制面自己的状态迁移仍走 upsert。
   */
  registerDiscovered(ref: SessionRef): {
    session: SessionRef;
    created: boolean;
    transcriptPathUpdated: boolean;
  } {
    const existing = this.#memory.get(ref.key)?.ref;
    if (existing === undefined) {
      this.upsert(ref);
      return { session: ref, created: true, transcriptPathUpdated: false };
    }
    const missingPath = existing.transcriptPath === undefined || existing.transcriptPath.length === 0;
    const incomingPath = ref.transcriptPath;
    if (missingPath && incomingPath !== undefined && incomingPath.length > 0) {
      const merged: SessionRef = { ...existing, transcriptPath: incomingPath };
      this.upsert(merged);
      return { session: merged, created: false, transcriptPathUpdated: true };
    }
    return { session: existing, created: false, transcriptPathUpdated: false };
  }

  /**
   * 只改状态（A06 管线对 `state_update` 的投影）：内存态与 `sessions` 表同步。
   * - 未知 key 返回 `null`（不抛、不凭空建行）：状态只能投影到已登记的会话。
   * - 返回更新后的 SessionRef；调用方拿到的旧引用不变（对象整体替换）。
   */
  updateStatus(sessionKey: string, status: SessionStatus): SessionRef | null {
    const entry = this.#memory.get(sessionKey);
    if (entry === undefined) {
      return null;
    }
    const updatedAt = new Date().toISOString();
    const ref: SessionRef = { ...entry.ref, status };
    this.#updateStatus().run(status, updatedAt, sessionKey);
    this.#memory.set(sessionKey, { ref, updatedAt });
    return ref;
  }

  /** 内存态快照，按 updated_at 倒序；可过滤 agent / status */
  list(filter: SessionFilter = {}): SessionRef[] {
    const entries: MemoryEntry[] = [];
    for (const entry of this.#memory.values()) {
      if (filter.agent !== undefined && entry.ref.agent !== filter.agent) {
        continue;
      }
      if (filter.status !== undefined && entry.ref.status !== filter.status) {
        continue;
      }
      entries.push(entry);
    }
    entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return entries.map((entry) => entry.ref);
  }

  /** 内存里的单个会话；没有则 null（不查库：库只是持久化副本） */
  get(key: string): SessionRef | null {
    return this.#memory.get(key)?.ref ?? null;
  }

  /**
   * 冷启动恢复（R34）：把 `sessions` 表读回内存，返回载入条数。
   * 语义是「以库为准」：先清空内存 map 再填，重复调用幂等。
   */
  loadFromDb(): number {
    const rows = this.#db.prepare("SELECT " + SESSION_COLUMNS + " FROM sessions").all() as SessionRow[];
    this.#memory.clear();
    for (const row of rows) {
      this.#memory.set(row.key, { ref: toSessionRef(row), updatedAt: row.updated_at });
    }
    return rows.length;
  }

  #upsert(): StatementSync {
    this.#upsertStmt ??= this.#db.prepare(UPSERT_SQL);
    return this.#upsertStmt;
  }

  #updateStatus(): StatementSync {
    this.#updateStatusStmt ??= this.#db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE key = ?");
    return this.#updateStatusStmt;
  }
}

/** 行 → SessionRef：可选字段（acp_session_id / transcript_path）为空时**不设**该键，与 upsert 写入的形状一致 */
function toSessionRef(row: SessionRow): SessionRef {
  const ref: SessionRef = {
    key: row.key,
    agent: row.agent,
    nativeId: row.native_id,
    cwd: row.cwd,
    status: row.status as SessionStatus,
    driver: row.driver as SessionRef["driver"],
    capabilities: parseCaps(row.caps_json),
    kind: asKind(row.kind),
  };
  if (row.acp_session_id !== null) {
    ref.acpSessionId = row.acp_session_id;
  }
  if (row.transcript_path !== null) {
    ref.transcriptPath = row.transcript_path;
  }
  return ref;
}

/** kind 落库时可能是历史上没填的值，非法的一律归到 unknown */
function asKind(raw: string): "interactive" | "background" | "unknown" {
  return raw === "interactive" || raw === "background" ? raw : "unknown";
}

/** caps_json 解析失败（手工改库 / 旧版本结构）→ 全 false，不让坏数据变成「有权限」 */
function parseCaps(raw: string): SessionCaps {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return NO_CAPABILITIES;
    }
    return parsed as SessionCaps;
  } catch {
    return NO_CAPABILITIES;
  }
}
