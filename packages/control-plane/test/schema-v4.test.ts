import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SCHEMA_VERSION, backupDbFile, migrate, openDb, schemaVersion } from "../src/db.ts";

test("新库迁移到 v4，重复迁移幂等", () => {
  const db = openDb(":memory:");
  migrate(db);
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(schemaVersion(db), 4);
  migrate(db);
  assert.equal(schemaVersion(db), 4);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  assert.ok(tables.some((t) => t.name === "instances"));
  assert.ok(tables.some((t) => t.name === "audit_log"));
});

test("v3 库升级保留旧行并补默认值", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-v4-"));
  const path = join(dir, "db.sqlite");
  const db = openDb(path);
  db.exec("CREATE TABLE sessions (key TEXT PRIMARY KEY, agent TEXT NOT NULL, native_id TEXT NOT NULL, acp_session_id TEXT, cwd TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, driver TEXT NOT NULL DEFAULT 'none', caps_json TEXT NOT NULL, transcript_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE leases (session_key TEXT PRIMARY KEY, driver TEXT NOT NULL, client_id TEXT NOT NULL, expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL)");
  db.exec("CREATE TABLE checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, path TEXT NOT NULL, summary TEXT NOT NULL, touched_files_json TEXT NOT NULL, next_step TEXT NOT NULL, cursor TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.exec("PRAGMA user_version = 3");
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("claude:a", "claude", "a", null, "/tmp", "interactive", "idle", "none", "{}", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const backup = backupDbFile(path, join(dir, "db-backup"), 3);
  assert.ok(backup !== null && existsSync(backup));
  migrate(db);
  assert.equal(schemaVersion(db), 4);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT dispatch_key FROM sessions").get() as { dispatch_key: string | null }).dispatch_key, null);
  const backups = readdirSync(join(dir, "db-backup"));
  assert.equal(backups.length, 1);
});

test("半迁移库：user_version=4 但缺表缺列时继续补齐", () => {
  const db = openDb(":memory:");
  db.exec("CREATE TABLE sessions (key TEXT PRIMARY KEY, agent TEXT NOT NULL, native_id TEXT NOT NULL, acp_session_id TEXT, cwd TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, driver TEXT NOT NULL DEFAULT 'none', caps_json TEXT NOT NULL, transcript_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.exec("CREATE TABLE leases (session_key TEXT PRIMARY KEY, driver TEXT NOT NULL, client_id TEXT NOT NULL, expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL)");
  db.exec("CREATE TABLE checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, path TEXT NOT NULL, summary TEXT NOT NULL, touched_files_json TEXT NOT NULL, next_step TEXT NOT NULL, cursor TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE instances (instance_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, host TEXT NOT NULL, version TEXT NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, ended_at TEXT)");
  db.exec("PRAGMA user_version = 4");
  migrate(db);
  assert.equal(schemaVersion(db), 4);
  const columns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns("leases").includes("instance_id"));
  assert.ok(columns("sessions").includes("dispatch_key"));
  assert.ok(columns("checkpoints").includes("version"));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  assert.ok(tables.some((t) => t.name === "audit_log"));
  migrate(db);
  assert.equal(schemaVersion(db), 4);
});

test("backupDbFile: 内存库/不存在的文件返回 null，只保留最近 2 份", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-v4-retention-"));
  const backupDir = join(dir, "db-backup");
  assert.equal(backupDbFile(":memory:", backupDir, 3), null);
  assert.equal(backupDbFile(join(dir, "missing.db"), backupDir, 3), null);

  const path = join(dir, "db.sqlite");
  const db = openDb(path);
  db.exec("PRAGMA user_version = 3");
  db.close();

  const first = backupDbFile(path, backupDir, 3, new Date(2026, 0, 1, 0, 0, 1));
  const second = backupDbFile(path, backupDir, 3, new Date(2026, 0, 1, 0, 0, 2));
  const third = backupDbFile(path, backupDir, 3, new Date(2026, 0, 1, 0, 0, 3));
  assert.ok(first !== null && second !== null && third !== null);
  const names = readdirSync(backupDir).sort();
  assert.equal(names.length, 2);
  assert.ok(!existsSync(first));
  assert.ok(existsSync(second));
  assert.ok(existsSync(third));
});
