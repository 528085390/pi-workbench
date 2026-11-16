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
import type { AgentDriver, AgentStatus } from "../src/agents/types.ts";
import { CLAUDE_CAPABILITIES, CODEX_CAPABILITIES, capsOf } from "../src/capabilities.ts";
import { CheckpointStore } from "../src/checkpoints.ts";
import type { Config } from "../src/config.ts";
import { ReadCursorStore } from "../src/cursors.ts";
import { migrate, openDb } from "../src/db.ts";
import { DispatchStore } from "../src/dispatch-store.ts";
import { EventStore } from "../src/events.ts";
import { PROBE_TIMEOUT_MS, probeAgents } from "../src/index.ts";
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
    claude: { adapterCmd: [process.execPath], permissionMode: "auto_allow" },
  };
}

type HarnessOptions = {
  drivers?: Registered[];
  agentStatuses?: () => Promise<AgentStatus[]>;
  now?: () => number;
  seed?: SessionRef[];
  pipelineAttach?: () => void;
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
      : { pipeline: { attach: () => {
          options.pipelineAttach?.();
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

test("codex dispatch 成功时不走 Claude 的 pipeline.attach；claude dispatch 仍挂管线", async () => {
  const claude = makeDriver("claude", CLAUDE_CAPABILITIES);
  const codex = makeDriver("codex", CODEX_CAPABILITIES, {
    newSession: async () => ({ sessionId: "sess-codex" }),
  });
  let attached = 0;
  const h = await makeHarness({
    drivers: [{ driver: claude.driver }, { driver: codex.driver }],
    pipelineAttach: () => {
      attached += 1;
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
    assert.equal(attached, 0, "codex 没有 attach 语义，不得调用 Claude 管线");
    assert.ok(codex.calls.includes("inject"));

    const claudeRes = await h.app.inject({
      method: "POST",
      url: API + "/dispatch",
      payload: { task: "干活", idempotencyKey: "k-claude" },
    });
    assert.equal(claudeRes.statusCode, 200, claudeRes.body);
    assert.equal(attached, 1, "claude dispatch 仍按 0.5-A 挂事件管线");
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

test("Pi 写操作在共享 LeaseManager 上临时切换到 driver clientId，handoff 不报 E_LEASE_CONFLICT", async () => {
  const key = "pi:sess-pi";
  const holders: string[] = [];
  let h: Harness | null = null;
  const pi = makeDriver("pi", capsOf("pi"), {
    inject: async () => {
      holders.push(h?.leases.current(key)?.clientId ?? "none");
      return { messageId: "pi-m1", effective: "now" };
    },
    handoff: async () => {
      holders.push(h?.leases.current(key)?.clientId ?? "none");
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

    const handed = await h.app.inject({
      method: "POST",
      url: API + "/sessions/" + encodeURIComponent(key) + "/handoff",
      payload: { to: "human", clientId: "pi:7", summary: "交给人类" },
    });
    assert.equal(handed.statusCode, 200, handed.body);
    assert.deepEqual(holders, ["pi", "pi"], "driver 内部看到的租约持有人必须与其 clientId 一致");
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
