/**
 * 审计日志（C03）测试。
 * 规格：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §7.4（30 天保留）/ §6.2（GET /api/cp/audit）。
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

type FakeOptions = { cancelError?: Error };
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
    },
    prompt: async (sessionId: string, text: string) => {
      calls.push("prompt:" + sessionId + ":" + text);
      return { messageId: "msg-" + String(calls.length) };
    },
    cancel: async (sessionId: string) => {
      calls.push("cancel:" + sessionId);
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
  dispose(): Promise<void>;
};

async function makeHarness(opts: { cancelError?: Error; seed?: Partial<SessionRef> } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-audit-"));
  const db = openDb(":memory:");
  migrate(db);
  const store = new EventStore(db);
  const leases = new LeaseManager(db);
  const registry = new SessionRegistry(db);
  const checkpoints = new CheckpointStore(db);
  const dispatches = new DispatchStore(db);
  const cursors = new ReadCursorStore(db);
  const audit = new AuditStore(db, { instanceId: "i-test" });
  const fake = makeFake(opts);
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    home: dir,
    authToken: null,
    leaseTtlMs: 30_000,
    dispatchReservedTtlMs: 120_000,
    claude: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialPermissionMode: "auto" },
    codex: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialAgentMode: "workspace-write" },
    pi: { rpcCmd: ["pi", "--mode", "rpc"] },
  };
  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter: fake.adapter,
    checkpoints,
    dispatches,
    handoffDir: join(dir, "handoffs"),
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

test("record/list 按 sessionKey 与 since 过滤", () => {
  const db = openDb(":memory:");
  migrate(db);
  try {
    const audit = new AuditStore(db, { instanceId: "i1", now: () => Date.parse("2026-11-17T00:00:00.000Z") });
    audit.record({ actor: "pi", action: "handoff", sessionKey: "claude:a", outcome: "ok", errorCode: null, detail: { step: "cancel" } });
    audit.record({ actor: "pi", action: "checkpoint", sessionKey: "claude:b", outcome: "error", errorCode: "E_CHECKPOINT_FAILED", detail: {} });
    assert.equal(audit.list().length, 2);
    assert.equal(audit.list({ sessionKey: "claude:a" }).length, 1);
    assert.equal(audit.list({ since: "2026-11-17T00:00:01.000Z" }).length, 0);
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
    now = Date.parse("2026-11-17T00:00:00.000Z");
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
    const audit = new AuditStore(db, { instanceId: "i1", now: () => Date.parse("2026-11-17T00:00:00.000Z") });
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

test("GET /api/cp/audit 返回 { items }，支持 sessionKey / since / limit", async () => {
  const h = await makeHarness();
  try {
    h.audit.record({ actor: "pi:1", action: "checkpoint", sessionKey: KEY, outcome: "ok", errorCode: null, detail: { step: "checkpoint" } });
    h.audit.record({ actor: "pi:1", action: "handoff", sessionKey: KEY, outcome: "ok", errorCode: null, detail: { to: "human" } });
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

    const since = await h.app.inject({ method: "GET", url: API + "/audit?since=" + encodeURIComponent("2999-01-01T00:00:00.000Z") });
    assert.equal(since.statusCode, 200);
    assert.equal(since.json<{ items: AuditItem[] }>().items.length, 0);

    const badLimit = await h.app.inject({ method: "GET", url: API + "/audit?limit=nope" });
    assert.equal(badLimit.statusCode, 400);
  } finally {
    await h.dispose();
  }
});

test("checkpoint 成功后写审计（action/outcome/actor/instanceId）", async () => {
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
  } finally {
    await h.dispose();
  }
});

test("handoff 失败写 errorCode 与出错步骤（cancel）", async () => {
  const h = await makeHarness({ cancelError: new Error("cancel boom"), seed: { status: "running" } });
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
    assert.equal(items.length, 1);
    assert.equal(items[0]?.action, "handoff");
    assert.equal(items[0]?.outcome, "error");
    assert.equal(items[0]?.errorCode, "E_HANDOFF_FAILED");
    assert.deepEqual(items[0]?.detail, { to: "human", step: "cancel" });
  } finally {
    await h.dispose();
  }
});

test("handoff 与 handback 成功各写一条 ok 审计", async () => {
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
    assert.deepEqual(items.map((item) => item.action), ["handoff", "handback"]);
    assert.deepEqual(items.map((item) => item.outcome), ["ok", "ok"]);
    assert.equal((items[0]?.detail as { to?: string }).to, "human");
  } finally {
    await h.dispose();
  }
});
