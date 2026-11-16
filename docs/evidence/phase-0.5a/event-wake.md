# 事件推送与唤醒（claude 回合结束 → 叫醒 Pi）验收证据

- 日期：2026-11-16
- 分支：`feat/phase-0.5a`
- spec：§6.6（用户 m02516 批准）
- 用户诉求：「claude code 执行完后可以直接触发 pi 进行下一轮，就像 dsh 子代理能触发主对话」

## 1. 实现

- `packages/extension/src/notify.ts`
  - `TurnNotifier`：收事件 → 合并窗口（默认 300ms）→ **投递前复核**未读 → 发一条指针消息 → 更新徽标。
  - 触发：`state_update.status === "idle"`（回合结束）、`needs-input`、`error`；其它事件忽略。
  - 历史回放按 `ts < 通知器创建时刻` 丢弃，Pi 启动不会被上周的回合叫醒。
  - 只唤醒 `driver === "pi"` 的会话；人接管中不吵。
  - 连续唤醒上限 5（任意 `cp_*` 调用清零）→ 触顶只更新徽标，防自激循环。
  - `clearSession(key)`：`cp_see`/`cp_read` 读完后清掉该会话待发通知。
  - `connectNotifier`：连 `WS /api/cp/ws?after=<lastSeq>`，只走 header 认证，断线线性退避重连（2s→10s）。
- `packages/extension/src/index.ts`：`WorkbenchClientOptions.onSessionRead` 钩子（`unread(ack=1)` / `markRead` 成功后触发）。
- `packages/extension/pi-workbench.plugin.ts`：`session_start` 捕获 `ctx.ui.setStatus`；`ready` 后建 notifier + 连 WS；`session_shutdown` 清理。
- 开关：`PI_WORKBENCH_NOTIFY=0` 全关；`PI_WORKBENCH_NOTIFY_MODE=followUp|steer|nextTurn`（默认 followUp）。

## 2. 自动化测试

`packages/extension`：40 tests / 40 pass（新增 `test/notify.test.ts` 13 个）：

| 用例 | 覆盖点 |
|---|---|
| reasonOf 四种 | idle→turn-end / needs-input / error / running 忽略 |
| 历史回放 | ts 早于创建 → 不入队不唤醒 |
| 正常投递 | 文案含 key/游标/条数；options = {deliverAs:"followUp", triggerTurn:true} |
| 投递前复核 | 未读 0 → 静默丢弃，连击计数不动 |
| driver=human | 不唤醒 |
| 多会话合并 | 一条消息 2 个会话 |
| clearSession | Pi 自己读过 → 不再提醒 |
| 连击上限 | 6 次只发 5 条，第 6 次仅徽标；工具调用后恢复 |
| nextTurn | triggerTurn=false |
| 复核失败 | daemon 挂 → 不发不崩 |
| 文案 | 不含"完成"断言 |
| notifierUrl | http→ws、https→wss、保留路径前缀、带 after |

## 3. 真机闭环（端口 7350，独立 home，真 claude + 真 pi TUI）

PTY 探针：`scratch/notify-test/pi-wake-probe.mjs`（node-pty 跑 `cmd.exe /c pi`）。

1. Pi 收到人类指令："调用 cp_dispatch 派任务：先等 20 秒，然后只回复 WAKE_TEST_OK；派完立刻回复'已派发'并结束本轮，不要自己轮询。"
2. Pi 调 `cp_dispatch` → `dispatched claude:21d7959f-1922-4923-bfa1-1d5376e620c1 (running)`，随后回复"已派发"结束本轮（**没有轮询**）。
3. ~20 秒后 claude 回合结束，控制面 `state_update(idle)` → 插件投递：

```
[pi-workbench] 1 个会话有更新（未读共 7 条）：
- claude:21d7959f-1922-4923-bfa1-1d5376e620c1 本轮结束，游标 0 之后有 7 条
用 cp_see <key> 读取（peek:true 只看不标记）。
```

底栏同时出现 `pi-workbench: 7 未读`。

4. Pi 的推理原文（TUI 抓屏）：「The user earlier said not to poll. But now there's a notification that the session has updates. … Should I read it? The notification is prompting. Let me read」→ 调 `cp_see key="claude:21d7959f-…"` → 返回 `7 unread message(s); cursor=210935`。
5. 事后核对：`GET /sessions/claude:21d…/unread?clientId=pi:tui-probe&ack=0` → `{"messages":[],"lastReadCursor":"210935","unread":0}`——读到即结清，没有再重复唤醒。

原始抓屏：`docs/evidence/phase-0.5a/pi-wake-screen.txt`（去 ANSI）。

## 4. 已知边界

- WS 连接建立之前的回合结束不会补唤醒（重连只推进游标）；未读事实仍在列表/徽标里。
- `pi:${pid}` 默认 clientId 每进程不同：换进程后旧未读仍在但不会被唤醒。
- Pi 正忙时按 `deliverAs` 语义排队（followUp 等本轮结束；steer 工具调用间隙插入；nextTurn 不触发）。
