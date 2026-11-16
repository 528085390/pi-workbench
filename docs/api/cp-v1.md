# Control Plane API v1

> 状态：**冻结**（2026-11-17，C06 / Task 11）。机器可读清单见 `packages/shared/src/api.ts` 的 `API_ROUTES`（22 条，含裸 `GET /health`），契约测试为 `packages/control-plane/test/api-contract.test.ts`。
>
> 冻结范围：只承诺 `/api/cp/*` 与 `GET /health`；CLI 参数与 Pi 扩展内部接口不在承诺内。
>
> **v1 只做 additive**：只允许新增可选字段与新端点；删字段、改语义一律走 `/api/cp/v2`，并提供迁移文档。
>
> 通用错误响应：`{ "error": { "code": "E_XXX", "message": "...", "details": { ... } } }`；`details` 可省略。

## 0. 通用约定

### 鉴权

- 配置了 `authToken` 时，除 `GET /health` 外所有路由（含 WS 升级）都要求 `Authorization: Bearer <token>`；缺失或错误返回 `401 E_UNAUTHORIZED`。
- 回环监听且未配置 `authToken` 时全部放行（默认 `127.0.0.1:7331`）。
- `GET /health` 永远免鉴权，供 CLI / 进程管理器探活。

### 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `E_BAD_REQUEST` | 参数 / 请求体 / 查询串非法（含 Fastify 的 413、415） |
| 400 | `E_ASSET_CONFIG_INVALID` | `assets.json` 格式或结构错误 |
| 401 | `E_UNAUTHORIZED` | 缺少或错误的 Bearer token |
| 404 | `E_SESSION_NOT_FOUND` | 会话键不存在 |
| 409 | `E_LEASE_CONFLICT` | 租约被其他客户端持有 |
| 409 | `E_NO_LEASE` | 调用方未持有该会话租约 |
| 409 | `E_IDEMPOTENCY_CONFLICT` | 同一 `idempotencyKey` 对应不同请求 |
| 409 | `E_DISPATCH_IN_PROGRESS` | 同一幂等键的派发仍在进行 |
| 409 | `E_RESUME_REJECTED` | attach / handback 时原生会话已被丢弃或拒绝恢复 |
| 422 | `E_CAP_UNSUPPORTED` | 会话能力未声明该操作 |
| 422 | `E_AGENT_UNAVAILABLE` | 目标 Agent 未注册 / CLI 不可用 / 探测失败 |
| 429 | `E_SESSION_BUSY` | 会话忙，稍后重试 |
| 500 | `E_CHECKPOINT_FAILED` | 检查点写文件 / 落库失败 |
| 500 | `E_INTERNAL` | 未预期异常（对外固定文案，细节只进 daemon 日志） |
| 503 | `E_ADAPTER_DOWN` | Agent 适配器 / RPC 子进程不可用 |
| 503 | `E_HANDOFF_FAILED` | handoff 某一步失败，`details.step` 指明 `cancel` / `close` / `handoff` |

### 游标与事件序号

- `events.seq` 由 SQLite AUTOINCREMENT 分配，**全局单调但不保证连续**：回滚、`INSERT OR IGNORE` 命中等都会消耗序号，允许跳号。
- 重启后 seq 继续递增，不回到 1；客户端应把 seq 当不透明递增游标，不要用 `seq + 1` 推断下一条。
- 所有 `after` 参数都是**排他游标**（只返回 `seq > after` / `cursor > after`）。

