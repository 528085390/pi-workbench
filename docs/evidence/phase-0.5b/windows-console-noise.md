# Windows 控制台窗口噪音修复（2026-11-16）

## 症状

用户启动 Pi 后看到额外的空白 `cmd.exe` 窗口；其中一张截图是：

```text
C:\WINDOWS\system32\cmd.exe
```

同时 Pi 日志不断刷：

```text
[notify] WS 断开，10000ms 后重连（after=68249）
[pi-workbench] WS 错误：connect ECONNREFUSED 127.0.0.1:7331
```

## 根因

有两类不同的窗口：

1. **排查期间的临时启动脚本**：为了验证权限改动，曾用 WMI 启动
   `cmd.exe /c E:\pi-workbench\tmp\start-workbenchd.cmd`，这个 `cmd.exe` 没有隐藏，
   留下了空白窗口（进程 46296）。该脚本只是排查用产物，不是产品代码；已删除脚本并结束该进程。
2. **产品链路里的 Pi RPC 子进程**：pi 包的 `RpcClient.start()` 内部写死了：

   ```js
   spawn("node", [cliPath, "--mode", "rpc", ...], {
     cwd: this.options.cwd,
     env: { ...process.env, ...this.options.env },
     stdio: ["pipe", "pipe", "pipe"],
   });
   ```

   没有传 `windowsHide`。daemon 本身没有控制台，Windows 会为每个 RpcClient 子进程创建新的
   控制台窗口；Pi 的 attach / inject / handoff / newSession 都可能触发。

   `cli start`、daemon 自身、Claude ACP adapter、启动探测此前都已有 `windowsHide: true`，
   唯独 pi 包的 RpcClient 没有。

## 修复

新增 `packages/control-plane/src/child-process.ts`：

- `wrapSpawnWithHiddenWindow(spawnImpl)`：给所有 `child_process.spawn` 调用默认补
  `{ windowsHide: true }`；调用方显式传 `windowsHide: false` 时不覆盖。
- `hideWindowsChildProcesses()`：只在 Windows 生效、幂等；替换
  `node:child_process` 的 `spawn` 后调用 `syncBuiltinESMExports()`，
  这样动态 import 的 pi `RpcClient` 也会使用带隐藏窗口的 spawn。

`packages/control-plane/src/index.ts` 的 `main()` 在加载配置前调用
`hideWindowsChildProcesses()`，确保后续动态 import `RpcClient` 时补丁已就位。

同时，排查用的 `tmp/start-workbenchd.cmd` 已删除；live daemon 改为由 WMI 直接启动
`E:\nodejs\node.exe E:\pi-workbench\tmp\start-workbenchd.mjs`（内部 import `dist/index.js` 并调用
`main()`），不再经过 `cmd.exe` 包装。该 mjs 只是临时启动脚本，不影响产品代码。

## 验证

### 自动化

```text
pnpm -r build                         三包 Done
control-plane                         361 tests / 360 pass / 1 skip / 0 fail
extension                             53 pass / 0 fail
```

新增 `packages/control-plane/test/child-process.test.ts`：

- spawn 默认带 `windowsHide:true`；
- 显式 `windowsHide:false` 保留。

### 进程现场

- live daemon：`http://127.0.0.1:7331/api/cp/health` → 200，pid 59632；
- `GET /api/cp/agents` → claude / codex / pi 均 available；
- `Get-CimInstance Win32_Process` 中已无 `start-workbenchd.cmd` 的 cmd 进程；
- daemon 进程 `MainWindowHandle=0`，没有可见控制台主窗口。

### RpcClient 探测

用临时脚本在 patch 后启动真实 `RpcClient`，其子进程为：

```text
node E:\pi-workbench\tmp\dummy-rpc.mjs --mode rpc
```

进程树中没有为该子进程创建额外的 `conhost.exe` 子进程，说明 `windowsHide` 已生效。
临时脚本与 dummy 文件随后已清理。

## 说明

- Pi 自己是 TUI 程序，仍会占用一个终端窗口；这不是 workbench 额外拉起的窗口。
- 若希望 Pi 的终端也更好看，建议用 Windows Terminal 或固定快捷方式启动 Pi；workbench 不再额外弹命令窗。
