#!/usr/bin/env node
/**
 * Phase 0.5-C 重启恢复 E2E（C07 / Task 13 Step 1）。
 *
 *   node scripts/e2e-restart.mjs
 *
 * 隔离：默认 PI_WORKBENCH_HOME=<repo>/tmp/e2e-restart，端口每次从空闲端口里挑
 * （绝不占用 7331）；默认 PASS 后删除 home，失败保留；PI_WORKBENCH_E2E_KEEP=1 时 PASS 后也保留。
 *
 * 流程（任一步失败 → 退出码 1，但后续清理照做）：
 *   启动 daemon #1 → dispatch 一个 claude 任务 → 等 session/assistant 出现
 *   → taskkill /F /PID <daemon>（POSIX 用 SIGKILL）→ 用同一个 home 重启 daemon #2
 *   → 断言 GET /sessions 仍含该 key、GET transcript 可读、POST attach 返回
 *     200 或结构化 E_RESUME_REJECTED（Claude 交互式会话先被能力闸门挡成
 *     E_CAP_UNSUPPORTED，属预期分支）
 *   → 断言 workbench.db 有 2 个 instances 行、1 条 daemon_restart 事件。
 *
 * 证据：<home>/e2e-restart.jsonl，每步一行 {ts, step, ok, detail}；默认 PASS 后随 home 删除，
 * 需要复查时设 PI_WORKBENCH_E2E_KEEP=1 保留。
 * 只用 Node 内置能力 + HTTP：不 import packages 下的任何模块（避免把控制面代码
 * import 进脚本，让「跑不通」只剩一种解释：daemon / adapter 真的不行）。
 *
 * 已知偏差（C07 裁定）：Claude 交互式会话 attach=false，POST attach 会在能力闸门
 * 返回 422 E_CAP_UNSUPPORTED（契约已记录）；因此「attach 200 后 restart 再 inject」的
 * 正向链路无法用 Claude interactive 演练。本脚本把 422 作为负向断言保留，不伪造 200。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = resolve(process.env.PI_WORKBENCH_HOME ?? join(repoRoot, "tmp", "e2e-restart"));
const workspace = join(home, "workspace");
const evidencePath = join(home, "e2e-restart.jsonl");
const keepHome = process.env.PI_WORKBENCH_E2E_KEEP === "1";
const nonce = randomUUID().slice(0, 8);

const state = { daemon: null, port: 0, baseUrl: "", daemonLog: "", checks: 0, failures: [] };

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
    // 证据写失败不该盖住原始失败原因
  }
  process.stdout.write((ok ? "✔ " : "✘ ") + step + (detail === "" ? "" : "：" + detailOf(detail)) + "\n");
  if (!ok) state.failures.push(step + ": " + detailOf(detail));
  return ok;
}

function must(condition, message) {
  if (!condition) throw new Error(message);
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

/** 杀掉 daemon 前核对命令行的最后一道闸：pid 复用/拿错 pid 时绝不下手。 */
function commandLineOf(pid) {
  if (process.platform !== "win32") {
    try {
      return readFileSync("/proc/" + String(pid) + "/cmdline", "utf8").replaceAll("\0", " ").trim();
    } catch {
      return "";
    }
  }
  const script = "Get-CimInstance Win32_Process -Filter \"ProcessId = " + String(pid) + "\" | Select-Object -ExpandProperty CommandLine";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ...winEnv },
  });
  return (result.stdout ?? "").trim();
}

/** 上一轮崩溃/中断留下的 daemon 先清掉，否则单实例锁会让本轮启动失败 */
function killStaleFromHome() {
  const pidPath = join(home, "workbench.pid");
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (pidAlive(pid)) {
    // 与 kill daemon #1 同一道闸：pid 文件只证明「某个 pid」，命令行不含 control-plane 时绝不下手。
    const cmd = commandLineOf(pid);
    if (!cmd.toLowerCase().includes("control-plane")) {
      rmSync(pidPath, { force: true });
      return;
    }
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, ...winEnv } });
    } else {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  rmSync(pidPath, { force: true });
}

function killTree(child) {
  if (child === null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, ...winEnv } });
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
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