## 1. 路由总表

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 免 | 存活 + 运行态摘要 |
| GET | `/api/cp/version` | 是 | API / schema 版本与 daemon 实例 id |
| GET | `/api/cp/agents` | 是 | 三 Agent 可用性 |
| GET | `/api/cp/sessions` | 是 | 会话列表（可带 clientId） |
| GET | `/api/cp/sessions/discover` | 是 | 发现并登记原生会话 |
| POST | `/api/cp/sessions` | 是 | 登记已存在的原生会话 |
| GET | `/api/cp/sessions/:key` | 是 | 会话详情 + 当前租约 |
| GET | `/api/cp/sessions/:key/transcript` | 是 | 增量 transcript |
| GET | `/api/cp/sessions/:key/unread` | 是 | 未读数 |
| POST | `/api/cp/sessions/:key/read` | 是 | 推进读者游标 |
| POST | `/api/cp/sessions/:key/lease` | 是 | 取 / 续 / 放租约 |
| POST | `/api/cp/sessions/:key/inject` | 是 | 注入 |
| POST | `/api/cp/sessions/:key/interrupt` | 是 | 中断 |
| POST | `/api/cp/sessions/:key/attach` | 是 | 接入会话（重启后重连入口） |
| POST | `/api/cp/sessions/:key/checkpoint` | 是 | 写检查点 |
| GET | `/api/cp/sessions/:key/checkpoint` | 是 | 读最新检查点 |
| POST | `/api/cp/sessions/:key/handoff` | 是 | 交给 human / pi |
| POST | `/api/cp/sessions/:key/handback` | 是 | 从 human 接回 |
| POST | `/api/cp/dispatch` | 是 | 派发新任务 |
| GET | `/api/cp/ws` | 是 | 事件流（支持 `after` 回放） |
| GET | `/api/cp/audit` | 是 | 审计查询 |
| GET | `/api/cp/assets` | 是 | 资产清单（只读） |

> `/api/cp/health` 是 `/health` 的兼容别名（早期 CLI 探活依赖），不属于冻结清单；契约测试比较运行时路由时会先剔除它。

## 2. 元信息

### GET /health

免鉴权。返回：

```json
{ "ok": true, "name": "pi-workbenchd", "version": "0.0.1", "pid": 12345, "uptimeMs": 34567, "schemaVersion": 4 }
```

- `version` 是 daemon 版本；`schemaVersion` 是当前库 schema（v1 契约承诺为 4）。
- 客户端必须忽略未知字段：v1 内只会 additive。

### GET /api/cp/version

返回（`api` / `schemaVersion` 必须与 `API_VERSION` / `SCHEMA_VERSION_EXPECTED` 常量一致）：

```json
{ "api": "1", "schemaVersion": 4, "daemon": "0.0.1", "instanceId": "0b0e6f1a-0000-4000-8000-000000000000" }
```

- `instanceId` 是本次 daemon 启动写入 `instances` 表的实例 id；未登记时为空串。
- 错误：`401 E_UNAUTHORIZED`、`500 E_INTERNAL`。

## 3. Agents 与会话

### GET /api/cp/agents

返回 `AgentStatus[]`（30s 缓存）：

```json
[
  { "agent": "claude", "available": true, "version": "2.1.325", "caps": { "stream": true, "inject": true, "interrupt": true, "attach": false, "resume": true, "transcript": true, "permissions": true, "background": false } }
]
```

- `caps` 是该 Agent 的能力矩阵；未声明为 true 的能力不注册工具、不显示按钮。
- `available=false` 时带机器可读 `reason`（以 `E_AGENT_UNAVAILABLE:` 开头）。
- 错误：`401`、`500 E_INTERNAL`。

### GET /api/cp/sessions

查询参数（均可选）：

| 参数 | 说明 |
|---|---|
| `agent` | 按 Agent 过滤 |
| `status` | 按会话状态过滤（`starting` / `running` / `needs-input` / `idle` / `handoff` / `exited` / `unknown`） |
| `clientId` | 传入时每项返回 `SessionView`（附加读状态），不传返回纯 `SessionRef[]` |

`SessionRef` 核心字段：`key`、`agent`、`nativeId`、`cwd`、`status`、`driver`、`capabilities`，以及可选的 `acpSessionId`、`transcriptPath`、`kind`、`lineage`。

`SessionView` 在 `SessionRef` 上追加：

```json
{ "lastReadCursor": "128", "unread": 3, "awaiting": false }
```

- `unread` 是「游标之后还剩几条 transcript 消息」，不受分页上限影响。
- 错误：`400 E_BAD_REQUEST`（参数非法）、`401`、`500 E_INTERNAL`。

### GET /api/cp/sessions/discover

查询参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `agent` | 是 | `codex` / `pi` / `claude` |
| `cwd` | 否 | 按工作目录过滤 |
| `limit` | 否 | 正整数，默认 100 |

返回登记（幂等 upsert）后的会话：

```json
{ "sessions": [ { "key": "codex:...", "agent": "codex", "nativeId": "...", "cwd": "...", "status": "idle", "driver": "none", "capabilities": { } } ], "count": 1 }
```

- 错误：`400 E_BAD_REQUEST`（缺 `agent` / `limit` 非法）、`401`、`422 E_AGENT_UNAVAILABLE`（Agent 未注册或不可用）、`500 E_INTERNAL`。

