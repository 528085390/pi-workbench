/**
 * SQLite 架构与迁移（A03）。
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §5。
 * 使用 Node 内置 `node:sqlite`（Node ≥ 24），不引入 better-sqlite3 等原生依赖。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 当前 schema 版本，写入 `PRAGMA user_version`。
 * v2：dispatches（dispatch 幂等预留表）；v3：read_cursors（每读者未读游标，spec §6.5）。
 */
export const SCHEMA_VERSION = 3;

const MEMORY_PATH = ":memory:";

/**
 * 打开数据库：父目录不存在时创建，并启用 WAL + 外键。
 * `:memory:` 直接透传（此时 journal_mode 由 SQLite 决定为 memory，WAL 无效但不报错）。
 */
export function openDb(path: string): DatabaseSync {
  if (path !== MEMORY_PATH && !path.startsWith("file:")) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** 读取当前 user_version。 */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * 建 §5 四表与索引。幂等：user_version 已 >= SCHEMA_VERSION 时直接返回。
 * DDL 与规格逐字一致（仅在 CREATE 后加 IF NOT EXISTS，防止半建库报错）。
 */
export function migrate(db: DatabaseSync): void {
  if (schemaVersion(db) >= SCHEMA_VERSION) {
    return;
  }

  const current = schemaVersion(db);
  db.exec("BEGIN");
  try {
    if (current < 1) {
    db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  key TEXT PRIMARY KEY,              -- 'claude:<nativeId>'
  agent TEXT NOT NULL,
  native_id TEXT NOT NULL,
  acp_session_id TEXT,
  cwd TEXT NOT NULL,
  kind TEXT NOT NULL,                -- interactive | background | unknown
  status TEXT NOT NULL,              -- starting|running|needs-input|idle|handoff|exited|unknown
  driver TEXT NOT NULL DEFAULT 'none',
  caps_json TEXT NOT NULL,
  transcript_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  ts TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_key, seq);
CREATE TABLE IF NOT EXISTS leases (
  session_key TEXT PRIMARY KEY,
  driver TEXT NOT NULL,              -- pi | human
  client_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,          -- ISO
  heartbeat_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  path TEXT NOT NULL,                -- ~/.pi-workbench/handoffs/<key>-<ts>.md
  summary TEXT NOT NULL,
  touched_files_json TEXT NOT NULL,
  next_step TEXT NOT NULL,
  cursor TEXT NOT NULL,              -- transcript byte offset
  created_at TEXT NOT NULL
);
`);
    }

    if (current < 2) {
      // v2：dispatch 幂等预留表。主键 + INSERT OR IGNORE 提供原子占位，避免并发重复 dispatch。
      db.exec(`
CREATE TABLE IF NOT EXISTS dispatches (
  idempotency_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  session_key TEXT,
  status TEXT NOT NULL,              -- reserved | done | failed
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
    }

    if (current < 3) {
      // v3：每读者游标（spec §6.5）。unread = 会话最新 seq - last_read_seq。
      db.exec(`
CREATE TABLE IF NOT EXISTS read_cursors (
  session_key TEXT NOT NULL,
  client_id TEXT NOT NULL,
  last_read_cursor TEXT NOT NULL,    -- 该读者读到的 transcript 游标（字节偏移字符串）
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_key, client_id)
);
`);
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
