/**
 * HTTP/WS 服务层测试（A06 收尾 + A10 前置，Task 8）。
 * 口径：task-8-brief 的 R31–R47；spec §6（API 契约）/ §7（事件模型）。
 * HTTP 走 app.inject；WS 走真 listen（127.0.0.1:0）+ Node 内置 WebSocket 客户端。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { SessionCaps, SessionRef } from "@pi-workbench/shared";
import type { FastifyInstance } from "fastify";

import type { AgentAdapter } from "../src/adapters/types.ts";
import { CLAUDE_CAPABILITIES } from "../src/capabilities.ts";
import { CheckpointStore } from "../src/checkpoints.ts";
import type { Config } from "../src/config.ts";
import { migrate, openDb } from "../src/db.ts";
import { DispatchStore } from "../src/dispatch-store.ts";
import { isWorkbenchError } from "../src/errors.ts";
import { EventStore } from "../src/events.ts";
import { LeaseManager } from "../src/lease.ts";
import { SessionRegistry } from "../src/registry.ts";
import { STATUS_BY_CODE, createServer, startServer } from "../src/server.ts";
import type { ServerDeps, ServerTranscriptReader } from "../src/server.ts";
import { TakeoverEngine } from "../src/takeover.ts";

const SESSION_KEY = "claude:sess-1";
const CWD = "E:\\pi-workbench\\spike\\a00-workspace";
const TRANSCRIPT = "C:/tmp/pi-workbench-api-test/sess-1.jsonl";
const API = "/api/cp";
const SESSIONS = API + "/sessions/" + SESSION_KEY;

type FakeOptions = { newSessionError?: Error; resumeError?: Error; cancelError?: Error };
type Fake = { adapter: AgentAdapter; calls: string[] };

/** 假 adapter：只记录调用，不起子进程 */
function makeFake(opts: FakeOptions = {}): Fake {
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    newSession: async (cwd: string) => {
      calls.push("newSession:" + cwd);
      if (opts.newSessionError !== undefined) {
        throw opts.newSessionError;
      }
      return { sessionId: "sess-new" };
    },
    resume: async (sessionId: string, cwd: string) => {
      calls.push("resume:" + sessionId + ":" + cwd);
      if (opts.resumeError !== undefined) {
        throw opts.resumeError;
      }
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
    key: SESSION_KEY,
    agent: "claude",
    nativeId: "sess-1",
    acpSessionId: "sess-1",
    cwd: CWD,
    transcriptPath: TRANSCRIPT,
    status: "idle",
    driver: "pi",
    capabilities: CLAUDE_CAPABILITIES,
    kind: "interactive",
    ...overrides,
  };
}

function makeConfig(home: string, overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    home,
    authToken: null,
    leaseTtlMs: 30_000,
    claude: { adapterCmd: [process.execPath], permissionMode: "auto_allow" },
    ...overrides,
  };
}

type Bundle = {
  deps: ServerDeps;
  db: DatabaseSync;
  store: EventStore;
  leases: LeaseManager;
  registry: SessionRegistry;
  checkpoints: CheckpointStore;
  calls: string[];
  dir: string;
  dispose(): void;
};

type BundleOptions = {
  config?: Partial<Config>;
  fakeOptions?: FakeOptions;
  readTranscript?: ServerTranscriptReader;
};