### POST /api/cp/sessions

请求体：

```json
{ "agent": "claude", "nativeId": "abc", "cwd": "E:/work", "key": "claude:abc", "transcriptPath": "C:/.../abc.jsonl" }
```

- `agent` / `nativeId` / `cwd` 必填；`key` 缺省为 `agent + ":" + nativeId`；`transcriptPath` 可选。
- 成功 `200`：`{ "session": SessionRef, "created": true }`。

错误：`400 E_BAD_REQUEST`、`401`、`422 E_AGENT_UNAVAILABLE`、`500 E_INTERNAL`。

### GET /api/cp/sessions/:key

查询参数：`clientId`（可选，传入时 `session` 为 `SessionView`）。

返回：

```json
{ "session": { }, "lease": { "sessionKey": "claude:abc", "driver": "pi", "clientId": "pi:123", "instanceId": "...", "expiresAt": "2026-11-17T03:10:00.000Z", "heartbeatAt": "2026-11-17T03:09:30.000Z" } }
```

无租约时 `lease=null`。错误：`400`、`401`、`404 E_SESSION_NOT_FOUND`、`500 E_INTERNAL`。

### GET /api/cp/sessions/:key/transcript

查询参数：

| 参数 | 说明 |
|---|---|
| `after` | 字节偏移游标（非负整数字符串），默认 `"0"`，排他 |
| `limit` | 正整数，单页消息上限 |

成功 `200`：

```json
{ "messages": [ { "id": "m1", "role": "assistant", "kind": "text", "text": "hi", "ts": "2026-11-17T03:00:00.000Z" } ], "nextCursor": "256", "pending": false }
```

- `pending=true` 表示原生侧可能还有未落盘内容（由 driver.see 返回时可能带）。
- 读取 transcript 不需要租约，重启后仍可读。
- 错误：`400 E_BAD_REQUEST`（游标 / limit 非法）、`401`、`404 E_SESSION_NOT_FOUND`、`500 E_INTERNAL`。

### GET /api/cp/sessions/:key/unread

查询参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `clientId` | 是 | 读者身份 |
| `limit` | 否 | 单页消息上限 |
| `ack` | 否 | `1/true` 推进游标；`0/false`（默认）只 peek |

成功 `200`：

```json
{ "messages": [], "nextCursor": "256", "lastReadCursor": "128", "unread": 3, "pageCount": 2, "awaiting": false, "acked": false }
```

- `unread` 是从「当前已读位置」起还剩几条，不是本页条数。
- 错误：`400 E_BAD_REQUEST`、`401`、`404 E_SESSION_NOT_FOUND`、`500 E_INTERNAL`。

### POST /api/cp/sessions/:key/read

请求体：

```json
{ "clientId": "pi:12345", "cursor": "256" }
```

- `clientId` 必填；`cursor` 可选，非负整数字符串；不给则读到 EOF（全部已读）。
- 成功 `200`：`{ "sessionKey": "claude:abc", "clientId": "pi:12345", "lastReadCursor": "256", "updatedAt": "..." }`。
- 错误：`400 E_BAD_REQUEST`、`401`、`404 E_SESSION_NOT_FOUND`、`500 E_INTERNAL`。

## 4. 租约与控制

### POST /api/cp/sessions/:key/lease

请求体：

```json
{ "clientId": "pi:12345", "action": "acquire", "driver": "pi", "ttlMs": 30000 }
```

- `clientId` / `action` 必填；`action` ∈ `acquire` / `heartbeat` / `release`。
- `driver` 可选，∈ `pi` / `human` / `none`，默认 `pi`。
- `ttlMs` 可选，正整数；缺省用服务端 `leaseTtlMs`。

| action | 200 响应 |
|---|---|
| `acquire` | `Lease` |
| `heartbeat` | `Lease` |
| `release` | `{ "released": true, "sessionKey": "...", "clientId": "..." }` |

错误：`400 E_BAD_REQUEST`、`401`、`404 E_SESSION_NOT_FOUND`、`409 E_LEASE_CONFLICT`、`500 E_INTERNAL`。

### POST /api/cp/sessions/:key/inject

请求体：`{ "clientId": "pi:12345", "text": "继续" }`（`text` 原样投递，不 trim）。

成功 `200`：

