import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionStatus } from "@pi-workbench/shared";
import { migrate, openDb } from "../src/db.ts";
import { EventStore } from "../src/events.ts";
import { SessionRegistry } from "../src/registry.ts";
import { reconcileSessions } from "../src/boot-recovery.ts";

const ref = (key: string, driver: "pi" | "human" | "none", status: SessionStatus) => ({
  key,
  agent: "claude",
  nativeId: key.split(":")[1]!,
  cwd: "/tmp",
  kind: "interactive" as const,
  status,
  driver,
  capabilities: {} as never,
});

test("对账把 driver 会话置 driver=none/unknown 并只写一次事件", () => {
  const db = openDb(":memory:");
  migrate(db);
  const registry = new SessionRegistry(db);
  const store = new EventStore(db);
  registry.upsert(ref("claude:a", "pi", "running"));
  registry.upsert(ref("claude:b", "human", "handoff"));
  const report = reconcileSessions({ registry, store, instanceId: "i1" });
  assert.deepEqual(report, { total: 2, markedUnknown: 1, keptHandoff: 1 });
  assert.equal(registry.get("claude:a")?.driver, "none");
  assert.equal(registry.get("claude:a")?.status, "unknown");
  assert.equal(registry.get("claude:b")?.driver, "human");
  assert.equal(registry.get("claude:b")?.status, "handoff");
  assert.equal(store.list("claude:a").length, 1);
  assert.equal(store.list("claude:a")[0]?.type, "state_update");
  assert.deepEqual(store.list("claude:a")[0]?.payload, {
    reason: "daemon_restart",
    previous: { driver: "pi", status: "running" },
  });
  assert.equal(store.list("claude:b").length, 0);
  reconcileSessions({ registry, store, instanceId: "i1" });
  assert.equal(store.list("claude:a").length, 1);
});

test("非终态全部置 unknown（含 idle/handoff），none 与 exited 不动", () => {
  const db = openDb(":memory:");
  migrate(db);
  const registry = new SessionRegistry(db);
  const store = new EventStore(db);
  registry.upsert(ref("claude:c", "pi", "starting"));
  registry.upsert(ref("codex:d", "pi", "needs-input"));
  registry.upsert(ref("claude:e", "pi", "idle"));
  registry.upsert(ref("claude:f", "pi", "handoff"));
  registry.upsert(ref("claude:g", "pi", "exited"));
  registry.upsert(ref("pi:h", "none", "running"));

  const report = reconcileSessions({ registry, store, instanceId: "i2" });
  assert.deepEqual(report, { total: 6, markedUnknown: 4, keptHandoff: 0 });
  for (const key of ["claude:c", "codex:d", "claude:e", "claude:f"]) {
    assert.equal(registry.get(key)?.driver, "none", key + " driver 应为 none");
    assert.equal(registry.get(key)?.status, "unknown", key + " status 应为 unknown");
  }
  assert.equal(registry.get("claude:g")?.driver, "pi");
  assert.equal(registry.get("claude:g")?.status, "exited");
  assert.equal(registry.get("pi:h")?.driver, "none");
  assert.equal(registry.get("pi:h")?.status, "running");
  assert.equal(store.list("claude:g").length, 0);
  assert.equal(store.list("pi:h").length, 0);
  assert.deepEqual(store.list("claude:e")[0]?.payload, {
    reason: "daemon_restart",
    previous: { driver: "pi", status: "idle" },
  });
  assert.deepEqual(store.list("claude:f")[0]?.payload, {
    reason: "daemon_restart",
    previous: { driver: "pi", status: "handoff" },
  });
  assert.equal(store.list("claude:c")[0]?.source, "claude");
  assert.equal(store.list("claude:c")[0]?.idempotencyKey, "recovery:i2:claude:c");
});

test("对账结果落库，重新 loadFromDb 后仍是 driver=none/unknown", () => {
  const db = openDb(":memory:");
  migrate(db);
  const registry = new SessionRegistry(db);
  const store = new EventStore(db);
  registry.upsert(ref("claude:persist", "pi", "running"));
  reconcileSessions({ registry, store, instanceId: "i3" });

  // 模拟下一次冷启动：新 registry 从库恢复，driver / 状态 / 事件都还在。
  const reloaded = new SessionRegistry(db);
  assert.equal(reloaded.loadFromDb(), 1);
  assert.equal(reloaded.get("claude:persist")?.driver, "none");
  assert.equal(reloaded.get("claude:persist")?.status, "unknown");
  assert.equal(new EventStore(db).list("claude:persist").length, 1);
});
