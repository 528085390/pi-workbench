/**
 * API v1 契约测试（C06 / Task 11）。
 *
 * 口径：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §6。
 * - 常量必须与 spec §6.1 的冻结路由清单逐条一致（23 条，含 GET /health；resume 为 2026-11-17 additive）；
 * - 运行时 printRoutes 必须与常量完全相等（先剔除 /api/cp/health 别名）；
 * - GET /api/cp/version 的 api / schemaVersion 必须等于契约常量；
 * - WS after 回放跨重启：同一 db 重建 server 后不重复、不断档。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import {
  API_ROUTES,
  API_VERSION,
  SCHEMA_VERSION_EXPECTED,
  WORKBENCH_VERSION,
} from "@pi-workbench/shared";
import type { SessionEventType } from "@pi-workbench/shared";
import type { FastifyInstance } from "fastify";

import type { AgentAdapter } from "../src/adapters/types.ts";
import { CheckpointStore } from "../src/checkpoints.ts";
import type { Config } from "../src/config.ts";
import { ReadCursorStore } from "../src/cursors.ts";
import { SCHEMA_VERSION, migrate, openDb } from "../src/db.ts";
import { DispatchStore } from "../src/dispatch-store.ts";
import { EventStore } from "../src/events.ts";
import { LeaseManager } from "../src/lease.ts";
import { SessionRegistry } from "../src/registry.ts";
import { API_PREFIX, createServer, startServer } from "../src/server.ts";
import type { ServerDeps } from "../src/server.ts";
import { TakeoverEngine } from "../src/takeover.ts";

const INSTANCE_ID = "contract-instance";

function makeFakeAdapter(): AgentAdapter {
  return {
    newSession: async () => ({ sessionId: "sess-contract" }),
    resume: async () => {},
    prompt: async () => ({ messageId: "msg-contract" }),
    cancel: async () => ({ stopReason: "cancelled" }),
    close: async () => {},
    onUpdate: () => () => {},
    dispose: async () => {},
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
    codex: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialAgentMode: "workspace-write" },
    pi: { rpcCmd: ["pi", "--mode", "rpc"] },
    ...overrides,
  };
}

/** 最小可装配依赖：契约测试只走路由装配，不碰真实 adapter / transcript */
function makeDeps(db: DatabaseSync, dir: string, overrides: Partial<Config> = {}): ServerDeps {
  const store = new EventStore(db);
  const leases = new LeaseManager(db);
  const registry = new SessionRegistry(db);
  const checkpoints = new CheckpointStore(db);
  const dispatches = new DispatchStore(db);
  const cursors = new ReadCursorStore(db);
  const adapter = makeFakeAdapter();
  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter,
    checkpoints,
    dispatches,
    handoffDir: join(dir, "handoffs"),
  });
  return {
    config: makeConfig(dir, overrides),
    store,
    leases,
    registry,
    engine,
    adapter,
    checkpoints,
    cursors,
    instanceId: INSTANCE_ID,
  };
}

/**
 * Fastify printRoutes({commonPrefix:false}) 的行 → "METHOD /path"。
 * 输出仍是缩进树（子路由相对父路径），按 4 字符一层的缩进重建完整路径；
 * 只跳过 Fastify 为 GET 自动补的 HEAD，其余方法（含误加的 PUT/DELETE）都进集合。
 */
function parsedRoutes(app: FastifyInstance): string[] {
  const routes: string[] = [];
  const stack: string[] = [];
  const linePattern = /^((?:[│ ]   )*)(?:├── |└── )(\S+)(?:\s+\(([^)]+)\))?\s*$/;
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const match = linePattern.exec(line);
    if (match === null) {
      continue;
    }
    const depth = (match[1] ?? "").length / 4;
    const segment = match[2] ?? "";
    const full = depth === 0 ? segment : (stack[depth - 1] ?? "") + segment;
    stack.length = depth + 1;
    stack[depth] = full;
    for (const method of (match[3] ?? "").split(",").map((item) => item.trim())) {
      if (method.length > 0 && method !== "HEAD") {
        routes.push(method + " " + full);
      }
    }
  }
  return routes;
}

