#!/usr/bin/env node
/**
 * Phase 0.5-C 故障注入 E2E（C07 / Task 13 Step 3 后半）。
 *
 *   node scripts/e2e-faults.mjs
 *
 * 隔离：默认 PI_WORKBENCH_HOME=<repo>/tmp/e2e-faults；端口从空闲端口里挑，绝不占用 7331。
 *
 * 断言（任一步失败 → 退出码 1）：
 *   1. dispatch 建立 running 会话后拿到写租约（driver=pi）。
 *   2. 杀掉 daemon 名下的 claude-agent-acp 子进程（模拟 adapter 崩溃）。
 *   3. 30s 内租约被释放（GET /sessions/:key → lease=null），会话状态变 exited，
 *      事件表出现 error / E_ADAPTER_CRASHED（payload.pid 指向被杀进程）。
 *   4. daemon 停止后没有残留子进程（含 adapter / conhost）。
 *
 * 平台说明：Windows 上 Node 的 SIGTERM 是 TerminateProcess，daemon 的
 * SIGINT/SIGTERM handler 不会执行（2026-11-17 实测），所以第 4 步只能验证
 * 「停止后无残留子进程」这一可观测不变量，不能验证优雅关闭日志。
 *
 * 只用 Node 内置能力 + HTTP + 只读 SQLite。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = resolve(process.env.PI_WORKBENCH_HOME ?? join(repoRoot, "tmp", "e2e-faults"));
const workspace = join(home, "workspace");
const evidencePath = join(home, "e2e-faults.jsonl");
const keepHome = process.env.PI_WORKBENCH_E2E_KEEP !== "0";
const nonce = randomUUID().slice(0, 8);
const clientId = "e2e-faults";

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

function pidAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killPid(pid, tree = false) {
  if (process.platform === "win32") {
    const args = tree ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/F"];
    spawnSync("taskkill", args, { encoding: "utf8", timeout: 20_000, env: { ...process.env, ...winEnv } });
  } else {
    try { process.kill(pid, tree ? "SIGKILL" : "SIGTERM"); } catch {}
  }
}

function killStaleFromHome() {
  const pidPath = join(home, "workbench.pid");
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (pidAlive(pid)) killPid(pid, true);
  rmSync(pidPath, { force: true });
}

/** 一次性拉全进程表，避免对每个 pid 反复起 PowerShell */
function processTable() {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...winEnv },
  });
  const raw = (result.stdout ?? "").trim();
  if (raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function descendantsOf(rootPid) {
  const table = processTable();
  const children = new Map();
  for (const row of table) {
    const parent = Number(row.ParentProcessId);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of children.get(current) ?? []) {
      out.push(child);
      queue.push(Number(child.ProcessId));
    }
  }
  return out;
}

function adapterChildren(daemonPid) {
  return descendantsOf(daemonPid).filter((row) => String(row.CommandLine ?? "").includes("claude-agent-acp"));
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

async function pollLeaseReleased(key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getSession(key);
    if (last.lease === null) return { released: true, session: last };
    await sleep(300);
  }
  return { released: false, session: last };
}

function dbQuery(sql, params = []) {
  const db = new DatabaseSync(join(home, "workbench.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

async function pollCrashEvent(key, adapterPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = dbQuery("SELECT seq, type, payload_json FROM events WHERE session_key = ? AND type = 'error' ORDER BY seq", [key]);
    const parsed = last.map((row) => ({ seq: Number(row.seq), payload: JSON.parse(row.payload_json) }));
    const hit = parsed.find((row) => row.payload?.code === "E_ADAPTER_CRASHED");
    if (hit !== undefined && Number(hit.payload.pid) === adapterPid) return { found: true, event: hit };
    await sleep(300);
  }
  return { found: false, events: last };
}

async function main() {
  killStaleFromHome();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  await startDaemon();
  const daemonPid = state.daemon.pid;

  // 慢任务：让会话在杀 adapter 时仍处于 running（崩溃事件只对 running 会话生成）
  const task = "E2E 故障注入（nonce " + nonce + "）：请先用 Bash 运行 sleep 120，完成后只回复 E2E_FAULT_" + nonce + "。不要使用其他工具。";
  const dispatch = await http("POST", "/api/cp/dispatch", { agent: "claude", task, cwd: workspace, idempotencyKey: "e2e-faults:" + nonce }, 180_000);
  record("dispatch-accepted", dispatch.status === 200, { status: dispatch.status, body: dispatch.body });
  must(dispatch.status === 200, "dispatch 失败：" + JSON.stringify(dispatch.body));
  const key = dispatch.body.key;

  const listed = await http("GET", "/api/cp/sessions/" + encodeURIComponent(key), undefined, 10_000);
  const running = listed.body?.session?.status;
  record("session-running", running === "running", { status: running, driver: listed.body?.session?.driver });

  const lease = await http("POST", "/api/cp/sessions/" + encodeURIComponent(key) + "/lease", {
    clientId, action: "acquire", driver: "pi", ttlMs: 120_000,
  });
  record("lease-acquired", lease.status === 200 && lease.body?.clientId === clientId, { status: lease.status, body: lease.body });
  must(lease.status === 200, "拿不到写租约：" + JSON.stringify(lease.body));

  // 等 adapter 进程出现（启动时已 spawn 一个；dispatch 后仍复用）
  let adapters = [];
  const adapterDeadline = Date.now() + 20_000;
  while (Date.now() < adapterDeadline) {
    adapters = adapterChildren(daemonPid);
    if (adapters.length > 0) break;
    await sleep(300);
  }
  const adapter = adapters[0];
  record("adapter-child-found", adapter !== undefined, {
    daemonPid,
    found: adapters.map((row) => ({ pid: Number(row.ProcessId), name: row.Name, cmd: String(row.CommandLine ?? "").slice(0, 160) })),
  });
  must(adapter !== undefined, "20s 内没找到 daemon 名下的 claude-agent-acp 子进程");

  const adapterPid = Number(adapter.ProcessId);
  killPid(adapterPid, false);
  await sleep(500);
  record("adapter-killed", !pidAlive(adapterPid), { adapterPid });

  const released = await pollLeaseReleased(key, 30_000);
  record("lease-released-within-30s", released.released, {
    released: released.released,
    sessionStatus: released.session?.session?.status,
    lease: released.session?.lease,
  });

  const crashEvent = await pollCrashEvent(key, adapterPid, 30_000);
  record("error-event-E_ADAPTER_CRASHED", crashEvent.found, crashEvent.found ? crashEvent.event : crashEvent.events);
  record("session-status-exited", released.session?.session?.status === "exited", { status: released.session?.session?.status });

  const alive = await http("GET", "/health", undefined, 10_000);
  record("daemon-still-healthy", alive.status === 200, { status: alive.status, adapters: alive.body?.adapters });

  // ---- 停止 daemon：不留下任何子进程 -------------------------------------------
  const beforeStop = descendantsOf(daemonPid).map((row) => Number(row.ProcessId));
  state.daemon.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise((done) => state.daemon.once("exit", () => done(true))),
    sleep(10_000).then(() => false),
  ]);
  record("daemon-stop-exit", stopped === true, { daemonPid });
  await sleep(3000);
  const survivors = beforeStop.filter((pid) => pidAlive(pid));
  record("no-residual-children", survivors.length === 0, { beforeStop, survivors });
  if (survivors.length > 0) {
    for (const pid of survivors) killPid(pid, true);
  }
}

try {
  await main();
} catch (error) {
  record("fatal", false, messageOf(error));
} finally {
  if (state.daemon !== null) killPid(state.daemon.pid, true);
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
