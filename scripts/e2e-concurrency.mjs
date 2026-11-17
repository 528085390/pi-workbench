#!/usr/bin/env node
/**
 * Phase 0.5-C 并发与幂等 E2E（C07 / Task 13 Step 3 前半）。
 *
 *   node scripts/e2e-concurrency.mjs
 *
 * 隔离：默认 PI_WORKBENCH_HOME=<repo>/tmp/e2e-concurrency；端口从空闲端口里挑，
 * 绝不占用 7331。PI_WORKBENCH_E2E_KEEP=0 时结束后删除 home。
 *
 * 断言（任一步失败 → 退出码 1）：
 *   1. 同一个 idempotencyKey 并发 dispatch 3 次 → 3 个 200、同一个 session key、
 *      库里 dispatches 只有 1 行（幂等预留原子生效）。
 *   2. 两个客户端抢同一会话租约 → 第二个 E_LEASE_CONFLICT（R25 单写者）。
 *   3. 同一会话并发 inject 10 条 → 全部 200、messageId 互不相同；transcript 恰好
 *      10 条完整用户消息；WS 帧按 seq 到达（无重复/乱序），状态机
 *      running→idle 交替 10 个回合（写队列串行化，没有交错/截断）。
 *
 * 只用 Node 内置能力 + HTTP + 只读 SQLite：不 import packages 下的模块。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = resolve(process.env.PI_WORKBENCH_HOME ?? join(repoRoot, "tmp", "e2e-concurrency"));
const workspace = join(home, "workspace");
const evidencePath = join(home, "e2e-concurrency.jsonl");
const keepHome = process.env.PI_WORKBENCH_E2E_KEEP !== "0";
const nonce = randomUUID().slice(0, 8);
const CLIENTS = { conflictA: "e2e-conflict-a", conflictB: "e2e-conflict-b", inject: "e2e-concurrency" };
const INJECT_COUNT = 10;
const DISPATCH_COUNT = 3;

const state = { daemon: null, port: 0, baseUrl: "", daemonLog: "", checks: 0, failures: [], ws: null };
const winEnv = { SystemDrive: "C:", SystemRoot: "C:\\Windows" };

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function detailOf(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 1500 ? text.slice(0, 1500) + "…" : text;
}

function record(step, ok, detail = "") {
  state.checks += 1;
  const line = { ts: new Date().toISOString(), step, ok, detail: detailOf(detail) };
  try {
    appendFileSync(evidencePath, JSON.stringify(line) + "\n", "utf8");
  } catch {
    // ignore
  }
  process.stdout.write((ok ? "✔ " : "✘ ") + step + (detail === "" ? "" : "：" + detailOf(detail)) + "\n");
  if (!ok) state.failures.push(step + ": " + detailOf(detail));
  return ok;
}

function must(condition, message) {
  if (!condition) throw new Error(message);
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

/** 订阅 WS：从 after 开始回放 + 实时帧，按「到达顺序」记录 seq。 */
async function openWsCollector(afterSeq, frames) {
  const url = state.baseUrl.replace(/^http/, "ws") + "/api/cp/ws?after=" + String(afterSeq);
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    let frame = null;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (frame !== null && typeof frame === "object" && Number.isInteger(frame.seq)) {
      frames.push({ at: Date.now(), seq: frame.seq, type: typeof frame.type === "string" ? frame.type : "" });
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WS 连接失败：" + url)), { once: true });
  });
  return socket;
}

function messagesOf(page) {
  return page !== null && typeof page === "object" && Array.isArray(page.messages) ? page.messages : [];
}

function textOf(message) {
  return typeof message === "object" && message !== null && typeof message.text === "string" ? message.text : "";
}

function roleOf(message) {
  return typeof message === "object" && message !== null && typeof message.role === "string" ? message.role : "";
}

function pidAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killStaleFromHome() {
  const pidPath = join(home, "workbench.pid");
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (pidAlive(pid)) killPid(pid);
  rmSync(pidPath, { force: true });
}

function killPid(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, ...winEnv } });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

function killTree(child) {
  if (child === null || child.pid === undefined) return;
  killPid(child.pid);
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
      // 未就绪
    }
    await sleep(300);
  }
  throw new Error("60s 内 /health 未就绪：" + state.daemonLog.slice(-1500));
}

