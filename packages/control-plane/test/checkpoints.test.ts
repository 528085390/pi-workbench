import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDb, migrate } from "../src/db.ts";
import { CheckpointStore } from "../src/checkpoints.ts";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "pi-cp-store-"));
  const db = openDb(join(dir, "wb.sqlite"));
  migrate(db);
  return { db, dir };
}

test("save/latest 往返：字段完整、touchedFiles 数组还原", () => {
  const { db, dir } = freshDb();
  try {
    const store = new CheckpointStore(db);
    assert.equal(store.latest("claude:s1"), null);
    store.save({
      sessionKey: "claude:s1",
      path: join(dir, "a.md"),
      summary: "摘要",
      touchedFiles: ["src/a.ts", "src/b.ts"],
      nextStep: "下一步",
      transcriptCursor: "120",
      createdAt: new Date().toISOString(),
      version: 1,
    });
    const latest = store.latest("claude:s1");
    assert.ok(latest);
    assert.equal(latest.summary, "摘要");
    assert.deepEqual(latest.touchedFiles, ["src/a.ts", "src/b.ts"]);
    assert.equal(latest.transcriptCursor, "120");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest 取最新一条，list 倒序", () => {
  const { db, dir } = freshDb();
  try {
    const store = new CheckpointStore(db);
    for (const n of [1, 2, 3]) {
      store.save({
        sessionKey: "claude:s2",
        path: join(dir, String(n) + ".md"),
        summary: "s" + String(n),
        touchedFiles: [],
        nextStep: "",
        transcriptCursor: String(n),
        createdAt: new Date(2026, 0, n).toISOString(),
        version: 1,
      });
    }
    assert.equal(store.latest("claude:s2")?.summary, "s3");
    assert.deepEqual(store.list("claude:s2").map((c) => c.summary), ["s3", "s2", "s1"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("坏 JSON 不抛异常，touchedFiles 退化为空数组", () => {
  const { db, dir } = freshDb();
  try {
    db.prepare(
      "INSERT INTO checkpoints (session_key, path, summary, touched_files_json, next_step, cursor, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run("claude:s3", join(dir, "x.md"), "s", "{not json", "", "0", new Date().toISOString());
    const latest = new CheckpointStore(db).latest("claude:s3");
    assert.deepEqual(latest?.touchedFiles, []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint 带 version 且缺省为 1", () => {
  const db = openDb(":memory:");
  migrate(db);
  const store = new CheckpointStore(db);
  store.save({
    sessionKey: "claude:a",
    path: "/tmp/a.md",
    summary: "s",
    touchedFiles: [],
    nextStep: "n",
    transcriptCursor: "10",
    createdAt: "2026-11-17T00:00:00.000Z",
    version: 1,
  });
  assert.equal(store.latest("claude:a")?.version, 1);
});

test("历史行缺 version 值时读取按 1 处理", () => {
  const db = openDb(":memory:");
  migrate(db);
  db.prepare(
    "INSERT INTO checkpoints (session_key, path, summary, touched_files_json, next_step, cursor, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run("claude:legacy", "/tmp/old.md", "s", "[]", "", "0", "2026-11-16T00:00:00.000Z");
  assert.equal(new CheckpointStore(db).latest("claude:legacy")?.version, 1);
});
test("version 列为 NULL 时读取按 1 处理（old-schema / 半迁移行）", () => {
  const db = openDb(":memory:");
  // 模拟迁移前的旧表：version 列可空，行里是 NULL —— 走 toStored 的 row.version ?? 1 分支
  db.exec(
    "CREATE TABLE checkpoints (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, path TEXT NOT NULL, " +
      "summary TEXT NOT NULL, touched_files_json TEXT NOT NULL, next_step TEXT NOT NULL, " +
      "cursor TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER)",
  );
  db.prepare(
    "INSERT INTO checkpoints (session_key, path, summary, touched_files_json, next_step, cursor, created_at, version) " +
      "VALUES (?,?,?,?,?,?,?,NULL)",
  ).run("claude:null-version", "/tmp/null.md", "s", "[]", "", "0", "2026-11-16T00:00:00.000Z");
  try {
    assert.equal(new CheckpointStore(db).latest("claude:null-version")?.version, 1);
  } finally {
    db.close();
  }
});
