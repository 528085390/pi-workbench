import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionRef } from "@pi-workbench/shared";

import type { AgentAdapter } from "../src/adapters/types.ts";
import { CLAUDE_CAPABILITIES } from "../src/capabilities.ts";
import { CheckpointStore } from "../src/checkpoints.ts";
import type { Config } from "../src/config.ts";
import { ReadCursorStore } from "../src/cursors.ts";
import { migrate, openDb } from "../src/db.ts";
import { WorkbenchError } from "../src/errors.ts";
import { EventStore } from "../src/events.ts";
import { LeaseManager } from "../src/lease.ts";
import { SessionRegistry } from "../src/registry.ts";
import { STATUS_BY_CODE, createServer } from "../src/server.ts";
import type { ServerDeps } from "../src/server.ts";
import type { TakeoverEngine } from "../src/takeover.ts";
import { SessionWriteQueue } from "../src/write-queue.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("同会话 FIFO，不同会话并行", async () => {
  const q = new SessionWriteQueue();
  const order: string[] = [];
  let activeSameSession = 0;
  let maxActiveSameSession = 0;
  const job = (session: string, id: string, ms: number) => async (): Promise<string> => {
    if (session === "a") {
      activeSameSession += 1;
      maxActiveSameSession = Math.max(maxActiveSameSession, activeSameSession);
    }
    order.push("start:" + id);
    await delay(ms);
    order.push("end:" + id);
    if (session === "a") {
      activeSameSession -= 1;
    }
    return id;
  };

  const [a1, a2, b1] = await Promise.all([
    q.run("a", job("a", "a1", 30)),
    q.run("a", job("a", "a2", 1)),
    q.run("b", job("b", "b1", 10)),
  ]);

  assert.deepEqual([a1, a2, b1], ["a1", "a2", "b1"]);
  assert.equal(maxActiveSameSession, 1, "同一 sessionKey 的任务不得重叠");
  assert.ok(order.indexOf("start:b1") < order.indexOf("end:a1"), "不同 sessionKey 必须能并行（b1 应在 a1 结束前启动）");
  assert.ok(order.indexOf("end:a1") < order.indexOf("start:a2"), "同 sessionKey 必须 FIFO（a2 应在 a1 结束后启动）");
});

test("队列超限返回 E_SESSION_BUSY", async () => {
  const q = new SessionWriteQueue({ maxPending: 1 });
  let release = (): void => {};
  const blocker = q.run("a", async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return 1;
  });
  const second = q.run("a", async () => 2);
  await assert.rejects(q.run("a", async () => 3), (err: unknown) => {
    assert.ok(err instanceof WorkbenchError);
    assert.equal(err.code, "E_SESSION_BUSY");
    assert.deepEqual(err.details, { sessionKey: "a" });
    return true;
  });
  assert.equal(q.pending("a"), 1);
  release();
  assert.deepEqual(await Promise.all([blocker, second]), [1, 2]);
  assert.equal(q.pending("a"), 0);
});

test("等待超时返回 E_SESSION_BUSY，且取消项不阻塞后续任务", async () => {
  const q = new SessionWriteQueue({ waitTimeoutMs: 30 });
  let release = (): void => {};
  const blocker = q.run("a", async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return "blocker";
  });
  const timedOut = q.run("a", async () => "late");
  await assert.rejects(timedOut, (err: unknown) => {
    assert.ok(err instanceof WorkbenchError);
    assert.equal(err.code, "E_SESSION_BUSY");
    return true;
  });
  assert.equal(q.pending("a"), 0, "超时项应从待排队列移除");
  const next = q.run("a", async () => "next");
  release();
  assert.equal(await blocker, "blocker");
  assert.equal(await next, "next");
});

test("任务失败后槽位释放，后续任务继续执行", async () => {
  const q = new SessionWriteQueue();
  const first = q.run("a", async () => {
    throw new Error("boom");
  });
  const second = q.run("a", async () => 42);
  await assert.rejects(first, /boom/);
  assert.equal(await second, 42);
  assert.equal(q.pending("a"), 0);
});

test("E_SESSION_BUSY 映射为 HTTP 429", () => {
  assert.equal(STATUS_BY_CODE.E_SESSION_BUSY, 429);
});

type WiringHarness = {
  app: Awaited<ReturnType<typeof createServer>>;
  queueCalls: string[];
  engineCalls: string[];
  setBusy(value: boolean): void;
  close(): Promise<void>;
};

const SESSION_A = "claude:queue-a";
const SESSION_B = "claude:queue-b";

function makeConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    home: ".",
    authToken: null,
    leaseTtlMs: 30_000,
    dispatchReservedTtlMs: 120_000,
    claude: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialPermissionMode: "auto" },
    codex: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialAgentMode: "workspace-write" },
    pi: { rpcCmd: ["pi", "--mode", "rpc"] },
  };
}

