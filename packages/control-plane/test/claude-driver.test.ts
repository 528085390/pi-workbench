import test from "node:test";
import assert from "node:assert/strict";

import type { SessionRef } from "@pi-workbench/shared";

import type { AdapterUpdate, AgentAdapter } from "../src/adapters/types.ts";
import { capsOf } from "../src/capabilities.ts";
import { ClaudeDriver } from "../src/agents/claude-driver.ts";

type Call = { method: string; args: unknown[] };

function makeFake(): { adapter: AgentAdapter; calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
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
      return { messageId: "msg-1" };
    },
    cancel: async (sessionId: string) => {
      record("cancel", [sessionId]);
      return { stopReason: "cancelled" };
    },
    close: async (sessionId: string) => {
      record("close", [sessionId]);
    },
    onUpdate: (cb: (update: AdapterUpdate) => void) => {
      record("onUpdate", [cb]);
      return () => {
        record("unsubscribe", []);
      };
    },
    dispose: async () => {
      record("dispose", []);
    },
  };
  return { adapter, calls };
}

function makeRef(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    key: "claude:sess-1",
    agent: "claude",
    nativeId: "sess-1",
    cwd: "E:\\pi-workbench",
    status: "idle",
    driver: "pi",
    capabilities: capsOf("claude"),
    kind: "interactive",
    ...overrides,
  };
}

test("ClaudeDriver.caps 与 capsOf('claude') 一致", () => {
  const { adapter } = makeFake();
  const driver = new ClaudeDriver(adapter);
  assert.equal(driver.agent, "claude");
  assert.deepEqual(driver.caps, capsOf("claude"));
});

test("ClaudeDriver.inject 委托 adapter.prompt；running 会话标 next_turn", async () => {
  const { adapter, calls } = makeFake();
  const driver = new ClaudeDriver(adapter);

  const idle = await driver.inject(makeRef(), "继续");
  assert.deepEqual(idle, { messageId: "msg-1", effective: "now" });
  const running = await driver.inject(makeRef({ status: "running" }), "插话");
  assert.deepEqual(running, { messageId: "msg-1", effective: "next_turn" });
  assert.deepEqual(calls.filter((call) => call.method === "prompt"), [
    { method: "prompt", args: ["sess-1", "继续"] },
    { method: "prompt", args: ["sess-1", "插话"] },
  ]);
});

test("ClaudeDriver.interrupt 委托 adapter.cancel", async () => {
  const { adapter, calls } = makeFake();
  const driver = new ClaudeDriver(adapter);
  const result = await driver.interrupt(makeRef());
  assert.deepEqual(result, { stopReason: "cancelled" });
  assert.deepEqual(calls.filter((call) => call.method === "cancel"), [{ method: "cancel", args: ["sess-1"] }]);
});

test("ClaudeDriver.handoff：interactive → claude --resume；background → claude attach", async () => {
  const { adapter } = makeFake();
  const driver = new ClaudeDriver(adapter);

  assert.deepEqual(await driver.handoff(makeRef()), {
    command: ["claude", "--resume", "sess-1"],
    mode: "resume-tui",
  });
  assert.deepEqual(await driver.handoff(makeRef({ kind: "background", key: "claude:sess-bg", nativeId: "sess-bg" })), {
    command: ["claude", "attach", "sess-bg"],
    mode: "attach",
  });
});

test("ClaudeDriver.resume / attach 都委托 adapter.resume", async () => {
  const { adapter, calls } = makeFake();
  const driver = new ClaudeDriver(adapter);
  await driver.resume(makeRef());
  await driver.attach(makeRef());
  assert.deepEqual(calls.filter((call) => call.method === "resume"), [
    { method: "resume", args: ["sess-1", "E:\\pi-workbench"] },
    { method: "resume", args: ["sess-1", "E:\\pi-workbench"] },
  ]);
});

test("ClaudeDriver.onUpdate / dispose 委托 adapter", async () => {
  const { adapter, calls } = makeFake();
  const driver = new ClaudeDriver(adapter);
  const cb = (_update: AdapterUpdate): void => {};
  const off = driver.onUpdate(cb);
  off();
  await driver.dispose();
  assert.deepEqual(calls.map((call) => call.method), ["onUpdate", "unsubscribe", "dispose"]);
  assert.equal(calls[0]?.args[0], cb);
});
