# Codex ACP 驱动与原生 handoff 出口（0.5-B B03 证据）

- 日期：2026-11-16
- 分支：`feat/phase-0.5b-codex-pi`
- 任务：T5 / B03（Codex ACP 驱动 + 原生 handoff 出口）
- 实现：`packages/control-plane/src/agents/codex-driver.ts`、`packages/control-plane/src/adapters/codex-acp.ts`
- 单测：`packages/control-plane/test/codex-driver.test.ts`（假 ACP server，不依赖真实 codex）
- 夹具：`packages/control-plane/test/fixtures/fake-codex-acp-agent.mjs`

## 1. 安装与版本

安装命令（只改 control-plane 的 package.json，锁精确版本）：

~~~powershell
pnpm --filter @pi-workbench/control-plane add @agentclientprotocol/codex-acp@2.6.0 --save-exact
~~~

实测版本：

| 包 / 命令 | 版本 | 备注 |
|---|---|---|
| `@agentclientprotocol/codex-acp` | `2.6.0` | package.json 写死 `2.6.0`，pnpm-lock.yaml 一并提交 |
| `@agentclientprotocol/sdk` | `2.6.0` | control-plane 直接依赖；v2 experimental API |
| `@openai/codex`（传递依赖） | `0.166.0` | codex-acp 自带，约 180 MB |
| `codex --version` | `codex-cli 0.167.0` | 本机 PATH 的 CLI，用于原生 handoff 的最终执行方 |

解析出的 adapter 入口：

```text
E:\pi-workbench\node_modules\.pnpm\@agentclientprotocol+codex-acp@2.6.0\node_modules\@agentclientprotocol\codex-acp\dist\index.js
```

## 2. ACP 握手实测（initialize / session/new / session/resume / session/close）

实测方式：在 `packages/control-plane` 下用一次性的 Node ESM 探针直接起真实 codex-acp；
`spawnSync` 超时 `120000ms`，子进程环境带 `TERM=xterm-256color`。

请求参数摘要：

| 方法 | 请求 params |
|---|---|
| `initialize` | `{ protocolVersion: 2, info: { name: "pi-workbench-control-plane", version: "0.5.0" } }` |
| `session/new` | `{ cwd: "E:\\pi-workbench\\spike\\workspace" }` |
| `session/resume` | `{ sessionId: "01a1d7c5-8568-73e2-b75f-ef912b042c4c", cwd: "E:\\pi-workbench\\spike\\workspace" }` |
| `session/close` | `{ sessionId: "<session/new 返回的 id>" }` |

响应摘要：

| 方法 | 响应 |
|---|---|
| `initialize` | `protocolVersion=2`；`info={ name:"@agentclientprotocol/codex-acp", title:"Codex", version:"2.6.0" }`；`capabilities` 顶层键 `session`、`auth`；`authMethods=[api-key, chat-gpt]`；`_meta.steering.supported=true` |
| `session/new` | `sessionId="01a1e307-3083-7130-9bf0-dc1a471f3586"`；`configOptions` 4 项（mode / collaboration_mode / model / reasoning_effort） |
| `session/resume` | 成功 result，键为 `configOptions`、`availableCommands`；`configOptionsCount=4`、`availableCommandsCount=29`。响应本身**不带** `sessionId` 或 `resumed` 布尔字段；成功以 JSON-RPC result 为准 |
| `session/close` | `{}`（成功空对象） |

`session/load` 说明：codex-acp v2 没有注册这个方法。实测发送：

~~~json
{ "method": "session/load", "params": { "sessionId": "01a1d7c5-8568-73e2-b75f-ef912b042c4c", "cwd": "E:\\pi-workbench\\spike\\workspace" } }
~~~

返回：

~~~json
{ "code": -32601, "message": "\"Method not found\": session/load", "data": { "method": "session/load" } }
~~~

因此本驱动按规格 §8/§13 走 v2 的 `session/resume(threadId)`，不调用 `session/load`。

## 3. 按原生 thread id resume 成功证据

测试线程（A8 已确认的原生 rollout）：

```text
threadId = 01a1d7c5-8568-73e2-b75f-ef912b042c4c
cwd      = E:\pi-workbench\spike\workspace
rollout  = C:\Users\huang\.codex\sessions\2026\11\14\rollout-2026-11-14T09-56-48-01a1d7c5-8568-73e2-b75f-ef912b042c4c.jsonl
```

用 `CodexDriver`（默认 `resolveDefaultCodexAdapterCmd()`）实测；Node 脚本内 `spawnSync` 超时 `180000ms`：

~~~powershell
node --experimental-strip-types --input-type=module -e "<T5 原生 resume 探针>"
~~~

探针核心步骤：`new CodexDriver(config, { cwd })` → `driver.resume(ref)` →
`driver.inject(ref, "Reply with exactly RESUME_PROMPT_OK and do not modify any files.")` →
`driver.waitForTurn(ref, 120000)` → `driver.see(ref, "0", 20)`。

实测输出：

~~~json
{
  "nativeId": "01a1d7c5-8568-73e2-b75f-ef912b042c4c",
  "injected": {
    "messageId": "e43d07a8-9cb0-499e-9b27-f3c685d59670",
    "effective": "now"
  },
  "turn": { "stopReason": "end_turn" },
  "text": "RESUME_PROMPT_OK",
  "elapsedMs": 3658,
  "seeMessages": 14,
  "seePending": false,
  "updates": 9
}
~~~

结论：

