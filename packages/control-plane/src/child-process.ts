import { createRequire, syncBuiltinESMExports } from "node:module";

import type { AgentName } from "@pi-workbench/shared";

import type { ProcessRegistry, TrackedChild } from "./process-registry.ts";

type ChildProcessModule = typeof import("node:child_process");

let installed = false;

/** 当前进程的登记表；index.ts 在启动时注入，spawn 补丁据此登记 adapter / RPC 子进程。 */
let processRegistry: ProcessRegistry | null = null;

/** 注入 / 清除 ProcessRegistry。必须在 adapter / RPC 子进程启动前调用。 */
export function setProcessRegistry(registry: ProcessRegistry | null): void {
  processRegistry = registry;
}

/** 从 spawn 的 command + args 猜测所属 agent，仅用于退出治理筛选会话。 */
export function detectSpawnAgent(command: unknown, args: unknown): AgentName | undefined {
  const parts: string[] = [];
  if (typeof command === "string") {
    parts.push(command);
  }
  if (Array.isArray(args)) {
    for (const arg of args) {
      if (typeof arg === "string") {
        parts.push(arg);
      }
    }
  }
  const text = parts.join(" ").toLowerCase();
  if (text.includes("claude-agent-acp")) {
    return "claude";
  }
  if (text.includes("codex-acp")) {
    return "codex";
  }
  const leaf = String(command).toLowerCase().split(/[\\/]/).pop() ?? "";
  if (text.includes("pi-coding-agent") || text.includes("--mode rpc") || leaf === "pi" || leaf === "pi.cmd" || leaf === "pi.exe") {
    return "pi";
  }
  return undefined;
}

/** label 按计划取命令行首项。 */
function commandLabel(command: unknown): string {
  if (typeof command === "string") {
    return command;
  }
  if (command instanceof URL) {
    return command.href;
  }
  return String(command);
}

function registerSpawnedChild(child: unknown, command: unknown, args: unknown): void {
  if (processRegistry === null || child === null || typeof child !== "object") {
    return;
  }
  const tracked = child as Partial<TrackedChild>;
  if (typeof tracked.once !== "function") {
    return;
  }
  processRegistry.track(tracked as TrackedChild, commandLabel(command), detectSpawnAgent(command, args));
}

/**
 * 给 spawn 的结果补 windowsHide: true。
 *
 * Windows 上父进程没有控制台时（daemon / Pi 插件），child_process.spawn 默认会为子进程
 * 新建一个控制台窗口。pi 包的 RpcClient 在 start() 里写死了 spawn("node", ...) 且没有
 * windowsHide 选项，于是每次 Pi RPC 会话都会弹一个黑窗。这里统一给所有 spawn 默认补上
 * windowsHide；调用方显式传 false 时仍尊重显式值（方便测试/特殊场景）。
 *
 * 分工：静态 import 的 claude.ts 显式传 windowsHide；Pi 包是动态 import，必须在
 * 它解析之前调用本文件的全局 patch。不要删掉 claude.ts 的显式参数，也不要把 Pi 包
 * 改成静态 import，否则会静默退回控制台弹窗。
 */
export function wrapSpawnWithHiddenWindow(spawnImpl: typeof import("node:child_process").spawn): typeof import("node:child_process").spawn {
  return ((...args: unknown[]) => {
    const [command, commandArgs, options] = args;
    const child = (spawnImpl as (...callArgs: unknown[]) => unknown)(command, commandArgs, {
      windowsHide: true,
      ...(options as Record<string, unknown> | undefined ?? {}),
    });
    registerSpawnedChild(child, command, commandArgs);
    return child;
  }) as typeof import("node:child_process").spawn;
}

/** 只在 Windows 上生效；重复调用是幂等的。必须在动态 import RpcClient 之前调用。 */
export function hideWindowsChildProcesses(sync = syncBuiltinESMExports): void {
  if (installed || process.platform !== "win32") {
    return;
  }
  const require = createRequire(import.meta.url);
  const cp = require("node:child_process") as ChildProcessModule;
  cp.spawn = wrapSpawnWithHiddenWindow(cp.spawn);
  sync();
  installed = true;
}
