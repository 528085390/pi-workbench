#!/usr/bin/env node
/**
 * 最小 ACP v2 Codex 假 agent（NDJSON over stdio），仅供 CodexDriver 离线测试。
 *
 * 启动参数：
 *   --record <path>  把每个收到的请求 {method, params} 追加进 JSONL
 *   --fail-init      握手前写 stderr 并退出（模拟 codex-acp 起不来）
 *   --fail-resume    session/resume 回 JSON-RPC 错误（模拟恢复被拒）
 *   --hang-cancel    session/cancel 不回 idle（模拟运行中 cancel 超时）
 *
 * 支持方法：initialize / session/new / session/resume / session/load /
 *          session/prompt / session/cancel / session/close。
 * prompt 的普通文本会回 codex-pong:<text>，并结束回合（idle + end_turn）。
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = 2;
const argv = process.argv.slice(2);

function argValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

const recordPath = argValue("--record");
const recordEnvPath = argValue("--record-env");
const failInit = argv.includes("--fail-init");
const failResume = argv.includes("--fail-resume");
const hangCancel = argv.includes("--hang-cancel");

if (recordEnvPath !== undefined) {
  writeFileSync(recordEnvPath, process.env.INITIAL_AGENT_MODE ?? "", "utf8");
}

if (failInit) {
  process.stderr.write("fake-codex-acp: --fail-init，握手前退出\n");
  process.exit(1);
}

let sessionSeq = 0;
let messageSeq = 0;

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function record(method, params) {
  if (recordPath === undefined) {
    return;
  }
  appendFileSync(recordPath, JSON.stringify({ method, params }) + "\n", "utf8");
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

function handlePrompt(id, params) {
  const sessionId = String(params.sessionId);
  const text = promptText(params);
  messageSeq += 1;
  const messageId = "msg_" + String(messageSeq);
  emitUpdate(sessionId, { sessionUpdate: "state_update", state: "running" });
  respond(id, { messageId: "usr_" + String(messageSeq) });
  emitUpdate(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text: "codex-pong:" + text },
  });
  emitUpdate(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
}

function handleMessage(message) {
  if (message === null || typeof message !== "object") {
    return;
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  if (typeof message.method !== "string") {
    return;
  }
  const method = message.method;
  const params = message.params !== null && typeof message.params === "object" ? message.params : {};
  record(method, params);

  if (method === "initialize") {
    respond(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      info: { name: "@agentclientprotocol/codex-acp-fake", version: "2.6.0" },
      capabilities: { session: {} },
      authMethods: [],
    });
    return;
  }
  if (method === "session/new") {
    sessionSeq += 1;
    respond(message.id, { sessionId: "thread-" + String(sessionSeq) });
    return;
  }
  if (method === "session/resume" || method === "session/load") {
    if (failResume) {
      respondError(message.id, -32000, "session not found: " + String(params.sessionId));
      return;
    }
    respond(message.id, {});
    emitUpdate(String(params.sessionId), { sessionUpdate: "state_update", state: "idle" });
    return;
  }
  if (method === "session/prompt") {
    handlePrompt(message.id, params);
    return;
  }
  if (method === "session/cancel") {
    if (hangCancel) {
      return;
    }
    emitUpdate(String(params.sessionId), { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
    return;
  }
  if (method === "session/close") {
    respond(message.id, {});
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
    process.stderr.write("fake-codex-acp: 非法 JSON 行\n");
    return;
  }
  try {
    handleMessage(parsed);
  } catch (error) {
    const reason = error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : String(error);
    process.stderr.write("fake-codex-acp: " + reason + "\n");
  }
});
rl.on("close", () => {
  process.exit(0);
});
