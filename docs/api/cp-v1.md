# Control Plane API v1（草案）

> 本文件当前记录 Task 6b 的 interrupt 时序契约与 Task 7 的 audit 查询契约；逐路由的完整请求 / 响应 / 错误码表由 C06（API v1 冻结）补齐。
>
> v1 只做 additive：破坏性改动走 `/api/cp/v2`。

## POST /api/cp/sessions/:key/interrupt

请求体：

```json
{ "clientId": "pi:12345" }
```

- 必须持有该会话的租约；没有租约返回 `409 E_NO_LEASE`。
- 成功返回 `200`，响应体为 `{ "stopReason": "<string>" }`。

### 落定语义

- `200` 只表示取消请求已被控制面受理，**不等于** agent 的回合已经停止。
- `interrupt` 返回后，agent 的状态投影可能延迟 0.5–1s 才落 `idle`；控制面在返回前会同步追加一条 `state_update` 兜底事件。
- 状态落定以 `GET /api/cp/ws` 的 `state_update` 事件为准：`payload.state === "idle"`，并携带 `stopReason`；同一回合若有多条，以最后一条为准。
- 客户端不得用 interrupt 响应推断会话已进入 `idle`；必须等 `state_update`，或轮询 `GET /api/cp/sessions` 观察 `status`。

## GET /api/cp/audit

查询参数（均可选）：

| 参数 | 说明 |
|---|---|
| `sessionKey` | 精确匹配会话键，如 `claude:abc` |
| `since` | ISO8601 下界，按 `ts >= since` 过滤 |
| `afterId` | 增量游标：只返回 `id > afterId` 的行；同 `ts` 多条时避免重复回放 |
| `limit` | 正整数；默认 100，上限 1000（超过按 1000 截断） |

成功返回 `200`，按 `id` 升序（写入顺序）：

```json
{
  "items": [
    {
      "id": 1,
      "ts": "2026-11-17T02:00:00.000Z",
      "instanceId": "0b0e6f1a-0000-4000-8000-000000000000",
      "actor": "pi:12345",
      "action": "handoff",
      "sessionKey": "claude:abc",
      "outcome": "ok",
      "errorCode": null,
      "detail": { "step": "cancel", "durationMs": 12, "skipped": false }
    }
  ]
}
```

- `audit_log` 只追加；daemon 启动时删除超过 `auditRetentionDays` 的记录（默认 30，可配置；env：`PI_WORKBENCH_AUDIT_RETENTION_DAYS`）。
- **每个内部步骤一条记录**，`action` 表示操作，`detail.step` 表示步骤：
  - `checkpoint`：`step=checkpoint`
  - `handoff`：`step=cancel`（idle 会话记 `skipped=true`）→ `checkpoint` → `close` → `handoff`（命令拼接）
  - `handback`：`step=resume`
- 每条 `detail` 都带 `durationMs`（该步骤实测耗时，毫秒）；失败行 `outcome="error"`，顶层和 `detail` 都带 `errorCode`。
- `handoff` 内 checkpoint 写失败返回 `500 E_CHECKPOINT_FAILED`，`error.details.action="checkpoint"`。
- 错误：`400 E_BAD_REQUEST`（`limit` 不是正整数 / `afterId` 不是非负整数）、`401 E_UNAUTHORIZED`、`500 E_INTERNAL`。
