# Codex 回合结束不唤醒 Pi：根因与修复（2026-11-16）

## 症状

Pi 会话 `2026-11-16T11-39-04-032Z_01a1e427-4fdf-7426-a3ee-3d9d1a96e908.jsonl` 中执行：

- `cp_dispatch agent=codex` 返回 `codex:01a1e45e-83a4-7da2-8afc-c387240fd4d2`（running）
- Codex 完成并写出 rollout，但 Pi 没有收到 `[pi-workbench] ... 本轮结束` 消息
- `cp_sessions` 中该会话以及其它 Codex 会话的 `unread` 都是 0

## 根因

Codex ACP 的 rollout 文件在 `session/new` 返回之后才落盘（实测约几十毫秒）。原来的解析链只在 dispatch 时尝试一次：

1. `CodexDriver.newSession()` 调用了 `resolveTranscriptPath()`，但丢弃了返回值；
2. `TakeoverEngine.dispatch()` 紧接着再次解析，仍可能抢在文件创建前；
3. 失败后路径只存在于 driver 内部的 `#rolloutPaths`，没有写回 `SessionRegistry`；
4. `GET /sessions` 的 `viewOf()` 只读 `session.transcriptPath`，路径为空时 `unread` 恒为 0；
5. `TurnNotifier` 在投递前复核 `unread > 0`，把这条回合结束事件当作“已读完”丢弃。

Claude 的 transcript 路径由 adapter 直接提供，不经过这条延迟解析链，所以 Claude 唤醒正常、Codex 静默。

## 修复

- `packages/control-plane/src/takeover.ts`
  - 新增 `TakeoverEngine.refreshTranscriptPath(key)`：路径为空时让 driver 的 `resolveTranscriptPath()` 再解析一次，成功则写回注册表。
- `packages/control-plane/src/server.ts`
  - 新增 `ensureTranscriptPath()`；
  - `GET /sessions`（带 clientId）、`GET /sessions/:key`、`GET /sessions/:key/transcript`、`GET /sessions/:key/unread`、`POST /sessions/:key/read` 在路径为空时先补解析；
  - 这样 `TurnNotifier` 的 listSessions 复核能看到真实 `unread`。
- `packages/control-plane/src/agents/codex-driver.ts`
  - `newSession()` 在 rollout 已落盘时把 `transcriptPath` 一并返回，减少第一次列表前的空窗口。
- `packages/control-plane/test/api-agents.test.ts`
  - 新增回归：路径为空的 Codex 会话经 `GET /sessions?clientId=...` 后补上路径、`unread > 0`，第二次读取不再重复扫描。

## 验证

### 自动化

```text
pnpm --filter @pi-workbench/control-plane test
  tests 350 / pass 349 / fail 0 / skipped 1
pnpm --filter @pi-workbench/control-plane typecheck
  exit 0
pnpm -r build
  三包 Done
```

### 真实数据（重启 daemon 后）

对用户当前 `C:\Users\huang\.pi-workbench\workbench.db` 执行 `GET /api/cp/sessions?clientId=pi:30588`：

```text
codex:01a1e45e-83a4-7da2-8afc-c387240fd4d2  unread=27
  transcriptPath=C:\Users\huang\.codex\sessions\2026\11\16\rollout-2026-11-16T20-39-21-01a1e45e-...jsonl
```

路径已持久化到 `sessions.transcript_path`，不再是 NULL。

### 唤醒器复核

用真实 daemon 的 `GET /sessions?clientId=pi:wake-test` 作为 `TurnNotifier.listSessions`，喂入该 Codex 会话的 `state_update{state:"idle"}`，假 sink 收到：

```text
[pi-workbench] 1 个会话有更新（未读共 27 条）：
- codex:01a1e45e-83a4-7da2-8afc-c387240fd4d2 本轮结束，游标 0 之后有 27 条
用 cp_see <key> 读取（peek:true 只看不标记）。
```

说明“路径补解析 → unread > 0 → TurnNotifier 投递”链路已打通。

## 已知后续

- 这次修复只解决 Codex transcript 路径持久化与唤醒判定；Codex/Claude 的 ACP `session/update` 没有携带 sessionId 到 `AdapterUpdate`，当同一 driver 同时 attach 多个会话时事件可能串流，属 0.5-C 事件管线范围。
- 历史 Codex 会话在首次列表时会一次性补路径并显示历史未读，这是预期的“读到你没读过的内容”，不会自动发唤醒；真正的唤醒仍由新的 state_update 触发。