function makeBundle(opts: BundleOptions = {}): Bundle {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-api-"));
  const db = openDb(":memory:");
  migrate(db);

  const store = new EventStore(db);
  const leases = new LeaseManager(db);
  const registry = new SessionRegistry(db);
  const checkpoints = new CheckpointStore(db);
  const dispatches = new DispatchStore(db);
  const fake = makeFake(opts.fakeOptions);
  const config = makeConfig(dir, opts.config);

  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter: fake.adapter,
    checkpoints,
    dispatches,
    handoffDir: join(dir, "handoffs"),
    readTranscript: opts.readTranscript,
  });

  const deps: ServerDeps = {
    config,
    store,
    leases,
    registry,
    engine,
    adapter: fake.adapter,
    checkpoints,
    readTranscript: opts.readTranscript,
  };

  return {
    deps,
    db,
    store,
    leases,
    registry,
    checkpoints,
    calls: fake.calls,
    dir,
    dispose: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Harness = Bundle & { app: FastifyInstance; url: string; port: number; close(): Promise<void> };

type HarnessOptions = BundleOptions & { listen?: boolean; seed?: SessionRef[] | null };

async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const bundle = makeBundle(opts);
  let app: FastifyInstance;
  let url = "";
  let port = 0;
  if (opts.listen === true) {
    const handle = await startServer(bundle.deps);
    app = handle.app;
    url = handle.url;
    port = handle.port;
  } else {
    app = await createServer(bundle.deps);
  }

  const seeds = opts.seed === undefined ? [sessionRef()] : opts.seed;
  if (seeds !== null) {
    for (const ref of seeds) {
      bundle.registry.upsert(ref);
    }
  }

  return {
    ...bundle,
    app,
    url,
    port,
    close: async () => {
      await app.close();
      bundle.dispose();
    },
  };
}

/** 取一条有效租约（inject / interrupt / checkpoint / handoff 都要先持有） */
async function acquire(app: FastifyInstance, clientId: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: SESSIONS + "/lease",
    payload: { action: "acquire", driver: "pi", clientId },
  });
  assert.equal(res.statusCode, 200, "取租约应成功：" + res.body);
}

type ErrorEnvelope = { error: { code: string; message: string; details?: unknown } };

// ---------------------------------------------------------------- 健康检查

test("GET /health 与 /api/cp/health 都是 T1 健康形状（R31）", async () => {
  const h = await makeHarness();
  try {
    for (const path of ["/health", API + "/health"]) {
      const res = await h.app.inject({ method: "GET", url: path });
      assert.equal(res.statusCode, 200, path + " 应 200");
      const body = res.json<{ ok: boolean; name: string; version: string; pid: number; uptimeMs: number }>();
      assert.equal(body.ok, true);
      assert.equal(body.name, "pi-workbenchd");
      assert.equal(typeof body.version, "string");
      assert.equal(body.pid, process.pid);
      assert.ok(body.uptimeMs >= 0);
    }
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- agents

test("GET /agents 复用能力矩阵常量（R37）", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: API + "/agents" });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ agent: string; available: boolean; version: string; caps: SessionCaps }[]>();
    assert.equal(body.length, 1);
    const first = body[0];
    assert.ok(first !== undefined);
    assert.equal(first.agent, "claude");
    assert.equal(first.version, "unknown");
    assert.equal(typeof first.available, "boolean");
    assert.deepEqual(first.caps, CLAUDE_CAPABILITIES);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- sessions

test("GET /sessions 支持 agent / status 过滤", async () => {
  const h = await makeHarness({
    seed: [sessionRef(), sessionRef({ key: "claude:sess-2", nativeId: "sess-2", status: "running" })],
  });
  try {
    const all = await h.app.inject({ method: "GET", url: API + "/sessions" });
    assert.equal(all.statusCode, 200);
    assert.equal(all.json<SessionRef[]>().length, 2);

    const byAgent = await h.app.inject({ method: "GET", url: API + "/sessions?agent=claude" });
    assert.equal(byAgent.json<SessionRef[]>().length, 2);

    const otherAgent = await h.app.inject({ method: "GET", url: API + "/sessions?agent=codex" });
    assert.equal(otherAgent.json<SessionRef[]>().length, 0);

    const byStatus = await h.app.inject({ method: "GET", url: API + "/sessions?status=running" });
    const running = byStatus.json<SessionRef[]>();
    assert.equal(running.length, 1);
    assert.equal(running[0]?.key, "claude:sess-2");
  } finally {
    await h.close();
  }
});

test("GET /sessions/:key 返回 {session, lease}；未知 key → 404 E_SESSION_NOT_FOUND", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: SESSIONS });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ session: SessionRef; lease: unknown }>();
    assert.equal(body.session.key, SESSION_KEY);
    assert.equal(body.lease, null);

    const missing = await h.app.inject({ method: "GET", url: API + "/sessions/claude:nope" });
    assert.equal(missing.statusCode, 404);
    const err = missing.json<ErrorEnvelope>();
    assert.equal(err.error.code, "E_SESSION_NOT_FOUND");
    assert.equal(typeof err.error.message, "string");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- 租约

