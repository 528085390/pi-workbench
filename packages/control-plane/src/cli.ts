#!/usr/bin/env node
/**
 * pi-workbench 命令入口（A02 最小实现：start / stop / status）。
 * 只做分发，业务逻辑属于 daemon（index.ts）；后续任务在此扩展子命令。
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

export interface HealthResult {
  ok: boolean;
  body: unknown;
}

/**
 * 可注入的运行时依赖（测试用假实现，避免真的开进程 / 真的发信号）。
 * config 可传入已构造好的配置，方便测试隔离 home。
 */
export interface CliOptions {
  config?: Config;
  probeHealth?: (cfg: Config) => Promise<HealthResult>;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

interface Deps {
  probeHealth: (cfg: Config) => Promise<HealthResult>;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** 探活地址：监听 0.0.0.0 / :: 时回落到本机回环 */
export function healthUrl(cfg: Config): string {
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  return `http://${host}:${cfg.port}/health`;
}

/** 从 /health 响应体里取 pid；取不到返回 null */
export function readPidFromBody(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const pid = (body as { pid?: unknown }).pid;
  return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
}

async function probeHealth(cfg: Config): Promise<HealthResult> {
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

function withDefaults(overrides: CliOptions = {}): Deps {
  return {
    probeHealth: overrides.probeHealth ?? probeHealth,
    isAlive: overrides.isAlive ?? isProcessAlive,
    kill: overrides.kill ?? ((pid, signal) => void process.kill(pid, signal)),
    log: overrides.log ?? ((line) => console.log(line)),
    error: overrides.error ?? ((line) => console.error(line)),
  };
}

function configOf(options: CliOptions): Config {
  return options.config ?? loadConfig();
}

async function waitForHealth(cfg: Config, timeoutMs: number, deps: Deps): Promise<HealthResult> {
  const deadline = Date.now() + timeoutMs;
  let last: HealthResult = { ok: false, body: null };
  while (Date.now() < deadline) {
    last = await deps.probeHealth(cfg);
    if (last.ok) return last;
    await new Promise((done) => setTimeout(done, 200));
  }
  return last;
}

async function waitForExit(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return !isAlive(pid);
}

/** daemon 入口：dist 下用 index.js；源码态（type stripping）用 index.ts */
function daemonEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "index.js");
  return existsSync(built) ? built : join(here, "index.ts");
}

export async function start(options: CliOptions = {}): Promise<number> {
  const deps = withDefaults(options);
  const cfg = configOf(options);
  const paths = resolvePaths(cfg.home);
  ensureDirs(paths);

  const running = readPidFile(paths.pid);
  if (running !== null && deps.isAlive(running)) {
    deps.error(`E_ALREADY_RUNNING：控制面已在运行（pid ${running}，pid 文件 ${paths.pid}）`);
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

  const health = await waitForHealth(cfg, 10_000, deps);
  if (!health.ok) {
    deps.error(`启动失败：${healthUrl(cfg)} 在 10s 内没有健康响应，详见日志 ${logPath}`);
    return 1;
  }
  const pid = readPidFromBody(health.body) ?? readPidFile(paths.pid);
  deps.log(`pi-workbenchd 已启动：${healthUrl(cfg)}（pid ${pid ?? "?"}）`);
  return 0;
}

/**
 * 停止控制面。
 * pid 文件只证明「某个 pid」，不证明「这个 pid 是 pi-workbenchd」——pid 会被复用。
 * 所以发信号前必须用 /health 自报的 pid 做身份校验，不一致就不动手。
 */
export async function stop(options: CliOptions = {}): Promise<number> {
  const deps = withDefaults(options);
  const cfg = configOf(options);
  const paths = resolvePaths(cfg.home);

  const pid = readPidFile(paths.pid);
  if (pid === null || !deps.isAlive(pid)) {
    rmSync(paths.pid, { force: true });
    deps.log("控制面未在运行");
    return 0;
  }

  const health = await deps.probeHealth(cfg);
  if (!health.ok) {
    deps.error(
      `停止失败：pid 文件 ${paths.pid} 里的 pid ${pid} 存活，但 ${healthUrl(cfg)} 没有健康响应；` +
        `无法确认它是 pi-workbenchd，为避免误杀无关进程，未发送任何信号。确认后请手动处理或删除该 pid 文件。`,
    );
    return 1;
  }

  const healthPid = readPidFromBody(health.body);
  if (healthPid !== pid) {
    deps.error(
      `停止失败：pid ${pid} 不是 pi-workbenchd（${healthUrl(cfg)} 自报 pid ${healthPid ?? "未知"}），` +
        `pid 可能已被无关进程复用；为避免误杀，未发送任何信号。确认后请手动处理或删除 pid 文件 ${paths.pid}。`,
    );
    return 1;
  }

  try {
    deps.kill(pid, "SIGTERM");
  } catch (err) {
    deps.error(`停止失败：无法向 pid ${pid} 发送 SIGTERM（${err instanceof Error ? err.message : String(err)}）`);
    return 1;
  }

  let exited = await waitForExit(pid, 8000, deps.isAlive);
  if (!exited) {
    try {
      deps.kill(pid, "SIGKILL");
    } catch {
      // 进程可能刚好退出，忽略
    }
    exited = await waitForExit(pid, 2000, deps.isAlive);
  }

  if (readPidFile(paths.pid) === pid) rmSync(paths.pid, { force: true });
  deps.log(`${exited ? "已停止" : "未能停止"}（pid ${pid}）`);
  return exited ? 0 : 1;
}

export async function status(options: CliOptions = {}): Promise<number> {
  const deps = withDefaults(options);
  const cfg = configOf(options);
  const paths = resolvePaths(cfg.home);

  const pid = readPidFile(paths.pid);
  if (pid === null) {
    deps.error(`未运行：找不到 PID 文件 ${paths.pid}`);
    deps.error(START_HINT);
    return 1;
  }
  if (!deps.isAlive(pid)) {
    deps.error(`未运行：pid 文件中的进程 ${pid} 已不存在（残留文件 ${paths.pid}）`);
    deps.error(START_HINT);
    return 1;
  }

  const health = await deps.probeHealth(cfg);
  if (!health.ok) {
    deps.error(`运行中（pid ${pid}），但 ${healthUrl(cfg)} 健康检查失败`);
    deps.error(START_HINT);
    return 1;
  }

  deps.log(`运行中：pid ${pid}，${healthUrl(cfg)}`);
  deps.log(JSON.stringify(health.body, null, 2));
  return 0;
}

/** 分发子命令，返回退出码（不直接 process.exit，方便测试） */
export async function main(argv: string[] = process.argv): Promise<number> {
  const command = argv[2];
  try {
    switch (command) {
      case "start":
        return await start();
      case "stop":
        return await stop();
      case "status":
        return await status();
      default:
        if (command !== undefined) console.error(`未知子命令：${command}\n`);
        console.error(USAGE);
        return 2;
    }
  } catch (err) {
    // 配置错误等直接给出可读信息，不抛整段 stack
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** 直接执行才分发；被 import（例如测试）时保持无副作用 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(resolve(entry)) === realpathSync(self);
  } catch {
    return resolve(entry) === resolve(self);
  }
}

if (isEntrypoint()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
