/**
 * 会话注册表（A04）：SessionRef 双写 —— 内存 map + sessions 表。
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §5。
 *
 * 内存用于快速 list/get（避免每次扫描都查库），库里保留跨进程可见的持久态。
 * 写库用 `INSERT ... ON CONFLICT(key) DO UPDATE`：同 key 只更新，不新增行，且 created_at 不被覆盖。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { SessionRef, SessionStatus } from "@pi-workbench/shared";

/** list 的过滤条件；两个字段可组合，值为精确匹配 */
export type SessionFilter = {
  agent?: string;
  status?: string;
};

type MemoryEntry = {
  ref: SessionRef;
  updatedAt: string;
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

  #upsert(): StatementSync {
    this.#upsertStmt ??= this.#db.prepare(UPSERT_SQL);
    return this.#upsertStmt;
  }

  #updateStatus(): StatementSync {
    this.#updateStatusStmt ??= this.#db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE key = ?");
    return this.#updateStatusStmt;
  }
}