async function startDaemon(label) {
  state.port = await pickPort();
  state.baseUrl = "http://127.0.0.1:" + String(state.port);
  state.daemonLog = "";
  const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot, "packages", "control-plane", "src", "index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...winEnv,
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
  record(label + "-health", health.status === 200, { url: state.baseUrl, pid: child.pid, health: health.body });
  return health.body;
}

async function waitForSession(key, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await http("GET", "/api/cp/sessions", undefined, 10_000);
    must(response.status === 200, "GET /sessions 失败：" + JSON.stringify(response.body));
    const sessions = Array.isArray(response.body) ? response.body : [];
    const hit = sessions.find((session) => session.key === key);
    if (hit !== undefined) return hit;
    await sleep(300);
  }
  throw new Error("30s 内 /sessions 没出现 " + key);
}

async function pollTranscript(key, predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await http("GET", "/api/cp/sessions/" + encodeURIComponent(key) + "/transcript?after=0&limit=200", undefined, 10_000);
    must(response.status === 200, "GET transcript 失败：" + JSON.stringify(response.body));
    last = response.body;
    const messages = messagesOf(response.body);
    if (predicate(messages)) return { hit: true, messages, body: response.body };
    await sleep(intervalMs);
  }
  return { hit: false, messages: messagesOf(last), body: last };
}

function dbQuery(dbPath, sql) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

