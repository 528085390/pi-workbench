# Control Plane API v1（草案）

> 本文件当前只记录 Task 6b 需要冻结的 interrupt 时序契约；逐路由的完整请求 / 响应 / 错误码表由 C06（API v1 冻结）补齐。
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
