/**
 * ClaudeAdapter（A05）测试。
 *
 * 全部离线：用 test/fixtures/fake-acp-agent.mjs 这个最小 ACP v2 agent 走 NDJSON stdio，
 * 不需要真的 claude 登录态。真 adapter 冒烟默认跳过（见文件末尾）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAdapter, FALLBACK_ADAPTER_CMD } from "../src/adapters/claude.ts";
import type { AdapterUpdate } from "../src/adapters/types.ts";
import { resolveDefaultAdapterCmd } from "../src/adapters/claude.ts";
import type { Config, PermissionMode } from "../src/config.ts";
import { isWorkbenchError } from "../src/errors.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const WORKSPACE = fileURLToPath(new URL("./", import.meta.url));

function makeConfig(permissionMode: PermissionMode = "auto_allow"): Config {
  return {
    host: "127.0.0.1",
    port: 7331,
    home: WORKSPACE,
    authToken: null,
    leaseTtlMs: 30_000,
    claude: {
      adapterCmd: [process.execPath, FIXTURE],
      permissionMode,
    },
  };
}

/** 起一个接假 agent 的 ClaudeAdapter（adapterCmd 注入，不依赖真实 claude） */
function spawnFakeAdapter(
  permissionMode: PermissionMode = "auto_allow",
  fixtureArgs: string[] = [],
): Promise<ClaudeAdapter> {
  return ClaudeAdapter.spawn(makeConfig(permissionMode), {
    adapterCmd: [process.execPath, FIXTURE, ...fixtureArgs],
    cwd: WORKSPACE,
  });
}

function collectUpdates(adapter: ClaudeAdapter): AdapterUpdate[] {
  const updates: AdapterUpdate[] = [];
  adapter.onUpdate((update) => {
    updates.push(update);
  });
  return updates;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
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

/** assert.rejects 校验器：断言是 E_ADAPTER_DOWN */
function adapterDown(err: unknown): true {
  assert.ok(isWorkbenchError(err), "应抛 WorkbenchError，实际：" + String(err));
  assert.equal(err.code, "E_ADAPTER_DOWN");
  return true;
}

test("newSession 返回 ACP sessionId", async () => {
  const adapter = await spawnFakeAdapter();
  try {
    const { sessionId } = await adapter.newSession(WORKSPACE);
    assert.equal(typeof sessionId, "string");
    assert.ok(sessionId.length > 0);
  } finally {
    await adapter.dispose();
  }
});

test("prompt 立即返回 messageId，并把 session/update 映射成 text", async () => {
  const adapter = await spawnFakeAdapter();
  try {
    const updates = collectUpdates(adapter);
    const { sessionId } = await adapter.newSession(WORKSPACE);

    const startedAt = Date.now();
    const { messageId } = await adapter.prompt(sessionId, "hello");
    const promptElapsed = Date.now() - startedAt;
    assert.equal(typeof messageId, "string");
    assert.ok(messageId.length > 0);
    // prompt 不等回合结束：假 agent 要到 idle 才结束回合，返回必须远早于此
    assert.ok(promptElapsed < 2000, "prompt 不该阻塞到回合结束，实际耗时 " + String(promptElapsed) + "ms");

    const text = await waitForUpdate(updates, (u) => u.kind === "text");
    assert.equal(text.text, "pong");

    // thought / tool_call / tool_result / state 都要映射出来
    await waitForUpdate(updates, (u) => u.kind === "thought");
    const toolCall = await waitForUpdate(updates, (u) => u.kind === "tool_call");
    assert.equal(toolCall.toolName, "Bash");
    await waitForUpdate(updates, (u) => u.kind === "tool_result");
    await waitForUpdate(updates, (u) => u.kind === "state" && u.state === "idle");

    const turn = await adapter.waitForTurn(sessionId);
    assert.equal(turn.stopReason, "end_turn");
  } finally {
    await adapter.dispose();
  }
});

test("cancel 返回 stopReason", async () => {
  const adapter = await spawnFakeAdapter();
  try {
    const { sessionId } = await adapter.newSession(WORKSPACE);
    await adapter.prompt(sessionId, "hello");
    await adapter.waitForTurn(sessionId);

    const { stopReason } = await adapter.cancel(sessionId);
    assert.equal(stopReason, "cancelled");
  } finally {
    await adapter.dispose();
  }
});

test("子进程退出后 5 秒内 prompt 抛 E_ADAPTER_DOWN", async () => {
  const adapter = await spawnFakeAdapter();
  try {
    const { sessionId } = await adapter.newSession(WORKSPACE);
    // KILL 让假 agent 直接退出、不回响应
    await assert.rejects(adapter.prompt(sessionId, "KILL"), adapterDown);

    const startedAt = Date.now();
    await assert.rejects(adapter.prompt(sessionId, "hello"), adapterDown);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5000, "退出后重试应在 5s 内失败，实际 " + String(elapsed) + "ms");
  } finally {
    await adapter.dispose();
  }
});

