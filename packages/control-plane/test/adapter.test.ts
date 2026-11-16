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

import { ClaudeAdapter, FALLBACK_ADAPTER_CMD, mapSessionUpdate } from "../src/adapters/claude.ts";
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
    codex: { adapterCmd: [process.execPath, FIXTURE], permissionMode },
    pi: { rpcCmd: ["pi", "--mode", "rpc"] },
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

/** mapSessionUpdate 单测用的递增 id 生成器 */
function seqIds(): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    return "u" + String(seq);
  };
}

/** assert.rejects 校验器：断言是某个 WorkbenchError 错误码 */
function workbenchCode(code: string): (err: unknown) => true {
  return (err: unknown) => {
    assert.ok(isWorkbenchError(err), "应抛 WorkbenchError，实际：" + String(err));
    assert.equal(err.code, code);
    return true;
  };
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
    // M7：受理响应已经带回 messageId 时就用它（假 agent 立刻回 usr_<n>），不再自造 msg_<uuid>
    assert.match(messageId, /^usr_/, "prompt 应复用 PromptResponse.messageId，实际：" + messageId);
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

test("initialize 握手失败（假 agent 立刻退出）→ E_ADAPTER_DOWN，文案带 stderr 而非占位 reason", async () => {
  const startedAt = Date.now();
  await assert.rejects(spawnFakeAdapter("auto_allow", ["--fail-init"]), (err: unknown) => {
    adapterDown(err);
    const message = String((err as Error).message);
    // I2：占位 reason「未启动」不该出现在文案里
    assert.ok(!message.includes("未启动"), "握手失败文案不该带占位 reason，实际：" + message);
    // I2：要带 stderr 尾部片段，否则定位不了
    assert.match(message, /--fail-init/, "握手失败文案应带 stderr 尾部片段，实际：" + message);
    return true;
  });
  assert.ok(Date.now() - startedAt < 5000, "握手失败必须 5s 内报错");
});

test("dispose 幂等", async () => {
  const adapter = await spawnFakeAdapter();
  await adapter.dispose();
  await adapter.dispose();
});

test("C1 回合失败：emit kind:error 且 waitForTurn reject（不当成功 resolve）", async () => {
  const adapter = await spawnFakeAdapter();
  try {
    const updates = collectUpdates(adapter);
    const { sessionId } = await adapter.newSession(WORKSPACE);
    await adapter.prompt(sessionId, "ERROR");

    // 先拿到 kind:"error" 更新（文案取 agent 报的 JSON-RPC 错误）
    const errorUpdate = await waitForUpdate(updates, (u) => u.kind === "error");
    assert.match(String(errorUpdate.text), /上游 500/, "error update 应带 agent 的错误文案");

    // 回合必须 reject，不能 resolve
    await assert.rejects(adapter.waitForTurn(sessionId), (err: unknown) => {
      assert.ok(isWorkbenchError(err), "回合失败应抛 WorkbenchError，实际：" + String(err));
      assert.equal(err.code, "E_BAD_REQUEST");
      assert.match(String((err as Error).message), /上游 500/);
      return true;
    });
  } finally {
    await adapter.dispose();
  }
});

test("I3 SLOW 模式：prompt 不等 session/prompt 响应，返回时回合仍 pending", async () => {
  const adapter = await spawnFakeAdapter();
  try {
    const updates = collectUpdates(adapter);
    const { sessionId } = await adapter.newSession(WORKSPACE);

    const startedAt = Date.now();
    const promptPromise = adapter.prompt(sessionId, "SLOW");
    // 立刻挂上回合等待：prompt 返回的那一刻它必须还没结束
    let turnSettled = false;
    const turnPromise = adapter.waitForTurn(sessionId, 15_000).finally(() => {
      turnSettled = true;
    });

    const { messageId } = await promptPromise;
    const promptElapsed = Date.now() - startedAt;
    assert.ok(
      promptElapsed < 3500,
      "prompt 不该等 4s 才回的 session/prompt 响应，实际 " + String(promptElapsed) + "ms",
    );
    // 受理响应还没回来 → 回落到 msg_<uuid>（R11 允许）
    assert.match(messageId, /^msg_/, "拿不到受理 messageId 时应回落 msg_ 前缀，实际：" + messageId);

    // update 已经到了，但回合没结束
    await waitForUpdate(updates, (u) => u.kind === "text");
    assert.equal(turnSettled, false, "prompt 返回时回合不该已经结束");

    const turn = await turnPromise;
    assert.equal(turn.stopReason, "end_turn");
  } finally {
    await adapter.dispose();
  }
});

test("I4 子进程退出后六个调用都在 5 秒内抛 E_ADAPTER_DOWN", async () => {
  const adapter = await spawnFakeAdapter();
  try {
    const { sessionId } = await adapter.newSession(WORKSPACE);
    // KILL：假 agent 收到即退出，制造「子进程已死」的现场
    await assert.rejects(adapter.prompt(sessionId, "KILL"), adapterDown);

    const calls: Array<{ name: string; run: () => Promise<unknown> }> = [
      { name: "prompt", run: () => adapter.prompt(sessionId, "hello") },
      { name: "cancel", run: () => adapter.cancel(sessionId) },
      { name: "close", run: () => adapter.close(sessionId) },
      { name: "newSession", run: () => adapter.newSession(WORKSPACE) },
      { name: "resume", run: () => adapter.resume(sessionId, WORKSPACE) },
      { name: "waitForTurn", run: () => adapter.waitForTurn(sessionId, 60_000) },
    ];
    for (const call of calls) {
      const startedAt = Date.now();
      await assert.rejects(call.run(), (err: unknown) => {
        adapterDown(err);
        assert.equal((err as { code?: string }).code, "E_ADAPTER_DOWN", call.name + " 应抛 E_ADAPTER_DOWN");
        return true;
      });
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 5000, call.name + " 应在 5s 内失败，实际 " + String(elapsed) + "ms");
    }
  } finally {
    await adapter.dispose();
  }
});

