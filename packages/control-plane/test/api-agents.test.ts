/**
 * B06：能力驱动的 /agents、dispatch 门禁与统一读路径（spec §11 / §11.1 / §12 / §13）。
 * 这里只覆盖新增的 HTTP 行为；0.5-A 的 Claude 语义仍由 api.test.ts / takeover.test.ts 锁定。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentName, SessionCaps, SessionRef } from "@pi-workbench/shared";
import type { FastifyInstance } from "fastify";

import type { AgentAdapter } from "../src/adapters/types.ts";
import { AgentRouter } from "../src/agents/router.ts";
import { CodexDriver } from "../src/agents/codex-driver.ts";
import type { AgentDriver, AgentStatus } from "../src/agents/types.ts";
import {
  CLAUDE_BACKGROUND_CAPABILITIES,
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  capsOf,
} from "../src/capabilities.ts";
import { CheckpointStore } from "../src/checkpoints.ts";
import type { Config } from "../src/config.ts";
import { ReadCursorStore } from "../src/cursors.ts";
import { migrate, openDb } from "../src/db.ts";
import { DispatchStore } from "../src/dispatch-store.ts";
import { EventStore } from "../src/events.ts";
import { makeCodexWriteGuard, PROBE_TIMEOUT_MS, probeAgents } from "../src/index.ts";
import { LeaseManager } from "../src/lease.ts";
import type { ProbeCommandRunner } from "../src/index.ts";
import { SessionRegistry } from "../src/registry.ts";
import type { ServerDeps } from "../src/server.ts";
import { createServer } from "../src/server.ts";
import { TakeoverEngine } from "../src/takeover.ts";

const CODEX_SAMPLE = fileURLToPath(new URL("./fixtures/codex/rollout-sample.jsonl", import.meta.url));
const API = "/api/cp";

type Fake = { adapter: AgentAdapter; calls: string[] };
function makeFake(): Fake {
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

type DriverOverrides = Partial<AgentDriver> & {
  newSession?: (cwd: string) => Promise<{ sessionId: string }>;
  close?: (ref: SessionRef) => Promise<void>;
  resolveTranscriptPath?: (ref: SessionRef) => Promise<string | undefined>;
};
type DriverBox = { driver: AgentDriver; calls: string[] };
function makeDriver(agent: AgentName, caps: SessionCaps, overrides: DriverOverrides = {}): DriverBox {
  const calls: string[] = [];
  const driver: AgentDriver = {
    agent,
    caps,
    discover: async () => [],
    attach: async () => {
      calls.push("attach");
    },
    inject: async () => {
      calls.push("inject");
      return { messageId: "m-1", effective: "now" };
    },
    interrupt: async () => {
      calls.push("interrupt");
      return { stopReason: "cancelled" };
    },
    resume: async () => {
      calls.push("resume");
    },
    handoff: async () => ({
      command: [agent, "resume", "native-1", "--no-alt-screen"],
      mode: "resume-tui",
    }),
    onUpdate: () => () => {},
    dispose: async () => {},
    ...overrides,
  };
  return { driver, calls };
}

type Registered = {
  driver: AgentDriver;
  available?: boolean;
  version?: string | null;
  reason?: string;
};

function sessionRef(agent: AgentName, nativeId: string, overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    key: agent + ":" + nativeId,
    agent,
    nativeId,
    acpSessionId: nativeId,
    cwd: "E:\\pi-workbench\\spike\\a00-workspace",
    transcriptPath: undefined,
    status: "idle",
    driver: "pi",
    capabilities: capsOf(agent),
    kind: "interactive",
    ...overrides,
  };
}

function makeConfig(home: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    home,
    authToken: null,
    leaseTtlMs: 30_000,
    dispatchReservedTtlMs: 120_000,
    claude: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialPermissionMode: "auto" },
    codex: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialAgentMode: "workspace-write" },
    pi: { rpcCmd: [process.execPath, "--mode", "rpc"] },
  };
}

type HarnessOptions = {
  drivers?: Registered[];
  agentStatuses?: () => Promise<AgentStatus[]>;
  now?: () => number;
  seed?: SessionRef[];
  pipelineAttach?: (source: unknown, sessionKey: string) => void;
};

type Harness = {
  app: FastifyInstance;
  router: AgentRouter;
  leases: LeaseManager;
  fake: Fake;
  dir: string;
  close(): Promise<void>;
};

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-agents-"));
  const db = openDb(":memory:");
  migrate(db);
  const fake = makeFake();
  const store = new EventStore(db);
  const leases = new LeaseManager(db);
  const registry = new SessionRegistry(db);
  const checkpoints = new CheckpointStore(db);
  const dispatches = new DispatchStore(db);
  const cursors = new ReadCursorStore(db);
  const router = new AgentRouter();
  for (const item of options.drivers ?? []) {
    router.register(item.driver, {
      ...(item.available === undefined ? {} : { available: item.available }),
      ...(item.version === undefined ? {} : { version: item.version }),
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    });
  }
  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter: fake.adapter,
    router,
    checkpoints,
    dispatches,
    handoffDir: join(dir, "handoffs"),
  });
  const deps: ServerDeps = {
    config: makeConfig(dir),
    store,
    leases,
    registry,
    engine,
    adapter: fake.adapter,
    checkpoints,
    cursors,
    router,
    ...(options.agentStatuses === undefined ? {} : { agentStatuses: options.agentStatuses }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pipelineAttach === undefined
      ? {}
      : { pipeline: { attach: (source: unknown, sessionKey: string) => {
          options.pipelineAttach?.(source, sessionKey);
          return () => {};
        } } }),
  };
  const app = await createServer(deps);
  for (const ref of options.seed ?? []) {
    registry.upsert(ref);
  }
  return {
    app,
    router,
    leases,
    fake,
    dir,
    close: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function acquire(app: FastifyInstance, key: string, clientId = "pi:7"): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: API + "/sessions/" + encodeURIComponent(key) + "/lease",
    payload: { action: "acquire", driver: "pi", clientId },
  });
  assert.equal(res.statusCode, 200, "取租约应成功：" + res.body);
}

type ErrorEnvelope = { error: { code: string; message: string; details?: unknown } };

test("GET /agents 返回三行 AgentStatus，并沿用 30s 缓存", async () => {
  const claude = makeDriver("claude", CLAUDE_CAPABILITIES);
  const codex = makeDriver("codex", CODEX_CAPABILITIES);
  const pi = makeDriver("pi", capsOf("pi"));
  let now = 1000;
  let probes = 0;
  let h: Harness | null = null;
  h = await makeHarness({
    drivers: [
      { driver: claude.driver, available: true, version: "1.2.3" },
      { driver: codex.driver, available: false, reason: "E_AGENT_UNAVAILABLE: codex 未登录" },
      { driver: pi.driver, available: true },
    ],
    agentStatuses: async () => {
      probes += 1;
      return h!.router.list();
    },
    now: () => now,
  });
  try {
    const first = await h.app.inject({ method: "GET", url: API + "/agents" });
    const second = await h.app.inject({ method: "GET", url: API + "/agents" });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const rows = first.json<AgentStatus[]>();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.agent), ["claude", "codex", "pi"]);
    assert.equal(rows[1]?.available, false);
    assert.match(String(rows[1]?.reason), /^E_AGENT_UNAVAILABLE: /);
    assert.equal(rows[0]?.version, "1.2.3");
    assert.equal(probes, 1, "30s 内第二次 GET 不得重新探测");

    now += 30_001;
    const third = await h.app.inject({ method: "GET", url: API + "/agents" });
    assert.equal(third.statusCode, 200);
    assert.equal(probes, 2, "超过 30s 后应重新探测");
  } finally {
    await h.close();
  }
});

test("POST /dispatch 对未注册 agent 返回 422 E_AGENT_UNAVAILABLE", async () => {
  const claude = makeDriver("claude", CLAUDE_CAPABILITIES);
  const h = await makeHarness({ drivers: [{ driver: claude.driver }] });
  try {
    const res = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "codex", task: "干活", idempotencyKey: "k-missing" },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json<ErrorEnvelope>().error.code, "E_AGENT_UNAVAILABLE");
    assert.deepEqual(h.fake.calls, []);
  } finally {
    await h.close();
  }
});

test("POST /dispatch 对 available=false 的 agent 返回 422 E_AGENT_UNAVAILABLE 且带 reason", async () => {
  const codex = makeDriver("codex", CODEX_CAPABILITIES);
  const h = await makeHarness({
    drivers: [{ driver: codex.driver, available: false, reason: "E_AGENT_UNAVAILABLE: codex 未登录" }],
  });
  try {
    const res = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "codex", task: "干活", idempotencyKey: "k-unavailable" },
    });
    assert.equal(res.statusCode, 422);
    const body = res.json<ErrorEnvelope>();
    assert.equal(body.error.code, "E_AGENT_UNAVAILABLE");
    assert.equal((body.error.details as { reason?: string }).reason, "E_AGENT_UNAVAILABLE: codex 未登录");
    assert.deepEqual(h.fake.calls, []);
  } finally {
    await h.close();
  }
});

test("POST /dispatch 能力不足返回 422 E_CAP_UNSUPPORTED，不产生 adapter / driver 调用", async () => {
  const codex = makeDriver("codex", { ...CODEX_CAPABILITIES, inject: false });
  const h = await makeHarness({ drivers: [{ driver: codex.driver }] });
  try {
    const res = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "codex", task: "干活", idempotencyKey: "k-cap" },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json<ErrorEnvelope>().error.code, "E_CAP_UNSUPPORTED");
    assert.deepEqual(h.fake.calls, []);
    assert.deepEqual(codex.calls, []);
  } finally {
    await h.close();
  }
});

test("codex dispatch 挂 codex driver 的 update 流；claude dispatch 挂 claude driver（B08 M2）", async () => {
  const claude = makeDriver("claude", CLAUDE_CAPABILITIES);
  const codex = makeDriver("codex", CODEX_CAPABILITIES, {
    newSession: async () => ({ sessionId: "sess-codex" }),
  });
  const attached: unknown[] = [];
  const h = await makeHarness({
    drivers: [{ driver: claude.driver }, { driver: codex.driver }],
    pipelineAttach: (source) => {
      attached.push(source);
    },
  });
  try {
    const codexRes = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "codex", task: "干活", idempotencyKey: "k-codex" },
    });
    assert.equal(codexRes.statusCode, 200, codexRes.body);
    assert.equal(codexRes.json<SessionRef>().key, "codex:sess-codex");
    assert.equal(attached.length, 1, "codex dispatch 必须挂事件管线");
    assert.equal(attached[0], codex.driver, "codex 挂的是 codex driver，不是 Claude adapter");
    assert.ok(codex.calls.includes("inject"));

    const claudeRes = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { task: "干活", idempotencyKey: "k-claude" },
    });
    assert.equal(claudeRes.statusCode, 200, claudeRes.body);
    assert.equal(attached.length, 2, "claude dispatch 也要挂事件管线");
    assert.equal(attached[1], claude.driver, "claude 挂的是 claude driver");
  } finally {
    await h.close();
  }
});

test("Pi dispatch 投递后释放内部 pi 租约，普通 clientId 可以继续 inject", async () => {
  const holders: string[] = [];
  let h: Harness | null = null;
  const pi = makeDriver("pi", capsOf("pi"), {
    newSession: async () => ({ sessionId: "sess-pi-dispatch" }),
    inject: async (ref) => {
      holders.push(h?.leases.current(ref.key)?.clientId ?? "none");
      h?.leases.acquire(ref.key, "pi", "pi");
      return { messageId: "pi-m1", effective: "now" };
    },
  });
  h = await makeHarness({ drivers: [{ driver: pi.driver }] });
  try {
    const dispatched = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { agent: "pi", task: "干活", idempotencyKey: "k-pi-dispatch" },
    });
    assert.equal(dispatched.statusCode, 200, dispatched.body);
    const key = dispatched.json<SessionRef>().key;
    assert.equal(holders[0], "none", "dispatch 投递前不应有租约");
    assert.equal(h.leases.current(key), null, "dispatch 返回后内部 pi 租约必须释放");

    await acquire(h.app, key);
    const injected = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/inject",
      payload: { text: "继续", clientId: "pi:7" },
    });
    assert.equal(injected.statusCode, 200, injected.body);
    assert.deepEqual(holders, ["none", "pi"], "第二次写操作期间 driver 看到的租约应是 pi");
    assert.equal(h.leases.current(key)?.clientId, "pi:7", "写操作结束后租约应还给扩展身份");
  } finally {
    await h.close();
  }
});

test("/transcript：会话没有 transcriptPath 时委派 driver.see（Codex ACP 新会话）", async () => {
  const codex = makeDriver("codex", CODEX_CAPABILITIES, {
    see: async () => ({
      messages: [{ id: "m1", role: "assistant", kind: "text", text: "delegated", ts: "2026-11-16T00:00:00.000Z" }],
      nextCursor: "12",
      pending: false,
    }),
  });
  const h = await makeHarness({
    drivers: [{ driver: codex.driver }],
    seed: [sessionRef("codex", "sess-lazy")],
  });
  try {
    const res = await h.app.inject({
      method: "GET",
      url: API + "/sessions/" + encodeURIComponent("codex:sess-lazy") + "/transcript?after=0&limit=10",
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ messages: Array<{ text: string }>; nextCursor: string }>();
    assert.equal(body.messages[0]?.text, "delegated");
    assert.equal(body.nextCursor, "12");
  } finally {
    await h.close();
  }
});

test("codex handoff 走 driver.handoff 返回原生 resume 命令（attach=false 不是 422）", async () => {
  const codex = makeDriver("codex", CODEX_CAPABILITIES, {
    handoff: async () => ({ command: ["codex", "resume", "sess-codex", "--no-alt-screen"], mode: "resume-tui" }),
  });
  const h = await makeHarness({
    drivers: [{ driver: codex.driver }],
    seed: [sessionRef("codex", "sess-codex", { transcriptPath: CODEX_SAMPLE })],
  });
  try {
    await acquire(h.app, "codex:sess-codex");
    const res = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent("codex:sess-codex") + "/handoff",
      payload: { to: "human", clientId: "pi:7", summary: "交给人类" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ command: string[]; mode: string }>();
    assert.deepEqual(body.command, ["codex", "resume", "sess-codex", "--no-alt-screen"]);
    assert.equal(body.mode, "resume-tui");
  } finally {
    await h.close();
  }
});

test("handoff 若实际返回 attach 语义而 agent caps.attach=false，返回 422 E_CAP_UNSUPPORTED", async () => {
  const codex = makeDriver("codex", CODEX_CAPABILITIES, {
    handoff: async () => ({ command: ["codex", "attach", "sess-codex"], mode: "attach" }),
  });
  const h = await makeHarness({
    drivers: [{ driver: codex.driver }],
    seed: [sessionRef("codex", "sess-codex")],
  });
  try {
    await acquire(h.app, "codex:sess-codex");
    const res = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent("codex:sess-codex") + "/handoff",
      payload: { to: "human", clientId: "pi:7" },
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json<ErrorEnvelope>().error.code, "E_CAP_UNSUPPORTED");
  } finally {
    await h.close();
  }
});

test("Pi 的 inject/interrupt/handoff/handback 在共享 LeaseManager 上临时切换到 driver clientId", async () => {
  const key = "pi:sess-pi";
  const holders: string[] = [];
  const order: string[] = [];
  let h: Harness | null = null;
  const pi = makeDriver("pi", capsOf("pi"), {
    inject: async () => {
      holders.push(h?.leases.current(key)?.clientId ?? "none");
      return { messageId: "pi-m1", effective: "now" };
    },
    interrupt: async () => {
      holders.push(h?.leases.current(key)?.clientId ?? "none");
      return { stopReason: "cancelled" };
    },
    resume: async () => {
      holders.push(h?.leases.current(key)?.clientId ?? "none");
    },
    close: async () => {
      order.push("close");
    },
    handoff: async () => {
      holders.push(h?.leases.current(key)?.clientId ?? "none");
      order.push("handoff");
      return { command: ["pi", "--session", "C:\\sessions\\pi-sess-pi.jsonl"], mode: "resume-tui" };
    },
  });
  h = await makeHarness({ drivers: [{ driver: pi.driver }], seed: [sessionRef("pi", "sess-pi")] });
  try {
    await acquire(h.app, key);
    const injected = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/inject",
      payload: { text: "你好", clientId: "pi:7" },
    });
    assert.equal(injected.statusCode, 200, injected.body);
    assert.equal(h.leases.current(key)?.clientId, "pi:7", "写操作结束后租约必须还给扩展身份");

    const interrupted = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/interrupt",
      payload: { clientId: "pi:7" },
    });
    assert.equal(interrupted.statusCode, 200, interrupted.body);
    assert.equal(h.leases.current(key)?.clientId, "pi:7");

    const handed = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/handoff",
      payload: { to: "human", clientId: "pi:7", summary: "交给人类" },
    });
    assert.equal(handed.statusCode, 200, handed.body);
    assert.deepEqual(order, ["close", "handoff"], "handoff 必须先 close 控制通道，再返回原生命令（避免双写）");

    const returned = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/handback",
      payload: { clientId: "pi:7" },
    });
    assert.equal(returned.statusCode, 200, returned.body);
    assert.equal(h.leases.current(key)?.clientId, "pi:7", "handback 后租约回到扩展身份");
    assert.deepEqual(holders, ["pi", "pi", "pi", "pi"], "每次写操作 driver 内部看到的租约持有人都必须是 pi");
  } finally {
    await h.close();
  }
});

test("GET /sessions 会补解析 Codex 的 transcriptPath 并计算 unread（唤醒修复）", async () => {
  let resolves = 0;
  const codex = makeDriver("codex", CODEX_CAPABILITIES, {
    resolveTranscriptPath: async () => {
      resolves += 1;
      return CODEX_SAMPLE;
    },
  });
  const h = await makeHarness({
    drivers: [{ driver: codex.driver }],
    seed: [sessionRef("codex", "sess-lazy")],
  });
  try {
    const first = await h.app.inject({ method: "GET", url: API + "/sessions?clientId=pi:7" });
    assert.equal(first.statusCode, 200, first.body);
    const rows = first.json<Array<SessionRef & { unread: number }>>();
    const row = rows.find((item) => item.key === "codex:sess-lazy");
    assert.ok(row, "列表应包含补解析的 codex 会话");
    assert.equal(row.transcriptPath, CODEX_SAMPLE, "读取列表时应把懒解析路径写回会话");
    assert.ok(row.unread > 0, "路径补上后 unread 必须能读到真实消息数，否则 TurnNotifier 会丢弃回合结束事件");

    const detail = await h.app.inject({
      method: "GET",
      url: API + "/sessions/" + encodeURIComponent("codex:sess-lazy") + "?clientId=pi:7",
    });
    assert.equal(detail.statusCode, 200, detail.body);
    const detailSession = detail.json<{ session: SessionRef & { unread: number } }>().session;
    assert.equal(detailSession.transcriptPath, CODEX_SAMPLE);
    assert.ok(detailSession.unread > 0);

    const unread = await h.app.inject({
      method: "GET",
      url: API + "/sessions/" + encodeURIComponent("codex:sess-lazy") + "/unread?clientId=pi:7",
    });
    assert.equal(unread.statusCode, 200, unread.body);
    assert.ok(unread.json<{ unread: number }>().unread > 0);
    assert.equal(resolves, 1, "路径已持久化后不应重复扫描 rollout");
  } finally {
    await h.close();
  }
});

test("codex 会话的读路径走 readTranscript(agent, ...)，不经过 Claude 解析器", async () => {
  const codex = makeDriver("codex", CODEX_CAPABILITIES);
  const h = await makeHarness({
    drivers: [{ driver: codex.driver }],
    seed: [sessionRef("codex", "sess-read", { transcriptPath: CODEX_SAMPLE })],
  });
  try {
    const res = await h.app.inject({
      method: "GET",
      url: API + "/sessions/" + encodeURIComponent("codex:sess-read") + "/transcript?after=0",
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ messages: Array<{ text: string }>; nextCursor: string }>();
    assert.equal(body.messages.length, 8);
    assert.ok(body.nextCursor !== "0");
  } finally {
    await h.close();
  }
});

test("probeAgents：三个探测器并行，codex/pi 子进程都带 3s 超时", async () => {
  const seen: Array<{ command: string; timeoutMs: number }> = [];
  const runCommand: ProbeCommandRunner = async (command, _args, timeoutMs) => {
    seen.push({ command, timeoutMs });
    return command === "codex" ? "codex-cli 0.167.0" : "pi 0.24.1";
  };
  const probes = await probeAgents(makeConfig("C:\\unused"), {
    home: "C:\\home",
    fileExists: () => true,
    readPackageVersion: () => "1.2.3",
    importPi: async () => ({}),
    runCommand,
  });
  assert.deepEqual(probes.map((probe) => probe.agent), ["claude", "codex", "pi"]);
  assert.ok(probes.every((probe) => probe.available === true), JSON.stringify(probes));
  assert.equal(probes[1]?.version, "0.167.0");
  assert.equal(probes[2]?.version, "0.24.1");
  assert.deepEqual(seen.map((item) => item.command), ["codex", "pi"]);
  assert.ok(seen.every((item) => item.timeoutMs === PROBE_TIMEOUT_MS));
  assert.equal(PROBE_TIMEOUT_MS, 3000);
});

test("probeAgents：任一探测器失败只返回机器可读 reason，绝不抛出", async () => {
  const failingRun: ProbeCommandRunner = async () => {
    throw Object.assign(new Error("spawn timeout"), { killed: true });
  };
  const probes = await probeAgents(makeConfig("C:\\unused"), {
    home: "C:\\home",
    fileExists: () => false,
    importPi: async () => {
      throw new Error("package missing");
    },
    runCommand: failingRun,
  });
  assert.equal(probes.length, 3);
  for (const probe of probes) {
    assert.equal(probe.available, false, probe.agent);
    assert.match(String(probe.reason), /^E_AGENT_UNAVAILABLE: /, probe.agent);
    assert.equal(probe.version, null);
  }
});

test("POST /attach：claude 后台会话（caps.attach=true）→ 200 并调用 driver.attach", async () => {
  const claude = makeDriver("claude", CLAUDE_BACKGROUND_CAPABILITIES);
  const h = await makeHarness({
    drivers: [{ driver: claude.driver }],
    seed: [
      sessionRef("claude", "sess-bg", {
        kind: "background",
        capabilities: { ...CLAUDE_BACKGROUND_CAPABILITIES },
      }),
    ],
  });
  try {
    const res = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent("claude:sess-bg") + "/attach",
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json<{ attached: boolean; agent: string }>(), {
      attached: true,
      sessionKey: "claude:sess-bg",
      agent: "claude",
    });
    assert.deepEqual(claude.calls, ["attach"]);
  } finally {
    await h.close();
  }
});

test("POST /attach：codex / pi（caps.attach=false）→ 422 E_CAP_UNSUPPORTED，且不调用 driver.attach", async () => {
  const codex = makeDriver("codex", CODEX_CAPABILITIES);
  const pi = makeDriver("pi", capsOf("pi"));
  const h = await makeHarness({
    drivers: [{ driver: codex.driver }, { driver: pi.driver }],
    seed: [sessionRef("codex", "sess-codex"), sessionRef("pi", "sess-pi")],
  });
  try {
    for (const key of ["codex:sess-codex", "pi:sess-pi"]) {
      const res = await h.app.inject({
        method: "POST",
        url: API + "/sessions/" + encodeURIComponent(key) + "/attach",
      });
      assert.equal(res.statusCode, 422, res.body);
      const body = res.json<ErrorEnvelope>();
      assert.equal(body.error.code, "E_CAP_UNSUPPORTED");
      assert.deepEqual(body.error.details, { agent: key.split(":")[0], cap: "attach" });
    }
    assert.deepEqual(codex.calls, [], "codex 不得调用 attach");
    assert.deepEqual(pi.calls, [], "pi 不得调用 attach");
  } finally {
    await h.close();
  }
});

test("POST /attach：claude 交互式会话（caps.attach=false）同样 422，不产生 driver 调用", async () => {
  const claude = makeDriver("claude", CLAUDE_CAPABILITIES);
  const h = await makeHarness({
    drivers: [{ driver: claude.driver }],
    seed: [sessionRef("claude", "sess-fg")],
  });
  try {
    const res = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent("claude:sess-fg") + "/attach",
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json<ErrorEnvelope>().error.code, "E_CAP_UNSUPPORTED");
    assert.deepEqual(claude.calls, []);
  } finally {
    await h.close();
  }
});

test("POST /attach：agent available=false → 422 E_AGENT_UNAVAILABLE，先于能力闸门且不调用 driver", async () => {
  const claude = makeDriver("claude", CLAUDE_BACKGROUND_CAPABILITIES);
  const h = await makeHarness({
    drivers: [{ driver: claude.driver, available: false, reason: "E_AGENT_UNAVAILABLE: claude CLI 未登录" }],
    seed: [sessionRef("claude", "sess-bg-unavailable", { capabilities: CLAUDE_BACKGROUND_CAPABILITIES, kind: "background" })],
  });
  try {
    const res = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent("claude:sess-bg-unavailable") + "/attach",
    });
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json<ErrorEnvelope>();
    assert.equal(body.error.code, "E_AGENT_UNAVAILABLE");
    assert.deepEqual(body.error.details, {
      agent: "claude",
      cap: "attach",
      reason: "E_AGENT_UNAVAILABLE: claude CLI 未登录",
    });
    assert.deepEqual(claude.calls, [], "不可用 agent 不得调用 attach");
  } finally {
    await h.close();
  }
});

test("GET /health 冷缓存立即返回注册表快照并后台预热，/agents 复用同一次探测", async () => {
  const claude = makeDriver("claude", CLAUDE_CAPABILITIES);
  let probes = 0;
  const h = await makeHarness({
    drivers: [{ driver: claude.driver }],
    agentStatuses: async () => {
      probes += 1;
      return [{ agent: "claude", available: false, version: null, caps: CLAUDE_CAPABILITIES, reason: "E_AGENT_UNAVAILABLE: probe down" }];
    },
  });
  try {
    const health = await h.app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200, health.body);
    assert.deepEqual(
      health.json<{ adapters: unknown }>().adapters,
      [{ agent: "claude", available: true }],
      "冷缓存 health 只读注册表快照，不等待探测",
    );
    const agents = await h.app.inject({ method: "GET", url: API + "/agents" });
    assert.equal(agents.statusCode, 200, agents.body);
    assert.equal(agents.json<AgentStatus[]>()[0]?.available, false);
    assert.equal(probes, 1, "health 触发的后台探测应被 /agents 复用（30s 内只探测一次）");
  } finally {
    await h.close();
  }
});

test("GET /health 不阻塞在 2s 探测上；随后 /agents 仍拿到探测结果", async () => {
  const claude = makeDriver("claude", CLAUDE_CAPABILITIES);
  let probes = 0;
  const h = await makeHarness({
    drivers: [{ driver: claude.driver }],
    agentStatuses: async () => {
      probes += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      return [{ agent: "claude", available: false, version: null, caps: CLAUDE_CAPABILITIES, reason: "E_AGENT_UNAVAILABLE: probe down" }];
    },
  });
  try {
    const started = Date.now();
    const health = await h.app.inject({ method: "GET", url: "/health" });
    const elapsedMs = Date.now() - started;
    assert.equal(health.statusCode, 200, health.body);
    assert.ok(elapsedMs < 1_000, "GET /health 必须远早于 2s 探测返回，实际 " + String(elapsedMs) + "ms");
    assert.deepEqual(
      health.json<{ adapters: unknown }>().adapters,
      [{ agent: "claude", available: true }],
      "冷缓存时 health 返回注册表快照",
    );
    assert.equal(probes, 1, "health 应在后台触发一次探测");

    const agents = await h.app.inject({ method: "GET", url: API + "/agents" });
    assert.equal(agents.statusCode, 200, agents.body);
    assert.equal(agents.json<AgentStatus[]>()[0]?.available, false, "后续 /agents 必须拿到探测结果");
    assert.equal(probes, 1, "后台探测进行中时 /agents 复用它，不重复探测");
  } finally {
    await h.close();
  }
});

test("POST /attach：会话不存在 → 404 E_SESSION_NOT_FOUND", async () => {
  const claude = makeDriver("claude", CLAUDE_BACKGROUND_CAPABILITIES);
  const h = await makeHarness({ drivers: [{ driver: claude.driver }] });
  try {
    const res = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent("claude:missing") + "/attach",
    });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json<ErrorEnvelope>().error.code, "E_SESSION_NOT_FOUND");
    assert.deepEqual(claude.calls, []);
  } finally {
    await h.close();
  }
});

test("GET /sessions/discover：按 agent 发现并登记，返回 SessionRef", async () => {
  const found = sessionRef("codex", "sess-found", { cwd: "E:\\work" });
  const calls: string[] = [];
  const codex = makeDriver("codex", CODEX_CAPABILITIES, {
    discover: async (opts) => {
      calls.push(JSON.stringify(opts));
      return [found];
    },
  });
  const h = await makeHarness({ drivers: [{ driver: codex.driver }] });
  try {
    const res = await h.app.inject({
      method: "GET",
      url: API + "/sessions/discover?agent=codex&cwd=" + encodeURIComponent("E:\\work") + "&limit=5",
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ sessions: SessionRef[]; count: number }>();
    assert.equal(body.count, 1);
    assert.equal(body.sessions[0]?.key, "codex:sess-found");
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0] ?? "{}"), { cwd: "E:\\work", limit: 5 });

    const defaulted = await h.app.inject({
      method: "GET",
      url: API + "/sessions/discover?agent=codex&cwd=" + encodeURIComponent("E:\\work"),
    });
    assert.equal(defaulted.statusCode, 200, defaulted.body);
    assert.deepEqual(JSON.parse(calls[1] ?? "{}"), { cwd: "E:\\work", limit: 100 }, "未显式传 limit 时默认 100");

    const list = await h.app.inject({ method: "GET", url: API + "/sessions?agent=codex" });
    assert.equal(list.statusCode, 200);
    const keys = list.json<SessionRef[]>().map((row) => row.key);
    assert.ok(keys.includes("codex:sess-found"), "发现结果必须登记进注册表：" + JSON.stringify(keys));
  } finally {
    await h.close();
  }
});

test("GET /sessions/discover：缺 agent 400，未注册 agent 422", async () => {
  const h = await makeHarness({ drivers: [] });
  try {
    const missing = await h.app.inject({ method: "GET", url: API + "/sessions/discover" });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json<ErrorEnvelope>().error.code, "E_BAD_REQUEST");

    const unknown = await h.app.inject({ method: "GET", url: API + "/sessions/discover?agent=nope" });
    assert.equal(unknown.statusCode, 422);
    assert.equal(unknown.json<ErrorEnvelope>().error.code, "E_AGENT_UNAVAILABLE");
  } finally {
    await h.close();
  }
});

test("dispatch 复用 /agents 的 30s 探测缓存：两次 dispatch 只探测一次（B08 S1）", async () => {
  const claude = makeDriver("claude", CLAUDE_CAPABILITIES);
  let probes = 0;
  const h = await makeHarness({
    drivers: [{ driver: claude.driver }],
    agentStatuses: async () => {
      probes += 1;
      return [{ agent: "claude", available: true, version: "x", caps: CLAUDE_CAPABILITIES }];
    },
  });
  try {
    for (const key of ["k-a", "k-b"]) {
      const res = await h.app.inject({
        method: "POST",
        url: API + "/dispatch",
        payload: { agent: "claude", task: "干活", idempotencyKey: key },
      });
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.equal(probes, 1, "30s 缓存内第二次 dispatch 不得重新探测");
  } finally {
    await h.close();
  }
});


test("P0-1 codex 的 inject/interrupt/handoff/handback 在 pi:<pid> 租约下全部 200", async () => {
  const key = "codex:sess-codex-write";
  const fake = makeFake();
  let h: Harness | null = null;
  const codex = new CodexDriver(makeConfig("C:\\unused"), {
    spawnAdapter: async () => fake.adapter,
    resolveRolloutPath: async () => undefined,
    discoverSessions: async () => [],
    authorizeWrite: (ref, action) => makeCodexWriteGuard(h!.leases)(ref, action),
  });
  h = await makeHarness({
    drivers: [{ driver: codex }],
    seed: [sessionRef("codex", "sess-codex-write")],
  });
  try {
    await acquire(h.app, key);

    const injected = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/inject",
      payload: { text: "你好", clientId: "pi:7" },
    });
    assert.equal(injected.statusCode, 200, injected.body);
    assert.equal(h.leases.current(key)?.clientId, "pi:7");

    const interrupted = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/interrupt",
      payload: { clientId: "pi:7" },
    });
    assert.equal(interrupted.statusCode, 200, interrupted.body);
    assert.equal(h.leases.current(key)?.clientId, "pi:7");

    const handed = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/handoff",
      payload: { to: "human", clientId: "pi:7", summary: "交给人类" },
    });
    assert.equal(handed.statusCode, 200, handed.body);
    assert.equal(handed.json<{ mode: string }>().mode, "resume-tui");
    assert.equal(h.leases.current(key)?.clientId, "handoff-pi:7");

    const returned = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/handback",
      payload: { clientId: "pi:7" },
    });
    assert.equal(returned.statusCode, 200, returned.body);
    assert.equal(h.leases.current(key)?.clientId, "pi:7");
    assert.ok(fake.calls.includes("prompt:" + "sess-codex-write:你好"));
    assert.ok(fake.calls.includes("cancel:" + "sess-codex-write"));
    assert.ok(fake.calls.includes("close:" + "sess-codex-write"));
    assert.equal(fake.calls.filter((call) => call.startsWith("resume:")).length, 2, "首轮 resume + handback resume");
  } finally {
    await h.close();
    await codex.dispose();
  }
});

test("P1-1 discover 不覆盖已存在会话的 status/driver，只补 transcriptPath", async () => {
  const found = sessionRef("codex", "sess-active", {
    status: "idle",
    driver: "none",
    transcriptPath: "C:\\rollout\\active.jsonl",
  });
  const codex = makeDriver("codex", CODEX_CAPABILITIES, { discover: async () => [found] });
  const h = await makeHarness({
    drivers: [{ driver: codex.driver }],
    seed: [sessionRef("codex", "sess-active", { status: "running", driver: "pi" })],
  });
  try {
    const discovered = await h.app.inject({
      method: "GET",
      url: API + "/sessions/discover?agent=codex&cwd=" + encodeURIComponent("E:\\work"),
    });
    assert.equal(discovered.statusCode, 200, discovered.body);
    const row = discovered.json<{ sessions: SessionRef[] }>().sessions[0];
    assert.equal(row?.status, "running", "发现结果不得把活跃会话打回 idle");
    assert.equal(row?.driver, "pi", "发现结果不得覆盖 driver");
    assert.equal(row?.transcriptPath, "C:\\rollout\\active.jsonl", "缺失的 transcriptPath 应补上");

    const registered = await h.app.inject({
      method: "POST",
      url: API + "/sessions",
      payload: {
        agent: "codex",
        nativeId: "sess-active",
        cwd: "E:\\work",
        transcriptPath: "C:\\other.jsonl",
      },
    });
    assert.equal(registered.statusCode, 200, registered.body);
    const body = registered.json<{ created: boolean; session: SessionRef }>();
    assert.equal(body.created, false);
    assert.equal(body.session.status, "running");
    assert.equal(body.session.driver, "pi");
    assert.equal(body.session.transcriptPath, "C:\\rollout\\active.jsonl", "已有 transcriptPath 不被覆盖");
  } finally {
    await h.close();
  }
});

test("P2-3 discover / register / handback 都会把会话挂到事件管线", async () => {
  const attached: Array<{ source: unknown; key: string }> = [];
  const found = sessionRef("codex", "sess-pipe", { transcriptPath: "C:\\rollout\\pipe.jsonl" });
  const codex = makeDriver("codex", CODEX_CAPABILITIES, { discover: async () => [found] });
  const hbKey = "codex:sess-handback";
  const h = await makeHarness({
    drivers: [{ driver: codex.driver }],
    seed: [sessionRef("codex", "sess-handback", { status: "handoff", driver: "human" })],
    pipelineAttach: (source, key) => attached.push({ source, key }),
  });
  try {
    const discovered = await h.app.inject({
      method: "GET",
      url: API + "/sessions/discover?agent=codex&cwd=" + encodeURIComponent("E:\\work"),
    });
    assert.equal(discovered.statusCode, 200, discovered.body);

    const registered = await h.app.inject({
      method: "POST",
      url: API + "/sessions",
      payload: { agent: "codex", nativeId: "sess-register", cwd: "E:\\work" },
    });
    assert.equal(registered.statusCode, 200, registered.body);

    h.leases.acquire(hbKey, "human", "handoff-pi:7");
    const returned = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(hbKey) + "/handback",
      payload: { clientId: "pi:7" },
    });
    assert.equal(returned.statusCode, 200, returned.body);

    assert.deepEqual(attached.map((item) => item.key), ["codex:sess-pipe", "codex:sess-register", hbKey]);
    assert.ok(attached.every((item) => item.source === codex.driver), "每条会话都必须挂到对应 driver 的 update 流");
  } finally {
    await h.close();
  }
});
