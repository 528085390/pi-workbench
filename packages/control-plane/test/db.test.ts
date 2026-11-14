import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { SCHEMA_VERSION, migrate, openDb } from "../src/db.ts";

const TABLES = ["sessions", "events", "leases", "checkpoints", "dispatches"];

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return Number(row?.user_version);
}

function readIntPragma(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const first = row === undefined ? undefined : Object.values(row)[0];
  return Number(first);
}

function readJournalMode(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined;
  return String(row === undefined ? "" : Object.values(row)[0]);
}

function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name).filter((name) => !name.startsWith("sqlite_"));
}

function freshFileDbPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-db-"));
  return { dir, file: join(dir, "nested", "deeper", "workbench.db") };
}

test("openDb: 新库 user_version 为 0，迁移前无业务表", () => {
  const db = openDb(":memory:");
  try {
    assert.equal(readUserVersion(db), 0);
    assert.deepEqual(listTables(db), []);
  } finally {
    db.close();
  }
});

test("openDb: :memory: 启用 foreign_keys", () => {
  const db = openDb(":memory:");
  try {
    assert.equal(readIntPragma(db, "foreign_keys"), 1);
    const value = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    assert.equal(Number(Object.values(value)[0]), 1);
  } finally {
    db.close();
  }
});

test("migrate: user_version 0→2 并建立五表与索引", () => {
  const db = openDb(":memory:");
  try {
    migrate(db);
    assert.equal(readUserVersion(db), 2);
    assert.equal(SCHEMA_VERSION, 2);
    assert.deepEqual(listTables(db), [...TABLES].sort());
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .all("idx_events_session_seq") as { name: string }[];
    assert.equal(indexes.length, 1);
  } finally {
    db.close();
  }
});

test("migrate: 四表列名与规格一致", () => {
  const db = openDb(":memory:");
  try {
    migrate(db);
    const columns = (table: string): string[] =>
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name);
    assert.deepEqual(columns("sessions"), [
      "key",
      "agent",
      "native_id",
      "acp_session_id",
      "cwd",
      "kind",
      "status",
      "driver",
      "caps_json",
      "transcript_path",
      "created_at",
      "updated_at",
    ]);
    assert.deepEqual(columns("events"), [
      "seq",
      "session_key",
      "type",
      "payload_json",
      "source",
      "ts",
      "idempotency_key",
    ]);
    assert.deepEqual(columns("leases"), [
      "session_key",
      "driver",
      "client_id",
      "expires_at",
      "heartbeat_at",
    ]);
    assert.deepEqual(columns("checkpoints"), [
      "id",
      "session_key",
      "path",
      "summary",
      "touched_files_json",
      "next_step",
      "cursor",
      "created_at",
    ]);
  } finally {
    db.close();
  }
});

test("migrate: 幂等（连跑两次不报错、结果不变）", () => {
  const db = openDb(":memory:");
  try {
    migrate(db);
    const before = listTables(db);
    migrate(db);
    assert.equal(readUserVersion(db), 2);
    assert.deepEqual(listTables(db), before);
    migrate(db);
    assert.equal(readUserVersion(db), 2);
  } finally {
    db.close();
  }
});

test("openDb: 文件库自动创建父目录并启用 WAL", () => {
  const { dir, file } = freshFileDbPath();
  const db = openDb(file);
  try {
    assert.ok(existsSync(file), "数据库文件应已创建");
    assert.ok(dirname(file).startsWith(dir), "父目录由 openDb 创建");
    assert.equal(readJournalMode(db), "wal");
    assert.equal(readIntPragma(db, "foreign_keys"), 1);
    migrate(db);
    assert.equal(readUserVersion(db), 2);
    assert.deepEqual(listTables(db), [...TABLES].sort());
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
