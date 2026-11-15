# 读语义 v2（未读 + 每读者游标）验收证据

- 日期：2026-11-16
- 分支：`feat/phase-0.5a`
- 规格：`docs/specs/2026-11-14-phase-0.5a-claude-slice.md` §6.5
- 背景：用户反馈「Pi 不该靠 `cp_see` 轮询盯会话；应当像聊天软件那样登记未读，读不读、何时读由 Pi 决定」。

## 1. 设计口径

| 项 | 值 |
|---|---|
| 落库 | `read_cursors(session_key, client_id, last_read_cursor, updated_at)`，主键 `(session_key, client_id)`（schema v3） |
| 游标域 | transcript **字节偏移字符串**，与 `GET /transcript` 的 `nextCursor` 同域 |
| `unread` | 游标之后还剩几条 transcript 消息（服务端现场数） |
| `awaiting` | `status === "needs-input"` |
| 推进规则 | 只进不退（SQL `CAST(... AS INTEGER)` 比较）；peek 不推进 |
| 通知 | 不在服务端做，客户端订阅 WS 自行决定（本版未做主动推送，见 §5） |

## 2. 自动化测试

```
packages/control-plane: 226 tests / 225 pass / 1 skip / 0 fail
packages/extension:     19 tests / 19 pass / 0 fail
```

新增用例：
- `test/cursors.test.ts`：默认未读、按 clientId 隔离、只进不退、跨连接持久（4 个）
- `test/db.test.ts`：schema v3 六表 + `read_cursors` 列形状
- `test/api.test.ts`：列表/详情附读状态、peek 不推进、ack 推进、clientId 隔离、`POST /read` 读到底与不回退、缺参 400、无 transcriptPath 空页（7 个）
- `test/cli.test.ts`：`unread`（ack=1 / --peek ack=0）、`read`、`sessions --client-id`（3 个）
- `test/extension.test.ts`：`unread`/`markRead` URL 与 body、`cp_see` 三态（默认未读 / peek / after）、`cp_sessions` 输出未读（3 个）

## 3. 真机验证（真 claude，非 fake）

环境：`PI_WORKBENCH_HOME=E:\\pi-workbench\\tmp\\readsem-home`、端口 7341、daemon pid 30816。

1. `POST /api/cp/dispatch`（cwd `spike/a00-workspace`）→ 会话 `claude:84029a9b-9d4d-418d-a06e-ce19739a08a0`。
2. `GET /sessions/:key/unread?clientId=pi:smoke&ack=0` → 3 条消息（user/text、assistant/thinking、assistant/text `READ_V2_SMOKE_4411`），`lastReadCursor:"0"`，`acked:false`。
3. `GET /sessions?clientId=pi:smoke` → `unread:3`（peek 未推进，符合预期）。
4. `GET /sessions/:key/unread?clientId=pi:smoke&ack=1` → `acked:true`、`lastReadCursor:"190607"`、`unread:0`。
5. `GET /sessions?clientId=pi:other` → 仍 `unread:3`（读者隔离）。
6. `POST /sessions/:key/read {clientId:"pi:other"}` → `lastReadCursor:"190607"`；再查 `unread:0`。
7. `GET /sessions`（不带 clientId）→ 返回纯 `SessionRef[]`，无 `unread` 字段（旧调用方不受影响）。

CLI（`PI_WORKBENCH_URL=http://127.0.0.1:7341`）：

```
$ pi-workbench sessions --client-id pi:cli
claude:84029a9b-...  idle  driver=pi  unread=3  E:\pi-workbench\spike\a00-workspace
$ pi-workbench unread <key> --client-id pi:cli --peek
3 条未读消息，游标 190607
[user/text] ...
[assistant/text] READ_V2_SMOKE_4411
$ pi-workbench sessions --client-id pi:cli      # peek 后仍 3
... unread=3 ...
$ pi-workbench unread <key> --client-id pi:cli  # 默认 ack
3 条未读消息，游标 190607
$ pi-workbench sessions --client-id pi:cli      # 已读 → 0
... unread=0 ...
$ pi-workbench read <key> --client-id pi:cli
已读游标：190607
```

Pi 插件（`pi -p`，`PI_WORKBENCH_URL=http://127.0.0.1:7341`，已 `pi install`）：

```
模型只调了一次 cp_see，工具返回：
3 unread message(s); cursor=190607
[user/text] ...
[assistant/text] READ_V2_SMOKE_4411
```

→ `cp_see` 现在默认就是"打开聊天窗口"：返回未读并标记已读，不再需要 Pi 自己维护 `after` 游标轮询。

## 4. 已知限制 / 后续

- `unread` 每次现数（读 transcript 游标之后的剩余部分）。会话很多 + transcript 很大时是 O(尾部)，量级可接受（200 KB 级毫秒）；若将来成为瓶颈，可加 `message_count` 冗余列。
- Pi 身份默认 `pi:<pid>`：每次 `pi -p` 是新 pid = 新读者。想跨进程保持同一读者/租约身份，设 `PI_WORKBENCH_CLIENT_ID`。
- 主动推送（回合结束/needs-input 时 `pi.sendMessage` + 底栏徽标）尚未实现：目前是"未读事实 + 按需读"，Pi 想提醒自己再拉一次列表即可。
- 列表接口未带 clientId 时不算未读，保持 v1 形状（兼容旧调用方）。
