/**
 * HTTP/WS 服务层测试（A06 收尾 + A10 前置，Task 8）。
 * 口径：task-8-brief 的 R31–R47；spec §6（API 契约）/ §7（事件模型）。
 * HTTP 走 app.inject；WS 走真 listen（127.0.0.1:0）+ Node 内置 WebSocket 客户端。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { SessionCaps, SessionEvent, SessionRef } from "@pi-workbench/shared";
import type { FastifyInstance } from "fastify";

import type { AgentAdapter } from "../src/adapters/types.ts";
import type { AgentDriver } from "../src/agents/types.ts";
import { AgentRouter } from "../src/agents/router.ts";
import { CLAUDE_BACKGROUND_CAPABILITIES, CLAUDE_CAPABILITIES } from "../src/capabilities.ts";
import { CheckpointStore } from "../src/checkpoints.ts";
import { ReadCursorStore } from "../src/cursors.ts";
import type { Config } from "../src/config.ts";
import { migrate, openDb } from "../src/db.ts";
import { DispatchStore } from "../src/dispatch-store.ts";
import { isWorkbenchError } from "../src/errors.ts";
import { EventStore } from "../src/events.ts";
import type { NewEvent } from "../src/events.ts";
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
    dispatchReservedTtlMs: 120_000,
    claude: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialPermissionMode: "auto" },
    ...overrides,
    codex: overrides.codex ?? { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialAgentMode: "workspace-write" },
    pi: overrides.pi ?? { rpcCmd: ["pi", "--mode", "rpc"] },
  };
}

type Bundle = {
  deps: ServerDeps;
  db: DatabaseSync;
  store: EventStore;
  leases: LeaseManager;
  registry: SessionRegistry;
  checkpoints: CheckpointStore;
  cursors: ReadCursorStore;
  calls: string[];
  dir: string;
  dispose(): void;
};

type BundleOptions = {
  config?: Partial<Config>;
  fakeOptions?: FakeOptions;
  readTranscript?: ServerTranscriptReader;
  /** 需要观察 WS 回放窗口时可换成 EventStore 子类（正常用例不传） */
  storeFactory?: (db: DatabaseSync) => EventStore;
  /** 500 路径的内部错误收集器（Fastify logger:false 时 app.log.error 是 no-op） */
  logError?: (error: unknown) => void;
  /** 需要走 /agents 或 attach 的用例注入注册表 */
  router?: AgentRouter;
};

