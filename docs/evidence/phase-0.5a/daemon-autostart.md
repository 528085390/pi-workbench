# daemon 自动拉起（Pi 插件加载即用）验收证据

- 日期：2026-11-16
- 分支：`feat/phase-0.5a`
- 用户诉求：「这个 daemon 能不能在 pi 插件加载的时候自动启动？」

## 1. 行为

Pi 插件（`packages/extension/pi-workbench.plugin.ts`）加载时：

1. 先探 `<baseUrl>/health`（默认 `http://127.0.0.1:7331`）；
2. 已在跑 → 什么都不做；
3. 没在跑 → detached 起 `node <repo>/packages/control-plane/dist/cli.js start`，
   把 baseUrl 里的 `host`/`port` 通过 `PI_WORKBENCH_HOST` / `PI_WORKBENCH_PORT` 传给子进程
   （保证"探 A 端口、起 B 端口"不会发生），然后轮询 /health 直到就绪；
4. **不阻塞 Pi 启动**：工厂函数不 await，第一个 `cp_*` 调用前才等（`beforeCall` 钩子）；
5. 只对回环地址自动拉起；远端 daemon 不代管；
6. 关掉：`PI_WORKBENCH_AUTOSTART=0`；自定义入口：`PI_WORKBENCH_DAEMON_ENTRY`。

失败语义：入口文件不存在（没 `pnpm -r build`）→ 立刻报 `E_DAEMON_DOWN: 找不到控制面入口 …`；
等了 20s 仍未就绪 → `E_DAEMON_DOWN: … 手工启动：node … start`。

## 2. 自动化测试

`packages/extension`：27 tests / 27 pass。

- `test/daemon.test.ts`（6）：已健康不 spawn、冷启动 detached + 轮询、超时文案、非回环不 spawn、
  入口缺失快速失败、回环判定；
- `test/extension.test.ts`（新增 2）：`beforeCall` 每次请求前 await、钩子抛错时不发请求。

## 3. 真机验证（真 `pi`，端口 7342，独立 home）

冷启动前：`curl 127.0.0.1:7342/health` → DOWN。

```
$ PI_WORKBENCH_URL=http://127.0.0.1:7342 PI_WORKBENCH_HOME=E:\pi-workbench\tmp\autostart-home \
  pi -p "调用一次 cp_sessions 工具（无参数）并把返回原样贴出"
[pi-workbench] 控制面未运行，已尝试自动启动：node E:\pi-workbench\packages\control-plane\dist\cli.js start（pid 29988）
cp_sessions 返回原文：
no sessions
```

事后再查：

```
$ curl -s http://127.0.0.1:7342/health
{"ok":true,"name":"pi-workbenchd","version":"0.0.1","pid":16600,...}
$ node -e "…PRAGMA user_version…"   # E:\pi-workbench\tmp\autostart-home\workbench.db
user_version 3
tables checkpoints,dispatches,events,leases,read_cursors,sessions,sqlite_sequence
```

→ 插件确实拉起了**新代码**（schema v3 含 `read_cursors`），监听的是 baseUrl 指定的端口，不需要用户另开窗口。

P.S. 幂等：daemon 已在跑时再次加载插件只做探活，不 spawn（单实例锁 + 探活双保险）。

## 4. 已知限制

- 只支持本仓布局的默认入口（`packages/control-plane/dist/cli.js`）；全局安装的 `pi-workbench` 可用 `PI_WORKBENCH_DAEMON_ENTRY` 指过去。
- 冷启动期间首个工具调用会等到就绪（通常 1–3s）；超 20s 才报错。
- 同一 `PI_WORKBENCH_HOME` 下多个不同端口的 daemon 会撞单实例锁（设计如此）。
