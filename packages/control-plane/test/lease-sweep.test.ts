import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { migrate, openDb } from "../src/db.ts";
import { LeaseManager } from "../src/lease.ts";

const START = Date.parse("2026-11-17T00:00:00.000Z");

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function rawInstanceId(db: DatabaseSync, sessionKey: string): string | undefined {
  const row = db
    .prepare("SELECT instance_id FROM leases WHERE session_key = ?")
    .get(sessionKey) as { instance_id: string } | undefined;
  return row?.instance_id;
}

test("TTL 到期后可重取（D7）", () => {
  const db = openDb(":memory:");
  migrate(db);
  let clock = START;
  const leases = new LeaseManager(db, { ttlMs: 1_000, now: () => clock, instanceId: "i1" });
  leases.acquire("claude:a", "pi", "c1");
  clock += 1_500;
  assert.equal(leases.current("claude:a"), null);
  assert.equal(leases.sweepExpired(), 1);
  assert.doesNotThrow(() => leases.acquire("claude:a", "pi", "c2"));
});

test("acquire 写入 instance_id，heartbeat 保持当前实例归属", () => {
  const db = openDb(":memory:");
  migrate(db);
  let clock = START;
  const leases = new LeaseManager(db, { ttlMs: 1_000, now: () => clock, instanceId: "i1" });
  const lease = leases.acquire("claude:a", "pi", "c1");
  assert.equal(lease.instanceId, "i1");
  assert.equal(rawInstanceId(db, "claude:a"), "i1");

  // 模拟归属漂移（历史行 / 外部写入），心跳必须把它收回当前实例。
  db.prepare("UPDATE leases SET instance_id = 'stale' WHERE session_key = ?").run("claude:a");
  clock += 200;
  const beat = leases.heartbeat("claude:a", "c1");
  assert.equal(beat.instanceId, "i1");
  assert.equal(rawInstanceId(db, "claude:a"), "i1");
});

test("启动清扫保留当前实例自己的租约", () => {
  const db = openDb(":memory:");
  migrate(db);
  const leases = new LeaseManager(db, { ttlMs: 60_000, now: () => START, instanceId: "i1" });
  leases.acquire("claude:a", "pi", "c1");
  assert.equal(leases.sweepForBoot(), 0);
  assert.equal(leases.current("claude:a")?.instanceId, "i1");
});

test("启动清扫删除其他实例的租约", () => {
  const db = openDb(":memory:");
  migrate(db);
  const old = new LeaseManager(db, { instanceId: "old", now: () => START });
  old.acquire("claude:a", "pi", "c1");
  const fresh = new LeaseManager(db, { instanceId: "new", now: () => START });
  assert.equal(fresh.sweepForBoot(), 1);
  assert.equal(fresh.current("claude:a"), null);
});

test("启动清扫删除空归属历史租约", () => {
  const db = openDb(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO leases (session_key, driver, client_id, instance_id, expires_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("claude:legacy", "pi", "c0", "", iso(START + 60_000), iso(START));
  const fresh = new LeaseManager(db, { instanceId: "new", now: () => START });
  assert.equal(fresh.sweepForBoot(), 1);
  assert.equal(fresh.current("claude:legacy"), null);
});

test("启动清扫保留未过期的 human handoff 租约并改归属", () => {
  const db = openDb(":memory:");
  migrate(db);
  const old = new LeaseManager(db, { instanceId: "old", now: () => START });
  old.acquire("claude:handoff", "human", "human:1", 30 * 60 * 1000);
  const fresh = new LeaseManager(db, { instanceId: "new", now: () => START });
  assert.equal(fresh.sweepForBoot(), 0);
  const kept = fresh.current("claude:handoff");
  assert.equal(kept?.clientId, "human:1");
  assert.equal(kept?.driver, "human");
  assert.equal(kept?.instanceId, "new");
  assert.equal(rawInstanceId(db, "claude:handoff"), "new");
});

test("启动清扫删除已过期的 human 租约", () => {
  const db = openDb(":memory:");
  migrate(db);
  let clock = START;
  const old = new LeaseManager(db, { instanceId: "old", now: () => clock });
  old.acquire("claude:handoff", "human", "human:1", 1_000);
  clock += 1_500;
  const fresh = new LeaseManager(db, { instanceId: "new", now: () => clock });
  assert.equal(fresh.sweepForBoot(), 1);
  assert.equal(fresh.current("claude:handoff"), null);
});