function makeBundle(opts: BundleOptions = {}): Bundle {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-api-"));
  const db = openDb(":memory:");
  migrate(db);

  const store = opts.storeFactory === undefined ? new EventStore(db) : opts.storeFactory(db);
  const leases = new LeaseManager(db);
  const registry = new SessionRegistry(db);
  const checkpoints = new CheckpointStore(db);
  const dispatches = new DispatchStore(db);
  const cursors = new ReadCursorStore(db);
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
    instanceId: "test-instance",
    db,
    engine,
    adapter: fake.adapter,
    checkpoints,
    cursors,
    readTranscript: opts.readTranscript,
    logError: opts.logError,
    ...(opts.router === undefined ? {} : { router: opts.router }),
  };

  return {
    deps,
    db,
    store,
    leases,
    registry,
    checkpoints,
    cursors,
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

test("GET /health 与 /api/cp/health 都是 T1 健康形状 + C04 运行态摘要（R31 / §6.2）", async () => {
  const h = await makeHarness();
  try {
    for (const path of ["/health", API + "/health"]) {
      const res = await h.app.inject({ method: "GET", url: path });
      assert.equal(res.statusCode, 200, path + " 应 200");
      const body = res.json<{
        ok: boolean;
        name: string;
        version: string;
        pid: number;
        uptimeMs: number;
        instanceId: string;
        db: { schemaVersion: number; ok: boolean };
        adapters: { agent: string; available: boolean }[];
      }>();
      assert.equal(body.ok, true);
      assert.equal(body.name, "pi-workbenchd");
      assert.equal(typeof body.version, "string");
      assert.equal(body.pid, process.pid);
      assert.ok(body.uptimeMs >= 0);
      assert.equal(body.instanceId, "test-instance");
      assert.deepEqual(body.db, { schemaVersion: 4, ok: true });
      assert.ok(Array.isArray(body.adapters));
    }
  } finally {
    await h.close();
  }
});

test("GET /health: db 关闭时 ok:false 且 503（spec §6.2 / §7.4）", async () => {
  const h = await makeHarness({ seed: null });
  try {
    h.db.close();
    for (const path of ["/health", API + "/health"]) {
      const res = await h.app.inject({ method: "GET", url: path });
      assert.equal(res.statusCode, 503, path + " 应 503");
      const body = res.json<{ ok: boolean; db: { schemaVersion: number; ok: boolean } }>();
      assert.equal(body.ok, false);
      assert.equal(body.db.ok, false);
      assert.equal(body.db.schemaVersion, 0);
    }
  } finally {
    await h.app.close();
    rmSync(h.dir, { recursive: true, force: true });
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

test("GET /agents：adapter 命令解析不到 → available:false（R37）", async () => {
  const h = await makeHarness({
    config: { claude: { adapterCmd: ["C:/nonexistent/pi-workbench-nope.exe"], permissionMode: "auto_allow", initialPermissionMode: "auto" } },
  });
  try {
    const res = await h.app.inject({ method: "GET", url: API + "/agents" });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ agent: string; available: boolean; caps: SessionCaps }[]>();
    assert.equal(body[0]?.agent, "claude");
    assert.equal(body[0]?.available, false, "绝对路径不存在时必须报 available:false");
    assert.deepEqual(body[0]?.caps, CLAUDE_CAPABILITIES);
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

test("POST inject：text 只做非空校验，原样投递（首尾空白不裁）", async () => {
  const h = await makeHarness();
  try {
    await acquire(h.app, "pi:1");
    const text = "  \n const a = 1;\n  ";
    const res = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/inject",
      payload: { text, clientId: "pi:1" },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(
      h.calls.includes("prompt:sess-1:" + text),
      "adapter.prompt 应收到未裁剪的原文，实际调用：" + JSON.stringify(h.calls),
    );

    // 只有空白仍然算缺失（trim 只用于空判定）
    const blank = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/inject",
      payload: { text: "   ", clientId: "pi:1" },
    });
    assert.equal(blank.statusCode, 400);
    assert.equal(blank.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");
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

test("checkpoint：落库失败 → 500 E_CHECKPOINT_FAILED，不留文件 / 行（C03 fix）", async () => {
  const h = await makeHarness();
  try {
    await acquire(h.app, "pi:1");
    // 让 checkpoints.save 在 INSERT 时失败，模拟落库异常
    h.db.exec(
      "CREATE TRIGGER fail_checkpoint_save BEFORE INSERT ON checkpoints " +
        "BEGIN SELECT RAISE(ABORT, 'checkpoint save boom'); END;",
    );

    const res = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/checkpoint",
      payload: { summary: "s", touchedFiles: [], nextStep: "n", clientId: "pi:1" },
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json<ErrorEnvelope>().error.code, "E_CHECKPOINT_FAILED");

    const row = h.db.prepare("SELECT count(*) AS n FROM checkpoints").get() as { n?: number } | undefined;
    assert.equal(Number(row?.n ?? 0), 0, "落库失败不得留行");
    assert.deepEqual(readdirSync(join(h.dir, "handoffs")), [], "落库失败必须清掉正式文件和 tmp");

    const latest = await h.app.inject({ method: "GET", url: SESSIONS + "/checkpoint" });
    assert.equal(latest.json<unknown>(), null);
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

test("未认证不得用 404/401 差异探路由：/api/cp/* 未知路径先 401，非 /api 未知路径仍 404（R32）", async () => {
  const h = await makeHarness({ config: { host: "0.0.0.0", authToken: "tok-123" } });
  try {
    const anon = await h.app.inject({ method: "GET", url: API + "/nope" });
    assert.equal(anon.statusCode, 401, "未认证访问未知 /api/cp 路径应 401，不能泄漏路由是否存在");
    assert.equal(anon.json<ErrorEnvelope>().error.code, "E_UNAUTHORIZED");

    const authed = await h.app.inject({
      method: "GET",
      url: API + "/nope",
      headers: { authorization: "Bearer tok-123" },
    });
    assert.equal(authed.statusCode, 404);
    assert.equal(authed.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    // 非 /api 路径不在受保护命名空间内：未认证也应保持 404
    const outside = await h.app.inject({ method: "GET", url: "/nope" });
    assert.equal(outside.statusCode, 404);
    assert.equal(outside.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");
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
    E_DISPATCH_IN_PROGRESS: 409,
    E_SESSION_BUSY: 429,
    E_ASSET_CONFIG_INVALID: 400,
    E_CAP_UNSUPPORTED: 422,
    E_AGENT_UNAVAILABLE: 422,
    E_ADAPTER_DOWN: 503,
    E_HANDOFF_FAILED: 503,
    E_CHECKPOINT_FAILED: 500,
    E_RESUME_REJECTED: 409,
  });
});

test("错误体形状与状态码（E_BAD_REQUEST / E_NO_LEASE / E_IDEMPOTENCY_CONFLICT / E_RESUME_REJECTED）", async () => {
  const h = await makeHarness({ fakeOptions: { resumeError: new Error("resume denied") } });
  try {
    // E_BAD_REQUEST：请求体是合法 JSON 但不是对象（字符串）
    const notObject = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/inject",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify("x"),
    });
    assert.equal(notObject.statusCode, 400);
    assert.equal(notObject.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    // E_NO_LEASE：无租约 interrupt
    const noLease = await h.app.inject({ method: "POST", url: SESSIONS + "/interrupt", payload: { clientId: "pi:1" } });
    assert.equal(noLease.statusCode, 409);
    assert.equal(noLease.json<ErrorEnvelope>().error.code, "E_NO_LEASE");

    // E_RESUME_REJECTED：handback 的 resume 失败 → 409（spec §7.3 / §8）
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
    assert.equal(handback.statusCode, 409);
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
  const logged: unknown[] = [];
  const h = await makeHarness({
    readTranscript: () => {
      throw new Error("boom");
    },
    logError: (error) => {
      logged.push(error);
    },
  });
  try {
    const res = await h.app.inject({ method: "GET", url: SESSIONS + "/transcript" });
    assert.equal(res.statusCode, 500);
    const body = res.json<ErrorEnvelope>();
    assert.equal(body.error.code, "E_INTERNAL");
    // 内部 message 不外泄（评审 Minor 2）：对外固定文案，真实原因只进日志
    assert.equal(body.error.message, "internal error");
    assert.ok(!res.body.includes("boom"), "不得把内部 error.message 回给客户端：" + res.body);
    // 评审 N1：logger:false 让 app.log.error 变 no-op，真实原因必须仍能落到注入的 logError
    assert.equal(logged.length, 1, "内部异常必须交给 logError 一次");
    assert.match(String((logged[0] as Error).message), /boom/);
  } finally {
    await h.close();
  }
});

test("Fastify 自身的 4xx（413 / 415）保留原状态码，code 仍是 E_BAD_REQUEST", async () => {
  const h = await makeHarness();
  try {
    // 413：body 超过默认 1MiB bodyLimit
    const tooLarge = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/inject",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ text: "x".repeat(1_200_000), clientId: "pi:1" }),
    });
    assert.equal(tooLarge.statusCode, 413, "payload 过大应保留 413，不能被压成 400：" + tooLarge.body);
    assert.equal(tooLarge.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    // 415：不支持的 Content-Type
    const badType = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/inject",
      headers: { "content-type": "application/x-pi-unknown" },
      payload: "text",
    });
    assert.equal(badType.statusCode, 415, "不支持的媒体类型应保留 415：" + badType.body);
    assert.equal(badType.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");
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

/** 手工升级请求的结果：101 时给 socket，其它状态给 status + body */
type UpgradeResult = { status: number; body: string; socket: Socket | null; head: Buffer };

/**
 * 手工发起 WS 升级（I1）：undici 的 WebSocket 客户端无法设置 header，
 * 「鉴权钩子是否覆盖升级请求」只能自己发 HTTP 请求。
 * 用裸 net socket 手写请求行，是因为被拒绝的升级（401）之后服务端会直接 RST，
 * http 客户端会把已到的响应丢掉；这里只认自己收到的字节。
 */
/**
 * 101 的 socket 交给调用方持有；这里再登记一份，测试结束时统一销毁，
 * 免得断言失败时裸 socket 把事件循环吊住（评审 N2：失败用例曾拖到 30s）。
 */
const PROBE_SOCKETS = new Set<Socket>();

after(() => {
  for (const socket of PROBE_SOCKETS) {
    socket.destroy();
  }
  PROBE_SOCKETS.clear();
});

function probeUpgrade(target: string, headers: Record<string, string>, timeoutMs = 4000): Promise<UpgradeResult> {
  const url = new URL(target);
  const port = Number(url.port);
  const requestText =
    [
      "GET " + url.pathname + url.search + " HTTP/1.1",
      "Host: " + url.hostname + ":" + String(port),
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...Object.entries(headers).map(([key, value]) => key + ": " + value),
      "",
      "",
    ].join("\r\n");

  return new Promise<UpgradeResult>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port });
    PROBE_SOCKETS.add(socket);
    socket.on("close", () => {
      PROBE_SOCKETS.delete(socket);
    });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const settle = (result: UpgradeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new Error("WS 升级请求超时：" + target));
    }, timeoutMs);

    const parseHead = (): { status: number; headText: string; rest: Buffer } | null => {
      const mark = buffer.indexOf("\r\n\r\n");
      if (mark === -1) {
        return null;
      }
      const headText = buffer.subarray(0, mark).toString("utf8");
      const match = /^HTTP\/1\.1 (\d{3})/.exec(headText);
      return { status: match === null ? 0 : Number(match[1]), headText, rest: buffer.subarray(mark + 4) };
    };

    /** 能把结果定下来就返回 true（非 101 需要 body 收齐） */
    const settleOnceAvailable = (force: boolean): boolean => {
      const parsed = parseHead();
      if (parsed === null) {
        return false;
      }
      if (parsed.status === 101) {
        settle({ status: 101, body: "", socket, head: parsed.rest });
        return true;
      }
      const lengthMatch = /content-length:\s*(\d+)/i.exec(parsed.headText);
      const length = lengthMatch === null ? -1 : Number(lengthMatch[1]);
      if (!force && length >= 0 && parsed.rest.length < length) {
        return false;
      }
      const body = (length >= 0 ? parsed.rest.subarray(0, length) : parsed.rest).toString("utf8");
      settle({ status: parsed.status, body, socket: null, head: Buffer.alloc(0) });
      socket.destroy();
      return true;
    };

    socket.on("connect", () => {
      socket.write(requestText);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      settleOnceAvailable(false);
    });
    socket.on("end", () => {
      settleOnceAvailable(true);
    });
    socket.on("error", (err: Error) => {
      // 401 之后服务端 RST：已收到的字节足够断言状态码与 body
      if (settleOnceAvailable(true)) {
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 解析一帧；数据不够返回 null。服务端帧不掩码，客户端掩码时按 RFC 跳过 4 字节掩码键。 */
function parseTextFrame(buffer: Buffer): { text: string; size: number } | null {
  if (buffer.length < 2) {
    return null;
  }
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const opcode = first & 0x0f;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) {
      return null;
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if ((second & 0x80) !== 0) {
    offset += 4;
  }
  if (buffer.length < offset + length) {
    return null;
  }
  const payload = buffer.subarray(offset, offset + length).toString("utf8");
  return { text: opcode === 0x1 ? payload : "", size: offset + length };
}

/** 从裸 socket 上读一帧文本（101 之后断言「确实收到事件」用） */
function readTextFrame(socket: Socket, head: Buffer, timeoutMs = 4000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = head;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待 WS 帧超时"));
    }, timeoutMs);
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = parseTextFrame(buffer);
      if (frame === null) {
        return;
      }
      cleanup();
      assert.ok(frame.text.length > 0, "收到的应是文本帧");
      resolve(frame.text);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    onData(Buffer.alloc(0));
  });
}

/**
 * I2 的确定性场景：让「回放瞬间刚 append 的事件」既进订阅缓冲、又出现在 listAll 的结果里。
 * 只有 server.ts 里 `event.seq <= lastSeq` 的去重守卫能挡住重复下发 —— 守卫一删，对应测试必红。
 */
class RaceReplayStore extends EventStore {
  /** 下一次 listAll 之前要插入的事件（模拟「回放窗口内到达的实时事件」） */
  pending: NewEvent | null = null;

  override listAll(afterSeq = 0, limit?: number): SessionEvent[] {
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) {
      this.append(pending);
    }
    return super.listAll(afterSeq, limit);
  }
}

test("WS：连接后 append 的事件以 {seq,sessionKey,type,source,ts,payload,idempotencyKey} 下发（R33 / §6.3）", async () => {
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
    assert.equal(wire["idempotencyKey"], "ws-1", "线格式保留 idempotencyKey（spec §6.3）");
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
    await waitFor(received, 2);
    // I2：静置 120ms 再看总数 —— 去重守卫一旦失效，缓冲里被回放过的存量会被补发一次，这里就会多出第 3 条
    await new Promise((resolve) => setTimeout(resolve, 120));
    const expected = 2; // newer 的存量回放 + 一条 live
    assert.equal(received.length, expected, "回放 + live 应恰好 " + String(expected) + " 条：" + JSON.stringify(received));
    const seqs = received.map((raw) => (JSON.parse(raw) as { seq: number }).seq);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok((seqs[i] ?? 0) > (seqs[i - 1] ?? 0), "seq 必须严格递增：" + JSON.stringify(seqs));
    }
    assert.equal(new Set(seqs).size, seqs.length, "seq 不得重复：" + JSON.stringify(seqs));
    assert.deepEqual(seqs, [newer.seq, newer.seq + 1]);
  } finally {
    socket?.close();
    await h.close();
  }
});

test("WS：回放窗口内到达的实时事件不会重复下发（去重靠 seq 单调，I2）", async () => {
  const h = await makeHarness({ listen: true, seed: null, storeFactory: (db) => new RaceReplayStore(db) });
  const received: string[] = [];
  let socket: MinimalSocket | null = null;
  try {
    h.store.append({
      sessionKey: SESSION_KEY,
      type: "notice",
      payload: { n: 1 },
      source: "claude",
      idempotencyKey: "ws-race-1",
    });
    // 连接时服务端先订阅再回放：这条事件既进缓冲，也会出现在回放结果里
    const store = h.store as RaceReplayStore;
    store.pending = {
      sessionKey: SESSION_KEY,
      type: "token",
      payload: { n: 2 },
      source: "claude",
      idempotencyKey: "ws-race-2",
    };

    socket = await openWs(wsUrl(h), received);
    await waitFor(received, 2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(received.length, 2, "同一条事件只能下发一次：" + JSON.stringify(received));
    const seqs = received.map((raw) => (JSON.parse(raw) as { seq: number }).seq);
    assert.equal(seqs.length, new Set(seqs).size, "seq 不得重复：" + JSON.stringify(seqs));
    assert.ok((seqs[1] ?? 0) > (seqs[0] ?? 0), "seq 必须严格递增：" + JSON.stringify(seqs));
  } finally {
    socket?.close();
    await h.close();
  }
});

// ---------------------------------------------------------------- WS 鉴权（R32 / I1）

test("WS 鉴权只认 Authorization header：无 header → 401、?token= → 401、Bearer → 101 且收到事件（I1）", async () => {
  const h = await makeHarness({ listen: true, seed: null, config: { authToken: "t" } });
  let socket: Socket | null = null;
  try {
    // (a) 无 Authorization：升级必须被拒绝（服务端回 401，不会完成 101 握手）
    const noHeader = await probeUpgrade(wsUrl(h), {});
    assert.equal(noHeader.status, 401, "无 Authorization 必须 401 拒绝升级");
    assert.equal(noHeader.socket, null, "被拒绝的升级不应拿到已升级的 socket");
    assert.equal((JSON.parse(noHeader.body) as ErrorEnvelope).error.code, "E_UNAUTHORIZED");

    // (a2) query-string 形式：header-only 规则，?token= 同样 401（浏览器无法给 WS 设 header 的 v1 限制）
    const queryToken = await probeUpgrade(wsUrl(h) + "?token=t", {});
    assert.equal(queryToken.status, 401, "?token= 不受支持：WS 鉴权只认 header");
    assert.equal((JSON.parse(queryToken.body) as ErrorEnvelope).error.code, "E_UNAUTHORIZED");

    // (b) 带正确 Bearer：握手成功，并能收到一条 append 的事件
    const upgraded = await probeUpgrade(wsUrl(h), { authorization: "Bearer t" });
    assert.equal(upgraded.status, 101, "带正确 Bearer 应 101");
    const raw = upgraded.socket;
    assert.ok(raw !== null, "101 必须给出已升级的 socket");
    socket = raw;

    const appended = h.store.append({
      sessionKey: SESSION_KEY,
      type: "token",
      payload: { text: "hello" },
      source: "claude",
      idempotencyKey: "ws-auth-1",
    });
    const wire = JSON.parse(await readTextFrame(raw, upgraded.head)) as Record<string, unknown>;
    assert.equal(wire["seq"], appended.seq);
    assert.equal(wire["sessionKey"], SESSION_KEY);
    assert.equal(wire["type"], "token");
  } finally {
    socket?.destroy();
    await h.close();
  }
});
// ---------------------------------------------------------------- 读语义 v2（spec §6.5）

/** 固定 5 条消息的假 transcript：游标是"已读条数"，nextCursor = 已读条数 + 本页条数 */
const READ_MESSAGES = [1, 2, 3, 4, 5].map((n) => ({
  id: "m" + String(n),
  role: n % 2 === 1 ? ("user" as const) : ("assistant" as const),
  kind: "text" as const,
  text: "消息 " + String(n),
  ts: "2026-11-16T00:00:0" + String(n) + ".000Z",
}));

const readFixed: ServerTranscriptReader = (_path, cursor, limit) => {
  const from = Number(cursor ?? "0");
  const rest = READ_MESSAGES.slice(from);
  const page = limit === undefined ? rest : rest.slice(0, limit);
  return { messages: page, nextCursor: String(from + page.length), pending: false };
};

test("读语义：GET /sessions?clientId= 附未读数，不带 clientId 保持旧形状", async () => {
  const h = await makeHarness({ readTranscript: readFixed });
  try {
    const plain = await h.app.inject({ method: "GET", url: SESSIONS.replace("/" + SESSION_KEY, "") });
    assert.equal(plain.statusCode, 200);
    const plainList = plain.json<Record<string, unknown>[]>();
    assert.equal(plainList.length, 1);
    assert.equal(plainList[0]?.["unread"], undefined, "旧调用方不该突然多出字段");

    const withClient = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:1" });
    assert.equal(withClient.statusCode, 200);
    const list = withClient.json<{ key: string; unread: number; lastReadCursor: string; awaiting: boolean }[]>();
    assert.equal(list[0]?.key, SESSION_KEY);
    assert.equal(list[0]?.unread, 5, "从没读过 → 全部未读");
    assert.equal(list[0]?.lastReadCursor, "0");
    assert.equal(list[0]?.awaiting, false);
  } finally {
    await h.close();
  }
});

test("读语义：awaiting 跟随 needs-input 状态；详情带 clientId 才有读状态", async () => {
  const h = await makeHarness({ readTranscript: readFixed, seed: [sessionRef({ status: "needs-input" })] });
  try {
    const detail = await h.app.inject({ method: "GET", url: SESSIONS });
    const plain = detail.json<{ session: Record<string, unknown> }>();
    assert.equal(plain.session["unread"], undefined);

    const withClient = await h.app.inject({ method: "GET", url: SESSIONS + "?clientId=pi:1" });
    const view = withClient.json<{ session: { awaiting: boolean; unread: number } }>();
    assert.equal(view.session.awaiting, true);
    assert.equal(view.session.unread, 5);
  } finally {
    await h.close();
  }
});

test("读语义：GET /unread 默认只读不推进（peek），ack=1 才推进游标", async () => {
  const h = await makeHarness({ readTranscript: readFixed });
  try {
    const peek = await h.app.inject({ method: "GET", url: SESSIONS + "/unread?clientId=pi:1&limit=2" });
    assert.equal(peek.statusCode, 200);
    const peeked = peek.json<{
      messages: unknown[];
      nextCursor: string;
      lastReadCursor: string;
      unread: number;
      pageCount: number;
      acked: boolean;
    }>();
    assert.equal(peeked.messages.length, 2);
    assert.equal(peeked.nextCursor, "2");
    assert.equal(peeked.lastReadCursor, "0", "peek 不推进");
    assert.equal(peeked.unread, 5, "R2：peek 没推进游标，剩余仍是全部 5 条（不是本页之后的 3）");
    assert.equal(peeked.pageCount, 2, "本页条数单列");
    assert.equal(peeked.acked, false);

    const stillUnread = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:1" });
    assert.equal(stillUnread.json<{ unread: number }[]>()[0]?.unread, 5, "peek 之后仍未读");

    const acked = await h.app.inject({ method: "GET", url: SESSIONS + "/unread?clientId=pi:1&limit=2&ack=1" });
    assert.equal(acked.statusCode, 200);
    const ackBody = acked.json<{ lastReadCursor: string; acked: boolean }>();
    assert.equal(ackBody.acked, true);
    assert.equal(ackBody.lastReadCursor, "2");

    const after = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:1" });
    assert.equal(after.json<{ unread: number }[]>()[0]?.unread, 3, "已读 2 条 → 剩 3 条");
    assert.equal(after.json<{ lastReadCursor: string }[]>()[0]?.lastReadCursor, "2");
  } finally {
    await h.close();
  }
});

test("attach 成功后恢复 driver=pi 且 status=idle（spec §7.1）", async () => {
  const calls: string[] = [];
  const router = new AgentRouter();
  const driver: AgentDriver = {
    agent: "claude",
    caps: CLAUDE_BACKGROUND_CAPABILITIES,
    discover: async () => [],
    attach: async () => {
      calls.push("attach");
    },
    inject: async () => ({ messageId: "m-1", effective: "now" }),
    interrupt: async () => ({ stopReason: "cancelled" }),
    resume: async () => {},
    handoff: async () => ({ command: ["claude", "attach", "sess-1"], mode: "attach" }),
    onUpdate: () => () => {},
    dispose: async () => {},
  };
  router.register(driver);

  const h = await makeHarness({
    router,
    seed: [
      sessionRef({
        status: "unknown",
        driver: "none",
        capabilities: CLAUDE_BACKGROUND_CAPABILITIES,
        kind: "background",
      }),
    ],
  });
  try {
    const res = await h.app.inject({ method: "POST", url: SESSIONS + "/attach" });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { attached: true, sessionKey: SESSION_KEY, agent: "claude" });
    assert.deepEqual(calls, ["attach"]);
    assert.equal(h.registry.get(SESSION_KEY)?.driver, "pi");
    assert.equal(h.registry.get(SESSION_KEY)?.status, "idle");
  } finally {
    await h.close();
  }
});

test("读语义：不同读者互不影响（clientId 隔离）", async () => {
  const h = await makeHarness({ readTranscript: readFixed });
  try {
    await h.app.inject({ method: "GET", url: SESSIONS + "/unread?clientId=pi:1&ack=1" });
    const other = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:2" });
    assert.equal(other.json<{ unread: number }[]>()[0]?.unread, 5, "另一个读者仍全部未读");

    const mine = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:1" });
    assert.equal(mine.json<{ unread: number }[]>()[0]?.unread, 0, "ack 无 limit → 读到底");
  } finally {
    await h.close();
  }
});

test("读语义：POST /read 不给 cursor 即读到底；显式 cursor 只进不退", async () => {
  const h = await makeHarness({ readTranscript: readFixed });
  try {
    const advanced = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/read",
      payload: { clientId: "pi:1", cursor: "3" },
    });
    assert.equal(advanced.statusCode, 200);
    assert.equal(advanced.json<{ lastReadCursor: string }>().lastReadCursor, "3");

    const back = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/read",
      payload: { clientId: "pi:1", cursor: "1" },
    });
    assert.equal(back.statusCode, 200);
    assert.equal(back.json<{ lastReadCursor: string }>().lastReadCursor, "3", "游标不允许回退");

    const all = await h.app.inject({ method: "POST", url: SESSIONS + "/read", payload: { clientId: "pi:1" } });
    assert.equal(all.statusCode, 200);
    assert.equal(all.json<{ lastReadCursor: string }>().lastReadCursor, "5");

    const list = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:1" });
    assert.equal(list.json<{ unread: number }[]>()[0]?.unread, 0);
  } finally {
    await h.close();
  }
});

test("读语义：>200 条未读不被默认分页上限截断（B1：未读总数 / 读到底 / 分页剩余）", async () => {
  // 真实 transcript 默认 limit=200（transcript/claude.ts DEFAULT_TRANSCRIPT_LIMIT）：
  // 250 条时必须报 250，而不是封顶 200；POST /read 也必须推进到 250。
  const LONG = Array.from({ length: 250 }, (_, i) => ({
    id: "L" + String(i),
    role: "assistant" as const,
    kind: "text" as const,
    text: "长会话消息 " + String(i),
    ts: "2026-11-16T00:00:00.000Z",
  }));
  const readLong: ServerTranscriptReader = (_path, cursor, limit) => {
    const from = Number(cursor ?? "0");
    const rest = LONG.slice(from);
    const page = limit === undefined || limit === Number.POSITIVE_INFINITY ? rest : rest.slice(0, limit);
    return { messages: page, nextCursor: String(from + page.length), pending: false };
  };
  const h = await makeHarness({ readTranscript: readLong });
  try {
    const list = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:1" });
    assert.equal(list.json<{ unread: number }[]>()[0]?.unread, 250, "未读总数不能被 200 截断");

    const peek = await h.app.inject({ method: "GET", url: SESSIONS + "/unread?clientId=pi:1&limit=2" });
    const peeked = peek.json<{ messages: unknown[]; unread: number; pageCount: number }>();
    assert.equal(peeked.messages.length, 2);
    assert.equal(peeked.pageCount, 2);
    assert.equal(peeked.unread, 250, "R2：peek 只看 2 条但没标记已读，剩余仍是 250");

    const readAll = await h.app.inject({ method: "POST", url: SESSIONS + "/read", payload: { clientId: "pi:1" } });
    assert.equal(readAll.json<{ lastReadCursor: string }>().lastReadCursor, "250", "读到底要跨过 200 上限");

    const after = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:1" });
    assert.equal(after.json<{ unread: number }[]>()[0]?.unread, 0);
  } finally {
    await h.close();
  }
});

test("读语义：缺 clientId / 非法 ack → 400 E_BAD_REQUEST", async () => {
  const h = await makeHarness({ readTranscript: readFixed });
  try {
    const noClient = await h.app.inject({ method: "GET", url: SESSIONS + "/unread" });
    assert.equal(noClient.statusCode, 400);
    assert.equal(noClient.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    const badAck = await h.app.inject({ method: "GET", url: SESSIONS + "/unread?clientId=pi:1&ack=maybe" });
    assert.equal(badAck.statusCode, 400);
    assert.equal(badAck.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    const noBody = await h.app.inject({ method: "POST", url: SESSIONS + "/read", payload: {} });
    assert.equal(noBody.statusCode, 400);

    const badCursor = await h.app.inject({
      method: "POST",
      url: SESSIONS + "/read",
      payload: { clientId: "pi:1", cursor: "12abc" },
    });
    assert.equal(badCursor.statusCode, 400, "游标必须是非负整数字符串");
    assert.equal(badCursor.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    const unknown = await h.app.inject({ method: "GET", url: API + "/sessions/claude:nope/unread?clientId=pi:1" });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json<ErrorEnvelope>().error.code, "E_SESSION_NOT_FOUND");
  } finally {
    await h.close();
  }
});

test("读语义：没有 transcriptPath 的会话 unread=0 且 /unread 返回空页", async () => {
  const h = await makeHarness({
    readTranscript: readFixed,
    seed: [sessionRef({ transcriptPath: undefined })],
  });
  try {
    const list = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:1" });
    assert.equal(list.json<{ unread: number }[]>()[0]?.unread, 0);

    const page = await h.app.inject({ method: "GET", url: SESSIONS + "/unread?clientId=pi:1&ack=1" });
    assert.equal(page.statusCode, 200);
    const body = page.json<{ messages: unknown[]; unread: number }>();
    assert.deepEqual(body.messages, []);
    assert.equal(body.unread, 0);
  } finally {
    await h.close();
  }
});