test("契约常量：API_VERSION / SCHEMA_VERSION_EXPECTED / 23 条冻结路由", () => {
  assert.equal(API_VERSION, "1");
  assert.equal(SCHEMA_VERSION_EXPECTED, 4);
  assert.equal(SCHEMA_VERSION, SCHEMA_VERSION_EXPECTED, "db.ts 的 SCHEMA_VERSION 必须与契约常量一致");
  assert.equal(API_ROUTES.length, 23);
  const keys = new Set(API_ROUTES.map((route) => route.method + " " + route.path));
  assert.equal(keys.size, API_ROUTES.length, "路由清单不得有重复项");
  assert.equal(keys.has("GET " + API_PREFIX + "/health"), false, "运行时别名 /api/cp/health 不进冻结清单");
  assert.ok(keys.has("GET /health"), "API_ROUTES 必须含裸 GET /health");
  assert.ok(keys.has("POST " + API_PREFIX + "/dispatch"));
  assert.ok(keys.has("GET " + API_PREFIX + "/ws"));
  assert.ok(keys.has("GET " + API_PREFIX + "/version"));
});

test("运行时契约：printRoutes 剔除 /api/cp/health 别名后与 API_ROUTES 完全相等", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-contract-"));
  const db = openDb(":memory:");
  migrate(db);
  const app = await createServer(makeDeps(db, dir));
  try {
    const alias = "GET " + API_PREFIX + "/health";
    const runtime = new Set(parsedRoutes(app).filter((route) => route !== alias));
    const declared = new Set(API_ROUTES.map((route) => route.method + " " + route.path));
    const missing = [...declared].filter((route) => !runtime.has(route)).sort();
    const extra = [...runtime].filter((route) => !declared.has(route)).sort();
    assert.deepEqual(missing, [], "运行时缺少契约路由：" + JSON.stringify(missing));
    assert.deepEqual(extra, [], "运行时多出契约外路由：" + JSON.stringify(extra));
    assert.deepEqual([...runtime].sort(), [...declared].sort());
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/cp/version 返回契约常量与实例 id，且受 Bearer 保护", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-contract-"));
  const db = openDb(":memory:");
  migrate(db);
  const app = await createServer(makeDeps(db, dir, { authToken: "secret" }));
  try {
    const unauthorized = await app.inject({ method: "GET", url: API_PREFIX + "/version" });
    assert.equal(unauthorized.statusCode, 401, "version 必须要求 Authorization");
    const res = await app.inject({
      method: "GET",
      url: API_PREFIX + "/version",
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      api: API_VERSION,
      schemaVersion: SCHEMA_VERSION_EXPECTED,
      daemon: WORKBENCH_VERSION,
      instanceId: INSTANCE_ID,
    });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- WS 回放跨重启

type GoldenEvent = {
  sessionKey: string;
  type: SessionEventType;
  payload: unknown;
  source: string;
  idempotencyKey: string;
};
/** WS 线格式（spec §6.3）：golden fixture 按完整帧逐字段比对 */
type WireEvent = {
  seq: number;
  sessionKey: string;
  type: string;
  source: string;
  ts: string;
  payload: unknown;
  idempotencyKey: string | null;
};
type GoldenFixture = {
  apiVersion: string;
  schemaVersion: number;
  events: GoldenEvent[];
  resumeAfterSeq: number;
  expectedReplay: WireEvent[];
};
/** ts 由事件写入时刻决定；比对前把实际 ts 归一成该占位符，同时断言它是合法 ISO8601 */
const TS_PLACEHOLDER = "<iso8601>";

function readFixture(): GoldenFixture {
  return JSON.parse(readFileSync(new URL("./fixtures/event-v1.json", import.meta.url), "utf8")) as GoldenFixture;
}

type MinimalSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
};
type WsConstructor = new (url: string) => MinimalSocket;