test("waitForTurn 超时抛 E_ADAPTER_DOWN，不挂起", async () => {
  const adapter = await spawnFakeAdapter();
  try {
    const { sessionId } = await adapter.newSession(WORKSPACE);
    await adapter.prompt(sessionId, "HANG");
    await assert.rejects(adapter.waitForTurn(sessionId, 100), (err: unknown) => {
      adapterDown(err);
      assert.match(String((err as Error).message), /turn timeout/);
      return true;
    });
  } finally {
    await adapter.dispose();
  }
});

test("auto_allow 权限模式：自动回 allow_once", async () => {
  const adapter = await spawnFakeAdapter("auto_allow");
  try {
    const updates = collectUpdates(adapter);
    const { sessionId } = await adapter.newSession(WORKSPACE);
    await adapter.prompt(sessionId, "PERMISSION");

    const permission = await waitForUpdate(updates, (u) => u.kind === "permission_request");
    assert.ok(permission.id.length > 0);
    const text = await waitForUpdate(updates, (u) => u.kind === "text");
    assert.equal(text.text, "permission:allow_once");
    await adapter.waitForTurn(sessionId);
  } finally {
    await adapter.dispose();
  }
});

test("deny 权限模式：回 cancelled", async () => {
  const adapter = await spawnFakeAdapter("deny");
  try {
    const updates = collectUpdates(adapter);
    const { sessionId } = await adapter.newSession(WORKSPACE);
    await adapter.prompt(sessionId, "PERMISSION");

    await waitForUpdate(updates, (u) => u.kind === "permission_request");
    const text = await waitForUpdate(updates, (u) => u.kind === "text");
    assert.equal(text.text, "permission:cancelled");
    await adapter.waitForTurn(sessionId);
  } finally {
    await adapter.dispose();
  }
});

test("initialize 握手失败（假 agent 立刻退出）→ E_ADAPTER_DOWN", async () => {
  const startedAt = Date.now();
  await assert.rejects(spawnFakeAdapter("auto_allow", ["--fail-init"]), adapterDown);
  assert.ok(Date.now() - startedAt < 5000, "握手失败必须 5s 内报错");
});

test("dispose 幂等", async () => {
  const adapter = await spawnFakeAdapter();
  await adapter.dispose();
  await adapter.dispose();
});

test("resolveDefaultAdapterCmd：本地包可解析 → node + 包入口", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-acp-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-acp", bin: { "fake-acp": "./dist/index.js" } }), "utf8");
    const cmd = resolveDefaultAdapterCmd(() => join(dir, "package.json"));
    assert.deepEqual(cmd, [process.execPath, join(dir, "dist", "index.js")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDefaultAdapterCmd：解析不到就回落 npx", () => {
  const cmd = resolveDefaultAdapterCmd(() => {
    throw new Error("Cannot find module '@agentclientprotocol/claude-agent-acp/package.json'");
  });
  assert.deepEqual(cmd, [...FALLBACK_ADAPTER_CMD]);
  assert.deepEqual(cmd, ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]);
});

test("resolveDefaultAdapterCmd：默认解析用本地入口（依赖已装）", () => {
  const cmd = resolveDefaultAdapterCmd();
  assert.equal(cmd[0], process.execPath);
  assert.ok(cmd.length >= 2);
  const entry = cmd[1] ?? "";
  assert.ok(entry.endsWith(".js"), "入口应是包内 js 文件，实际：" + entry);
});

test("真 adapter 冒烟（默认跳过，PI_WORKBENCH_REAL_ADAPTER=1 才跑）", { skip: process.env.PI_WORKBENCH_REAL_ADAPTER !== "1" }, async () => {
  const adapter = await ClaudeAdapter.spawn({
    ...makeConfig(),
    claude: { adapterCmd: resolveDefaultAdapterCmd(), permissionMode: "auto_allow" },
  });
  try {
    const { sessionId } = await adapter.newSession(WORKSPACE);
    assert.ok(sessionId.length > 0);
    await adapter.close(sessionId);
  } finally {
    await adapter.dispose();
  }
});
