/**
 * SQLite 架构与迁移（A03）。
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §5；
 * v4：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §5（expand-only）。
 * 使用 Node 内置 `node:sqlite`（Node ≥ 24），不引入 better-sqlite3 等原生依赖。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 当前 schema 版本，写入 `PRAGMA user_version`。
 * v2：dispatches（dispatch 幂等预留表）；v3：read_cursors（每读者未读游标，spec §6.5）；
 * v4：instances / audit_log / leases.instance_id / sessions.dispatch_key / checkpoints.version。
 */
export const SCHEMA_VERSION = 4;

const MEMORY_PATH = ":memory:";
const BACKUP_PREFIX = "pi-workbench-v";
const BACKUP_KEEP = 2;

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

/** 备份文件名里的时间戳：yyyyMMdd-HHmmss（本地时区，按文件名可直接排序）。 */
function formatBackupStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

/**
 * 升级前备份库文件（spec §5 约束 6）：`<backupDir>/pi-workbench-v<fromVersion>-<yyyyMMdd-HHmmss>.db`。
 * `:memory:`、`file:` URI 或文件不存在时返回 null；成功后只保留文件名倒序的最新 2 份。
 */
export function backupDbFile(
  dbPath: string,
  backupDir: string,
  fromVersion: number,
  now: Date = new Date(),
): string | null {
  if (dbPath === MEMORY_PATH || dbPath.startsWith("file:") || !existsSync(dbPath)) {
    return null;
  }
  mkdirSync(backupDir, { recursive: true });
  // WAL 模式下只复制主文件可能漏掉尚未 checkpoint 的已提交事务；
  // 先用独立连接把 WAL 合并回主文件，再复制，保证备份可直接打开。
  const source = new DatabaseSync(dbPath);
  try {
    source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    source.close();
  }
  const backupPath = resolve(backupDir, `${BACKUP_PREFIX}${String(fromVersion)}-${formatBackupStamp(now)}.db`);
  copyFileSync(dbPath, backupPath);

  const backups = readdirSync(backupDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(".db"))
    .sort()
    .reverse();
  for (const name of backups.slice(BACKUP_KEEP)) {
    unlinkSync(resolve(backupDir, name));
  }
  return backupPath;
}

/** 表是否存在：半迁移库可能只建了一部分表。 */
function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present?: unknown } | undefined;
  return row !== undefined;
}

/** 列是否存在：半迁移库（user_version 已是 4 但 DDL 只跑了一半）不能重复 ALTER。 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
  return rows.some((row) => row.name === column);
}

/**
 * v4 加法迁移（expand-only）：instances / audit_log / 归属列与索引。
 * 全部 DDL 可重复执行：CREATE IF NOT EXISTS + ALTER 前检查列，进程在迁移中被杀后重跑可补齐。
 */
function migrateToV4(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,
  pid         INTEGER NOT NULL,
  host        TEXT NOT NULL,
  version     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  ended_at    TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  session_key TEXT,
  outcome     TEXT NOT NULL,
  error_code  TEXT,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_session_ts ON audit_log(session_key, ts);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`);

  if (!hasColumn(db, "leases", "instance_id")) {
    db.exec("ALTER TABLE leases ADD COLUMN instance_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_leases_instance ON leases(instance_id)");

  if (!hasColumn(db, "sessions", "dispatch_key")) {
    db.exec("ALTER TABLE sessions ADD COLUMN dispatch_key TEXT");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_dispatch ON sessions(dispatch_key) WHERE dispatch_key IS NOT NULL",
  );

  if (!hasColumn(db, "checkpoints", "version")) {
    db.exec("ALTER TABLE checkpoints ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  }
}

/**
 * 建表与索引。幂等：所有 DDL 都是 CREATE IF NOT EXISTS；v4 的 ALTER 按列存在性检查，
 * 因此半迁移库（user_version 已写 4 但 DDL 缺一部分）重启后能继续补齐而不是报 duplicate column。
 */
export function migrate(db: DatabaseSync): void {
  const current = schemaVersion(db);
  // 比本代码更新的库：不降级、不改写，交给新版本自己处理。
  if (current > SCHEMA_VERSION) {
    return;
  }

  db.exec("BEGIN");
  try {
    if (
      current < 1 ||
      !tableExists(db, "sessions") ||
      !tableExists(db, "events") ||
      !tableExists(db, "leases") ||
      !tableExists(db, "checkpoints")
    ) {
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

    if (current < 2 || !tableExists(db, "dispatches")) {
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

    if (current < 3 || !tableExists(db, "read_cursors")) {
      // v3：每读者游标（spec §6.5）。游标是 transcript 字节偏移字符串，
      // unread = 该游标之后还剩几条消息（不是事件 seq 之差：事件与消息不是一一对应）。
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

    // v4 即使 user_version 已是 4 也重跑：补齐半迁移库缺的表 / 列 / 索引。
    migrateToV4(db);

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
