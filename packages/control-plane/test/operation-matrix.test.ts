/**
 * C08 操作矩阵：3 agents × {inject, interrupt, attach, handoff, resume} × {API route, driver method}。
 *
 * 与 matrix.test.ts（transcript 解析矩阵）分开：这里锁定控制面的操作入口与错误集合，
 * driver 用脚本化 test double，不起真实 adapter / RPC 子进程。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentName, SessionCaps, SessionRef } from "@pi-workbench/shared";
import type { FastifyInstance } from "fastify";

import type { AgentAdapter } from "../src/adapters/types.ts";
import { AgentRouter } from "../src/agents/router.ts";
import type { AgentDriver } from "../src/agents/types.ts";
import { capsOf } from "../src/capabilities.ts";
import { CheckpointStore } from "../src/checkpoints.ts";
import type { Config } from "../src/config.ts";
import { ReadCursorStore } from "../src/cursors.ts";
import { migrate, openDb } from "../src/db.ts";
import { DispatchStore } from "../src/dispatch-store.ts";
import { WorkbenchError } from "../src/errors.ts";
import { EventStore } from "../src/events.ts";
import { LeaseManager } from "../src/lease.ts";
import { SessionRegistry } from "../src/registry.ts";
import type { ServerDeps } from "../src/server.ts";
import { createServer } from "../src/server.ts";
import { TakeoverEngine } from "../src/takeover.ts";

const API = "/api/cp";
type Operation = "inject" | "interrupt" | "attach" | "handoff" | "resume";
type Entry = "api" | "driver";
const AGENTS: AgentName[] = ["claude", "codex", "pi"];
const OPERATIONS: Operation[] = ["inject", "interrupt", "attach", "handoff", "resume"];
const ENTRIES: Entry[] = ["api", "driver"];

type DriverBox = { driver: AgentDriver; calls: string[] };

function makeDriver(agent: AgentName, caps: SessionCaps = capsOf(agent)): DriverBox {
  const calls: string[] = [];
  const driver: AgentDriver = {
    agent,
    caps,
    discover: async () => [],
    attach: async () => {
      calls.push("attach");
      if (agent === "codex") {
        throw new WorkbenchError("E_CAP_UNSUPPORTED", "Codex 不支持 attach（caps.attach=false）", {
          agent: "codex",
          cap: "attach",
        });
      }
    },
    inject: async () => {
      calls.push("inject");
      return { messageId: agent + "-m1", effective: "now" };
    },
    interrupt: async () => {
      calls.push("interrupt");
      return { stopReason: "cancelled" };
    },
    resume: async () => {
      calls.push("resume");
    },
    handoff: async () => {
      calls.push("handoff");
      return agent === "claude"
        ? { command: ["claude", "--resume", "native-1"], mode: "resume-tui" }
        : agent === "codex"
          ? { command: ["codex", "resume", "native-1", "--no-alt-screen"], mode: "resume-tui" }
          : { command: ["pi", "--session", "native-1.jsonl"], mode: "resume-tui" };
    },
    onUpdate: () => () => {},
    dispose: async () => {},
  };
  return { driver, calls };
}

function makeAdapter(): AgentAdapter {
  return {
    newSession: async () => ({ sessionId: "native-1" }),
    resume: async () => {},
    prompt: async () => ({ messageId: "fallback-m1" }),
    cancel: async () => ({ stopReason: "cancelled" }),
    close: async () => {},
    onUpdate: () => () => {},
    dispose: async () => {},
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

function sessionRef(agent: AgentName, overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    key: agent + ":matrix",
    agent,
    nativeId: "matrix",
    acpSessionId: "matrix",
    cwd: "E:\\pi-workbench\\spike\\a00-workspace",
    status: "idle",
    driver: "pi",
    capabilities: capsOf(agent),
    kind: "interactive",
    ...overrides,
  };
}

type Harness = {
  app: FastifyInstance;
  leases: LeaseManager;
  driver: DriverBox;
  close(): Promise<void>;
};

async function makeHarness(agent: AgentName, seed: Partial<SessionRef> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-operation-matrix-"));
  const db = openDb(":memory:");
  migrate(db);
  const driver = makeDriver(agent);
  const router = new AgentRouter();
  router.register(driver.driver, { available: true, version: "test" });
  const store = new EventStore(db);
  const leases = new LeaseManager(db);
  const registry = new SessionRegistry(db);
  const checkpoints = new CheckpointStore(db);
  const dispatches = new DispatchStore(db);
  const cursors = new ReadCursorStore(db);
  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter: makeAdapter(),
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
    adapter: makeAdapter(),
    checkpoints,
    cursors,
    router,
  };
  const app = await createServer(deps);
  registry.upsert(sessionRef(agent, seed));
  return {
    app,
    leases,
    driver,
    close: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function assertApiError(res: { statusCode: number; body: string }, status: number, code: string): void {
  assert.equal(res.statusCode, status, res.body);
  const body = JSON.parse(res.body) as { error: { code: string; details?: unknown } };
  assert.equal(body.error.code, code);
}

async function runApiCell(agent: AgentName, operation: Operation): Promise<void> {
  const session =
    operation === "resume"
      ? { status: "handoff" as const, driver: "human" as const }
      : {};
  const h = await makeHarness(agent, session);
  try {
    const key = agent + ":matrix";
    if (operation === "resume") {
      h.leases.acquire(key, "human", "handoff-pi:1");
    } else {
      h.leases.acquire(key, "pi", "pi:1");
    }
    const url = API + "/sessions/" + encodeURIComponent(key) + "/" + (operation === "resume" ? "handback" : operation);
    const payload =
      operation === "inject"
        ? { clientId: "pi:1", text: "matrix" }
        : operation === "interrupt"
          ? { clientId: "pi:1" }
          : operation === "handoff"
            ? { to: "human", clientId: "pi:1" }
            : operation === "resume"
              ? { clientId: "handoff-pi:1" }
              : undefined;
    const res = await h.app.inject({ method: "POST", url, ...(payload === undefined ? {} : { payload }) });

    if (operation === "attach") {
      // 三个 agent 的交互式会话都声明 attach=false：API 必须在能力闸门返回 422，
      // 不调用 driver.attach（Claude 的 attach 能力只对 background 会话开放）。
      assertApiError(res, 422, "E_CAP_UNSUPPORTED");
      assert.deepEqual(h.driver.calls, [], "能力闸门不得调用 driver.attach");
      return;
    }
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<Record<string, unknown>>();
    if (operation === "inject") {
      assert.equal(body.messageId, agent + "-m1");
      assert.equal(body.effective, "now");
    } else if (operation === "interrupt") {
      assert.equal(body.stopReason, "cancelled");
    } else if (operation === "handoff") {
      assert.equal(typeof body.checkpoint, "object");
      assert.equal(Array.isArray(body.command), true);
      assert.equal(body.mode, "resume-tui");
    } else {
      assert.equal(body.resumed, true);
      assert.equal(typeof body.deltaSummary, "string");
    }
    assert.deepEqual(h.driver.calls, [operation]);
  } finally {
    await h.close();
  }
}

async function runDriverCell(agent: AgentName, operation: Operation): Promise<void> {
  const box = makeDriver(agent);
  const ref = sessionRef(agent, operation === "resume" ? { status: "handoff", driver: "human" } : {});
  if (operation === "attach") {
    if (agent === "codex") {
      await assert.rejects(() => box.driver.attach(ref), (err: unknown) => {
        assert.ok(err instanceof WorkbenchError);
        assert.equal(err.code, "E_CAP_UNSUPPORTED");
        return true;
      });
    } else {
      await box.driver.attach(ref);
    }
  } else if (operation === "inject") {
    const result = await box.driver.inject(ref, "matrix");
    assert.equal(result.messageId, agent + "-m1");
    assert.equal(result.effective, "now");
  } else if (operation === "interrupt") {
    const result = await box.driver.interrupt(ref);
    assert.equal(result.stopReason, "cancelled");
  } else if (operation === "handoff") {
    const result = await box.driver.handoff(ref);
    assert.equal(Array.isArray(result.command), true);
    assert.equal(result.command[0], agent);
    assert.equal(result.mode, "resume-tui");
  } else {
    await box.driver.resume(ref);
  }
  assert.deepEqual(box.calls, [operation]);
}

for (const agent of AGENTS) {
  for (const entry of ENTRIES) {
    for (const operation of OPERATIONS) {
      test("operation-matrix/" + agent + "/" + entry + "/" + operation, async () => {
        if (entry === "api") {
          await runApiCell(agent, operation);
        } else {
          await runDriverCell(agent, operation);
        }
      });
    }
  }
}
