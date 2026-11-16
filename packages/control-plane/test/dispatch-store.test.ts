import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { migrate, openDb } from "../src/db.ts";
import { DispatchStore } from "../src/dispatch-store.ts";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "pi-dispatch-"));
  const db = openDb(join(dir, "wb.sqlite"));
  migrate(db);
  return { db, dir };
}

test("reserve 第一个赢家 created=true，第二个 created=false 且读到赢家的记录", () => {
  const { db, dir } = fresh();
  try {
    const store = new DispatchStore(db);
    const a = store.reserve("k1", "hash-a");
    const b = store.reserve("k1", "hash-b");
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.record.payloadHash, "hash-a");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("complete 落 sessionKey 与 done；fail 落 failed 与原因", () => {
  const { db, dir } = fresh();
  try {
    const store = new DispatchStore(db);
    store.reserve("k2", "h");
    store.complete("k2", "claude:s1");
    assert.deepEqual(
      { s: store.get("k2")?.status, k: store.get("k2")?.sessionKey },
      { s: "done", k: "claude:s1" },
    );
    store.reserve("k3", "h");
    store.fail("k3", "boom");
    assert.equal(store.get("k3")?.status, "failed");
    assert.equal(store.get("k3")?.error, "boom");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨连接可见（另一个 db 句柄读到同一行，模拟重启）", () => {
  const { db, dir } = fresh();
  const path = join(dir, "wb.sqlite");
  try {
    new DispatchStore(db).reserve("k4", "h");
  } finally {
    db.close();
  }
  try {
    const db2 = openDb(path);
    migrate(db2);
    assert.equal(new DispatchStore(db2).get("k4")?.payloadHash, "h");
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reclaim 只回收超 TTL 的 reserved", () => {
  const { db, dir } = fresh();
  try {
    const store = new DispatchStore(db);
    store.reserve("k1", "h", new Date("2026-11-17T00:00:00.000Z"));
    assert.equal(store.reclaim("k1", 120_000, new Date("2026-11-17T00:01:00.000Z")), false);
    assert.equal(store.reclaim("k1", 120_000, new Date("2026-11-17T00:02:01.000Z")), true);
    assert.equal(store.get("k1")?.status, "reserved");
    assert.equal(store.get("k1")?.createdAt, "2026-11-17T00:02:01.000Z", "回收必须重置 created_at");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("touch 只续约 reserved，不碰 done", () => {
  const { db, dir } = fresh();
  try {
    const store = new DispatchStore(db);
    store.reserve("k-touch", "h", new Date("2026-11-17T00:00:00.000Z"));
    store.touch("k-touch", new Date("2026-11-17T00:01:00.000Z"));
    assert.equal(store.get("k-touch")?.updatedAt, "2026-11-17T00:01:00.000Z");

    store.complete("k-touch", "claude:s1", new Date("2026-11-17T00:02:00.000Z"));
    store.touch("k-touch", new Date("2026-11-17T00:03:00.000Z"));
    assert.equal(store.get("k-touch")?.updatedAt, "2026-11-17T00:02:00.000Z");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneRetained 只删过期 done/failed", () => {
  const { db, dir } = fresh();
  try {
    const store = new DispatchStore(db);
    store.reserve("old", "h", new Date("2026-11-15T00:00:00.000Z"));
    store.complete("old", "claude:a", new Date("2026-11-15T00:00:01.000Z"));
    store.reserve("new", "h", new Date("2026-11-17T00:00:00.000Z"));
    store.complete("new", "claude:b", new Date("2026-11-17T00:00:01.000Z"));
    assert.equal(store.pruneRetained(24 * 3600_000, new Date("2026-11-17T01:00:00.000Z")), 1);
    assert.equal(store.get("old"), null);
    assert.equal(store.get("new")?.status, "done");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("complete/fail 只对 reserved 生效（fencing）", () => {
  const { db, dir } = fresh();
  try {
    const store = new DispatchStore(db);
    store.reserve("k-fence", "h");
    assert.equal(store.complete("k-fence", "claude:s1"), true);
    assert.equal(store.complete("k-fence", "claude:s2"), false, "done 不能被二次 complete 覆盖");
    assert.equal(store.fail("k-fence", "late failure"), false, "done 不能被 fail 覆盖");
    assert.deepEqual(
      { s: store.get("k-fence")?.status, k: store.get("k-fence")?.sessionKey, e: store.get("k-fence")?.error },
      { s: "done", k: "claude:s1", e: null },
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retryFailed 原子把 failed 重置为 reserved 并清空 session_key/error", () => {
  const { db, dir } = fresh();
  try {
    const store = new DispatchStore(db);
    store.reserve("k-retry", "h", new Date("2026-11-17T00:00:00.000Z"));
    store.fail("k-retry", "boom", new Date("2026-11-17T00:01:00.000Z"));
    assert.equal(store.retryFailed("k-retry", new Date("2026-11-17T00:02:00.000Z")), true);
    const record = store.get("k-retry");
    assert.equal(record?.status, "reserved");
    assert.equal(record?.sessionKey, null);
    assert.equal(record?.error, null);
    assert.equal(record?.createdAt, "2026-11-17T00:02:00.000Z");
    assert.equal(store.retryFailed("k-retry"), false, "已 reserved 不能再次 retry");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneStaleReserved 只删过期 reserved", () => {
  const { db, dir } = fresh();
  try {
    const store = new DispatchStore(db);
    store.reserve("old", "h", new Date("2026-11-15T00:00:00.000Z"));
    store.reserve("new", "h", new Date("2026-11-17T00:00:00.000Z"));
    assert.equal(store.pruneStaleReserved(24 * 3600_000, new Date("2026-11-17T01:00:00.000Z")), 1);
    assert.equal(store.get("old"), null);
    assert.equal(store.get("new")?.status, "reserved");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
