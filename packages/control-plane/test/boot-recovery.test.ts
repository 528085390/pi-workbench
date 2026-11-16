import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, openDb } from "../src/db.ts";
import { EventStore } from "../src/events.ts";
import { SessionRegistry } from "../src/registry.ts";
import { reconcileSessions } from "../src/boot-recovery.ts";

const ref = (key: string, driver: "pi" | "human" | "none", status: "running" | "handoff") => ({
  key, agent: "claude", nativeId: key.split(":")[1]!, cwd: "/tmp", kind: "interactive" as const,
  status, driver, capabilities: {} as never,
});

test("对账把 driver 会话置 unknown 并只写一次事件", () => {
  const db = openDb(":memory:");
  migrate(db);
  const registry = new SessionRegistry(db);
  const store = new EventStore(db);
  registry.upsert(ref("claude:a", "pi", "running"));
  registry.upsert(ref("claude:b", "human", "handoff"));
  const report = reconcileSessions({ registry, store, instanceId: "i1" });
  assert.deepEqual(report, { total: 2, markedUnknown: 1, keptHandoff: 1 });
  assert.equal(registry.get("claude:a")?.status, "unknown");
  assert.equal(registry.get("claude:b")?.status, "handoff");
  assert.equal(store.list("claude:a").length, 1);
  assert.equal(store.list("claude:a")[0]?.type, "state_update");
  assert.equal(store.list("claude:b").length, 0);
  reconcileSessions({ registry, store, instanceId: "i1" });
  assert.equal(store.list("claude:a").length, 1);
});

test("starting / needs-input 同样置 unknown，none 与终态不动", () => {
  const db = openDb(":memory:");
  migrate(db);
  const registry = new SessionRegistry(db);
  const store = new EventStore(db);
  registry.upsert({ ...ref("claude:c", "pi", "running"), status: "starting" });
  registry.upsert({ ...ref("codex:d", "pi", "running"), status: "needs-input" });
  registry.upsert(ref("pi:e", "none", "running"));
  const report = reconcileSessions({ registry, store, instanceId: "i2" });
  assert.deepEqual(report, { total: 3, markedUnknown: 2, keptHandoff: 0 });
  assert.equal(registry.get("claude:c")?.status, "unknown");
  assert.equal(registry.get("codex:d")?.status, "unknown");
  assert.equal(registry.get("pi:e")?.status, "running");
  assert.equal(store.list("pi:e").length, 0);
  assert.deepEqual(store.list("claude:c")[0]?.payload, {
    reason: "daemon_restart",
    previous: { driver: "pi", status: "starting" },
  });
  assert.equal(store.list("claude:c")[0]?.source, "claude");
  assert.equal(store.list("claude:c")[0]?.idempotencyKey, "recovery:i2:claude:c");
});

test("对账结果落库，重新 loadFromDb 后仍是 unknown", () => {
  const db = openDb(":memory:");
  migrate(db);
  const registry = new SessionRegistry(db);
  const store = new EventStore(db);
  registry.upsert(ref("claude:persist", "pi", "running"));
  reconcileSessions({ registry, store, instanceId: "i3" });

  // 模拟下一次冷启动：新 registry 从库恢复，状态与事件都还在。
  const reloaded = new SessionRegistry(db);
  assert.equal(reloaded.loadFromDb(), 1);
  assert.equal(reloaded.get("claude:persist")?.status, "unknown");
  assert.equal(new EventStore(db).list("claude:persist").length, 1);
});