test("POST lease：acquire / heartbeat / release 与冲突（R36）", async () => {
  const h = await makeHarness();
  try {
    const acquired = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/lease",
      payload: { action: "acquire", driver: "pi", clientId: "pi:1" },
    });
    assert.equal(acquired.statusCode, 200);
    const lease = acquired.json<{ sessionKey: string; driver: string; clientId: string; expiresAt: string }>();
    assert.equal(lease.sessionKey, SESSION_KEY);
    assert.equal(lease.driver, "pi");
    assert.equal(lease.clientId, "pi:1");
    assert.ok(!Number.isNaN(Date.parse(lease.expiresAt)));

    const detail = await h.app.inject({ method: "GET", url: SESSIONS });
    assert.equal(detail.json<{ lease: { clientId: string } | null }>().lease?.clientId, "pi:1");

    const conflict = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/lease",
      payload: { action: "acquire", driver: "human", clientId: "human:1" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json<ErrorEnvelope>().error.code, "E_LEASE_CONFLICT");

    const heartbeat = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/lease",
      payload: { action: "heartbeat", clientId: "pi:1" },
    });
    assert.equal(heartbeat.statusCode, 200);
    assert.equal(heartbeat.json<{ clientId: string }>().clientId, "pi:1");

    const released = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/lease",
      payload: { action: "release", clientId: "pi:1" },
    });
    assert.equal(released.statusCode, 200);
    assert.equal(released.json<{ released: boolean }>().released, true);

    const after = await h.app.inject({ method: "GET", url: SESSIONS });
    assert.equal(after.json<{ lease: unknown }>().lease, null);

    const missingClient = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/lease",
      payload: { action: "acquire" },
    });
    assert.equal(missingClient.statusCode, 400);
    assert.equal(missingClient.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    const badAction = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/lease",
      payload: { action: "steal", clientId: "pi:1" },
    });
    assert.equal(badAction.statusCode, 400);
    assert.equal(badAction.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- 接管原语

test("POST inject：无租约 → 409 E_NO_LEASE；有租约 → {messageId, effective}", async () => {
  const h = await makeHarness();
  try {
    const denied = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/inject",
      payload: { text: "hi", clientId: "pi:1" },
    });
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.json<ErrorEnvelope>().error.code, "E_NO_LEASE");
    assert.equal(h.calls.filter((call) => call.startsWith("prompt:")).length, 0, "无租约不得投递 prompt");

    await acquire(h.app, "pi:1");
    const ok = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/inject",
      payload: { text: "hi", clientId: "pi:1" },
    });
    assert.equal(ok.statusCode, 200);
    const body = ok.json<{ messageId: string; effective: string }>();
    assert.equal(typeof body.messageId, "string");
    assert.equal(body.effective, "now");

    const noClient = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/inject",
      payload: { text: "hi" },
    });
    assert.equal(noClient.statusCode, 400);
    assert.equal(noClient.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");
  } finally {
    await h.close();
  }
});

test("POST interrupt：返回 stopReason 并落 state_update 事件", async () => {
  const h = await makeHarness();
  try {
    await acquire(h.app, "pi:1");
    const res = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/interrupt",
      payload: { clientId: "pi:1" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json<{ stopReason: string }>().stopReason, "cancelled");
    assert.equal(h.calls.filter((call) => call.startsWith("cancel:")).length, 1);
    const types = h.store.listAll(0).map((event) => event.type);
    assert.ok(types.includes("state_update"), "interrupt 应落 state_update 事件");
  } finally {
    await h.close();
  }
});

