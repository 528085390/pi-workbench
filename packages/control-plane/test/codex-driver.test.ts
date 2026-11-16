/**
 * CodexDriver（0.5-B B03）测试。
 *
 * 全部离线：进程级用例用 test/fixtures/fake-codex-acp-agent.mjs 这个最小 ACP v2 agent
 * 走 NDJSON stdio，不依赖真实 codex 二进制；纯逻辑用例注入假 AgentAdapter。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRef } from "@pi-workbench/shared";
import type { AdapterUpdate, AgentAdapter } from "../src/adapters/types.ts";
import { CodexDriver } from "../src/agents/codex-driver.ts";
import type { CodexDriverOptions } from "../src/agents/codex-driver.ts";
import { capsOf } from "../src/capabilities.ts";
import type { Config } from "../src/config.ts";
import { isWorkbenchError, WorkbenchError } from "../src/errors.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-codex-acp-agent.mjs", import.meta.url));
const WORKSPACE = fileURLToPath(new URL("./", import.meta.url));
const NATIVE_ID = "01a1d7c5-8568-73e2-b75f-ef912b042c4c";

function makeConfig(adapterCmd: string[]): Config {
  return {
    host: "127.0.0.1",
    port: 7331,
    home: WORKSPACE,
    authToken: null,
    leaseTtlMs: 30_000,
    claude: { adapterCmd: [process.execPath, FIXTURE], permissionMode: "auto_allow", initialPermissionMode: "auto" },
    codex: { adapterCmd, permissionMode: "auto_allow", initialAgentMode: "workspace-write" },
    pi: { rpcCmd: ["pi", "--mode", "rpc"] },
  };
}

function makeRef(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    key: "codex:" + NATIVE_ID,
    agent: "codex",
    nativeId: NATIVE_ID,
    cwd: "E:\\pi-workbench\\spike\\workspace",
    status: "idle",
    driver: "pi",
    capabilities: capsOf("codex"),
    kind: "interactive",
    ...overrides,
  };
}

type AdapterHarness = {
  adapter: AgentAdapter;
  calls: string[];
  args: Record<string, unknown[]>;
  emit: (update: AdapterUpdate) => void;
};

function makeFakeAdapter(overrides: Partial<AgentAdapter> = {}): AdapterHarness {
  const calls: string[] = [];
  const args: Record<string, unknown[]> = {};
  const listeners = new Set<(update: AdapterUpdate) => void>();
  const record = (method: string, values: unknown[]): void => {
    calls.push(method);
    args[method] = values;
  };
  const adapter: AgentAdapter = {
    newSession: async (cwd: string) => {
      record("newSession", [cwd]);
      return { sessionId: "sess-new" };
    },
    resume: async (sessionId: string, cwd: string) => {
      record("resume", [sessionId, cwd]);
    },
    prompt: async (sessionId: string, text: string) => {
      record("prompt", [sessionId, text]);
      return { messageId: "msg-fake" };
    },
    cancel: async (sessionId: string) => {
      record("cancel", [sessionId]);
      return { stopReason: "cancelled" };
    },
    close: async (sessionId: string) => {
      record("close", [sessionId]);
    },
    waitForTurn: async (sessionId: string, timeoutMs?: number) => {
      record("waitForTurn", [sessionId, timeoutMs]);
      return { stopReason: "end_turn" };
    },
    onUpdate: (cb: (update: AdapterUpdate) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose: async () => {
      record("dispose", []);
    },
    ...overrides,
  };
  return {
    adapter,
    calls,
    args,
    emit: (update: AdapterUpdate) => {
      for (const listener of listeners) {
        listener(update);
      }
    },
  };
}

function driverWith(harness: AdapterHarness, options: CodexDriverOptions = {}): CodexDriver {
  return new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    spawnAdapter: async () => harness.adapter,
    resolveRolloutPath: async () => undefined,
    discoverSessions: async () => [],
    ...options,
  });
}

function workbenchCode(code: string): (error: unknown) => true {
  return (error: unknown) => {
    assert.ok(isWorkbenchError(error), "应抛 WorkbenchError，实际：" + String(error));
    assert.equal(error.code, code);
    return true;
  };
}

function readLog(path: string): Array<{ method: string; params: Record<string, unknown> }> {
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) {
    return [];
  }
  return text.split(/\r?\n/).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

type AcpHarness = {
  driver: CodexDriver;
  logPath: string;
  dir: string;
};

function makeAcpDriver(fixtureArgs: string[] = [], options: CodexDriverOptions = {}): AcpHarness {
  const dir = mkdtempSync(join(tmpdir(), "codex-driver-"));
  const logPath = join(dir, "acp.log");
  const config = makeConfig([process.execPath, FIXTURE, "--record", logPath, ...fixtureArgs]);
  const driver = new CodexDriver(config, {
    cwd: WORKSPACE,
    resolveRolloutPath: async () => undefined,
    discoverSessions: async () => [],
    ...options,
  });
  return { driver, logPath, dir };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForUpdate(
  updates: AdapterUpdate[],
  predicate: (update: AdapterUpdate) => boolean,
  timeoutMs = 4000,
): Promise<AdapterUpdate> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = updates.find(predicate);
    if (hit !== undefined) {
      return hit;
    }
    await sleep(10);
  }
  assert.fail("等不到预期的 AdapterUpdate，已收到：" + JSON.stringify(updates));
}

test("CodexDriver.caps 与 capsOf('codex') 一致", () => {
  const { adapter } = makeFakeAdapter();
  const driver = driverWith({ adapter } as AdapterHarness);
  assert.equal(driver.agent, "codex");
  assert.deepEqual(driver.caps, capsOf("codex"));
  assert.equal(driver.caps.attach, false);
  assert.equal(driver.caps.permissions, false);
});

test("resume 通过 ACP 按原生 thread id 调 session/resume", async () => {
  const { driver, logPath, dir } = makeAcpDriver();
  try {
    await driver.resume(makeRef());
    const log = readLog(logPath);
    assert.deepEqual(log.map((entry) => entry.method), ["initialize", "session/resume"]);
    assert.equal(log[0]?.params["protocolVersion"], 2);
    assert.equal(log[1]?.params["sessionId"], NATIVE_ID);
    assert.equal(log[1]?.params["cwd"], makeRef().cwd);
  } finally {
    await driver.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inject 通过 ACP session/prompt 投递并收到 text update", async () => {
  const { driver, logPath, dir } = makeAcpDriver();
  try {
    const updates: AdapterUpdate[] = [];
    driver.onUpdate((update) => {
      updates.push(update);
    });
    await driver.resume(makeRef());
    const result = await driver.inject(makeRef(), "hello codex");
    assert.equal(result.messageId, "usr_1");
    assert.equal(result.effective, "now");
    const text = await waitForUpdate(updates, (update) => update.kind === "text");
    assert.equal(text.text, "codex-pong:hello codex");
    const log = readLog(logPath);
    const prompt = log.find((entry) => entry.method === "session/prompt");
    assert.deepEqual(prompt?.params["prompt"], [{ type: "text", text: "hello codex" }]);
    assert.equal(prompt?.params["sessionId"], NATIVE_ID);
    await driver.waitForTurn(makeRef());
  } finally {
    await driver.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("newSession 通过 ACP session/new 返回 thread id", async () => {
  const { driver, logPath, dir } = makeAcpDriver();
  try {
    const opened = await driver.newSession(WORKSPACE);
    assert.equal(opened.sessionId, "thread-1");
    const log = readLog(logPath);
    assert.deepEqual(log.map((entry) => entry.method), ["initialize", "session/new"]);
    assert.equal(log[1]?.params["cwd"], WORKSPACE);
  } finally {
    await driver.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume 被 agent 拒绝 → E_RESUME_REJECTED", async () => {
  const { driver, dir } = makeAcpDriver(["--fail-resume"]);
  try {
    await assert.rejects(driver.resume(makeRef()), workbenchCode("E_RESUME_REJECTED"));
  } finally {
    await driver.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter 起不来 → E_AGENT_UNAVAILABLE", async () => {
  const { driver, dir } = makeAcpDriver(["--fail-init"]);
  try {
    await assert.rejects(driver.resume(makeRef()), workbenchCode("E_AGENT_UNAVAILABLE"));
  } finally {
    await driver.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行中 resume 先 cancel 再 session/resume", async () => {
  const harness = makeFakeAdapter();
  const driver = driverWith(harness);
  try {
    await driver.resume(makeRef());
    await driver.resume(makeRef({ status: "running" }));
    assert.deepEqual(harness.calls, ["resume", "cancel", "resume"]);
  } finally {
    await driver.dispose();
  }
});

test("运行中 resume 即使本进程未驱动过也先 cancel", async () => {
  const harness = makeFakeAdapter();
  const driver = driverWith(harness);
  try {
    await driver.resume(makeRef({ status: "running" }));
    assert.deepEqual(harness.calls, ["cancel", "resume"]);
  } finally {
    await driver.dispose();
  }
});

test("运行中 cancel 超时 → E_RESUME_REJECTED", async () => {
  const harness = makeFakeAdapter({
    cancel: async () => await new Promise<{ stopReason: string }>(() => {}),
  });
  const driver = driverWith(harness, { quiesceTimeoutMs: 40 });
  try {
    await driver.resume(makeRef());
    await assert.rejects(driver.resume(makeRef({ status: "running" })), workbenchCode("E_RESUME_REJECTED"));
    assert.equal(harness.calls.filter((call) => call === "resume").length, 1);
  } finally {
    await driver.dispose();
  }
});

test("inject 无 lease 时不 spawn adapter、不发 prompt", async () => {
  const harness = makeFakeAdapter();
  let spawns = 0;
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    spawnAdapter: async () => {
      spawns += 1;
      return harness.adapter;
    },
    authorizeWrite: (ref, action) => {
      assert.equal(ref.nativeId, NATIVE_ID);
      assert.equal(action, "inject");
      throw new WorkbenchError("E_NO_LEASE", "测试：无租约");
    },
  });
  try {
    await assert.rejects(driver.inject(makeRef(), "不许发"), workbenchCode("E_NO_LEASE"));
    assert.equal(spawns, 0);
    assert.deepEqual(harness.calls, []);
  } finally {
    await driver.dispose();
  }
});

test("inject 在有 lease 时委托 adapter.prompt；running 标 next_turn", async () => {
  const harness = makeFakeAdapter();
  const actions: string[] = [];
  const driver = driverWith(harness, {
    authorizeWrite: (_ref, action) => {
      actions.push(action);
    },
  });
  try {
    await driver.resume(makeRef());
    const idle = await driver.inject(makeRef(), "继续");
    assert.deepEqual(idle, { messageId: "msg-fake", effective: "now" });
    const running = await driver.inject(makeRef({ status: "running" }), "插话");
    assert.deepEqual(running, { messageId: "msg-fake", effective: "next_turn" });
    assert.deepEqual(harness.args["prompt"], [NATIVE_ID, "插话"]);
    assert.deepEqual(actions, ["resume", "inject", "inject"]);
  } finally {
    await driver.dispose();
  }
});

test("interrupt 委托 adapter.cancel", async () => {
  const harness = makeFakeAdapter();
  const driver = driverWith(harness);
  try {
    await driver.resume(makeRef());
    const result = await driver.interrupt(makeRef());
    assert.deepEqual(result, { stopReason: "cancelled" });
    assert.deepEqual(harness.args["cancel"], [NATIVE_ID]);
  } finally {
    await driver.dispose();
  }
});

test("handoff 返回 codex resume <id> --no-alt-screen，且不 spawn adapter", async () => {
  let spawns = 0;
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    spawnAdapter: async () => {
      spawns += 1;
      throw new Error("不该 spawn");
    },
  });
  try {
    assert.deepEqual(await driver.handoff(makeRef()), {
      command: ["codex", "resume", NATIVE_ID, "--no-alt-screen"],
      mode: "resume-tui",
    });
    assert.equal(spawns, 0);
  } finally {
    await driver.dispose();
  }
});

test("attach 明确拒绝（caps.attach=false），不 spawn adapter", async () => {
  let spawns = 0;
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    spawnAdapter: async () => {
      spawns += 1;
      throw new Error("不该 spawn");
    },
  });
  try {
    await assert.rejects(driver.attach(makeRef()), workbenchCode("E_CAP_UNSUPPORTED"));
    assert.equal(spawns, 0);
  } finally {
    await driver.dispose();
  }
});

test("see：transcriptPath 为空返回 pending，不 spawn adapter", async () => {
  let spawns = 0;
  let reads = 0;
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    spawnAdapter: async () => {
      spawns += 1;
      throw new Error("不该 spawn");
    },
    readTranscript: () => {
      reads += 1;
      return { messages: [], nextCursor: "0", pending: false };
    },
    resolveRolloutPath: async () => undefined,
  });
  try {
    const page = await driver.see(makeRef(), "0", 10);
    assert.deepEqual(page, { messages: [], nextCursor: "0", pending: true });
    assert.equal(spawns, 0);
    assert.equal(reads, 0);
  } finally {
    await driver.dispose();
  }
});

test("see：有 transcriptPath 时走 readTranscript", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    readTranscript: (input) => {
      calls.push(input);
      return {
        messages: [{ id: "m1", role: "assistant", kind: "text", text: "hi", ts: "2026-11-16T00:00:00.000Z" }],
        nextCursor: "42",
        pending: false,
        skipped: 1,
      };
    },
  });
  try {
    const page = await driver.see(makeRef({ transcriptPath: "C:\\rollout.jsonl" }), "10", 5);
    assert.equal(page.nextCursor, "42");
    assert.equal(page.messages[0]?.text, "hi");
    assert.deepEqual(calls, [{ agent: "codex", path: "C:\\rollout.jsonl", cursor: "10", limit: 5 }]);
  } finally {
    await driver.dispose();
  }
});

test("see：无路径时懒解析成功就直接读，不返回 pending", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    resolveRolloutPath: async () => "C:\\lazy\\see.jsonl",
    readTranscript: (input) => {
      calls.push(input);
      return {
        messages: [{ id: "m1", role: "assistant", kind: "text", text: "lazy", ts: "2026-11-16T00:00:00.000Z" }],
        nextCursor: "9",
        pending: false,
      };
    },
  });
  try {
    const page = await driver.see(makeRef(), "0", 10);
    assert.equal(page.pending, false);
    assert.equal(page.messages[0]?.text, "lazy");
    assert.equal(calls[0]?.["path"], "C:\\lazy\\see.jsonl");
  } finally {
    await driver.dispose();
  }
});

test("resolveTranscriptPath：懒解析出的 rollout 路径可供 see 使用", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    resolveRolloutPath: async (threadId, cwd) => {
      assert.equal(threadId, NATIVE_ID);
      assert.equal(cwd, makeRef().cwd);
      return "C:\\lazy\\rollout.jsonl";
    },
    readTranscript: (input) => {
      calls.push(input);
      return { messages: [], nextCursor: "7", pending: false };
    },
  });
  try {
    const path = await driver.resolveTranscriptPath(makeRef());
    assert.equal(path, "C:\\lazy\\rollout.jsonl");
    const page = await driver.see(makeRef(), "0");
    assert.equal(page.nextCursor, "7");
    assert.equal(calls[0]?.["path"], "C:\\lazy\\rollout.jsonl");
  } finally {
    await driver.dispose();
  }
});

test("discover 透传 sessionsRoot / cwd / limit", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    sessionsRoot: "C:\\fake\\sessions",
    discoverSessions: async (opts) => {
      calls.push(opts);
      return [makeRef()];
    },
  });
  try {
    const refs = await driver.discover({ cwd: "E:\\pi-workbench", limit: 5 });
    assert.equal(refs.length, 1);
    assert.deepEqual(calls, [
      { sessionsRoot: "C:\\fake\\sessions", cwd: "E:\\pi-workbench", limit: 5, sinceDays: 30 },
    ]);
  } finally {
    await driver.dispose();
  }
});

test("discover 默认复用 T3 发现层，see 默认复用 T4 读取器", async () => {
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    sessionsRoot: join(WORKSPACE, "fixtures", "codex", "sessions"),
  });
  try {
    const refs = await driver.discover({ cwd: "E:\\pi-workbench\\fixture-cwd" });
    assert.ok(refs.length > 0);
    assert.ok(refs.every((ref) => ref.agent === "codex" && ref.nativeId.length > 0));
    const withTranscript = refs.find((ref) => typeof ref.transcriptPath === "string");
    assert.ok(withTranscript);
    const page = await driver.see(withTranscript, "0");
    assert.ok(Array.isArray(page.messages));
  } finally {
    await driver.dispose();
  }
});

test("newSession 后 inject 直接 prompt，不重复 resume", async () => {
  const harness = makeFakeAdapter();
  const driver = driverWith(harness);
  try {
    const opened = await driver.newSession(WORKSPACE);
    await driver.inject(makeRef({ nativeId: opened.sessionId, key: "codex:" + opened.sessionId }), "hi");
    assert.deepEqual(harness.calls, ["newSession", "prompt"]);
  } finally {
    await driver.dispose();
  }
});

test("spawn 前订阅的 onUpdate 在 adapter 起来后能收到 update", async () => {
  const harness = makeFakeAdapter();
  const driver = driverWith(harness);
  const updates: AdapterUpdate[] = [];
  driver.onUpdate((update) => {
    updates.push(update);
  });
  try {
    await driver.resume(makeRef());
    harness.emit({ kind: "text", id: "u1", text: "streamed" });
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.text, "streamed");
  } finally {
    await driver.dispose();
  }
});

test("dispose 幂等，只释放一次 adapter", async () => {
  const harness = makeFakeAdapter();
  const driver = driverWith(harness);
  await driver.resume(makeRef());
  await driver.dispose();
  await driver.dispose();
  assert.equal(harness.calls.filter((call) => call === "dispose").length, 1);
});


test("S5：ACP adapter 退出后下一次写操作会重建新 adapter", async () => {
  let spawns = 0;
  const first = makeFakeAdapter({ isAlive: () => false });
  const second = makeFakeAdapter();
  const driver = new CodexDriver(makeConfig([process.execPath, FIXTURE]), {
    spawnAdapter: async () => {
      spawns += 1;
      return spawns === 1 ? first.adapter : second.adapter;
    },
    resolveRolloutPath: async () => undefined,
    discoverSessions: async () => [],
  });
  try {
    const ref = makeRef({ transcriptPath: "C:\\rollout.jsonl" });
    await driver.inject(ref, "one");
    await driver.inject(ref, "two");
    assert.equal(spawns, 2, "死掉的 adapter 必须被替换，而不是永久复用");
    assert.ok(first.calls.includes("dispose"), "旧 adapter 必须释放");
    assert.deepEqual(second.args["prompt"], [NATIVE_ID, "two"], "第二次写操作应落到新 adapter");
  } finally {
    await driver.dispose();
  }
});
