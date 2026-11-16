# C04 故障注入证据（进程登记 / 日志轮转 / 健康检查）

- 日期：2026-11-17
- 环境：Windows 11，Node 24.16，pnpm 12.3.4
- 相关提交：ae01f3e（Task 9）；Task 9 fix 见 git log
- 规格：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §6.2、§7.4

## 1. adapter 子进程退出 → E_ADAPTER_CRASHED

用真实 Node 子进程模拟 adapter 异常退出（80ms 后 exit 1），登记到 ProcessRegistry，并挂
`createDriverExitHandler`；会话为 `pi:evidence`，状态 running，持有 daemon 租约。

复现脚本：`tmp/c04-evidence.mjs`（仅作本次证据，不进入产品代码）。

实测输出：

```json
{
  "crash": {
    "eventCode": "E_ADAPTER_CRASHED",
    "status": "exited",
    "leaseReleased": true
  }
}
```

结论：adapter 退出后错误事件 code 为 `E_ADAPTER_CRASHED`，会话 status 置 `exited`，租约已释放。

## 2. 优雅退出耗时（killAll / taskkill /T）

用真实子进程（忽略 SIGTERM 的 `setInterval` 进程）登记后调用 `killAll(500)`；超时后走
Windows `taskkill /PID <pid> /T /F` 兜底。

实测输出（同一脚本）：

```json
{
  "shutdown": {
    "pid": 50692,
    "elapsedMs": 1028,
    "alive": false
  }
}
```

结论：SIGTERM 等待 500ms 后强制杀树，整个 killAll 约 1.0s 完成，进程已不存在；
index.ts 外层仍有 5s force 定时器兜底。

## 3. 日志轮转（10MB / 5 份默认；测试用小阈值放大）

`createLogger({ dir, maxBytes: 180, keep: 2 })` 连续写 12 条，结果：

```json
{
  "files": [
    { "name": "daemon.log", "bytes": 154 },
    { "name": "daemon.log.1", "bytes": 152 },
    { "name": "daemon.log.2", "bytes": 152 }
  ]
}
```

结论：当前文件 + 2 份轮转文件，单文件均 <= maxBytes；默认常量为
`DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024`、`DEFAULT_LOG_KEEP = 5`，
`PI_WORKBENCH_LOG_DIR` 可覆盖默认 `~/.pi-workbench/logs`。

## 4. 健康检查（/health）

API 测试覆盖：

- `GET /health` 与 `GET /api/cp/health` 返回 `ok/name/version/pid/uptimeMs/schemaVersion` 及
  `instanceId/db:{schemaVersion,ok}/adapters:[{agent,available}]`。
- 关闭 DatabaseSync 后请求同一路径：`ok:false`、`db.ok:false`、HTTP 503。

运行命令：

```bash
node --test --experimental-strip-types --test-name-pattern health test/api.test.ts
```

结果：3/3 通过（含 closed-db 用例）。

## 5. 全量回归

```bash
pnpm -C packages/control-plane test
```

结果：481 tests，480 pass，0 fail，1 skipped（既有真实 adapter 冒烟，默认跳过）。
聚焦：`test/process-registry.test.ts` + `test/logger.test.ts` 17/17 通过。
