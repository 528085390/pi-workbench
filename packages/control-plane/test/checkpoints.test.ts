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