async function startDaemon() {
  state.port = await pickPort();
  state.baseUrl = "http://127.0.0.1:" + String(state.port);
  state.daemonLog = "";
  const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot, "packages", "control-plane", "src", "index.ts")], {
    cwd: repoRoot,
    env: { ...process.env, ...winEnv, PI_WORKBENCH_HOME: home, PI_WORKBENCH_PORT: String(state.port), PI_WORKBENCH_AUTOSTART: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  state.daemon = child;
  child.stdout.on("data", (chunk) => { state.daemonLog += String(chunk); });
  child.stderr.on("data", (chunk) => { state.daemonLog += String(chunk); });
  const health = await waitForHealth();
  record("daemon-health", health.status === 200, { url: state.baseUrl, pid: child.pid, instanceId: health.body?.instanceId });
}

async function getSession(key) {
  const response = await http("GET", "/api/cp/sessions/" + encodeURIComponent(key), undefined, 10_000);
  must(response.status === 200, "GET /sessions/:key 失败：" + JSON.stringify(response.body));
  return response.body;
}

async function waitForSession(key, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await http("GET", "/api/cp/sessions", undefined, 10_000);
    must(response.status === 200, "GET /sessions 失败：" + JSON.stringify(response.body));
    const sessions = Array.isArray(response.body) ? response.body : [];
    const hit = sessions.find((session) => session.key === key);
    if (hit !== undefined) return { session: hit, sessions };
    await sleep(300);
  }
  throw new Error("30s 内 /sessions 没出现 " + key);
}

async function pollTranscript(key, predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await http("GET", "/api/cp/sessions/" + encodeURIComponent(key) + "/transcript?after=0&limit=500", undefined, 15_000);
    must(response.status === 200, "GET transcript 失败：" + JSON.stringify(response.body));
    last = response.body;
    if (predicate(messagesOf(response.body))) return messagesOf(response.body);
    await sleep(intervalMs);
  }
  return messagesOf(last);
}

