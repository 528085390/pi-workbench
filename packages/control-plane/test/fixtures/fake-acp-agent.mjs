#!/usr/bin/env node
/**
 * 最小 ACP v2 agent（NDJSON over stdio），仅供控制面 ClaudeAdapter 离线测试。
 *
 * 支持方法：initialize / session/new / session/resume / session/prompt /
 * session/cancel / session/close。
 * 启动参数：
 *   --fail-init   → 立刻写 stderr 再退出（模拟握手失败，stderr 供断言用）
 *   --fail-resume → session/resume 回 JSON-RPC 错误（模拟恢复被拒）
 * 特殊 prompt 文本：
 *   KILL       → 立即 process.exit(1)（模拟 adapter 崩溃，用于测 E_ADAPTER_DOWN）
 *   HANG       → 回 prompt 响应但不结束回合（用于测 waitForTurn 超时）
 *   PERMISSION → 先发 session/request_permission，按回执发 permission:<optionId|cancelled>
 *   REJECTONLY → permission 只给 reject_* 选项（测 auto_allow 不许乱选，M5）
 *   SLOW       → update 立刻发，session/prompt 响应拖 4s（测 prompt 不等响应，I3）
 *   ERROR      → 先发 agent_message_chunk 再发 idle+stopReason:"error"（测回合失败，C1）
 * 普通 prompt：发 thought / text / tool_call / tool_result 更新，最后 idle + end_turn。
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = 2;

const argv = process.argv.slice(2);

/** session/prompt 响应拖多久（I3：要长于 ClaudeAdapter 的受理窗口） */
const SLOW_ACCEPT_DELAY_MS = 4000;

if (argv.includes("--fail-init")) {
  process.stderr.write("fake-acp-agent: --fail-init，握手前退出\n");
  process.exit(1);
}
/** --fail-resume：session/resume 回错误，测 E_RESUME_REJECTED */
const FAIL_RESUME = argv.includes("--fail-resume");
/** --record-config <path>：把 session/set_config_option 请求追加到文件，测权限模式设置 */
const recordConfigIndex = argv.indexOf("--record-config");
const RECORD_CONFIG = recordConfigIndex >= 0 ? argv[recordConfigIndex + 1] : undefined;

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

const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
  { optionId: "allow_always", name: "始终允许", kind: "allow_always" },
  { optionId: "reject_once", name: "拒绝一次", kind: "reject_once" },
];
/** 只有 reject_*：auto_allow 找不到 allow* 时也必须回 cancelled，不能拿 options[0]（M5） */
const REJECT_ONLY_OPTIONS = [{ optionId: "reject_once", name: "拒绝一次", kind: "reject_once" }];

function requestPermission(sessionId, options = DEFAULT_PERMISSION_OPTIONS) {
  msgSeq += 1;
  const id = "perm_" + String(msgSeq);
  const params = {
    sessionId,
    title: "需要执行 Bash 的权限",
    options,
  };
  return new Promise((resolve) => {
    pendingClientRequests.set(id, resolve);
    write({ jsonrpc: "2.0", id, method: "session/request_permission", params });
  });
}

/** 权限往返：按回执发 permission:<optionId|cancelled>，然后结束回合 */
async function permissionFlow(sessionId, messageId, options) {
  const response = await requestPermission(sessionId, options);
  const outcome = response !== null && typeof response === "object" && response.outcome ? response.outcome : {};
  const picked = outcome.outcome === "selected" ? String(outcome.optionId) : "cancelled";
  emitUpdate(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text: "permission:" + picked },
  });
  emitUpdate(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
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
  const accept = () => respond(id, { messageId: "usr_" + String(msgSeq) });
  const slow = text.includes("SLOW");
  if (!slow) {
    accept();
  }
  emitUpdate(sessionId, { sessionUpdate: "state_update", state: "running" });
  if (text.includes("HANG")) {
    return;
  }
  if (slow) {
    // I3：update 立刻发，但 session/prompt 响应拖到 4s 后，回合结束更晚
    emitUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: "slow-pong" },
    });
    setTimeout(() => {
      accept();
      emitUpdate(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    }, SLOW_ACCEPT_DELAY_MS);
    return;
  }
  if (text.includes("PERMISSION")) {
    await permissionFlow(sessionId, messageId, DEFAULT_PERMISSION_OPTIONS);
    return;
  }
  if (text.includes("REJECTONLY")) {
    await permissionFlow(sessionId, messageId, REJECT_ONLY_OPTIONS);
    return;
  }
  if (text.includes("ERROR")) {
    // C1：回合失败现场——先有输出，再 idle + stopReason:"error"（带 JSON-RPC 错误详情）
    emitUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: "回合失败了" },
    });
    emitUpdate(sessionId, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: -32000, message: "fake-acp-agent: 上游 500" },
    });
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
    if (FAIL_RESUME) {
      respondError(message.id, -32000, "session not found: " + String(params.sessionId));
      return;
    }
    respond(message.id, {});
    emitUpdate(params.sessionId, { sessionUpdate: "state_update", state: "idle" });
    return;
  }
  if (method === "session/set_config_option") {
    if (RECORD_CONFIG !== undefined) {
      appendFileSync(RECORD_CONFIG, JSON.stringify(params) + "\n", "utf8");
    }
    respond(message.id, { configOptions: [] });
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
