import assert from "node:assert/strict";
import { test } from "node:test";

import { migrate, openDb } from "../src/db.ts";
import { LeaseManager } from "../src/lease.ts";

test("TTL 到期后可重取（D7）", () => {
  const db = openDb(":memory:");
  migrate(db);
  let clock = Date.parse("2026-11-17T00:00:00.000Z");
  const leases = new LeaseManager(db, { ttlMs: 1_000, now: () => clock, instanceId: "i1" });
  leases.acquire("claude:a", "pi", "c1");
  clock += 1_500;
  assert.equal(leases.current("claude:a"), null);
  assert.equal(leases.sweepExpired(), 1);
  assert.doesNotThrow(() => leases.acquire("claude:a", "pi", "c2"));
});

test("启动清扫删除其他实例的租约", () => {
  const db = openDb(":memory:");
  migrate(db);
  const old = new LeaseManager(db, { instanceId: "old" });
  old.acquire("claude:a", "pi", "c1");
  const fresh = new LeaseManager(db, { instanceId: "new" });
  assert.equal(fresh.sweepForBoot(), 1);
  assert.equal(fresh.current("claude:a"), null);
});