test("checkpoint：POST 缺 clientId → 400；GET 先 null 再返回保存的检查点（R36 / R46）", async () => {
  const h = await makeHarness();
  try {
    const empty = await h.app.inject({ method: "GET", url: SESSIONS + "/checkpoint" });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json<unknown>(), null);

    const missingClient = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/checkpoint",
      payload: { summary: "s", touchedFiles: [], nextStep: "n" },
    });
    assert.equal(missingClient.statusCode, 400);
    assert.equal(missingClient.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    await acquire(h.app, "pi:1");
    const saved = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/checkpoint",
      payload: { summary: "摘要", touchedFiles: ["a.ts"], nextStep: "继续", clientId: "pi:1" },
    });
    assert.equal(saved.statusCode, 200);
    const checkpoint = saved.json<{ sessionKey: string; summary: string; touchedFiles: string[] }>();
    assert.equal(checkpoint.sessionKey, SESSION_KEY);
    assert.equal(checkpoint.summary, "摘要");
    assert.deepEqual(checkpoint.touchedFiles, ["a.ts"]);

    const latest = await h.app.inject({ method: "GET", url: SESSIONS + "/checkpoint" });
    assert.equal(latest.statusCode, 200);
    const stored = latest.json<{ summary: string; nextStep: string; transcriptCursor: string }>();
    assert.equal(stored.summary, "摘要");
    assert.equal(stored.nextStep, "继续");
    assert.equal(typeof stored.transcriptCursor, "string");
  } finally {
    await h.close();
  }
});

test("POST handoff → checkpoint + command + mode；handback 接回（R36）", async () => {
  const h = await makeHarness();
  try {
    await acquire(h.app, "pi:1");
    const handoff = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/handoff",
      payload: { to: "human", clientId: "pi:1", summary: "交给人类", touchedFiles: [], nextStep: "看 TUI" },
    });
    assert.equal(handoff.statusCode, 200);
    const body = handoff.json<{ checkpoint: { summary: string }; command: string[]; mode: string }>();
    assert.equal(body.checkpoint.summary, "交给人类");
    assert.deepEqual(body.command, ["claude", "--resume", "sess-1"]);
    assert.equal(body.mode, "resume-tui");

    const noClient = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/handoff",
      payload: { to: "human", clientId: "" },
    });
    assert.equal(noClient.statusCode, 400);

    const handback = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/handback",
      payload: { clientId: "handoff-pi:1" },
    });
    assert.equal(handback.statusCode, 200);
    const back = handback.json<{ resumed: boolean; deltaSummary: string }>();
    assert.equal(back.resumed, true);
    assert.equal(typeof back.deltaSummary, "string");
    assert.equal(h.calls.filter((call) => call.startsWith("resume:")).length, 1);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- dispatch

test("POST dispatch 返回 SessionRef 且同 key 幂等（R28）", async () => {
  const h = await makeHarness();
  try {
    const payload = { agent: "claude", task: "写测试", idempotencyKey: "idem-1" };
    const first = await h.app.inject({ method: "POST", url: API + "/dispatch", payload });
    assert.equal(first.statusCode, 200);
    const ref = first.json<SessionRef>();
    assert.equal(ref.key, "claude:sess-new");
    assert.equal(ref.agent, "claude");
    assert.equal(ref.nativeId, "sess-new");
    assert.equal(ref.status, "running");
    assert.equal(ref.driver, "pi");
    assert.deepEqual(ref.capabilities, CLAUDE_CAPABILITIES);
    assert.ok(typeof ref.cwd === "string" && ref.cwd.length > 0);

    const second = await h.app.inject({ method: "POST", url: API + "/dispatch", payload });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json<SessionRef>().key, ref.key);
    assert.equal(h.calls.filter((call) => call.startsWith("newSession:")).length, 1, "同 key 只允许建一次会话");

    const listed = await h.app.inject({ method: "GET", url: API + "/sessions" });
    assert.ok(listed.json<SessionRef[]>().some((item) => item.key === "claude:sess-new"));

    const badAgent = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "codex", task: "x", idempotencyKey: "idem-2" },
    });
    assert.equal(badAgent.statusCode, 400);
    assert.equal(badAgent.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    const noTask = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "claude", task: "  ", idempotencyKey: "idem-3" },
    });
    assert.equal(noTask.statusCode, 400);

    const noKey = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "claude", task: "x" },
    });
    assert.equal(noKey.statusCode, 400);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- transcript

