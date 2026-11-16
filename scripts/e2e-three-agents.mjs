#!/usr/bin/env node
/**
 * Phase 0.5-B 三 Agent 端到端脚本（T9 / B07）。
 *
 *   node scripts/e2e-three-agents.mjs
 *
 * 隔离环境：默认 PI_WORKBENCH_HOME=E:\pi-workbench\tmp\t9-e2e，端口自动挑空闲端口。
 * 脚本自己拉起 daemon，结束后 taskkill /T 回收；PI_WORKBENCH_E2E_KEEP=1 时保留 home。
 *
 * 覆盖（每个外部调用都带超时）：
 *   Claude  dispatch → WS 事件流 → transcript（必须 assistant）→ inject 回显 → interrupt
 *           → checkpoint → handoff → 原生 claude -p --resume 人类回合 → handback deltaSummary
 *   Codex   真实 codex exec 造 rollout → discover → 按原生 thread id resume → inject 回显
 *           → see 读到消息 → handoff 命令 ["codex","resume",<id>,"--no-alt-screen"]
 *   Pi      真实 pi --print 造 session → discover → RPC attach（--session 拉起 + get_state）
 *           → inject 回显 → 第二写者 E_LEASE_CONFLICT 且不新增 RPC 子进程 → handoff 命令
 *   统一渲染 三个 agent 的 /transcript 均为 UnifiedMessage（id/role/kind/text/ts）；未知记录/坏行不崩
 *
 * 证据：docs/evidence/phase-0.5b/e2e-three-agents.jsonl（每步一行 {ts,phase,step,ok,detail}）。
 * 只用 Node 内置能力 + HTTP；发现/驱动级步骤直接 import 产品源码（daemon 没有 discover/resume 路由，
 * 0.5-B 非目标），所有子进程调用都带 timeout。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { capsOf } from "../packages/control-plane/src/capabilities.ts";
import { loadConfig } from "../packages/control-plane/src/config.ts";
import { openDb, migrate } from "../packages/control-plane/src/db.ts";
import { LeaseManager } from "../packages/control-plane/src/lease.ts";
import { SessionRegistry } from "../packages/control-plane/src/registry.ts";
import { CodexDriver } from "../packages/control-plane/src/agents/codex-driver.ts";
import { PiDriver } from "../packages/control-plane/src/agents/pi-driver.ts";
import { discoverCodexSessions } from "../packages/control-plane/src/discover/codex.ts";
import { discoverPiSessions } from "../packages/control-plane/src/discover/pi.ts";
import { readTranscript } from "../packages/control-plane/src/transcript/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.PI_WORKBENCH_HOME ?? join(repoRoot, "tmp", "t9-e2e");
const workspace = process.env.PI_WORKBENCH_E2E_CWD ?? join(repoRoot, "tmp", "t9-workspace");
const evidencePath =
  process.env.PI_WORKBENCH_EVIDENCE ?? join(repoRoot, "docs", "evidence", "phase-0.5b", "e2e-three-agents.jsonl");
const keepHome = process.env.PI_WORKBENCH_E2E_KEEP === "1";
const nonce = randomUUID().slice(0, 8);
const clientId = "t9-" + nonce;
const startedIso = new Date().toISOString();

const state = {
  port: 0,
  baseUrl: "",
  daemon: null,
  daemonLog: "",
  claudeKey: null,
  claudeNativeId: null,
  codexKey: null,
  codexNativeId: null,
  piKey: null,
  piPath: null,
  failures: [],
};

mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, "", "utf8");

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function detailOf(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 1800 ? text.slice(0, 1800) + "…" : text;
}

function record(phase, step, ok, detail = "") {
  const line = { ts: new Date().toISOString(), phase, step, ok, detail: detailOf(detail) };
  appendFileSync(evidencePath, JSON.stringify(line) + "\n", "utf8");
  process.stdout.write((ok ? "✔ " : "✘ ") + "[" + phase + "] " + step + (detail === "" ? "" : "：" + detailOf(detail)) + "\n");
  if (!ok) state.failures.push(phase + "/" + step + ": " + detailOf(detail));
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " 超时（" + String(timeoutMs) + "ms）")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function pickPort() {
  const server = createNetServer();
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((done) => server.close(done));
  return port;
}

async function http(method, path, body, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const headers = { accept: "application/json" };
    const init = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(state.baseUrl + path, init);
    const raw = await response.text();
    let payload = null;
    if (raw.trim().length > 0) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { raw: raw.slice(0, 600) };
      }
    }
    return { status: response.status, body: payload, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function errorCodeOf(response) {
  const error = response.body !== null && typeof response.body === "object" ? response.body.error : undefined;
  return error !== undefined && typeof error.code === "string" ? error.code : null;
}

function textOf(message) {
  return typeof message === "object" && message !== null && typeof message.text === "string" ? message.text : "";
}

function roleOf(message) {
  return typeof message === "object" && message !== null && typeof message.role === "string" ? message.role : "";
}

function messagesOf(page) {
  return page !== null && typeof page === "object" && Array.isArray(page.messages) ? page.messages : [];
}

function cursorOf(page, fallback) {
  return page !== null && typeof page === "object" && typeof page.nextCursor === "string" ? page.nextCursor : fallback;
}

const UNIFIED_KEYS = ["id", "role", "kind", "text", "ts", "toolName"];

function shapeOf(message) {
  const keys = Object.keys(message).sort();
  for (const key of keys) {
    must(UNIFIED_KEYS.includes(key), "UnifiedMessage 出现未知字段 " + key + "：" + JSON.stringify(message).slice(0, 200));
  }
  for (const key of ["id", "role", "kind", "text", "ts"]) {
    must(typeof message[key] === "string", "UnifiedMessage 缺字符串字段 " + key + "：" + JSON.stringify(message).slice(0, 200));
  }
  must(["user", "assistant", "system"].includes(message.role), "非法 role：" + message.role);
  must(["text", "thinking", "tool_call", "tool_result"].includes(message.kind), "非法 kind：" + message.kind);
  return keys;
}

async function pollTranscript(key, startCursor, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = startCursor;
  let all = [];
  let last = null;
  while (Date.now() < deadline) {
    const page = await http("GET", "/api/cp/sessions/" + encodeURIComponent(key) + "/transcript?after=" + encodeURIComponent(cursor) + "&limit=200");
    must(page.status === 200, "读 transcript 失败：" + JSON.stringify(page.body));
    last = page.body;
    const fresh = messagesOf(page.body);
    if (fresh.length > 0) all = all.concat(fresh);
    cursor = cursorOf(page.body, cursor);
    if (predicate(all, fresh)) {
      return { hit: true, messages: all, fresh, cursor, waitedMs: timeoutMs - (deadline - Date.now()) };
    }
    await sleep(500);
  }
  return { hit: false, messages: all, fresh: messagesOf(last), cursor, waitedMs: timeoutMs };
}

function assistantHas(messages, needle) {
  return messages.some((message) => roleOf(message) === "assistant" && textOf(message).includes(needle));
}

function firstAssistant(messages) {
  return messages.some((message) => roleOf(message) === "assistant" && textOf(message).trim().length > 0);
}

function runCommand(label, command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspace,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: options.shell ?? false,
    env: { ...process.env, SystemDrive: "C:", SystemRoot: "C:\\Windows", ...(options.env ?? {}) },
  });
  return {
    label,
    status: result.status,
    signal: result.signal,
    error: result.error === undefined ? null : String(result.error),
    ms: Date.now() - started,
    stdout: (result.stdout ?? "").slice(-1200),
    stderr: (result.stderr ?? "").slice(-1200),
  };
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.daemon !== null && state.daemon.exitCode !== null) {
      throw new Error("daemon 提前退出（exit=" + String(state.daemon.exitCode) + "）：" + state.daemonLog.slice(-1500));
    }
    try {
      const response = await http("GET", "/health", undefined, 3000);
      if (response.status === 200) return response;
    } catch {
      // 还没起来
    }
    await sleep(300);
  }
  throw new Error("60s 内 /health 未就绪：" + state.daemonLog.slice(-1500));
}

async function startDaemon() {
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  state.port = await pickPort();
  state.baseUrl = "http://127.0.0.1:" + String(state.port);
  const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot, "packages", "control-plane", "src", "index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SystemDrive: "C:",
      SystemRoot: "C:\\Windows",
      PI_WORKBENCH_HOME: home,
      PI_WORKBENCH_PORT: String(state.port),
      PI_WORKBENCH_AUTOSTART: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  state.daemon = child;
  child.stdout.on("data", (chunk) => { state.daemonLog += String(chunk); });
  child.stderr.on("data", (chunk) => { state.daemonLog += String(chunk); });
  const health = await waitForHealth();
  record("setup", "daemon-ready", true, { url: state.baseUrl, pid: child.pid, health: health.body });
}

function stopDaemon() {
  if (state.daemon !== null && state.daemon.pid !== undefined) {
    spawnSync("taskkill", ["/PID", String(state.daemon.pid), "/T", "/F"], { encoding: "utf8", timeout: 20_000 });
  }
}

function countPiRpcProcesses() {
  const script =
    "$n=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -ne $null -and $_.CommandLine -match '--mode' -and $_.CommandLine -match 'rpc' -and $_.CommandLine -match 't9-workspace' }); $n.Count";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, SystemDrive: "C:", SystemRoot: "C:\\Windows" },
  });
  const value = Number((result.stdout ?? "").trim());
  return Number.isFinite(value) ? value : -1;
}

function seedDaemonDb(refs) {
  const db = openDb(join(home, "workbench.db"));
  try {
    migrate(db);
    const registry = new SessionRegistry(db);
    for (const ref of refs) {
      registry.upsert(ref);
    }
  } finally {
    db.close();
  }
}

function writeUnknownTranscript() {
  const path = join(home, "unknown-events.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "t9-unknown", timestamp: new Date().toISOString(), cwd: workspace }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "UNKNOWN_EVENT_USER" }], timestamp: new Date().toISOString() } }),
    JSON.stringify({ type: "totally_unknown_record", payload: { foo: "bar" } }),
    "{ this is not json",
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "UNKNOWN_EVENT_OK" }], timestamp: new Date().toISOString() } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "weird_block", text: "ignored" }], timestamp: new Date().toISOString() } }),
  ];
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

async function prepareSeeds() {
  mkdirSync(workspace, { recursive: true });
  const codexNonce = "T9_CODEX_SEED_" + nonce;
  const codexPrompt = "Reply with exactly " + codexNonce + " and do not modify any files.";
  const codexRun = runCommand("codex-exec-seed", "codex exec --skip-git-repo-check " + JSON.stringify(codexPrompt), [], {
    timeoutMs: 180_000,
    shell: true,
    env: { TERM: "xterm-256color" },
  });
  record("setup", "codex-exec-seed", codexRun.status === 0, codexRun);
  must(codexRun.status === 0, "codex exec 造会话失败：" + JSON.stringify(codexRun));

  const piNonce = "T9_PI_SEED_" + nonce;
  const piPrompt = "Reply with exactly " + piNonce + " and do not modify any files.";
  const piRun = runCommand("pi-print-seed", "pi --no-extensions --print " + JSON.stringify(piPrompt), [], {
    timeoutMs: 120_000,
    shell: true,
    env: { PI_WORKBENCH_AUTOSTART: "0" },
  });
  record("setup", "pi-print-seed", piRun.status === 0, piRun);
  must(piRun.status === 0, "pi --print 造会话失败：" + JSON.stringify(piRun));

  const codexRefs = await discoverCodexSessions({ cwd: workspace, limit: 50, sinceDays: 30 });
  must(codexRefs.length > 0, "discoverCodexSessions 没发现 " + workspace + " 下的 rollout");
  const codexRef = codexRefs[0];
  record("codex", "discover", true, {
    count: codexRefs.length,
    key: codexRef.key,
    nativeId: codexRef.nativeId,
    transcriptPath: codexRef.transcriptPath,
    seedEchoed: codexRun.stdout.includes(codexNonce),
  });

  const piRefs = await discoverPiSessions({ cwd: workspace, limit: 50 });
  must(piRefs.length > 0, "discoverPiSessions 没发现 " + workspace + " 下的 session");
  const piRef = piRefs[0];
  record("pi", "discover", true, {
    count: piRefs.length,
    key: piRef.key,
    nativeId: piRef.nativeId,
    transcriptPath: piRef.transcriptPath,
    seedEchoed: piRun.stdout.includes(piNonce),
  });

  codexRef.status = "idle";
  piRef.status = "idle";
  mkdirSync(home, { recursive: true });
  const unknownPath = writeUnknownTranscript();
  const unknownRef = {
    key: "pi:t9-unknown",
    agent: "pi",
    nativeId: "t9-unknown",
    cwd: workspace,
    transcriptPath: unknownPath,
    status: "idle",
    driver: "pi",
    capabilities: { ...capsOf("pi") },
    kind: "interactive",
  };
  seedDaemonDb([codexRef, piRef, unknownRef]);
  record("setup", "seed-sessions", true, {
    db: join(home, "workbench.db"),
    keys: [codexRef.key, piRef.key, unknownRef.key],
  });

  state.codexKey = codexRef.key;
  state.codexNativeId = codexRef.nativeId;
  state.piKey = piRef.key;
  state.piPath = piRef.transcriptPath;
  state.codexRef = codexRef;
  state.piRef = piRef;
}

async function phaseAgentsAndAttach() {
  const agents = await http("GET", "/api/cp/agents");
  must(agents.status === 200, "GET /agents 失败：" + JSON.stringify(agents.body));
  const rows = Array.isArray(agents.body) ? agents.body : [];
  must(rows.length === 3, "GET /agents 应返回三行，实际 " + String(rows.length));
  const summary = rows.map((row) => ({ agent: row.agent, available: row.available, version: row.version, caps: row.caps }));
  record("gate4", "agents", true, summary);

  for (const row of rows) {
    const expected = capsOf(row.agent);
    for (const [key, value] of Object.entries(expected)) {
      must(row.caps[key] === value, "GET /agents " + row.agent + " 的 caps." + key + " 应为 " + String(value) + "，实际 " + String(row.caps[key]));
    }
  }

  for (const [agent, key] of [["codex", state.codexKey], ["pi", state.piKey]]) {
    const response = await http("POST", "/api/cp/sessions/" + encodeURIComponent(key) + "/attach", {});
    must(response.status === 422, agent + " /attach 应 422，实际 " + String(response.status) + "：" + JSON.stringify(response.body));
    must(errorCodeOf(response) === "E_CAP_UNSUPPORTED", agent + " /attach 错误码应为 E_CAP_UNSUPPORTED，实际 " + String(errorCodeOf(response)));
    record("gate4", "attach-422-" + agent, true, { status: response.status, body: response.body, ms: response.ms });
  }

  for (const [agent, key] of [["codex", state.codexKey], ["pi", state.piKey]]) {
    const page = await http("GET", "/api/cp/sessions/" + encodeURIComponent(key) + "/transcript?after=0&limit=100");
    must(page.status === 200, agent + " /transcript 失败：" + JSON.stringify(page.body));
    const messages = messagesOf(page.body);
    must(messages.length > 0, agent + " /transcript 没有消息");
    const shapes = messages.map(shapeOf);
    must(shapes.every((shape) => shape.includes("id") && shape.includes("role") && shape.includes("kind") && shape.includes("text") && shape.includes("ts")), agent + " transcript 字段不一致");
    record("gate6", "unified-" + agent, true, { messages: messages.length, shapes: [...new Set(shapes.map((s) => s.join(",")))], nextCursor: page.body.nextCursor });
  }

  const unknown = await http("GET", "/api/cp/sessions/pi%3At9-unknown/transcript?after=0&limit=100");
  must(unknown.status === 200, "未知事件 transcript 应 200，实际 " + String(unknown.status) + "：" + JSON.stringify(unknown.body));
  const unknownMessages = messagesOf(unknown.body);
  must(unknownMessages.length === 2, "未知事件 transcript 应只返回 2 条已知消息，实际 " + String(unknownMessages.length));
  must(unknownMessages.some((message) => textOf(message).includes("UNKNOWN_EVENT_OK")), "未知事件 transcript 丢了合法 assistant 消息");
  record("gate6", "unknown-events", true, { messages: unknownMessages.length, body: unknown.body });

  const health = await http("GET", "/health");
  record("gate6", "daemon-health", health.status === 200, health.body);
}

async function phaseClaude() {
  const wsUrl = "ws://127.0.0.1:" + String(state.port) + "/api/cp/ws?after=0";
  const socket = new WebSocket(wsUrl);
  const events = [];
  await withTimeout(
    new Promise((done, fail) => {
      socket.onopen = done;
      socket.onerror = () => fail(new Error("WS 连接失败：" + wsUrl));
    }),
    5000,
    "Claude WS 连接",
  );
  socket.onmessage = (event) => {
    try {
      events.push(JSON.parse(String(event.data)));
    } catch {
      // 非 JSON 帧忽略
    }
  };
  record("claude", "ws-open", true, { url: wsUrl });

  const task = "T9 基线任务（nonce " + nonce + "）：请用一句话答复 T9_CLAUDE_READY_" + nonce;
  const dispatch = await http("POST", "/api/cp/dispatch", {
    agent: "claude",
    task,
    cwd: workspace,
    idempotencyKey: "t9-claude:" + nonce,
  });
  must(dispatch.status === 200, "Claude dispatch 失败：" + JSON.stringify(dispatch.body));
  state.claudeKey = dispatch.body.key;
  state.claudeNativeId = dispatch.body.nativeId;
  record("claude", "dispatch", true, { status: dispatch.status, key: dispatch.body.key, nativeId: dispatch.body.nativeId, ms: dispatch.ms });

  const lease = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.claudeKey) + "/lease", {
    action: "acquire",
    driver: "pi",
    clientId,
    ttlMs: 30 * 60 * 1000,
  });
  must(lease.status === 200, "Claude 取租约失败：" + JSON.stringify(lease.body));
  record("claude", "lease", true, { status: lease.status, expiresAt: lease.body.expiresAt });

  const ready = await pollTranscript(state.claudeKey, "0", (messages) => firstAssistant(messages), 120_000);
  must(ready.hit, "Claude 120s 内没等到 assistant 消息：" + JSON.stringify(ready.messages.slice(-2)));
  record("claude", "see-ready", true, { waitedMs: ready.waitedMs, messages: ready.messages.length, last: ready.messages.slice(-1).map(textOf) });
  let cursor = ready.cursor;

  const injectNonce = "T9_CLAUDE_INJECT_" + nonce;
  const injected = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.claudeKey) + "/inject", {
    text: "请只回答这一行，不要加任何别的内容：" + injectNonce,
    clientId,
  });
  must(injected.status === 200, "Claude inject 失败：" + JSON.stringify(injected.body));
  record("claude", "inject", true, { status: injected.status, body: injected.body });

  const echoed = await pollTranscript(state.claudeKey, cursor, (messages) => assistantHas(messages, injectNonce), 120_000);
  cursor = echoed.cursor;
  must(echoed.hit, "Claude 120s 内没在 assistant 消息里看到 " + injectNonce);
  record("claude", "see-inject", true, { waitedMs: echoed.waitedMs, messages: echoed.messages.length });

  const interrupted = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.claudeKey) + "/interrupt", { clientId });
  must(interrupted.status === 200, "Claude interrupt 失败：" + JSON.stringify(interrupted.body));
  record("claude", "interrupt", true, { status: interrupted.status, body: interrupted.body });

  const checkpoint = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.claudeKey) + "/checkpoint", {
    clientId,
    summary: "T9 Claude e2e " + nonce + "：dispatch/see/inject/interrupt 已跑通",
    nextStep: "handoff 到原生 claude，再 handback",
    touchedFiles: [],
  });
  must(checkpoint.status === 200, "Claude checkpoint 失败：" + JSON.stringify(checkpoint.body));
  record("claude", "checkpoint", true, { status: checkpoint.status, body: checkpoint.body });

  const handoff = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.claudeKey) + "/handoff", {
    to: "human",
    clientId,
    summary: "T9 Claude e2e " + nonce + " 交接",
    nextStep: "在原生 claude 里回一轮，然后 handback",
    touchedFiles: [],
  });
  must(handoff.status === 200, "Claude handoff 失败：" + JSON.stringify(handoff.body));
  must(Array.isArray(handoff.body.command) && handoff.body.command[0] === "claude", "Claude handoff 命令不对：" + JSON.stringify(handoff.body));
  record("claude", "handoff", true, { status: handoff.status, mode: handoff.body.mode, command: handoff.body.command });

  const humanNonce = "T9_CLAUDE_HUMAN_" + nonce;
  const humanCommand = "claude -p --resume " + state.claudeNativeId + " " + JSON.stringify("请只回答这一行：" + humanNonce);
  const human = runCommand("claude-human-turn", humanCommand, [], { timeoutMs: 180_000, shell: true });
  record("claude", "human-turn", human.status === 0, human);
  must(human.status === 0, "Claude 人类回合失败：" + JSON.stringify(human));

  const detail = await http("GET", "/api/cp/sessions/" + encodeURIComponent(state.claudeKey));
  const handbackClientId = detail.body !== null && typeof detail.body === "object" && detail.body.lease !== null && typeof detail.body.lease === "object" ? detail.body.lease.clientId : null;
  must(typeof handbackClientId === "string" && handbackClientId.length > 0, "handback 前没有 lease.clientId：" + JSON.stringify(detail.body));
  const handback = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.claudeKey) + "/handback", { clientId: handbackClientId });
  must(handback.status === 200, "Claude handback 失败：" + JSON.stringify(handback.body));
  const deltaSummary = typeof handback.body.deltaSummary === "string" ? handback.body.deltaSummary : "";
  must(deltaSummary.includes(humanNonce), "handback deltaSummary 不含人类 nonce：" + JSON.stringify(deltaSummary));
  record("claude", "handback", true, { status: handback.status, resumed: handback.body.resumed, deltaSummary: deltaSummary.slice(0, 500) });

  await sleep(800);
  const types = {};
  for (const event of events) types[event.type] = (types[event.type] ?? 0) + 1;
  record("claude", "events", events.length > 0, {
    count: events.length,
    types,
    firstSeq: events[0]?.seq ?? null,
    lastSeq: events[events.length - 1]?.seq ?? null,
  });
  socket.close();

  const page = await http("GET", "/api/cp/sessions/" + encodeURIComponent(state.claudeKey) + "/transcript?after=0&limit=200");
  must(page.status === 200, "Claude /transcript 失败：" + JSON.stringify(page.body));
  const messages = messagesOf(page.body);
  const shapes = messages.map(shapeOf);
  record("gate6", "unified-claude", true, { messages: messages.length, shapes: [...new Set(shapes.map((s) => s.join(",")))], nextCursor: page.body.nextCursor });

  const attach = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.claudeKey) + "/attach", {});
  must(attach.status === 422, "交互式 Claude /attach 应 422（caps.attach=false），实际 " + String(attach.status));
  record("gate4", "attach-422-claude-interactive", true, { status: attach.status, body: attach.body });
}

async function phaseCodexHttp() {
  const taskNonce = "T9_CODEX_HTTP_" + nonce;
  const dispatch = await http("POST", "/api/cp/dispatch", {
    agent: "codex",
    task: "Reply with exactly " + taskNonce + " and do not modify any files.",
    cwd: workspace,
    idempotencyKey: "t9-codex:" + nonce,
  }, 180_000);
  must(dispatch.status === 200, "Codex dispatch 失败：" + JSON.stringify(dispatch.body));
  state.codexHttpKey = dispatch.body.key;
  state.codexHttpNativeId = dispatch.body.nativeId;
  record("codex", "http-dispatch", true, { status: dispatch.status, key: dispatch.body.key, nativeId: dispatch.body.nativeId, ms: dispatch.ms });

  const ready = await pollTranscript(state.codexHttpKey, "0", (messages) => firstAssistant(messages), 120_000);
  must(ready.hit, "Codex dispatch 后 120s 内没有 assistant 消息");
  record("codex", "http-see", true, { waitedMs: ready.waitedMs, messages: ready.messages.length, last: ready.messages.slice(-1).map(textOf) });

  const lease = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.codexHttpKey) + "/lease", {
    action: "acquire",
    driver: "pi",
    clientId,
    ttlMs: 30 * 60 * 1000,
  });
  must(lease.status === 200, "Codex 取租约失败：" + JSON.stringify(lease.body));
  const handoff = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.codexHttpKey) + "/handoff", {
    to: "human",
    clientId,
    summary: "T9 Codex handoff " + nonce,
  });
  must(handoff.status === 200, "Codex handoff 失败：" + JSON.stringify(handoff.body));
  const command = Array.isArray(handoff.body.command) ? handoff.body.command : [];
  must(command[0] === "codex" && command[1] === "resume" && command[2] === state.codexHttpNativeId && command[3] === "--no-alt-screen", "Codex handoff 命令形状不对：" + JSON.stringify(command));
  must(handoff.body.mode === "resume-tui", "Codex handoff mode 应为 resume-tui：" + JSON.stringify(handoff.body));
  record("gate4", "handoff-codex", true, { status: handoff.status, command, mode: handoff.body.mode });
  record("gate5", "handoff-codex", true, { command, mode: handoff.body.mode });
}

async function phasePiHttp() {
  const lease = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.piKey) + "/lease", {
    action: "acquire",
    driver: "pi",
    clientId,
    ttlMs: 30 * 60 * 1000,
  });
  must(lease.status === 200, "Pi 取租约失败：" + JSON.stringify(lease.body));
  record("pi", "http-lease", true, { status: lease.status });

  const conflict = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.piKey) + "/lease", {
    action: "acquire",
    driver: "pi",
    clientId: "t9-intruder",
  });
  must(conflict.status === 409, "第二写者应 409，实际 " + String(conflict.status) + "：" + JSON.stringify(conflict.body));
  must(errorCodeOf(conflict) === "E_LEASE_CONFLICT", "第二写者错误码应为 E_LEASE_CONFLICT，实际 " + String(errorCodeOf(conflict)));
  record("gate7", "lease-conflict-http", true, { status: conflict.status, body: conflict.body });

  const handoff = await http("POST", "/api/cp/sessions/" + encodeURIComponent(state.piKey) + "/handoff", {
    to: "human",
    clientId,
    summary: "T9 Pi handoff " + nonce,
  });
  must(handoff.status === 200, "Pi handoff 失败：" + JSON.stringify(handoff.body));
  const command = Array.isArray(handoff.body.command) ? handoff.body.command : [];
  must(command[0] === "pi" && command[1] === "--session" && command[2] === state.piPath && handoff.body.mode === "resume-tui", "Pi handoff 命令形状不对：" + JSON.stringify(handoff.body));
  record("gate4", "handoff-pi", true, { status: handoff.status, command, mode: handoff.body.mode });
  record("gate5", "handoff-pi", true, { command, mode: handoff.body.mode });
}

async function phaseCodexDriver() {
  const ref = state.codexRef;
  const config = loadConfig({
    ...process.env,
    PI_WORKBENCH_HOME: home,
    PI_WORKBENCH_PORT: String(state.port),
    PI_WORKBENCH_AUTOSTART: "0",
  });
  const driver = new CodexDriver(config, { cwd: workspace });
  try {
    const resumeStarted = Date.now();
    await driver.resume(ref);
    record("codex", "resume-by-native-id", true, { nativeId: ref.nativeId, ms: Date.now() - resumeStarted });

    const injectNonce = "T9_CODEX_RESUME_" + nonce;
    const injected = await driver.inject(ref, "Reply with exactly " + injectNonce + " and do not modify any files.");
    record("codex", "inject", true, injected);

    const turn = await driver.waitForTurn(ref, 120_000);
    record("codex", "wait-turn", true, turn);

    const page = await driver.see(ref, "0", 200);
    const messages = Array.isArray(page.messages) ? page.messages : [];
    must(assistantHas(messages, injectNonce), "Codex resume 后 assistant 消息没有回显 " + injectNonce + "：" + JSON.stringify(messages.slice(-3)));
    page.messages.forEach(shapeOf);
    record("codex", "see", true, { messages: messages.length, pending: page.pending, last: messages.filter((m) => roleOf(m) === "assistant").slice(-1).map(textOf) });

    const handoff = await driver.handoff(ref);
    must(Array.isArray(handoff.command) && handoff.command.join(" ") === ["codex", "resume", ref.nativeId, "--no-alt-screen"].join(" "), "Codex driver handoff 命令不对：" + JSON.stringify(handoff));
    record("gate5", "handoff-codex-driver", true, handoff);
  } finally {
    await driver.dispose();
  }
}

async function phasePiDriver() {
  const ref = state.piRef;
  const db = openDb(":memory:");
  try {
    migrate(db);
    const leases = new LeaseManager(db);
    const makeDriver = (id) =>
      new PiDriver({
        lease: leases,
        clientId: id,
        env: { PI_WORKBENCH_AUTOSTART: "0" },
        timeoutMs: 120_000,
      });
    const first = makeDriver("pi:t9-a-" + nonce);
    const second = makeDriver("pi:t9-b-" + nonce);
    try {
      const attachStarted = Date.now();
      await first.attach(ref);
      record("pi", "rpc-attach", true, { ms: Date.now() - attachStarted, session: ref.transcriptPath });

      const injectNonce = "T9_PI_ATTACH_" + nonce;
      const injected = await first.inject(ref, "Reply with exactly " + injectNonce + " and do not modify any files.");
      record("pi", "inject", true, injected);

      const deadline = Date.now() + 120_000;
      let cursor = "0";
      let all = [];
      while (Date.now() < deadline) {
        const page = readTranscript("pi", ref.transcriptPath, cursor, 200);
        cursor = page.nextCursor;
        all = all.concat(page.messages);
        if (assistantHas(all, injectNonce)) break;
        await sleep(500);
      }
      must(assistantHas(all, injectNonce), "Pi attach 后 assistant 消息没有回显 " + injectNonce + "：" + JSON.stringify(all.slice(-3)));
      all.forEach(shapeOf);
      record("pi", "see", true, { messages: all.length, last: all.filter((m) => roleOf(m) === "assistant").slice(-1).map(textOf) });

      const before = countPiRpcProcesses();
      let conflict = null;
      try {
        await second.inject(ref, "T9_PI_SECOND_WRITER_SHOULD_FAIL");
      } catch (error) {
        conflict = { code: error.code ?? null, message: messageOf(error) };
      }
      const after = countPiRpcProcesses();
      must(conflict !== null && conflict.code === "E_LEASE_CONFLICT", "第二写者应 E_LEASE_CONFLICT，实际 " + JSON.stringify(conflict));
      must(before === after && before >= 1, "第二写者不应新增 RPC 子进程：before=" + String(before) + " after=" + String(after));
      record("gate3", "pi-lease-conflict", true, { conflict, before, after, newProcesses: after - before });

      const handoff = await first.handoff(ref);
      must(Array.isArray(handoff.command) && handoff.command[0] === "pi" && handoff.command[1] === "--session" && handoff.command[2] === ref.transcriptPath && handoff.mode === "resume-tui", "Pi driver handoff 命令不对：" + JSON.stringify(handoff));
      record("gate5", "handoff-pi-driver", true, handoff);
    } finally {
      await second.dispose();
      await first.dispose();
    }
  } finally {
    db.close();
  }
}

async function phaseErrorPaths() {
  const missingAgent = await http("POST", "/api/cp/dispatch", {
    agent: "t9-no-such-agent",
    task: "noop",
    idempotencyKey: "t9-missing:" + nonce,
  });
  must(missingAgent.status === 422 && errorCodeOf(missingAgent) === "E_AGENT_UNAVAILABLE", "adapter 不存在的错误不对：" + JSON.stringify(missingAgent));
  record("gate7", "agent-unavailable", true, { status: missingAgent.status, body: missingAgent.body });

  const missingSession = await http("GET", "/api/cp/sessions/" + encodeURIComponent("claude:t9-missing-" + nonce));
  must(missingSession.status === 404 && errorCodeOf(missingSession) === "E_SESSION_NOT_FOUND", "会话不存在的错误不对：" + JSON.stringify(missingSession));
  record("gate7", "session-not-found", true, { status: missingSession.status, body: missingSession.body });

  const config = loadConfig({
    ...process.env,
    PI_WORKBENCH_HOME: home,
    PI_WORKBENCH_PORT: String(state.port),
    PI_WORKBENCH_AUTOSTART: "0",
  });
  const driver = new CodexDriver(config, { cwd: workspace });
  try {
    const bogus = {
      key: "codex:00000000-0000-0000-0000-000000000000",
      agent: "codex",
      nativeId: "00000000-0000-0000-0000-000000000000",
      cwd: workspace,
      status: "idle",
      driver: "pi",
      capabilities: { ...capsOf("codex") },
      kind: "interactive",
    };
    let rejected = null;
    const started = Date.now();
    try {
      await withTimeout(driver.resume(bogus), 60_000, "Codex 拒绝 resume 探针");
    } catch (error) {
      rejected = { code: error.code ?? null, message: messageOf(error), details: error.details ?? null };
    }
    must(rejected !== null && rejected.code === "E_RESUME_REJECTED", "resume 被拒的错误码不对：" + JSON.stringify(rejected));
    record("gate7", "resume-rejected", true, { ms: Date.now() - started, rejected });
  } finally {
    await driver.dispose();
  }
}

async function main() {
  record("setup", "start", true, {
    nonce,
    repoRoot,
    home,
    workspace,
    evidencePath,
    node: process.version,
    platform: process.platform,
    startedIso,
  });

  if (existsSync(home)) {
    rmSync(home, { recursive: true, force: true });
    record("setup", "clean-home", true, { removed: home });
  }
  mkdirSync(workspace, { recursive: true });

  const phases = [
    ["setup", prepareSeeds],
    ["setup", startDaemon],
    ["gate4+6", phaseAgentsAndAttach],
    ["claude", phaseClaude],
    ["codex-http", phaseCodexHttp],
    ["pi-http", phasePiHttp],
    ["codex-driver", phaseCodexDriver],
    ["pi-driver", phasePiDriver],
    ["gate7", phaseErrorPaths],
  ];

  for (const [phase, fn] of phases) {
    try {
      await fn();
      record(phase, "phase-summary", true, "done");
    } catch (error) {
      record(phase, "phase-summary", false, messageOf(error));
      process.stdout.write("  ↳ 继续执行后续阶段（失败已记录）\n");
    }
  }

  const passed = state.failures.length === 0;
  record("summary", "result", passed, {
    result: passed ? "PASS" : "FAIL",
    failures: state.failures,
    claudeKey: state.claudeKey,
    codexKey: state.codexKey,
    piKey: state.piKey,
    evidencePath,
  });
  process.stdout.write("\n" + (passed ? "PASS" : "FAIL") + " —— 证据：" + evidencePath + "\n");
}

try {
  await main();
} finally {
  stopDaemon();
  if (!keepHome) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论
    }
  }
}
process.exitCode = state.failures.length === 0 ? 0 : 1;