```json
{ "messageId": "msg-1", "effective": "now" }
```

- `effective=next_turn` 表示会话正在跑当前回合，注入在下一个 turn 边界生效。

错误：`400`、`401`、`404`、`409 E_NO_LEASE`、`422 E_CAP_UNSUPPORTED`、`503 E_ADAPTER_DOWN`、`500 E_INTERNAL`。

### POST /api/cp/sessions/:key/interrupt

请求体：

```json
{ "clientId": "pi:12345" }
```

- 必须持有该会话的租约；没有租约返回 `409 E_NO_LEASE`。
- 成功返回 `200`，响应体为 `{ "stopReason": "<string>" }`。

#### 落定语义

- `200` 只表示取消请求已被控制面受理，**不等于** agent 的回合已经停止。
- `interrupt` 返回后，agent 的状态投影可能延迟 0.5–1s 才落 `idle`；控制面在返回前会同步追加一条 `state_update` 兜底事件。
- 状态落定以 `GET /api/cp/ws` 的 `state_update` 事件为准：`payload.state === "idle"`，并携带 `stopReason`；同一回合若有多条，以最后一条为准。
- 客户端不得用 interrupt 响应推断会话已进入 `idle`；必须等 `state_update`，或轮询 `GET /api/cp/sessions` 观察 `status`。

错误：`400`、`401`、`404`、`409 E_NO_LEASE`、`422 E_CAP_UNSUPPORTED`、`503 E_ADAPTER_DOWN`、`500 E_INTERNAL`。

### POST /api/cp/sessions/:key/attach

请求体：无（`{}` 亦可）。

成功 `200`：`{ "attached": true, "sessionKey": "claude:abc", "agent": "claude" }`。

**双判定顺序（C06 明确）**：

1. 会话必须存在 → 否则 `404 E_SESSION_NOT_FOUND`。
2. 目标 Agent 必须已在注册表且可用 → 否则 `422 E_AGENT_UNAVAILABLE`（`details.cap="attach"`）。
3. 会话自身声明的 `capabilities.attach` 必须为 `true` → 否则 `422 E_CAP_UNSUPPORTED`。这里用**会话快照**而不是 `driver.caps`：Claude 的 attach 随 `kind` 变化（interactive=false、background=true），driver.caps 只是交互式快照。
4. 调 `driver.attach()` 建立控制通道；原生侧拒绝恢复 → `409 E_RESUME_REJECTED`，会话状态不变。
5. 成功后注册表置 `driver="pi"`、`status="idle"`；失败不改状态。

其他错误：`401`、`500 E_INTERNAL`。

## 5. 检查点与交接

### POST /api/cp/sessions/:key/checkpoint

请求体：

```json
{ "clientId": "pi:12345", "summary": "已修完路由", "touchedFiles": ["packages/control-plane/src/server.ts"], "nextStep": "跑测试" }
```

- `clientId` / `summary` 必填；`touchedFiles` 为字符串数组；`nextStep` 可选（默认空串）。
- 必须持有租约。
- 成功 `200`：`Checkpoint`：

```json
{ "sessionKey": "claude:abc", "summary": "...", "touchedFiles": [], "nextStep": "...", "transcriptCursor": "512", "createdAt": "2026-11-17T03:00:00.000Z", "version": 1 }
```

- `transcriptCursor` 是写检查点时 transcript 末尾的字节偏移，handback 从这里读增量。
- 错误：`400 E_BAD_REQUEST`、`401`、`404`、`409 E_NO_LEASE`、`500 E_CHECKPOINT_FAILED`、`500 E_INTERNAL`。

### GET /api/cp/sessions/:key/checkpoint

无需租约。返回最新检查点（`Checkpoint` + `path`），没有则 `200 null`：

```json
{ "sessionKey": "claude:abc", "summary": "...", "touchedFiles": [], "nextStep": "...", "transcriptCursor": "512", "createdAt": "...", "version": 1, "path": "E:/.../handoffs/claude-abc.json" }
```

错误：`400`、`401`、`404 E_SESSION_NOT_FOUND`、`500 E_INTERNAL`。

### POST /api/cp/sessions/:key/handoff

请求体：

```json
{ "to": "human", "clientId": "pi:12345", "summary": "...", "touchedFiles": [], "nextStep": "..." }
```

