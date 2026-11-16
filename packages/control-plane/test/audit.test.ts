/**
 * 审计日志（C03）测试。
 * 规格：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §7.3（每步审计）/ §7.4（保留）/ §6.2（GET /api/cp/audit）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { SessionRef } from "@pi-workbench/shared";
import type { FastifyInstance } from "fastify";

import type { AgentAdapter } from "../src/adapters/types.ts";
import { AuditStore } from "../src/audit.ts";
import { CLAUDE_CAPABILITIES } from "../src/capabilities.ts";
import { CheckpointStore } from "../src/checkpoints.ts";
import type { Config } from "../src/config.ts";
import { ReadCursorStore } from "../src/cursors.ts";
import { migrate, openDb } from "../src/db.ts";
import { DispatchStore } from "../src/dispatch-store.ts";
import { EventStore } from "../src/events.ts";
import { LeaseManager } from "../src/lease.ts";
import { SessionRegistry } from "../src/registry.ts";
import { createServer } from "../src/server.ts";
import type { ServerDeps } from "../src/server.ts";
import { TakeoverEngine } from "../src/takeover.ts";

const API = "/api/cp";
const KEY = "claude:sess-1";
const CWD = "E:\\pi-workbench\\spike\\a00-workspace";
const NOW = Date.parse("2026-11-17T00:00:00.000Z");

type Clock = { now: () => number; advance: (ms: number) => void };

function makeClock(start: number = NOW): Clock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

type FakeOptions = { cancelError?: Error; onCancel?: () => void; onResume?: () => void };
type Fake = { adapter: AgentAdapter; calls: string[] };

function makeFake(opts: FakeOptions = {}): Fake {
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    newSession: async (cwd: string) => {
      calls.push("newSession:" + cwd);
      return { sessionId: "sess-new" };
    },
    resume: async (sessionId: string, cwd: string) => {
      calls.push("resume:" + sessionId + ":" + cwd);
      opts.onResume?.();
    },
    prompt: async (sessionId: string, text: string) => {
      calls.push("prompt:" + sessionId + ":" + text);
      return { messageId: "msg-" + String(calls.length) };
    },
    cancel: async (sessionId: string) => {
      calls.push("cancel:" + sessionId);
      opts.onCancel?.();
      if (opts.cancelError !== undefined) {
        throw opts.cancelError;
      }
      return { stopReason: "cancelled" };
    },
    close: async (sessionId: string) => {
      calls.push("close:" + sessionId);
    },
    onUpdate: () => () => {},
    dispose: async () => {
      calls.push("dispose");
    },
  };
  return { adapter, calls };
}

function sessionRef(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    key: KEY,
    agent: "claude",
    nativeId: "sess-1",
    cwd: CWD,
    status: "idle",
    driver: "pi",
    capabilities: CLAUDE_CAPABILITIES,
    kind: "interactive",
    ...overrides,
  };
}

type Harness = {
  app: FastifyInstance;
  db: DatabaseSync;
  audit: AuditStore;
  registry: SessionRegistry;
  handoffDir: string;
  clock: Clock;
  dispose(): Promise<void>;
};

async function makeHarness(opts: { cancelError?: Error; seed?: Partial<SessionRef>; clock?: Clock; onCancel?: () => void } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-audit-"));
  const clock = opts.clock ?? makeClock();
  const db = openDb(":memory:");
  migrate(db);
  const store = new EventStore(db);
  const leases = new LeaseManager(db, { now: clock.now });
  const registry = new SessionRegistry(db);
  const checkpoints = new CheckpointStore(db);
  const dispatches = new DispatchStore(db);
  const cursors = new ReadCursorStore(db);
  const audit = new AuditStore(db, { instanceId: "i-test", now: clock.now });
  const fake = makeFake({
    ...(opts.cancelError === undefined ? {} : { cancelError: opts.cancelError }),
    ...(opts.onCancel === undefined ? {} : { onCancel: opts.onCancel }),
    onResume: () => clock.advance(11),
  });
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    home: dir,
    authToken: null,
    leaseTtlMs: 30_000,
    dispatchReservedTtlMs: 120_000,
    auditRetentionDays: 30,
    claude: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialPermissionMode: "auto" },
    codex: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialAgentMode: "workspace-write" },
    pi: { rpcCmd: ["pi", "--mode", "rpc"] },
  };
  const handoffDir = join(dir, "handoffs");
  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter: fake.adapter,
    checkpoints,
    dispatches,
    handoffDir,
    now: clock.now,
    audit,
  });
  const deps: ServerDeps = {
    config,
    store,
    leases,
    registry,
    engine,
    adapter: fake.adapter,
    checkpoints,
    cursors,
    audit,
  };
  const app = await createServer(deps);
  registry.upsert(sessionRef(opts.seed));
  return {
    app,
    db,
    audit,
    registry,
    handoffDir,
    clock,
    dispose: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function acquire(app: FastifyInstance, clientId: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: API + "/sessions/" + KEY + "/lease",
    payload: { action: "acquire", driver: "pi", clientId },
  });
  assert.equal(res.statusCode, 200, "取租约应成功：" + res.body);
}

type AuditItem = {
  id: number;
  ts: string;
  instanceId: string;
  actor: string;
  action: string;
  sessionKey: string | null;
  outcome: "ok" | "error";
  errorCode: string | null;
  detail: unknown;
};

function detailOf(item: AuditItem | undefined): Record<string, unknown> {
  assert.ok(item !== undefined, "审计行应存在");
  return item.detail as Record<string, unknown>;
}

test("record/list 按 sessionKey、since、afterId 过滤", () => {
  const db = openDb(":memory:");
  migrate(db);
  try {
    const audit = new AuditStore(db, { instanceId: "i1", now: () => NOW });
    audit.record({ actor: "pi", action: "handoff", sessionKey: "claude:a", outcome: "ok", errorCode: null, detail: { step: "cancel" } });
    audit.record({ actor: "pi", action: "checkpoint", sessionKey: "claude:b", outcome: "error", errorCode: "E_CHECKPOINT_FAILED", detail: {} });
    assert.equal(audit.list().length, 2);
    assert.equal(audit.list({ sessionKey: "claude:a" }).length, 1);
    assert.equal(audit.list({ since: "2026-11-17T00:00:01.000Z" }).length, 0);
    const first = audit.list()[0];
    assert.ok(first !== undefined);
    assert.equal(audit.list({ afterId: first.id }).length, 1, "afterId 只返回更大的 id");
    assert.equal(audit.list({ afterId: 0 }).length, 2);
  } finally {
    db.close();
  }
});

test("prune 删除超过保留期的行，保留窗口内的行", () => {
  const db = openDb(":memory:");
  migrate(db);
  try {
    let now = Date.parse("2026-09-01T00:00:00.000Z");
    const audit = new AuditStore(db, { instanceId: "i1", now: () => now });
    audit.record({ actor: "pi", action: "handoff", sessionKey: null, outcome: "ok", errorCode: null, detail: {} });
    now = NOW;
    assert.equal(audit.prune(30), 1);
    assert.equal(audit.list().length, 0);

    audit.record({ actor: "pi", action: "checkpoint", sessionKey: null, outcome: "ok", errorCode: null, detail: {} });
    assert.equal(audit.prune(30), 0, "30 天内的行必须保留");
    assert.equal(audit.list().length, 1);
  } finally {
    db.close();
  }
});

test("record 写入失败只 console.error，绝不抛出", () => {
  const db = openDb(":memory:");
  migrate(db);
  const audit = new AuditStore(db, { instanceId: "i1" });
  db.close();
  const original = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    assert.doesNotThrow(() =>
      audit.record({ actor: "pi", action: "handoff", sessionKey: null, outcome: "ok", errorCode: null, detail: {} }),
    );
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
});

test("list 按 id 升序，默认 100 条、上限 1000 条", () => {
  const db = openDb(":memory:");
  migrate(db);
  try {
    const audit = new AuditStore(db, { instanceId: "i1", now: () => NOW });
    for (let i = 0; i < 1005; i += 1) {
      audit.record({ actor: "pi", action: "step-" + String(i), sessionKey: "claude:a", outcome: "ok", errorCode: null, detail: {} });
    }
    const byDefault = audit.list();
    assert.equal(byDefault.length, 100);
    assert.equal(byDefault[0]?.action, "step-0");
    assert.equal(byDefault[99]?.action, "step-99");
    for (let i = 1; i < byDefault.length; i += 1) {
      assert.ok((byDefault[i]?.id ?? 0) > (byDefault[i - 1]?.id ?? 0), "必须按 id 升序");
    }
    assert.equal(audit.list({ limit: 5000 }).length, 1000);
    assert.equal(audit.list({ limit: 3 }).length, 3);
  } finally {
    db.close();
  }
});

test("GET /api/cp/audit 返回 { items }，支持 sessionKey / since / limit / afterId", async () => {
  const h = await makeHarness();
  try {
    h.audit.record({ actor: "pi:1", action: "checkpoint", sessionKey: KEY, outcome: "ok", errorCode: null, detail: { step: "checkpoint" } });
    h.audit.record({ actor: "pi:1", action: "handoff", sessionKey: KEY, outcome: "ok", errorCode: null, detail: { step: "cancel" } });
    h.audit.record({ actor: "pi:2", action: "checkpoint", sessionKey: "claude:other", outcome: "ok", errorCode: null, detail: {} });

    const all = await h.app.inject({ method: "GET", url: API + "/audit" });
    assert.equal(all.statusCode, 200, all.body);
    const items = all.json<{ items: AuditItem[] }>().items;
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((item) => item.action), ["checkpoint", "handoff", "checkpoint"]);
    for (let i = 1; i < items.length; i += 1) {
      assert.ok((items[i]?.id ?? 0) > (items[i - 1]?.id ?? 0), "必须按 id 升序");
    }

    const bySession = await h.app.inject({ method: "GET", url: API + "/audit?sessionKey=" + encodeURIComponent(KEY) });
    assert.equal(bySession.statusCode, 200);
    assert.equal(bySession.json<{ items: AuditItem[] }>().items.length, 2);

    const limited = await h.app.inject({ method: "GET", url: API + "/audit?limit=1" });
    assert.equal(limited.statusCode, 200);
    assert.equal(limited.json<{ items: AuditItem[] }>().items.length, 1);

    const firstId = items[0]?.id ?? 0;
    const after = await h.app.inject({ method: "GET", url: API + "/audit?afterId=" + String(firstId) });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json<{ items: AuditItem[] }>().items.length, 2, "afterId 避免同 ts 行重复回放");

    const since = await h.app.inject({ method: "GET", url: API + "/audit?since=" + encodeURIComponent("2999-01-01T00:00:00.000Z") });
    assert.equal(since.statusCode, 200);
    assert.equal(since.json<{ items: AuditItem[] }>().items.length, 0);

    const badLimit = await h.app.inject({ method: "GET", url: API + "/audit?limit=nope" });
    assert.equal(badLimit.statusCode, 400);
    const badAfter = await h.app.inject({ method: "GET", url: API + "/audit?afterId=nope" });
    assert.equal(badAfter.statusCode, 400);
  } finally {
    await h.dispose();
  }
});

test("checkpoint 成功写一条 step=checkpoint 审计（含 durationMs）", async () => {
  const h = await makeHarness();
  try {
    await acquire(h.app, "pi:1");
    const saved = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + KEY + "/checkpoint",
      payload: { clientId: "pi:1", summary: "审计检查点", touchedFiles: ["a.ts"], nextStep: "继续" },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const res = await h.app.inject({ method: "GET", url: API + "/audit?sessionKey=" + encodeURIComponent(KEY) });
    const items = res.json<{ items: AuditItem[] }>().items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.action, "checkpoint");
    assert.equal(items[0]?.outcome, "ok");
    assert.equal(items[0]?.errorCode, null);
    assert.equal(items[0]?.actor, "pi:1");
    assert.equal(items[0]?.instanceId, "i-test");
    assert.equal(items[0]?.sessionKey, KEY);
    const detail = detailOf(items[0]);
    assert.equal(detail["step"], "checkpoint");
    assert.equal(typeof detail["durationMs"], "number");
    assert.ok((detail["durationMs"] as number) >= 0);
  } finally {
    await h.dispose();
  }
});

test("handoff cancel 失败：审计 outcome=error、errorCode、durationMs", async () => {
  const h = await makeHarness({ cancelError: new Error("cancel boom"), seed: { status: "running" }, onCancel: () => h.clock.advance(7) });
  try {
    await acquire(h.app, "pi:1");
    const failed = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + KEY + "/handoff",
      payload: { to: "human", clientId: "pi:1" },
    });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json<{ error: { code: string } }>().error.code, "E_HANDOFF_FAILED");

    const res = await h.app.inject({ method: "GET", url: API + "/audit?sessionKey=" + encodeURIComponent(KEY) });
    const items = res.json<{ items: AuditItem[] }>().items;
    assert.equal(items.length, 1, "失败后不应继续写后续步骤");
    assert.equal(items[0]?.action, "handoff");
    assert.equal(items[0]?.outcome, "error");
    assert.equal(items[0]?.errorCode, "E_HANDOFF_FAILED");
    const detail = detailOf(items[0]);
    assert.equal(detail["step"], "cancel");
    assert.equal(detail["errorCode"], "E_HANDOFF_FAILED");
    assert.equal(detail["durationMs"], 7);
  } finally {
    await h.dispose();
  }
});

test("handoff 内 checkpoint 失败：500 E_CHECKPOINT_FAILED，details.action=checkpoint", async () => {
  const h = await makeHarness();
  try {
    await acquire(h.app, "pi:1");
    // 直接让 checkpoints.save 失败：文件名已带 key 哈希与序号，不能再靠占位目录制造 rename 失败
    h.db.exec(
      "CREATE TRIGGER fail_checkpoint_save BEFORE INSERT ON checkpoints " +
        "BEGIN SELECT RAISE(ABORT, 'checkpoint save boom'); END;",
    );

    const failed = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + KEY + "/handoff",
      payload: { to: "human", clientId: "pi:1" },
    });
    assert.equal(failed.statusCode, 500, failed.body);
    const envelope = failed.json<{ error: { code: string; details: { action?: string; step?: string } } }>();
    assert.equal(envelope.error.code, "E_CHECKPOINT_FAILED");
    assert.equal(envelope.error.details.action, "checkpoint");
    assert.equal(envelope.error.details.step, "checkpoint");

    const res = await h.app.inject({ method: "GET", url: API + "/audit?sessionKey=" + encodeURIComponent(KEY) });
    const items = res.json<{ items: AuditItem[] }>().items;
    assert.deepEqual(items.map((item) => detailOf(item)["step"]), ["cancel", "checkpoint"]);
    assert.deepEqual(items.map((item) => item.outcome), ["ok", "error"]);
    assert.equal(items[1]?.errorCode, "E_CHECKPOINT_FAILED");
    assert.equal(detailOf(items[1])["errorCode"], "E_CHECKPOINT_FAILED");
    assert.equal(typeof detailOf(items[1])["durationMs"], "number");
  } finally {
    await h.dispose();
  }
});

test("handoff 四步 + handback resume 逐条留痕，durationMs 可度量", async () => {
  const h = await makeHarness();
  try {
    await acquire(h.app, "pi:1");
    const handoff = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + KEY + "/handoff",
      payload: { to: "human", clientId: "pi:1", summary: "交给人类" },
    });
    assert.equal(handoff.statusCode, 200, handoff.body);

    const handback = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + KEY + "/handback",
      payload: { clientId: "handoff-pi:1" },
    });
    assert.equal(handback.statusCode, 200, handback.body);

    const res = await h.app.inject({ method: "GET", url: API + "/audit?sessionKey=" + encodeURIComponent(KEY) });
    const items = res.json<{ items: AuditItem[] }>().items;
    assert.deepEqual(items.map((item) => item.action), ["handoff", "handoff", "handoff", "handoff", "handback"]);
    assert.deepEqual(items.map((item) => detailOf(item)["step"]), ["cancel", "checkpoint", "close", "handoff", "resume"]);
    assert.deepEqual(items.map((item) => item.outcome), ["ok", "ok", "ok", "ok", "ok"]);
    assert.deepEqual(items.map((item) => item.errorCode), [null, null, null, null, null]);
    for (const item of items) {
      assert.equal(typeof detailOf(item)["durationMs"], "number");
      assert.ok((detailOf(item)["durationMs"] as number) >= 0);
    }
    assert.equal(detailOf(items[0])["skipped"], true, "idle 会话的 quiesce 记录为 skipped");
    assert.equal(detailOf(items[4])["durationMs"], 11, "resume 耗时按注入时钟度量");
  } finally {
    await h.dispose();
  }
});
