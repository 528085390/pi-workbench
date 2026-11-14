#!/usr/bin/env node
/**
 * 最小 ACP v2 agent（NDJSON over stdio），仅供控制面 ClaudeAdapter 离线测试。
 *
 * 支持方法：initialize / session/new / session/resume / session/prompt /
 * session/cancel / session/close。
 * 启动参数 --fail-init：进程启动即退出（模拟握手失败）。
 * 特殊 prompt 文本：
 *   KILL       → 立即 process.exit(1)（模拟 adapter 崩溃，用于测 E_ADAPTER_DOWN）
 *   HANG       → 回 prompt 响应但不结束回合（用于测 waitForTurn 超时）
 *   PERMISSION → 先发 session/request_permission，按回执发 permission:<optionId|cancelled>
 * 普通 prompt：发 thought / text / tool_call / tool_result 更新，最后 idle + end_turn。
 */
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = 2;

if (process.argv.slice(2).includes("--fail-init")) {
  process.stderr.write("fake-acp-agent: --fail-init，握手前退出\n");
  process.exit(1);
}

let sessionSeq = 0;
let msgSeq = 0;
const pendingClientRequests = new Map();

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

function emitUpdate(sessionId, update) {
  notify("session/update", { sessionId, update });
}

function promptText(params) {
  const blocks = params !== null && typeof params === "object" && Array.isArray(params.prompt) ? params.prompt : [];
  return blocks
    .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function requestPermission(sessionId) {
  msgSeq += 1;
  const id = "perm_" + String(msgSeq);
  const params = {
    sessionId,
    title: "需要执行 Bash 的权限",
    options: [
      { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
      { optionId: "allow_always", name: "始终允许", kind: "allow_always" },
      { optionId: "reject_once", name: "拒绝一次", kind: "reject_once" },
    ],
  };
  return new Promise((resolve) => {
    pendingClientRequests.set(id, resolve);
    write({ jsonrpc: "2.0", id, method: "session/request_permission", params });
  });
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId;
  const text = promptText(params);
  if (text.includes("KILL")) {
    process.stderr.write("fake-acp-agent: 收到 KILL，立即退出\n");
    process.exit(1);
  }
  msgSeq += 1;
  const messageId = "msg_" + String(msgSeq);
  respond(id, { messageId: "usr_" + String(msgSeq) });
  emitUpdate(sessionId, { sessionUpdate: "state_update", state: "running" });
  if (text.includes("HANG")) {
    return;
  }
  if (text.includes("PERMISSION")) {
    const response = await requestPermission(sessionId);
    const outcome = response !== null && typeof response === "object" && response.outcome ? response.outcome : {};
    const picked = outcome.outcome === "selected" ? String(outcome.optionId) : "cancelled";
    emitUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: "permission:" + picked },
    });
    emitUpdate(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    return;
  }
  emitUpdate(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    messageId: "th_" + String(msgSeq),
    content: { type: "text", text: "想一想" },
  });
  emitUpdate(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text: "pong" },
  });
  emitUpdate(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_" + String(msgSeq),
    name: "Bash",
    status: "in_progress",
  });
  emitUpdate(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_" + String(msgSeq),
    status: "completed",
  });
  emitUpdate(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
}

async function handleMessage(message) {
  if (message === null || typeof message !== "object") {
    return;
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  if (typeof message.method !== "string") {
    if (hasId) {
      const resolve = pendingClientRequests.get(message.id);
      if (resolve !== undefined) {
        pendingClientRequests.delete(message.id);
        resolve(message.result);
      }
    }
    return;
  }
  const method = message.method;
  const params = message.params !== null && typeof message.params === "object" ? message.params : {};
  if (method === "initialize") {
    respond(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      info: { name: "fake-acp-agent", version: "0.0.0" },
      capabilities: { session: {} },
    });
    return;
  }
  if (method === "session/new") {
    sessionSeq += 1;
    respond(message.id, { sessionId: "sess_" + String(sessionSeq) });
    return;
  }
  if (method === "session/resume") {
    respond(message.id, {});
    emitUpdate(params.sessionId, { sessionUpdate: "state_update", state: "idle" });
    return;
  }
  if (method === "session/close") {
    respond(message.id, {});
    return;
  }
  if (method === "session/prompt") {
    await handlePrompt(message.id, params);
    return;
  }
  if (method === "session/cancel") {
    emitUpdate(params.sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
    return;
  }
  if (hasId) {
    respondError(message.id, -32601, "未实现: " + method);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    process.stderr.write("fake-acp-agent: 非法 JSON 行\n");
    return;
  }
  handleMessage(parsed).catch((error) => {
    const reason = error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : String(error);
    process.stderr.write("fake-acp-agent: " + reason + "\n");
  });
});
rl.on("close", () => {
  process.exit(0);
});
