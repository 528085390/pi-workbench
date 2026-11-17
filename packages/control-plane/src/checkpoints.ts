/**
 * 检查点存储（A08 支撑件）。
 *
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §5（checkpoints 表）。
 * 由 TakeoverEngine.checkpoint 写入，Task 8 的 `GET /sessions/:key/checkpoint` 读取。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { Checkpoint } from "@pi-workbench/shared";

/** 当前检查点格式版本（spec §7.3：数据库 `checkpoints.version` 固定写 1）。 */
export const CHECKPOINT_VERSION = 1;

/** 带落盘路径的检查点（数据库行里 path 列的值）。 */
export type StoredCheckpoint = Checkpoint & { path: string };

type CheckpointRow = {
  session_key: string;
  path: string;
  summary: string;
  touched_files_json: string;
  next_step: string;
  cursor: string;
  created_at: string;
  version: number | null;
};

const COLUMNS = "session_key, path, summary, touched_files_json, next_step, cursor, created_at, version";

function toStored(row: CheckpointRow): StoredCheckpoint {
  let touched: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.touched_files_json);
    if (Array.isArray(parsed)) touched = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    touched = [];
  }
  return {
    sessionKey: row.session_key,
    path: row.path,
    summary: row.summary,
    touchedFiles: touched,
    nextStep: row.next_step,
    transcriptCursor: row.cursor,
    createdAt: row.created_at,
    // 半迁移 / 历史行没有 version 值时按 1 读（spec §7.3）
    version: Number(row.version ?? 1),
  };
}

/** checkpoints 表的读写（append-only，最新一条即当前检查点）。 */
export class CheckpointStore {
  readonly #db: DatabaseSync;
  #insertStmt: StatementSync | null = null;
  #latestStmt: StatementSync | null = null;
  #listStmt: StatementSync | null = null;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 落一条检查点；path 为 Markdown 文件绝对路径。 */
  save(checkpoint: StoredCheckpoint): void {
    this.#insert().run(
      checkpoint.sessionKey,
      checkpoint.path,
      checkpoint.summary,
      JSON.stringify(checkpoint.touchedFiles ?? []),
      checkpoint.nextStep,
      checkpoint.transcriptCursor,
      checkpoint.createdAt,
      checkpoint.version ?? CHECKPOINT_VERSION,
    );
  }

  /** 最新一条（按 id 倒序）；没有则 null。 */
  latest(sessionKey: string): StoredCheckpoint | null {
    const row = this.#latest().get(sessionKey) as CheckpointRow | undefined;
    return row === undefined ? null : toStored(row);
  }

  /** 历史检查点，最近的在前。 */
  list(sessionKey: string, limit = 20): StoredCheckpoint[] {
    const normalized = Number.isInteger(limit) && limit > 0 ? limit : 20;
    const rows = this.#list().all(sessionKey, normalized) as CheckpointRow[];
    return rows.map(toStored);
  }

  #insert(): StatementSync {
    this.#insertStmt ??= this.#db.prepare(
      `INSERT INTO checkpoints (session_key, path, summary, touched_files_json, next_step, cursor, created_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.#insertStmt;
  }

  #latest(): StatementSync {
    this.#latestStmt ??= this.#db.prepare(
      `SELECT ${COLUMNS} FROM checkpoints WHERE session_key = ? ORDER BY id DESC LIMIT 1`,
    );
    return this.#latestStmt;
  }

  #list(): StatementSync {
    this.#listStmt ??= this.#db.prepare(
      `SELECT ${COLUMNS} FROM checkpoints WHERE session_key = ? ORDER BY id DESC LIMIT ?`,
    );
    return this.#listStmt;
  }
}