- `session/resume` 接受了原生 thread id，没有新建 thread；
- 随后 `session/prompt` 在同一 thread 上完成回合，返回文本 `RESUME_PROMPT_OK`；
- `transcriptPath` 懒解析命中真实 rollout（见上一行路径），`see` 读取 14 条消息且 `pending=false`；
- handoff 仍返回原生命令，不依赖 ACP 进程存活（本用例在 `dispose` 前直接取命令）：

~~~json
{
  "command": ["codex", "resume", "01a1d7c5-8568-73e2-b75f-ef912b042c4c", "--no-alt-screen"],
  "mode": "resume-tui"
}
~~~

## 4. caps 与 handoff 口径

`capsOf("codex")` 实测：

~~~json
{"stream":true,"inject":true,"interrupt":true,"attach":false,"resume":true,"transcript":true,"permissions":false,"background":false}
~~~

- `attach`：Codex 没有 attach 语义，`CodexDriver.attach()` 明确抛 `E_CAP_UNSUPPORTED`，不产生子进程；
- `permissions` / `background`：未声明，路由层不得暴露；
- handoff：`["codex","resume",threadId,"--no-alt-screen"]`，`mode="resume-tui"`，只拼命令不执行；
  执行侧（T8 / 终端）需设置 `TERM=xterm-256color`，这是 TUI 正常渲染的前提。

## 5. 失败码映射

单测用 `fake-codex-acp-agent.mjs` 注入故障，覆盖：

| 场景 | 触发方式 | 对外错误码 | 测试 |
|---|---|---|---|
| adapter 起不来 / initialize 前退出 | `--fail-init`（stderr + exit 1） | `E_AGENT_UNAVAILABLE` | `adapter 起不来 → E_AGENT_UNAVAILABLE` |
| `session/resume` 被 agent 拒绝 | `--fail-resume` 返回 JSON-RPC `-32000` | `E_RESUME_REJECTED` | `resume 被 agent 拒绝 → E_RESUME_REJECTED` |
| 运行中 cancel 后一直不 idle | `--hang-cancel` + 注入短 quiesce 窗口 | `E_RESUME_REJECTED`（`reason=quiesce_timeout`） | `运行中 cancel 超时 → E_RESUME_REJECTED` |
| adapter 子进程已退出 | 任意后续 RPC | `E_ADAPTER_DOWN` 原样透传 | adapter 既有用例 + 驱动透传分支 |
| 无写租约 | `authorizeWrite` 抛 `E_NO_LEASE` | `E_NO_LEASE`，且 **0 个 ACP 请求 / 0 次 spawn** | `inject 无 lease 时不 spawn adapter、不发 prompt` |
| Codex 不支持 attach | `driver.attach()` | `E_CAP_UNSUPPORTED`，不 spawn | `attach 明确拒绝（caps.attach=false），不 spawn adapter` |
| 发现 / transcript 模块未就绪 | 动态 import 失败 | `E_AGENT_UNAVAILABLE`（含模块名） | 由默认路径集成用例覆盖已就绪场景 |

约定：驱动不把 `E_RESUME_REJECTED` 静默降级成新会话；运行中 resume 必须先 cancel 等 idle，
超时直接失败（规格 §8 的保守策略）。

## 6. 单测（CI 级，不依赖真实 codex）

命令（测试进程由 `spawnSync` 启动，超时 `180000ms`）：

~~~powershell
cd packages/control-plane
node --test --experimental-strip-types test/codex-driver.test.ts
~~~

结果：`22 tests / 22 pass / 0 fail`，覆盖：

- caps 与 `capsOf("codex")` 一致；
- `resume` 的 ACP 请求顺序：`initialize` → `session/resume`，且 `sessionId` / `cwd` 为原生 id；
- `inject` 走 `session/prompt` 并收到 text update；
- `newSession` 返回 thread id；
- `--fail-resume` → `E_RESUME_REJECTED`；
- `--fail-init` → `E_AGENT_UNAVAILABLE`；
- 运行中 resume 先 cancel 再 resume（含本进程未驱动过的 running ref）；
- cancel 超时 → `E_RESUME_REJECTED`；
- 无租约时 0 spawn / 0 prompt；
- `inject` 的 `effective` 语义（idle=now，running=next_turn）；
- `interrupt` 委托 `session/cancel`；
- handoff 命令形状且不 spawn；
- `attach` 拒绝；
- `see` 无 transcriptPath 返回空页 + `pending:true`；
- `see` 有路径走 T4 `readTranscript`；
- `resolveTranscriptPath` 懒解析后可读；
- `discover` 透传 `sessionsRoot/cwd/limit`；
- 默认接入 T3 `discoverCodexSessions` 与 T4 `readTranscript`（真实 fixture）；
- `newSession` 后 inject 不重复 resume；
- spawn 前订阅 `onUpdate` 能收到 update；
- `dispose` 幂等。

## 7. 已知边界 / 后续任务

- **T8 需要处理**：`packages/control-plane/src/index.ts` 目前只注册 `ClaudeAdapter` / Claude 驱动；
  T5 被禁止改 `src/index.ts`、`src/server.ts`、`src/takeover.ts`，因此 `CodexDriver` 的注册与路由接线
  （以及 `newSession/waitForTurn/close` 的 dispatch / takeover 调用）留给 T8。
- transcript 懒解析依赖 T3 的 `discover/codex.ts` 与 T4 的 `transcript/index.ts`；两者已存在时默认路径可用，
  缺失时 `see` 按 `pending:true` 返回，不报错。ACP 全新会话刚创建时 rollout 可能尚未落盘，属于规格 §7.1 的允许窗口。
- `session/resume` 成功响应没有显式 `resumed` 字段；本驱动以 JSON-RPC 成功作为恢复成功，不伪造该字段。
- 真实 codex-acp 联调是手动证据，不进 CI；CI 只跑假 ACP server。