test("GET transcript 用注入的 readTranscript（R46）", async () => {
  const reader: ServerTranscriptReader = (path, cursor, limit) => ({
    messages: [
      {
        id: "m1",
        role: "assistant",
        kind: "text",
        text: "看到 " + path + " @" + (cursor ?? "0") + " limit=" + String(limit),
        ts: "2026-11-15T00:00:00.000Z",
      },
    ],
    nextCursor: "42",
    pending: false,
  });
  const h = await makeHarness({ readTranscript: reader });
  try {
    const res = await h.app.inject({ method: "GET", url: SESSIONS + "/transcript?after=0&limit=5" });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ messages: { id: string; text: string }[]; nextCursor: string }>();
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0]?.id, "m1");
    assert.ok(body.messages[0]?.text.includes("limit=5"));
    assert.equal(body.nextCursor, "42");

    const missing = await h.app.inject({ method: "GET", url: API + "/sessions/claude:nope/transcript" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json<ErrorEnvelope>().error.code, "E_SESSION_NOT_FOUND");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- 鉴权（R32）

test("非 loopback + token：/api/cp/* 需 Bearer，/health 免鉴权", async () => {
  const h = await makeHarness({ config: { host: "0.0.0.0", authToken: "tok-123" } });
  try {
    const noHeader = await h.app.inject({ method: "GET", url: API + "/agents" });
    assert.equal(noHeader.statusCode, 401);
    const err = noHeader.json<ErrorEnvelope>();
    assert.equal(err.error.code, "E_UNAUTHORIZED");

    const wrong = await h.app.inject({
      method: "GET",
      url: API + "/agents",
      headers: { authorization: "Bearer nope" },
    });
    assert.equal(wrong.statusCode, 401);

    const ok = await h.app.inject({
      method: "GET",
      url: API + "/agents",
      headers: { authorization: "Bearer tok-123" },
    });
    assert.equal(ok.statusCode, 200);

    for (const path of ["/health", API + "/health"]) {
      const health = await h.app.inject({ method: "GET", url: path });
      assert.equal(health.statusCode, 200, path + " 应免鉴权");
    }
  } finally {
    await h.close();
  }
});

test("非 loopback 且无 token：拒绝构造，不静默裸奔（R32）", async () => {
  const bundle = makeBundle({ config: { host: "0.0.0.0", authToken: null } });
  try {
    await assert.rejects(
      () => createServer(bundle.deps),
      (err: unknown) => {
        assert.ok(isWorkbenchError(err), "应为 WorkbenchError");
        assert.equal(err.code, "E_UNAUTHORIZED");
        return true;
      },
    );
    await assert.rejects(() => startServer(bundle.deps), (err: unknown) => {
      assert.ok(isWorkbenchError(err));
      assert.equal(err.code, "E_UNAUTHORIZED");
      return true;
    });
  } finally {
    bundle.dispose();
  }
});

// ---------------------------------------------------------------- 错误映射（R35）

test("错误码 → 状态码映射覆盖 R35 全表", () => {
  assert.deepEqual(STATUS_BY_CODE, {
    E_BAD_REQUEST: 400,
    E_UNAUTHORIZED: 401,
    E_SESSION_NOT_FOUND: 404,
    E_LEASE_CONFLICT: 409,
    E_NO_LEASE: 409,
    E_IDEMPOTENCY_CONFLICT: 409,
    E_CAP_UNSUPPORTED: 422,
    E_ADAPTER_DOWN: 503,
    E_RESUME_REJECTED: 503,
  });
});

test("错误体形状与状态码（E_BAD_REQUEST / E_NO_LEASE / E_IDEMPOTENCY_CONFLICT / E_RESUME_REJECTED）", async () => {
  const h = await makeHarness({ fakeOptions: { resumeError: new Error("resume denied") } });
  try {
    // E_BAD_REQUEST：请求体不是 JSON 对象
    const notObject = await h.app.inject({ method: "POST", url: SESSIONS + "/inject", payload: "x" });
    assert.equal(notObject.statusCode, 400);
    assert.equal(notObject.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    // E_NO_LEASE：无租约 interrupt
    const noLease = await h.app.inject({ method: "POST", url: SESSIONS + "/interrupt", payload: { clientId: "pi:1" } });
    assert.equal(noLease.statusCode, 409);
    assert.equal(noLease.json<ErrorEnvelope>().error.code, "E_NO_LEASE");

    // E_RESUME_REJECTED：handback 的 resume 失败 → 503
    await acquire(h.app, "pi:1");
    const handoff = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/handoff",
      payload: { to: "human", clientId: "pi:1" },
    });
    assert.equal(handoff.statusCode, 200);
    const handback = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/handback",
      payload: { clientId: "handoff-pi:1" },
    });
    assert.equal(handback.statusCode, 503);
    assert.equal(handback.json<ErrorEnvelope>().error.code, "E_RESUME_REJECTED");

    // E_IDEMPOTENCY_CONFLICT：同 key 换 payload
    const first = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "claude", task: "a", idempotencyKey: "idem-x" },
    });
    assert.equal(first.statusCode, 200);
    const conflicting = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "claude", task: "b", idempotencyKey: "idem-x" },
    });
    assert.equal(conflicting.statusCode, 409);
    assert.equal(conflicting.json<ErrorEnvelope>().error.code, "E_IDEMPOTENCY_CONFLICT");
  } finally {
    await h.close();
  }
});