function makeSession(key: string, nativeId: string): SessionRef {
  return {
    key,
    agent: "claude",
    nativeId,
    acpSessionId: nativeId,
    cwd: "E:\\pi-workbench",
    transcriptPath: "C:/tmp/" + nativeId + ".jsonl",
    status: "idle",
    driver: "pi",
    capabilities: CLAUDE_CAPABILITIES,
    kind: "interactive",
  };
}

/** 用假 queue / 假 engine 观察路由层是否按 sessionKey 入队，不启动任何子进程。 */
async function makeWiringHarness(): Promise<WiringHarness> {
  const db = openDb(":memory:");
  migrate(db);
  const store = new EventStore(db);
  const leases = new LeaseManager(db);
  const registry = new SessionRegistry(db);
  const checkpoints = new CheckpointStore(db);
  const cursors = new ReadCursorStore(db);
  const queueCalls: string[] = [];
  const engineCalls: string[] = [];
  let busy = false;

  const writeQueue = {
    run: async <T>(sessionKey: string, task: () => Promise<T>): Promise<T> => {
      if (busy) {
        throw new WorkbenchError("E_SESSION_BUSY", "队列忙", { sessionKey });
      }
      queueCalls.push(sessionKey);
      return await task();
    },
    pending: (): number => 0,
  };

  const engine = {
    inject: async (key: string) => {
      engineCalls.push("inject:" + key);
      return { ok: true };
    },
    interrupt: async (key: string) => {
      engineCalls.push("interrupt:" + key);
      return { ok: true };
    },
    checkpoint: async (key: string) => {
      engineCalls.push("checkpoint:" + key);
      return { ok: true };
    },
    handoff: async (key: string) => {
      engineCalls.push("handoff:" + key);
      return { ok: true };
    },
    handback: async (key: string) => {
      engineCalls.push("handback:" + key);
      return { ok: true };
    },
  };

  const deps: ServerDeps = {
    config: makeConfig(),
    store,
    leases,
    registry,
    engine: engine as unknown as TakeoverEngine,
    adapter: {} as unknown as AgentAdapter,
    checkpoints,
    cursors,
    writeQueue: writeQueue as unknown as SessionWriteQueue,
  };
  const app = await createServer(deps);
  registry.upsert(makeSession(SESSION_A, "queue-a"));
  registry.upsert(makeSession(SESSION_B, "queue-b"));

  return {
    app,
    queueCalls,
    engineCalls,
    setBusy: (value: boolean) => {
      busy = value;
    },
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

test("五个写路由按 sessionKey 入队，队列拒绝映射 429", async () => {
  const h = await makeWiringHarness();
  try {
    const cases: { suffix: string; payload: Record<string, unknown>; method: string }[] = [
      { suffix: "inject", payload: { clientId: "c1", text: "hi" }, method: "inject" },
      { suffix: "interrupt", payload: { clientId: "c1" }, method: "interrupt" },
      { suffix: "checkpoint", payload: { clientId: "c1", summary: "s" }, method: "checkpoint" },
      { suffix: "handoff", payload: { clientId: "c1", to: "human" }, method: "handoff" },
      { suffix: "handback", payload: { clientId: "c1" }, method: "handback" },
    ];
    for (const item of cases) {
      h.queueCalls.length = 0;
      h.engineCalls.length = 0;
      const res = await h.app.inject({
        method: "POST",
        url: "/api/cp/sessions/" + encodeURIComponent(SESSION_A) + "/" + item.suffix,
        payload: item.payload,
      });
      assert.equal(res.statusCode, 200, item.suffix + " 应 200：" + res.body);
      assert.deepEqual(h.queueCalls, [SESSION_A], item.suffix + " 必须按路径 sessionKey 入队");
      assert.deepEqual(h.engineCalls, [item.method + ":" + SESSION_A], item.suffix + " 必须调用 engine." + item.method);
    }

    h.queueCalls.length = 0;
    const other = await h.app.inject({
      method: "POST",
      url: "/api/cp/sessions/" + encodeURIComponent(SESSION_B) + "/inject",
      payload: { clientId: "c1", text: "hi" },
    });
    assert.equal(other.statusCode, 200, other.body);
    assert.deepEqual(h.queueCalls, [SESSION_B], "不同会话的路径 key 必须原样传给队列");

    h.setBusy(true);
    const busy = await h.app.inject({
      method: "POST",
      url: "/api/cp/sessions/" + encodeURIComponent(SESSION_A) + "/inject",
      payload: { clientId: "c1", text: "hi" },
    });
    assert.equal(busy.statusCode, 429, busy.body);
    assert.equal(busy.json<{ error: { code: string } }>().error.code, "E_SESSION_BUSY");
  } finally {
    await h.close();
  }
});
