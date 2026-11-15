import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ReadCursorStore } from "../src/cursors.ts";
import { migrate, openDb } from "../src/db.ts";

function memoryDb(): DatabaseSync {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("ReadCursorStore: 没读过时 cursorOf 返回 \"0\"、get 返回 null", () => {
  const db = memoryDb();
  try {
    const cursors = new ReadCursorStore(db);
    assert.equal(cursors.get("claude:a", "pi:1"), null);
    assert.equal(cursors.cursorOf("claude:a", "pi:1"), "0");
  } finally {
    db.close();
  }
});

test("ReadCursorStore: set 后可读回，listForClient 只列本读者", () => {
  const db = memoryDb();
  try {
    const cursors = new ReadCursorStore(db, () => "2026-11-16T00:00:00.000Z");
    cursors.set("claude:a", "pi:1", "120");
    cursors.set("claude:b", "pi:1", "40");
    cursors.set("claude:a", "pi:2", "999");

    assert.equal(cursors.cursorOf("claude:a", "pi:1"), "120");
    assert.equal(cursors.get("claude:a", "pi:1")?.updatedAt, "2026-11-16T00:00:00.000Z");

    const mine = cursors.listForClient("pi:1");
    assert.deepEqual(
      mine.map((c) => [c.sessionKey, c.lastReadCursor]),
      [
        ["claude:a", "120"],
        ["claude:b", "40"],
      ],
    );
    assert.equal(cursors.cursorOf("claude:a", "pi:2"), "999", "不同读者互不影响");
  } finally {
    db.close();
  }
});

test("ReadCursorStore: 只进不退（小游标不覆盖大游标）", () => {
  const db = memoryDb();
  try {
    const cursors = new ReadCursorStore(db);
    cursors.set("claude:a", "pi:1", "500");
    const after = cursors.set("claude:a", "pi:1", "100");
    assert.equal(after.lastReadCursor, "500");
    assert.equal(cursors.cursorOf("claude:a", "pi:1"), "500");
  } finally {
    db.close();
  }
});

test("ReadCursorStore: 跨连接持久（重启后未读状态不丢）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-cursors-"));
  const file = join(dir, "workbench.db");
  try {
    const first = openDb(file);
    migrate(first);
    new ReadCursorStore(first).set("claude:a", "pi:1", "256");
    first.close();

    const second = openDb(file);
    try {
      assert.equal(new ReadCursorStore(second).cursorOf("claude:a", "pi:1"), "256");
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
