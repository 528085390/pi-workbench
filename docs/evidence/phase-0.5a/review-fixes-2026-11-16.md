# 分支评审修复（2026-11-16）

来源：`.superpowers/sdd/2026-11-14-phase-0.5a-claude-slice/review-branch-2026-11-16.md`（master...HEAD 30 commits）。
评审结论 FIX-FIRST：2 阻塞（B1/B2）+ 4 Important（I1–I4）+ 3 Minor（C1–C3）。本文件记录逐项修复与验证。

## 修复清单

| 编号 | 问题 | 修复 | 回归用例 |
|---|---|---|---|
| B1 | `viewOf` / `POST /read` 调 `readTranscript` 未传 limit → 被 `DEFAULT_TRANSCRIPT_LIMIT=200` 截断：250 条未读永远显示 200，`/read` 读不完 | `server.ts` 新增 `readToEnd(path, cursor)`（`limit=Infinity`，走注入 reader）；`normalizeLimit` 认 `Infinity`→`MAX_SAFE_INTEGER`；新增 `readClaudeTranscriptToEnd` | `api.test.ts`「>200 条未读不被默认分页上限截断」：unread=250、`/unread?limit=2` 报 248（pageCount=2）、`POST /read` 到 250 |
| B2 | 插件在 `beforeCall` 里调 `noteToolActivity()`，通知器自己的投递前复核也走该 client → 每次清零，连击上限失效（实测 6 次发 6 条） | 新增 `wrapToolExecute(activity, run)`（src/index.ts），只在 `pi.registerTool` 的 execute 包装里清账；`beforeCall` 不再清 | `extension.test.ts`「wrapToolExecute：工具执行前清连击」；`scratch/review-check/verify-fixes.mjs` 实测 sent=5 |
| I1 | `/unread` 的 `unread: page.messages.length` 是"本页条数"不是"剩余总数" | 返回 `unread`=读到 EOF 的剩余数，另加 `pageCount` | 同上（limit=2 → unread=248 / pageCount=2） |
| I2 | `PI_WORKBENCH_NOTIFY=0` 把徽标一起关掉（违反 spec §6.6 解耦） | `TurnNotifier` 增 `sendEnabled`（false=只维护徽标不发消息）；插件始终建 notifier+WS | `notify.test.ts`「I2：sendEnabled=false 只维护徽标、不发消息」 |
| I3 | 自动拉起失败只打日志 → 首个 `cp_*` 报 `E_INTERNAL: fetch failed` | 插件保存 `readyError`，`beforeCall` 抛出；`DaemonDownError`(`code=E_DAEMON_DOWN`)；`formatToolError` 透出任意 `E_*` code | `extension.test.ts`「formatToolError：带 E_* code 的领域错误原样透出」 |
| I4 | 无 `cp_handback` 工具；`handback` 固定发 `pi:<pid>`，但 handoff 的租约是 `handoff-<pi>` → 普通 pi 身份 E_NO_LEASE | `takeover.handback` 先解析「当前租约是否 `handoff-<去前缀 id>`」再 assert，release 用同一 id；新增第 9 个工具 `cp_handback`；client.handback(key, clientId?) | `takeover.test.ts`「Pi 用自身 clientId 也能交回」「非租约持有人 E_NO_LEASE」；`extension.test.ts`「cp_handback 打到 /handback」 |
| C1 | 旧 daemon（schema v2）在跑时新插件静默半残（/health 只探 ok） | `/health` 返回 `schemaVersion`；`ensureDaemon` 探到 < 3 抛 `E_DAEMON_DOWN`「控制面版本过旧」且不 spawn | `daemon.test.ts`「健康但 schema 过旧」「版本够新」 |
| C2 | daemon 认 `PI_WORKBENCH_AUTH_TOKEN`、client 只认 `PI_WORKBENCH_TOKEN` → 双名分叉 | client/插件 `PI_WORKBENCH_TOKEN ?? PI_WORKBENCH_AUTH_TOKEN`（daemon 侧已有兼容） | 真机：仅设 `AUTH_TOKEN` 启动 0.0.0.0:7361，匿名 401、client 200 |
| C3 | `daemon.ts` 环境里残留 `PI_WORKBENCH_PORT` 时"探 A 端口、起 B 端口" | 端口以 URL 为准（`parsed.port || env`），主机名仍让 env 优先 | `daemon.test.ts`「C3：端口以 URL 为准」 |
| 建议 | 显式游标无校验 | `POST /read` 的 `cursor` 必须 `/^\d+$/`，否则 400 | `api.test.ts` 非法游标 400 |

## 验证

```
pnpm -r build                    # 三包 Done
control-plane: 229 tests / 228 pass / 1 skip / 0 fail
extension:     47 tests / 47 pass / 0 fail
```

`scratch/review-check/verify-fixes.mjs`（不入库）：

```
B1 默认分页仍是 200          ok  200
B1 读到底 250                ok  250
B2 连击上限 5（复核不清零）  ok  sent=5
B2 工具执行仍清零            ok  notes=1
C1 旧 schema → E_DAEMON_DOWN ok  E_DAEMON_DOWN: 控制面版本过旧（schema 低于 v3）...
```

真机（schema v3，0.0.0.0:7361，仅设 `PI_WORKBENCH_AUTH_TOKEN`）：

```
GET /health                → {"ok":true,...,"schemaVersion":3}
GET /api/cp/sessions 匿名  → 401
client（只读 AUTH_TOKEN）  → sessions: 0（200）
```

## 未修（评审建议项，留 0.5-C）

- `pi-workbench.plugin.ts` 未纳入 `tsconfig` include（它 import `./dist/index.js`，依赖先 build）。
- `.full-review/` 为评审产物，已加入 .gitignore。
