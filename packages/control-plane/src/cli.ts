#!/usr/bin/env node
/**
 * pi-workbench 命令入口（A02 最小实现：start / stop / status）。
 * 只做分发，业务逻辑属于 daemon（index.ts）；后续任务在此扩展子命令。
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type Config } from "./config.ts";
import { ensureDirs, isProcessAlive, readPidFile, resolvePaths } from "./paths.ts";

const START_HINT = "启动命令：pi-workbench start";

const USAGE = [
  "用法：pi-workbench <start|stop|status>",
  "",
  "  start   后台启动控制面",
  "  stop    停止控制面",
  "  status  查看运行状态（含 /health 结果）",
].join("\n");

/** 探活地址：监听 0.0.0.0 / :: 时回落到本机回环 */
function healthUrl(cfg: Config): string {
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  return `http://${host}:${cfg.port}/health`;
}

function readPidFromBody(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const pid = (body as { pid?: unknown }).pid;
  return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
}

async function probeHealth(cfg: Config): Promise<{ ok: boolean; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(healthUrl(cfg), { signal: controller.signal });
    const body: unknown = await res.json();
    const ok = res.ok && typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
    return { ok, body };
  } catch {
    return { ok: false, body: null };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(cfg: Config, timeoutMs: number): Promise<{ ok: boolean; body: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let last: { ok: boolean; body: unknown } = { ok: false, body: null };
  while (Date.now() < deadline) {
    last = await probeHealth(cfg);
    if (last.ok) return last;
    await new Promise((done) => setTimeout(done, 200));
  }
  return last;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return !isProcessAlive(pid);
}

/** daemon 入口：dist 下用 index.js；源码态（type stripping）用 index.ts */
function daemonEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "index.js");
  return existsSync(built) ? built : join(here, "index.ts");
}

async function start(): Promise<number> {
  const cfg = loadConfig();
  const paths = resolvePaths(cfg.home);
  ensureDirs(paths);

  const running = readPidFile(paths.pid);
  if (running !== null && isProcessAlive(running)) {
    console.error(`E_ALREADY_RUNNING：控制面已在运行（pid ${running}，pid 文件 ${paths.pid}）`);
    return 1;
  }

  const logPath = join(paths.logs, "daemon.log");
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [daemonEntry()], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      cwd: process.cwd(),
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const health = await waitForHealth(cfg, 10_000);
  if (!health.ok) {
    console.error(`启动失败：${healthUrl(cfg)} 在 10s 内没有健康响应，详见日志 ${logPath}`);
    return 1;
  }
  const pid = readPidFromBody(health.body) ?? readPidFile(paths.pid);
  console.log(`pi-workbenchd 已启动：${healthUrl(cfg)}（pid ${pid ?? "?"}）`);
  return 0;
}

async function stop(): Promise<number> {
  const cfg = loadConfig();
  const paths = resolvePaths(cfg.home);

  const pid = readPidFile(paths.pid);
  if (pid === null || !isProcessAlive(pid)) {
    rmSync(paths.pid, { force: true });
    console.log("控制面未在运行");
    return 0;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`停止失败：无法向 pid ${pid} 发送 SIGTERM（${err instanceof Error ? err.message : String(err)}）`);
    return 1;
  }

  let exited = await waitForExit(pid, 8000);
  if (!exited) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能刚好退出，忽略
    }
    exited = await waitForExit(pid, 2000);
  }

  if (readPidFile(paths.pid) === pid) rmSync(paths.pid, { force: true });
  console.log(`${exited ? "已停止" : "未能停止"}（pid ${pid}）`);
  return exited ? 0 : 1;
}

async function status(): Promise<number> {
  const cfg = loadConfig();
  const paths = resolvePaths(cfg.home);

  const pid = readPidFile(paths.pid);
  if (pid === null) {
    console.error(`未运行：找不到 PID 文件 ${paths.pid}`);
    console.error(START_HINT);
    return 1;
  }
  if (!isProcessAlive(pid)) {
    console.error(`未运行：pid 文件中的进程 ${pid} 已不存在（残留文件 ${paths.pid}）`);
    console.error(START_HINT);
    return 1;
  }

  const health = await probeHealth(cfg);
  if (!health.ok) {
    console.error(`运行中（pid ${pid}），但 ${healthUrl(cfg)} 健康检查失败`);
    console.error(START_HINT);
    return 1;
  }

  console.log(`运行中：pid ${pid}，${healthUrl(cfg)}`);
  console.log(JSON.stringify(health.body, null, 2));
  return 0;
}

const command = process.argv[2];

try {
  switch (command) {
    case "start":
      process.exitCode = await start();
      break;
    case "stop":
      process.exitCode = await stop();
      break;
    case "status":
      process.exitCode = await status();
      break;
    default:
      if (command !== undefined) console.error(`未知子命令：${command}\n`);
      console.error(USAGE);
      process.exitCode = 2;
  }
} catch (err) {
  // 配置错误等直接给出可读信息，不抛整段 stack
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
