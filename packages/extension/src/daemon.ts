/**
 * daemon 自动拉起（Pi 插件加载时用）。
 *
 * 语义：Pi 一装上插件就有控制面可用，不需要用户另开窗口跑 `pi-workbench start`。
 * - 只对**回环地址**自动拉起（远端 daemon 起不了，也不该起）；
 * - 先探 /health，活着就什么都不做；
 * - 不在就 detached 起一个 `node <control-plane>/dist/cli.js start`（cli 自己会等就绪后退出），
 *   然后轮询 /health 直到超时；
 * - 绝不抛同步异常：失败只返回/抛出 Error，由调用方决定怎么提示（不阻塞 Pi 启动）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_PROBE_TIMEOUT_MS = 800;
export const DEFAULT_START_TIMEOUT_MS = 20_000;
export const DEFAULT_POLL_INTERVAL_MS = 300;

export type EnsureDaemonOptions = {
  /** 控制面地址，例如 http://127.0.0.1:7331 */
  baseUrl: string;
  /** cli 入口；缺省按本包位置解析 `packages/control-plane/dist/cli.js` */
  entry?: string;
  /** 等就绪的总预算 */
  timeoutMs?: number;
  pollMs?: number;
  /** 探测 /health（测试注入） */
  probe?: (baseUrl: string) => Promise<boolean>;
  /** 起进程（测试注入） */
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
};

export type EnsureDaemonResult = {
  /** true = 这次真的拉起了一个 daemon；false = 本来就在或不该拉起 */
  started: boolean;
  waitedMs: number;
};

/** 插件/包内相对路径 → control-plane 的 cli.js（env 可覆盖） */
export function daemonEntryPath(metaUrl: string = import.meta.url): string {
  const override = process.env["PI_WORKBENCH_DAEMON_ENTRY"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  // dist/daemon.js 或 src/daemon.ts 都在 packages/extension/<x>/ 下，三层到仓根
  return fileURLToPath(new URL("../../../packages/control-plane/dist/cli.js", metaUrl));
}

/** 回环判定（与服务端 assertAuthConfig 的口径保持一致） */
export function isLoopbackUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = host.replace(/^\[/, "").replace(/\]$/, "");
  return bare === "localhost" || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** 探一次 /health（任何异常都当"没起来"） */
export async function probeHealth(baseUrl: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<boolean> {
  const url = baseUrl.replace(/\/+$/, "") + "/health";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 确保 daemon 可用：活着 → 直接返回；否则拉起并等就绪。
 * 超时抛 `E_DAEMON_DOWN: ...`（message 里带怎么手工启动）。
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  const probe = options.probe ?? probeHealth;
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = options.log ?? ((): void => {});
  const began = Date.now();

  if (await probe(options.baseUrl)) {
    return { started: false, waitedMs: Date.now() - began };
  }
  if (!isLoopbackUrl(options.baseUrl)) {
    log("[pi-workbench] 控制面 " + options.baseUrl + " 不是回环地址，跳过自动启动（远端 daemon 请自行启动）");
    return { started: false, waitedMs: Date.now() - began };
  }

  // 拉起时必须让新 daemon 监听 baseUrl 指向的端口，否则探活探的是 A、起的是 B
  let childEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  try {
    const parsed = new URL(options.baseUrl);
    childEnv = {
      ...childEnv,
      PI_WORKBENCH_HOST: childEnv["PI_WORKBENCH_HOST"] ?? parsed.hostname,
      PI_WORKBENCH_PORT: childEnv["PI_WORKBENCH_PORT"] ?? parsed.port,
    };
  } catch {
    // URL 解析失败交给后面的探活超时处理
  }

  const entry = options.entry ?? daemonEntryPath();
  if (!existsSync(entry)) {
    // 常见原因：只装了插件、没 build 控制面。快速失败，别让首个工具调用白等 20s
    throw new Error("E_DAEMON_DOWN: 找不到控制面入口 " + entry + "（先在本仓跑 pnpm -r build）");
  }
  let child: ChildProcess;
  try {
    child = spawnImpl(process.execPath, [entry, "start"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv,
    });
    child.unref();
  } catch (err) {
    throw new Error("E_DAEMON_DOWN: 拉起控制面失败（" + String(err) + "）");
  }
  log("[pi-workbench] 控制面未运行，已尝试自动启动：node " + entry + " start（pid " + String(child.pid) + "）");

  while (Date.now() - began < timeoutMs) {
    if (await probe(options.baseUrl)) {
      return { started: true, waitedMs: Date.now() - began };
    }
    await sleep(pollMs);
  }
  throw new Error(
    "E_DAEMON_DOWN: 等了 " +
      String(Math.round((Date.now() - began) / 1000)) +
      "s 控制面仍不可用（" +
      options.baseUrl +
      "）。手工启动：node " +
      entry +
      " start",
  );
}