test("E_ADAPTER_DOWN：dispatch 建会话失败 → 503", async () => {
  const h = await makeHarness({ fakeOptions: { newSessionError: new Error("adapter 已退出") } });
  try {
    const res = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "claude", task: "a", idempotencyKey: "idem-down" },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json<ErrorEnvelope>().error.code, "E_ADAPTER_DOWN");
  } finally {
    await h.close();
  }
});

test("未知异常 → 500 E_INTERNAL（R35 兜底码）", async () => {
  const h = await makeHarness({
    readTranscript: () => {
      throw new Error("boom");
    },
  });
  try {
    const res = await h.app.inject({ method: "GET", url: SESSIONS + "/transcript" });
    assert.equal(res.statusCode, 500);
    const body = res.json<ErrorEnvelope>();
    assert.equal(body.error.code, "E_INTERNAL");
    assert.match(body.error.message, /boom/);
  } finally {
    await h.close();
  }
});

test("未匹配路由 → 404 E_BAD_REQUEST（R31）", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: API + "/nope" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- 存储层补充（R33 / R34）

test("EventStore.listAll：跨会话按 seq 升序，支持 afterSeq 与 limit（R33）", async () => {
  const h = await makeHarness({ seed: null });
  try {
    const first = h.store.append({
      sessionKey: "claude:a",
      type: "notice",
      payload: {},
      source: "claude",
      idempotencyKey: "a-1",
    });
    const second = h.store.append({
      sessionKey: "claude:b",
      type: "token",
      payload: {},
      source: "claude",
      idempotencyKey: "b-1",
    });

    assert.deepEqual(h.store.listAll(0).map((event) => event.seq), [first.seq, second.seq]);
    assert.deepEqual(h.store.listAll(first.seq).map((event) => event.seq), [second.seq]);
    assert.equal(h.store.listAll(0, 1).length, 1);
  } finally {
    await h.close();
  }
});

test("SessionRegistry.loadFromDb 冷启动恢复（R34）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-load-"));
  const dbPath = join(dir, "workbench.db");
  try {
    const writer = openDb(dbPath);
    migrate(writer);
    new SessionRegistry(writer).upsert(sessionRef());
    writer.close();

    const reader = openDb(dbPath);
    try {
      const registry = new SessionRegistry(reader);
      assert.equal(registry.get(SESSION_KEY), null, "新建的 registry 内存应为空");
      assert.equal(registry.loadFromDb(), 1);
      const restored = registry.get(SESSION_KEY);
      assert.ok(restored !== null);
      assert.equal(restored.key, SESSION_KEY);
      assert.equal(restored.status, "idle");
      assert.equal(restored.driver, "pi");
      assert.equal(restored.cwd, CWD);
      assert.deepEqual(restored.capabilities, CLAUDE_CAPABILITIES);
    } finally {
      reader.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- WebSocket（R33）

type WsEvent = { data: unknown };
type MinimalSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: WsEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
};
type WsConstructor = new (url: string) => MinimalSocket;

/** Node ≥ 22 自带全局 WebSocket（undici），不必额外装客户端依赖 */
function wsConstructor(): WsConstructor {
  const ctor = (globalThis as unknown as { WebSocket?: WsConstructor }).WebSocket;
  if (ctor === undefined) {
    throw new Error("当前 Node 运行时没有全局 WebSocket");
  }
  return ctor;
}

async function openWs(url: string, received: string[]): Promise<MinimalSocket> {
  const socket = new (wsConstructor())(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS 连接超时：" + url)), 4000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WS 连接失败：" + url));
    };
  });
  socket.onmessage = (event) => {
    received.push(typeof event.data === "string" ? event.data : JSON.stringify(event.data));
  };
  return socket;
}