async function main() {
  // 干净起点：同一 home 里的旧库会让 instances 行数不复现
  killStaleFromHome();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const health1 = await startDaemon("daemon-1");
  const instanceId1 = typeof health1 === "object" && health1 !== null ? health1.instanceId : null;
  must(typeof instanceId1 === "string" && instanceId1.length > 0, "daemon #1 的 /health 没有 instanceId");

  const task = "E2E 重启恢复任务（nonce " + nonce + "）：请只回答这一行，不要使用任何工具：E2E_RESTART_" + nonce;
  const dispatch = await http("POST", "/api/cp/dispatch", {
    agent: "claude",
    task,
    cwd: workspace,
    idempotencyKey: "e2e-restart:" + nonce,
  }, 180_000);
  record("dispatch-accepted", dispatch.status === 200, { status: dispatch.status, body: dispatch.body, ms: dispatch.ms });
  must(dispatch.status === 200, "dispatch 失败：" + JSON.stringify(dispatch.body));
  const key = dispatch.body.key;

  const listed = await waitForSession(key);
  record("session-listed-before-restart", listed.key === key, { key: listed.key, status: listed.status, driver: listed.driver });

  const sessionsBeforeResponse = await http("GET", "/api/cp/sessions", undefined, 10_000);
  must(sessionsBeforeResponse.status === 200, "重启前 GET /sessions 失败：" + JSON.stringify(sessionsBeforeResponse.body));
  const sessionCountBefore = Array.isArray(sessionsBeforeResponse.body) ? sessionsBeforeResponse.body.length : -1;
  record("sessions-count-before-restart", sessionCountBefore >= 1, { count: sessionCountBefore });

  // 只要求「有一条 assistant 输出」：模型不一定会照抄 nonce，内容不该成为回归门槛
  const before = await pollTranscript(key, (messages) => messages.some((message) => roleOf(message) === "assistant" && textOf(message).length > 0), 120_000);
  record("transcript-before-restart", before.hit, { messages: before.messages.length, waited: before.hit });
  must(before.hit, "120s 内没有等到 assistant 回复，无法建立重启前的基线");

  // 硬杀：模拟 daemon 崩溃（计划要求 taskkill /F /PID）。
  // 先核对 pid 的命令行，避免 pid 复用/拿错进程时误杀无关进程。
  const pid = state.daemon.pid;
  const daemonCommandLine = commandLineOf(pid);
  const isControlPlane = daemonCommandLine.toLowerCase().includes("control-plane");
  record("daemon-pid-is-control-plane", isControlPlane, { pid, cmd: daemonCommandLine.slice(0, 400) });
  must(isControlPlane, "拒绝 taskkill：pid " + String(pid) + " 的命令行不含 control-plane：" + daemonCommandLine);
  killTree(state.daemon);
  const exited = await withTimeout(new Promise((done) => state.daemon.once("exit", () => done(true))), 20_000, "daemon #1 退出");
  record("daemon-1-killed", exited === true, { pid });

  const health2 = await startDaemon("daemon-2");
  const instanceId2 = typeof health2 === "object" && health2 !== null ? health2.instanceId : null;
  record("daemon-2-new-instance", typeof instanceId2 === "string" && instanceId2.length > 0 && instanceId2 !== instanceId1, {
    instanceId1,
    instanceId2,
  });

  const sessionsResponse = await http("GET", "/api/cp/sessions", undefined, 10_000);
  must(sessionsResponse.status === 200, "重启后 GET /sessions 失败：" + JSON.stringify(sessionsResponse.body));
  const sessions = Array.isArray(sessionsResponse.body) ? sessionsResponse.body : [];
  record("sessions-count-unchanged", sessions.length === sessionCountBefore, {
    before: sessionCountBefore,
    after: sessions.length,
  });
  const restored = sessions.find((session) => session.key === key);
  record("sessions-after-restart", restored !== undefined, {
    total: sessions.length,
    found: restored === undefined ? null : { key: restored.key, agent: restored.agent, status: restored.status, driver: restored.driver },
  });
  must(restored !== undefined, "重启后 /sessions 丢了会话 " + key);
  record("session-reconciled-unknown", restored.driver === "none" && restored.status === "unknown", {
    driver: restored.driver,
    status: restored.status,
  });

  const after = await http("GET", "/api/cp/sessions/" + encodeURIComponent(key) + "/transcript?after=0&limit=200", undefined, 10_000);
  const afterMessages = messagesOf(after.body);
  const taskStillThere = afterMessages.some((message) => roleOf(message) === "user" && textOf(message).includes("E2E_RESTART_" + nonce));
  record("transcript-after-restart", after.status === 200 && taskStillThere && afterMessages.length >= before.messages.length, {
    status: after.status,
    messages: afterMessages.length,
    beforeMessages: before.messages.length,
  });

  // 已知偏差（C07 裁定）：Claude 交互式会话 attach=false，能力闸门会先返回
  // 422 E_CAP_UNSUPPORTED。这里把它作为明确的负向断言，而不是接受 200 的假正向。
  const attach = await http("POST", "/api/cp/sessions/" + encodeURIComponent(key) + "/attach", {}, 30_000);
  const attachCode = errorCodeOf(attach);
  const attachOk = attach.status === 422 && attachCode === "E_CAP_UNSUPPORTED";
  record("attach-after-restart-capability-gate-422", attachOk, {
    status: attach.status,
    code: attachCode,
    knownDeviation: "Claude interactive attach=false; attach 200 + inject-after-restart is not exercised",
    body: attach.body,
  });

  const dbPath = join(home, "workbench.db");
  must(existsSync(dbPath), "workbench.db 不存在：" + dbPath);
  const instances = dbQuery(dbPath, "SELECT COUNT(*) AS n FROM instances")[0]?.n ?? -1;
  record("db-instances-2", instances === 2, { dbPath, instances });
  const restartEvents = dbQuery(dbPath, "SELECT COUNT(*) AS n FROM events WHERE type = 'state_update' AND payload_json LIKE '%\"reason\":\"daemon_restart\"%'")[0]?.n ?? -1;
  record("db-daemon-restart-event", restartEvents === 1, { events: restartEvents });

  // daemon 把日志写进 <home>/logs/daemon.log，不走 stdout
  const daemonLogPath = join(home, "logs", "daemon.log");
  const daemonLog = existsSync(daemonLogPath) ? readFileSync(daemonLogPath, "utf8") : "";
  record("daemon-log-recovery", daemonLog.includes("重启对账"), { path: daemonLogPath, tail: daemonLog.slice(-400) });

  // 收尾：停止 daemon #2（正常路径），并确认进程真的没了
  const pid2 = state.daemon.pid;
  killTree(state.daemon);
  await sleep(500);
  record("daemon-2-stopped", !pidAlive(pid2), { pid: pid2 });
}

try {
  await main();
} catch (error) {
  record("fatal", false, messageOf(error));
} finally {
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
if (!keepHome && state.failures.length === 0) {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
