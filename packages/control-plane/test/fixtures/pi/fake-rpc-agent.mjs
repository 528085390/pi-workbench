#!/usr/bin/env node
/**
 * 假 Pi RPC 进程：按行读取 JSON 命令，按行写 JSON 响应/事件。
 * 只实现 T6 驱动需要的命令；行为通过 FAKE_PI_* 环境变量控制。
 */
import { appendFileSync } from "node:fs";

const logPath = process.env.FAKE_PI_LOG ?? "";
const argv = process.argv.slice(2);
const sessionIndex = argv.indexOf("--session");
let currentSessionFile = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
let sessionId = process.env.FAKE_PI_SESSION_ID ?? "session-1";

function log(record) {
  if (logPath.length === 0) return;
  appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
}
function write(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}
function respond(command, data, id) {
  write({ type: "response", command, success: true, ...(data === undefined ? {} : { data }), ...(id === undefined ? {} : { id }) });
}
function fail(command, error, id) {
  write({ type: "response", command, success: false, error, ...(id === undefined ? {} : { id }) });
}
function emit(record) {
  write(record);
}

log({ event: "start", argv, cwd: process.cwd() });
if (process.env.FAKE_PI_EMIT_UNKNOWN === "1") {
  emit({ type: "totally_unknown_event", value: 42 });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf("\n");
    if (at < 0) break;
    const line = buffer.slice(0, at).replace(/\r$/, "");
    buffer = buffer.slice(at + 1);
    if (line.trim().length === 0) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      log({ event: "bad-command", line });
      continue;
    }
    handle(command);
  }
});

function handle(command) {
  const type = command?.type;
  log({ event: "request", command: type, message: command?.message, streamingBehavior: command?.streamingBehavior, sessionPath: command?.sessionPath });
  if (type === "prompt") {
    if (process.env.FAKE_PI_HANG_PROMPT === "1") return;
    if (process.env.FAKE_PI_PROMPT_ERROR) {
      fail("prompt", process.env.FAKE_PI_PROMPT_ERROR, command.id);
      return;
    }
    if (process.env.FAKE_PI_EMIT_EVENTS === "1") {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK" } });
      emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "a.txt" } });
      emit({ type: "tool_execution_end", toolCallId: "tool-1", result: { content: "file body" }, isError: false });
    }
    respond("prompt", { disposition: "started" }, command.id);
    if (process.env.FAKE_PI_EMIT_EVENTS === "1") {
      emit({ type: "agent_settled", aborted: false });
    }
    return;
  }
  if (type === "abort") {
    respond("abort", undefined, command.id);
    emit({ type: "agent_settled", aborted: true });
    return;
  }
  if (type === "new_session") {
    if (process.env.FAKE_PI_NEW_SESSION_ERROR) {
      fail("new_session", process.env.FAKE_PI_NEW_SESSION_ERROR, command.id);
      return;
    }
    sessionId = process.env.FAKE_PI_NEW_SESSION_ID ?? "new-" + String(Date.now());
    currentSessionFile = process.env.FAKE_PI_NEW_SESSION_FILE ?? (process.cwd() + "/pi-new-" + sessionId + ".jsonl");
    respond("new_session", { cancelled: false }, command.id);
    return;
  }
  if (type === "switch_session") {
    currentSessionFile = command.sessionPath;
    if (typeof command.sessionPath === "string") {
      const base = command.sessionPath.split(/[\\/]/).pop() ?? "session-1";
      sessionId = base.replace(/\.jsonl$/, "").split("_").pop() ?? sessionId;
    }
    respond("switch_session", { cancelled: false }, command.id);
    return;
  }
  if (type === "get_state") {
    respond("get_state", { sessionId, sessionFile: currentSessionFile, isStreaming: false, messageCount: 2 }, command.id);
    return;
  }
  if (type === "get_messages") {
    respond("get_messages", { messages: [] }, command.id);
    return;
  }
  fail(String(type), "unsupported command", command.id);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log({ event: "signal", signal });
    process.exit(0);
  });
}