- `to` ∈ `human` / `pi`，`clientId` 必填；三个 checkpoint 字段均可选。
- 必须持有租约。七步顺序：cancel（运行中）→ checkpoint → close → 拼接管命令 → 租约转交 → 注册表 `handoff` → `state_update`。
- 成功 `200`：

```json
{ "checkpoint": { }, "command": ["claude", "attach", "abc"], "mode": "attach" }
```

- 失败补偿：`500 E_CHECKPOINT_FAILED`（`details.action="checkpoint"`）、`503 E_HANDOFF_FAILED`（`details.step` = `cancel` / `close` / `handoff`）、`422 E_CAP_UNSUPPORTED` / `E_AGENT_UNAVAILABLE`（能力门禁）。
- 其他错误：`400`、`401`、`404`、`409 E_NO_LEASE` / `E_LEASE_CONFLICT`、`500 E_INTERNAL`。

### POST /api/cp/sessions/:key/handback

请求体：`{ "clientId": "pi:12345" }`。

- 从人类手里接回：resume → 按最新 checkpoint 的 `transcriptCursor` 读增量 → 注册表 `driver="pi"` / `status="idle"` → 租约转回 pi。
- 成功 `200`：`{ "resumed": true, "deltaSummary": "..." }`。
- resume 被拒：`409 E_RESUME_REJECTED`，会话状态与租约不变。
- 其他错误：`400`、`401`、`404`、`409 E_NO_LEASE`、`500 E_INTERNAL`。

## 6. 派发

### POST /api/cp/dispatch

请求体：

```json
{ "agent": "claude", "task": "修复登录", "idempotencyKey": "dispatch-1", "cwd": "E:/work" }
```

- `task` / `idempotencyKey` 必填；`agent` 可选，默认 `claude`；`cwd` 可选。
- 成功 `200`：`SessionRef`（新会话已登记并挂上事件管线）。
- 幂等：同一 `idempotencyKey` 重复调用只产生一个会话；参数不同返回 `409 E_IDEMPOTENCY_CONFLICT`，仍在进行返回 `409 E_DISPATCH_IN_PROGRESS`。
- 其他错误：`400`、`401`、`422 E_AGENT_UNAVAILABLE`、`500 E_INTERNAL`。

## 7. 事件流（WebSocket）

### GET /api/cp/ws

升级地址：`ws://127.0.0.1:7331/api/cp/ws?after=<seq>`。配置 token 时升级请求同样要 `Authorization: Bearer <token>`（不支持 query token）。

- 连接后服务端**先订阅再回放**：先按 seq 升序回放 `seq > after` 的存量事件，再补发订阅缓冲期内到达的新事件；重复事件由 `seq` 单调去重。
- 每帧为 JSON：

```json
{ "seq": 42, "sessionKey": "claude:abc", "type": "state_update", "payload": { "state": "idle" }, "source": "claude", "ts": "2026-11-17T03:00:00.000Z" }
```

- `type` ∈ `token` / `thought` / `tool_call` / `tool_result` / `permission_request` / `plan` / `state_update` / `session_status` / `needs_input` / `lease_changed` / `error` / `notice`。
- 回放跨重启：seq 由库分配并继续递增；客户端保存最后收到的 seq，重连时作为 `after`，不会丢事件也不会重复。

## 8. 审计

### GET /api/cp/audit

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

## 9. 资产清单

### GET /api/cp/assets

只读：读 `<home>/assets.json`，不回写 Agent 配置、不启动 MCP server、不做双向同步。成功 `200`：

```json
{
  "mcpServers": [ { "name": "filesystem", "transport": "stdio", "command": ["npx", "..."], "exists": true } ],
  "skills": [ { "name": "doc-tree", "path": "C:/Users/me/.dsh/skills/doc-tree", "exists": true } ],
  "memory": { "projection": "disabled" }
}
```

- 文件缺失 = 空清单（`mcpServers: []`、`skills: []`）。
- 错误：`400 E_ASSET_CONFIG_INVALID`（JSON 非法 / 结构不对）、`401`、`500 E_INTERNAL`。

## 10. 兼容性规则

- v1 内只新增可选字段或新端点；客户端必须忽略未知字段。
- 删除字段、收紧类型、改变既有字段语义，都必须新建 `/api/cp/v2` 并提供迁移说明。
- 本文件的机器可读真源是 `packages/shared/src/api.ts`；常量与运行时路由不一致时契约测试会失败。