async function openWs(url: string, received: string[]): Promise<MinimalSocket> {
  const ctor = (globalThis as unknown as { WebSocket?: WsConstructor }).WebSocket;
  if (ctor === undefined) {
    throw new Error("当前 Node 运行时没有全局 WebSocket");
  }
  const socket = new ctor(url);
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

async function waitFor(received: string[], count: number, timeoutMs = 4000): Promise<WireEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count) {
    if (Date.now() > deadline) {
      throw new Error("等待 WS 消息超时，已收到 " + String(received.length) + " 条");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return received.map((raw) => JSON.parse(raw) as WireEvent);
}

test("WS：同一 db 重建 server 后 after 回放不重复、不断档（golden fixture）", async () => {
  const fixture = readFixture();
  assert.equal(fixture.apiVersion, API_VERSION);
  assert.equal(fixture.schemaVersion, SCHEMA_VERSION_EXPECTED);

  const dir = mkdtempSync(join(tmpdir(), "pi-wb-restart-"));
  const dbPath = join(dir, "events.db");
  const received: string[] = [];
  let socket: MinimalSocket | null = null;

  // 第一段：写 fixture 事件，模拟重启前的 daemon
  const db1 = openDb(dbPath);
  migrate(db1);
  const store1 = new EventStore(db1);
  const appended = fixture.events.map((event) => store1.append(event));
  assert.deepEqual(appended.map((event) => event.seq), [1, 2, 3, 4, 5], "空库首次写入 seq 从 1 连续分配");
  const first = await startServer(makeDeps(db1, dir));
  await first.close();
  db1.close();

  try {
    // 第二段：同一 db 文件重建 server（daemon 重启），客户端带旧游标订阅
    const db2 = openDb(dbPath);
    migrate(db2);
    const secondDeps = makeDeps(db2, dir);
    const second = await startServer(secondDeps);
    try {
      const base = second.url.replace("http://", "ws://");
      socket = await openWs(base + API_PREFIX + "/ws?after=" + String(fixture.resumeAfterSeq), received);
      const replayed = await waitFor(received, fixture.expectedReplay.length);
      const normalizedReplay = replayed.map((event) => {
        assert.equal(typeof event.ts, "string");
        assert.ok(!Number.isNaN(Date.parse(event.ts)), "WS ts 必须是合法 ISO8601：" + event.ts);
        return { ...event, ts: TS_PLACEHOLDER };
      });
      assert.deepEqual(
        normalizedReplay,
        fixture.expectedReplay,
        "回放必须逐字段等于 golden 完整帧（seq/sessionKey/type/source/ts/payload/idempotencyKey）：不重复、不断档",
      );
      assert.equal(new Set(replayed.map((event) => event.seq)).size, replayed.length, "seq 不得重复");

      // 重启后继续追加：AUTOINCREMENT 必须接着旧 seq，不回到 1；必须用 server 自己的 store 才能广播
      const live = secondDeps.store.append({
        sessionKey: "claude:sess-a",
        type: "token",
        payload: { text: "after-restart" },
        source: "claude",
        idempotencyKey: "golden-6",
      });
      assert.equal(live.seq, 6, "重启后 seq 应继续递增");
      const all = await waitFor(received, fixture.expectedReplay.length + 1);
      const last = all.at(-1);
      assert.ok(last !== undefined);
      assert.deepEqual(
        { ...last, ts: TS_PLACEHOLDER },
        {
          seq: 6,
          sessionKey: "claude:sess-a",
          type: "token",
          source: "claude",
          ts: TS_PLACEHOLDER,
          payload: { text: "after-restart" },
          idempotencyKey: "golden-6",
        },
        "重启后的 live 帧也必须带 idempotencyKey",
      );
    } finally {
      socket?.close();
      await second.close();
      db2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