async function waitFor(received: string[], count: number, timeoutMs = 4000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count) {
    if (Date.now() > deadline) {
      throw new Error("等待 WS 消息超时，已收到 " + String(received.length) + " 条");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [...received];
}

function wsUrl(harness: Harness, after?: number): string {
  const base = harness.url.replace("http://", "ws://");
  return base + API + "/ws" + (after === undefined ? "" : "?after=" + String(after));
}

test("WS：连接后 append 的事件以 {seq,sessionKey,type,payload,source,ts} 下发（R33）", async () => {
  const h = await makeHarness({ listen: true, seed: null });
  const received: string[] = [];
  let socket: MinimalSocket | null = null;
  try {
    socket = await openWs(wsUrl(h), received);
    const appended = h.store.append({
      sessionKey: SESSION_KEY,
      type: "token",
      payload: { text: "hello" },
      source: "claude",
      idempotencyKey: "ws-1",
    });
    const messages = await waitFor(received, 1);
    const wire = JSON.parse(messages[0] ?? "{}") as Record<string, unknown>;
    assert.equal(wire["seq"], appended.seq);
    assert.equal(wire["sessionKey"], SESSION_KEY);
    assert.equal(wire["type"], "token");
    assert.deepEqual(wire["payload"], { text: "hello" });
    assert.equal(wire["source"], "claude");
    assert.equal(typeof wire["ts"], "string");
    assert.equal(wire["idempotencyKey"], undefined, "线格式不暴露 idempotencyKey");
  } finally {
    socket?.close();
    await h.close();
  }
});

test("WS：?after=<seq> 先回放存量再收新事件，且不重复下发", async () => {
  const h = await makeHarness({ listen: true, seed: null });
  const received: string[] = [];
  let socket: MinimalSocket | null = null;
  try {
    const older = h.store.append({
      sessionKey: SESSION_KEY,
      type: "notice",
      payload: { n: 1 },
      source: "claude",
      idempotencyKey: "ws-old",
    });
    const newer = h.store.append({
      sessionKey: SESSION_KEY,
      type: "notice",
      payload: { n: 2 },
      source: "claude",
      idempotencyKey: "ws-new",
    });

    socket = await openWs(wsUrl(h, older.seq), received);
    await waitFor(received, 1);
    const replayed = JSON.parse(received[0] ?? "{}") as { seq: number };
    assert.equal(replayed.seq, newer.seq, "只回放 after 之后的存量");

    h.store.append({
      sessionKey: SESSION_KEY,
      type: "token",
      payload: { n: 3 },
      source: "claude",
      idempotencyKey: "ws-live",
    });
    const messages = await waitFor(received, 2);
    const live = JSON.parse(messages[1] ?? "{}") as { seq: number; type: string };
    assert.equal(live.type, "token");
    assert.ok(live.seq > newer.seq);
  } finally {
    socket?.close();
    await h.close();
  }
});
