import test from "node:test";
import assert from "node:assert/strict";

import type { SessionCaps } from "@pi-workbench/shared";

import type { AdapterUpdate } from "../src/adapters/types.ts";
import { isWorkbenchError } from "../src/errors.ts";
import { AgentRouter } from "../src/agents/router.ts";
import type { AgentDriver } from "../src/agents/types.ts";

const BASE_CAPS: SessionCaps = {
  stream: true,
  inject: true,
  interrupt: true,
  attach: true,
  resume: true,
  transcript: true,
  permissions: true,
  background: false,
};

function makeDriver(agent: string, caps: Partial<SessionCaps> = {}): AgentDriver {
  return {
    agent,
    caps: { ...BASE_CAPS, ...caps },
    discover: async () => [],
    attach: async () => {},
    see: async () => ({ messages: [], nextCursor: "0", pending: true }),
    inject: async () => ({ messageId: "msg-1", effective: "now" }),
    interrupt: async () => ({ stopReason: "cancelled" }),
    resume: async () => {},
    handoff: async () => ({ command: ["agent", "resume"], mode: "resume-tui" }),
    onUpdate: (_cb: (update: AdapterUpdate) => void) => () => {},
    dispose: async () => {},
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(isWorkbenchError(err), "预期 WorkbenchError，实际：" + String(err));
    return err.code;
  }
  assert.fail("预期抛错，但没有抛");
}

test("AgentRouter.get: 命中返回注册的 driver，未注册返回 null", () => {
  const router = new AgentRouter();
  const claude = makeDriver("claude");
  const codex = makeDriver("codex");
  router.register(claude);
  router.register(codex);

  assert.equal(router.get("claude"), claude);
  assert.equal(router.get("codex"), codex);
  assert.equal(router.get("pi"), null);
});

test("AgentRouter.assertCap: 有能力返回 driver，缺能力抛 E_CAP_UNSUPPORTED", () => {
  const router = new AgentRouter();
  const driver = makeDriver("codex", { inject: false, transcript: false });
  router.register(driver);

  assert.equal(router.assertCap("codex", "resume"), driver);
  assert.equal(router.assertCap("codex", "attach"), driver, "caps.attach=true 时 attach 能力可用");
  assert.equal(codeOf(() => router.assertCap("codex", "inject")), "E_CAP_UNSUPPORTED");
  // see 能力落在 caps.transcript 上，不另建一份能力表
  assert.equal(codeOf(() => router.assertCap("codex", "see")), "E_CAP_UNSUPPORTED");
});

test("AgentRouter.assertCap: 未注册 agent 抛 E_AGENT_UNAVAILABLE", () => {
  const router = new AgentRouter();
  assert.equal(codeOf(() => router.assertCap("pi", "resume")), "E_AGENT_UNAVAILABLE");
});

test("AgentRouter.list: 返回 available/version/caps/reason，顺序与注册顺序一致", () => {
  const router = new AgentRouter();
  const claude = makeDriver("claude");
  const codex = makeDriver("codex", { attach: false });
  router.register(claude, { available: true, version: "1.2.3" });
  router.register(codex, { available: false, version: null, reason: "E_AGENT_UNAVAILABLE: codex 未登录" });

  const list = router.list();
  assert.equal(list.length, 2);
  assert.equal(list[0]?.agent, "claude");
  assert.equal(list[0]?.available, true);
  assert.equal(list[0]?.version, "1.2.3");
  assert.deepEqual(list[0]?.caps, claude.caps);
  assert.equal(list[0]?.reason, undefined);

  assert.equal(list[1]?.agent, "codex");
  assert.equal(list[1]?.available, false);
  assert.equal(list[1]?.version, null);
  assert.equal(list[1]?.reason, "E_AGENT_UNAVAILABLE: codex 未登录");
  assert.deepEqual(list[1]?.caps, codex.caps);
});

test("AgentRouter.list: 返回副本，调用方改 caps 不影响注册表", () => {
  const router = new AgentRouter();
  const driver = makeDriver("claude");
  router.register(driver);
  const first = router.list();
  const caps = first[0]?.caps;
  assert.ok(caps !== undefined);
  caps.stream = false;
  assert.equal(router.list()[0]?.caps.stream, true);
});