function dbQuery(sql, params = []) {
  const db = new DatabaseSync(join(home, "workbench.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function injectText(index) {
  return "E2E_INJECT_" + nonce + "_" + String(index) + " 请只回复 OK，不要使用任何工具。";
}

async function main() {
  killStaleFromHome();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  await startDaemon();

  // 评审 P2-7：先采会话列表基线，dispatch 后断言「只多出这一个会话」。
  // 隔离 home 从空库起步，基线应为 0；写成 baseline + 1 也能兼容将来预置会话的用例。
  const beforeList = await http("GET", "/api/cp/sessions", undefined, 10_000);
  must(beforeList.status === 200, "GET /sessions 基线失败：" + JSON.stringify(beforeList.body));
  const sessionsBefore = Array.isArray(beforeList.body) ? beforeList.body.length : 0;

  // ---- 1. 同一 idempotencyKey 并发 dispatch 3 次 ---------------------------------
  const idempotencyKey = "e2e-concurrency:" + nonce;
  const task = "E2E 并发任务（nonce " + nonce + "）：请只回答一行，不要使用任何工具：E2E_CONCURRENCY_" + nonce;
  const startedAt = Date.now();
  const dispatches = await Promise.all(
    Array.from({ length: DISPATCH_COUNT }, () =>
      http("POST", "/api/cp/dispatch", { agent: "claude", task, cwd: workspace, idempotencyKey }, 180_000),
    ),
  );
  const keys = dispatches.map((response) => response.body?.key);
  const allOk = dispatches.every((response) => response.status === 200);
  record("dispatch-concurrent-all-200", allOk, {
    statuses: dispatches.map((response) => response.status),
    keys,
    elapsedMs: Date.now() - startedAt,
    ms: dispatches.map((response) => response.ms),
  });
  must(allOk, "并发 dispatch 不是全部 200：" + JSON.stringify(dispatches.map((response) => ({ status: response.status, code: errorCodeOf(response) }))));
  const key = keys[0];
  record("dispatch-same-key", keys.every((candidate) => candidate === key), { key, keys });
  must(typeof key === "string" && key.length > 0, "dispatch 没有返回 key");

  const listed = await waitForSession(key);
  const sessionsAfter = listed.sessions.length;
  record(
    "dispatch-single-session",
    sessionsAfter === sessionsBefore + 1 && listed.sessions.filter((session) => session.key === key).length === 1,
    { baseline: sessionsBefore, totalSessions: sessionsAfter, expected: sessionsBefore + 1, key },
  );
  const dispatchRows = dbQuery("SELECT idempotency_key, status, session_key FROM dispatches WHERE idempotency_key = ?", [idempotencyKey]);
  record("dispatch-single-row", dispatchRows.length === 1 && dispatchRows[0].status === "done" && dispatchRows[0].session_key === key, dispatchRows);

  // 建立基线：等首个回合结束（后面 inject 才不会被算进同一回合）
  // 回合结束看状态机（idle），不依赖模型是否照抄 nonce
  const idleDeadline = Date.now() + 120_000;
  let baselineSession = null;
  while (Date.now() < idleDeadline) {
    baselineSession = (await getSession(key)).session;
    if (baselineSession.status === "idle") break;
    await sleep(500);
  }
  const baseline = await pollTranscript(key, (messages) => messages.some((message) => roleOf(message) === "assistant" && textOf(message).length > 0), 10_000);
  record("dispatch-turn-completed", baselineSession?.status === "idle" && baseline.some((message) => roleOf(message) === "assistant"), {
    status: baselineSession?.status,
    messages: baseline.length,
  });
  const baselineSeq = Number(dbQuery("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events")[0]?.maxSeq ?? 0);
  const wsFrames = [];
  state.ws = await openWsCollector(baselineSeq, wsFrames);
  record("ws-connected", true, { after: baselineSeq });

  // ---- 2. 租约冲突 ---------------------------------------------------------------
  const leaseA = await http("POST", "/api/cp/sessions/" + encodeURIComponent(key) + "/lease", {
    clientId: CLIENTS.conflictA, action: "acquire", driver: "human", ttlMs: 120_000,
  });
  const leaseB = await http("POST", "/api/cp/sessions/" + encodeURIComponent(key) + "/lease", {
    clientId: CLIENTS.conflictB, action: "acquire", driver: "human", ttlMs: 120_000,
  });
  record("lease-conflict", leaseA.status === 200 && leaseB.status === 409 && errorCodeOf(leaseB) === "E_LEASE_CONFLICT", {
    a: { status: leaseA.status, body: leaseA.body },
    b: { status: leaseB.status, code: errorCodeOf(leaseB) },
  });
  const released = await http("POST", "/api/cp/sessions/" + encodeURIComponent(key) + "/lease", {
    clientId: CLIENTS.conflictA, action: "release",
  });
  record("lease-released", released.status === 200, { status: released.status, body: released.body });

  const injectLease = await http("POST", "/api/cp/sessions/" + encodeURIComponent(key) + "/lease", {
    clientId: CLIENTS.inject, action: "acquire", driver: "human", ttlMs: 600_000,
  });
  record("inject-lease-acquired", injectLease.status === 200, { status: injectLease.status, body: injectLease.body });
  must(injectLease.status === 200, "拿不到写租约：" + JSON.stringify(injectLease.body));

  // ---- 3. 10 并发 inject ---------------------------------------------------------
  const texts = Array.from({ length: INJECT_COUNT }, (_, index) => injectText(index));
  const injects = await Promise.all(
    texts.map((text) =>
      http("POST", "/api/cp/sessions/" + encodeURIComponent(key) + "/inject", { clientId: CLIENTS.inject, text }, 120_000),
    ),
  );
  const injectOk = injects.every((response) => response.status === 200);
  record("inject-concurrent-all-200", injectOk, {
    statuses: injects.map((response) => response.status),
    codes: injects.map((response) => errorCodeOf(response)),
    ms: injects.map((response) => response.ms),
  });
  must(injectOk, "并发 inject 失败：" + JSON.stringify(injects.map((response) => ({ status: response.status, body: response.body }))));

  const messageIds = injects.map((response) => response.body?.messageId);
  record("inject-message-ids-unique", messageIds.every((id) => typeof id === "string" && id.length > 0) && new Set(messageIds).size === INJECT_COUNT, messageIds);

  // 等 10 条注入全部落进 transcript（每条都是完整文本）
  const prefix = "E2E_INJECT_" + nonce + "_";
  const finalMessages = await pollTranscript(
    key,
    (messages) => messages.filter((message) => roleOf(message) === "user" && textOf(message).startsWith(prefix)).length >= INJECT_COUNT,
    240_000,
  );
  const userInjectTexts = finalMessages.filter((message) => roleOf(message) === "user" && textOf(message).startsWith(prefix)).map((message) => textOf(message).trim());
  const exactTexts = texts.map((text) => text.trim()).sort();
  const sortedObserved = userInjectTexts.slice().sort();
  record("transcript-10-complete-user-messages", userInjectTexts.length === INJECT_COUNT && JSON.stringify(sortedObserved) === JSON.stringify(exactTexts), {
    count: userInjectTexts.length,
    unique: new Set(userInjectTexts).size,
  });

  // ---- 4. 事件 seq 严格递增、回合不交错 ------------------------------------------
  // 事件是 token/thought/state 流（不是整条消息），「无交错」的可观测口径：
  // 状态机必须 running → idle → running 严格交替，10 次 inject 恰好对应 10 个回合，
  // 且每个回合内至少有一条 token/thought 事件（没有两个回合的流交织在一起）。
  // 10 条 inject 已落 transcript 不代表第 10 个回合已启动；等到 10 个 running 状态再评估交替，
  // 否则最后一条 inject 尚未开始会被误判成少一个回合。
  let eventRows = [];
  const cycleDeadline = Date.now() + 120_000;
  while (Date.now() < cycleDeadline) {
    eventRows = dbQuery("SELECT seq, type, payload_json FROM events WHERE session_key = ? ORDER BY seq", [key]).map((row) => ({
      seq: Number(row.seq),
      type: row.type,
      payload: JSON.parse(row.payload_json),
    }));
    const runningStates = eventRows.filter(
      (event) => event.type === "state_update" && event.seq > baselineSeq && event.payload.state === "running",
    ).length;
    if (runningStates >= INJECT_COUNT) break;
    await sleep(500);
  }
  const seqs = eventRows.map((event) => event.seq);
  // WS 到达顺序是独立于 DB 的证据：帧必须从 baselineSeq+1 起按 seq 单调到达，且不重复。
  // 不把 DB 的 MAX(seq) 当作序列化证据——那是存储层自己生成的，属于同义反复。
  await sleep(2000);
  const receivedSeqs = wsFrames.map((frame) => frame.seq);
  // 只断言「WS 到达顺序」：首帧从 baselineSeq+1 开始，后续严格递增且不重复。
  // 不要求收到全部历史帧（订阅/回放可能按会话过滤或延迟），也不拿 DB MAX(seq) 当证据。
  const wsOrdered = receivedSeqs.length > 0
    && receivedSeqs[0] === baselineSeq + 1
    && receivedSeqs.every((seq, index) => index === 0 || seq > receivedSeqs[index - 1])
    && new Set(receivedSeqs).size === receivedSeqs.length;
  record("ws-arrival-order", wsOrdered, {
    after: baselineSeq,
    received: receivedSeqs.length,
    first: receivedSeqs[0] ?? null,
    last: receivedSeqs[receivedSeqs.length - 1] ?? null,
    dbMaxSeq: seqs.length > 0 ? seqs[seqs.length - 1] : null,
    sample: wsFrames.slice(0, 5),
  });

  const stateEvents = eventRows.filter(
    (event) => event.type === "state_update" && event.seq > baselineSeq && typeof event.payload.state === "string",
  );
  const transitions = [];
  for (const event of stateEvents) {
    if (transitions.length === 0 || transitions[transitions.length - 1].state !== event.payload.state) {
      transitions.push({ seq: event.seq, state: event.payload.state });
    }
  }
  // 基线回合的收尾 idle 可能落在 baselineSeq 之后，忽略开头多余的那一个 idle
  const cycles = transitions.length > 0 && transitions[0].state === "idle" ? transitions.slice(1) : transitions;
  let alternationOk = true;
  let runningCount = 0;
  let cyclesWithOutput = 0;
  for (let index = 0; index < cycles.length; index += 1) {
    const expected = index % 2 === 0 ? "running" : "idle";
    if (cycles[index].state !== expected) alternationOk = false;
    if (expected !== "running") continue;
    runningCount += 1;
    const endSeq = cycles[index + 1] === undefined ? Number.MAX_SAFE_INTEGER : cycles[index + 1].seq;
    const hasOutput = eventRows.some(
      (event) => event.seq > cycles[index].seq && event.seq < endSeq && (event.type === "token" || event.type === "thought"),
    );
    if (hasOutput) cyclesWithOutput += 1;
  }
  // 最后一条 inject 的回合可能刚开始（还没吐 token），只要求「已结束」的回合有输出
  const trailingRunning = cycles.length > 0 && cycles[cycles.length - 1].state === "running";
  const completedCycles = trailingRunning ? runningCount - 1 : runningCount;
  const outputOk = trailingRunning
    ? cyclesWithOutput === completedCycles || cyclesWithOutput === completedCycles + 1
    : cyclesWithOutput === completedCycles;
  record("events-no-interleaving", alternationOk && runningCount === INJECT_COUNT && outputOk, {
    transitions: transitions.length,
    runningCycles: runningCount,
    cyclesWithOutput,
    completedCycles,
    trail: cycles.slice(-6),
  });

  const unread = await http("GET", "/api/cp/sessions/" + encodeURIComponent(key) + "/unread?clientId=" + encodeURIComponent(CLIENTS.inject), undefined, 10_000);
  record("unread-visible", unread.status === 200, { status: unread.status, body: unread.body });
}

try {
  await main();
} catch (error) {
  record("fatal", false, messageOf(error));
} finally {
  if (state.ws !== null) {
    try { state.ws.close(); } catch {}
    state.ws = null;
  }
  killTree(state.daemon);
  state.daemon = null;
}

const total = state.checks;
if (state.failures.length > 0) {
  process.stdout.write("FAIL " + String(state.checks - state.failures.length) + "/" + String(total) + " checks failed\n");
  for (const failure of state.failures) process.stderr.write("  - " + failure + "\n");
  process.exit(1);
}
process.stdout.write("PASS " + String(total) + " checks\n");
if (!keepHome) {
  rmSync(home, { recursive: true, force: true });
}