test("M5 auto_allow 但选项里没有 allow*：回 cancelled，不拿 options[0]", async () => {
  const adapter = await spawnFakeAdapter("auto_allow");
  try {
    const updates = collectUpdates(adapter);
    const { sessionId } = await adapter.newSession(WORKSPACE);
    await adapter.prompt(sessionId, "REJECTONLY");

    await waitForUpdate(updates, (u) => u.kind === "permission_request");
    const text = await waitForUpdate(updates, (u) => u.kind === "text");
    assert.equal(text.text, "permission:cancelled");
    await adapter.waitForTurn(sessionId);
  } finally {
    await adapter.dispose();
  }
});

test("M9 resume 被 agent 拒绝 → E_RESUME_REJECTED", async () => {
  const adapter = await spawnFakeAdapter("auto_allow", ["--fail-resume"]);
  try {
    await assert.rejects(adapter.resume("sess_missing", WORKSPACE), workbenchCode("E_RESUME_REJECTED"));
  } finally {
    await adapter.dispose();
  }
});

test("M9 mapSessionUpdate：notice(error) → kind:error 且带文案", () => {
  const update = mapSessionUpdate(
    { sessionUpdate: "notice", severity: "error", title: "boom" },
    seqIds(),
  );
  assert.equal(update?.kind, "error");
  assert.equal(update?.text, "boom");
});

test("M9 mapSessionUpdate：notice(info) → 丢弃（null）", () => {
  assert.equal(mapSessionUpdate({ sessionUpdate: "notice", level: "info", title: "hi" }, seqIds()), null);
});

test("M9 mapSessionUpdate：agent_message（非 chunk）→ kind:text，id 取 messageId", () => {
  const update = mapSessionUpdate(
    { sessionUpdate: "agent_message", messageId: "m1", content: { type: "text", text: "hello" } },
    seqIds(),
  );
  assert.equal(update?.kind, "text");
  assert.equal(update?.id, "m1");
  assert.equal(update?.text, "hello");
});

test("M9 mapSessionUpdate：tool_call_content_chunk → kind:tool_call", () => {
  const update = mapSessionUpdate(
    { sessionUpdate: "tool_call_content_chunk", toolCallId: "tc_9", content: { type: "text", text: "out" } },
    seqIds(),
  );
  assert.equal(update?.kind, "tool_call");
  assert.equal(update?.id, "tc_9");
});

test("M9 mapSessionUpdate：未识别标签 → 丢弃（null）", () => {
  assert.equal(mapSessionUpdate({ sessionUpdate: "usage_update", used: 1 }, seqIds()), null);
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
