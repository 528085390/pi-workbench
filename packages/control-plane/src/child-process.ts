import { createRequire, syncBuiltinESMExports } from "node:module";

type ChildProcessModule = typeof import("node:child_process");

let installed = false;

/**
 * 给 spawn 的结果补 windowsHide: true。
 *
 * Windows 上父进程没有控制台时（daemon / Pi 插件），child_process.spawn 默认会为子进程
 * 新建一个控制台窗口。pi 包的 RpcClient 在 start() 里写死了 spawn("node", ...) 且没有
 * windowsHide 选项，于是每次 Pi RPC 会话都会弹一个黑窗。这里统一给所有 spawn 默认补上
 * windowsHide；调用方显式传 false 时仍尊重显式值（方便测试/特殊场景）。
 */
export function wrapSpawnWithHiddenWindow(spawnImpl: typeof import("node:child_process").spawn): typeof import("node:child_process").spawn {
  return ((...args: unknown[]) => {
    const [command, commandArgs, options] = args;
    return (spawnImpl as (...callArgs: unknown[]) => unknown)(command, commandArgs, {
      windowsHide: true,
      ...(options as Record<string, unknown> | undefined ?? {}),
    });
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
