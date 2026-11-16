import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, openDb } from "../src/db.ts";
import { InstanceStore } from "../src/instances.ts";

test("begin/touch/finish 写 instances 行", () => {
  const db = openDb(":memory:");
  migrate(db);
  let clock = Date.parse("2026-11-17T00:00:00.000Z");
  const store = new InstanceStore(db, { pid: 4242, host: "test", version: "0.0.1", now: () => clock });
  const info = store.begin();
  assert.equal(info.pid, 4242);
  assert.equal(info.host, "test");
  assert.equal(info.endedAt, null);
  clock += 15_000;
  store.touch();
  assert.equal(store.get(info.id)?.heartbeatAt, "2026-11-17T00:00:15.000Z");
  store.finish();
  assert.equal(store.get(info.id)?.endedAt, "2026-11-17T00:00:15.000Z");
  assert.deepEqual(store.unfinished(), []);
});

test("unfinished 列出上次未收尾的实例，finish 只收尾本实例行", () => {
  const db = openDb(":memory:");
  migrate(db);
  const t0 = Date.parse("2026-11-16T00:00:00.000Z");
  let clock = t0;
  // 上一轮 daemon 没正常收尾就退出了（ended_at 为空）
  const previous = new InstanceStore(db, { pid: 1, host: "host-a", version: "0.0.1", now: () => clock }).begin();
  clock += 60_000;
  const current = new InstanceStore(db, { pid: 2, host: "host-b", version: "0.0.1", now: () => clock });
  const info = current.begin();

  assert.deepEqual(
    current.unfinished().map((row) => row.id),
    [previous.id, info.id],
  );
  assert.equal(current.get("no-such-instance"), null);

  current.finish();
  // 只收尾本实例行：上一个实例仍留给重启对账补 ended_at
  assert.deepEqual(current.unfinished().map((row) => row.id), [previous.id]);
  assert.equal(current.get(previous.id)?.endedAt, null);
  assert.equal(current.get(info.id)?.endedAt, "2026-11-16T00:01:00.000Z");
});
