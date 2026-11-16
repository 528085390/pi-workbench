# Agent 权限模式：Codex Guardian 与 Claude 自动审批修复（2026-11-16）

## 症状

- Codex：Pi 里执行 `cp_dispatch agent=codex` 后，Codex 侧报：
  `guardian assessment was not valid JSON`。任务可能被自动审批环节 fail-closed 拦下。
- Claude：复合 PowerShell 命令曾被 Claude 的 `auto` 权限分类器拦截，需要拆成多条简单命令才能通过；
  用户希望两个 Agent 都使用完全权限，不再出现自动审批误判。

## 根因

### Codex

`@agentclientprotocol/codex-acp@2.6.0` 的默认 Agent 模式是 `Agent`：

- `approvalPolicy = "on-request"`
- `approvalsReviewer = "auto_review"`
- sandbox = `workspaceWrite`

即默认启用 Guardian 自动审批。当前 Codex provider（DeepSeek V4.1 Flash）输出的是散文式说明而不是
严格 JSON，Guardian 解析失败后按 fail-closed 拒绝，表现为 `guardian assessment was not valid JSON`。

### Claude

Claude ACP v2 的 `session/new` 不接受初始权限模式；claude-agent-acp 的
`resolveInitialPermissionMode` 会从 `~/.claude/settings.json` 的 `permissions.defaultMode` 取值，
但 `filterEscalatingDefaultMode` 会过滤掉仓库层/不可信层提供的 `bypassPermissions`。结果是设置文件里写了
`bypassPermissions`，实际会话仍是 `auto`（实测旧会话 transcript 中 `permissionMode:"auto"`）。
`auto` 用模型分类器判断权限，可能拦截复杂的复合命令。

## 修复

### 配置

`packages/control-plane/src/config.ts` 新增：

- `Config.claude.initialPermissionMode`：`default | acceptEdits | auto | bypassPermissions | dontAsk | plan`，
  默认 `auto`；
- `Config.codex.initialAgentMode`：`read-only | workspace-write | agent | agent-full-access`，
  默认 `workspace-write`；
- 环境变量 `PI_WORKBENCH_CLAUDE_INITIAL_MODE`、`PI_WORKBENCH_CODEX_INITIAL_MODE` 只覆盖运行值，不写回文件；
- 两个字段都会写入/读取 `config.yaml`，旧配置缺失时自动补默认值。

本机 `C:\Users\huang\.pi-workbench\config.yaml` 已设置：

```yaml
claude:
  initialPermissionMode: bypassPermissions
codex:
  initialAgentMode: agent-full-access
```

修改前备份：`C:\Users\huang\.pi-workbench\config.yaml.bak-202611161405`。

### Codex

- `packages/control-plane/src/adapters/codex-acp.ts` 启动 codex-acp 子进程时注入
  `INITIAL_AGENT_MODE = config.codex.initialAgentMode`。
- codex-acp 的 `agent-full-access` 模式实际为：
  `approvalPolicy="never"`、`approvalsReviewer="user"`、`sandboxPolicy={type:"dangerFullAccess"}`。
- 生产装配 `packages/control-plane/src/index.ts` 把配置传入 adapter；默认仍是较安全的
  `workspace-write`，本机显式用完全访问。

### Claude

- `packages/control-plane/src/adapters/types.ts` 的 `AdapterSpawnOptions` 新增
  `initialPermissionMode?`（仅 Claude adapter 使用）。
- `packages/control-plane/src/adapters/claude.ts`：
  - `newSession()` 与 `resume()` 成功后调用 `#applyInitialPermissionMode(sessionId)`；
  - 通过 ACP v2 的 `session/set_config_option` 发送
    `{ configId: "mode", type: "id", value: "bypassPermissions" }`；
  - 不依赖 `settings.json` 的 `permissions.defaultMode`，避免被 `filterEscalatingDefaultMode` 降级。
- `packages/control-plane/src/index.ts` 生产装配显式传
  `initialPermissionMode: config.claude.initialPermissionMode`。

## 验证

### 自动化

```text
pnpm --filter @pi-workbench/control-plane typecheck        exit 0
pnpm --filter @pi-workbench/control-plane test            359 tests / 358 pass / 1 skip / 0 fail
pnpm --filter @pi-workbench/extension test                53 pass / 0 fail
pnpm -r build                                             三包 Done
```

新增/更新的测试：

- `packages/control-plane/test/config.test.ts`：Claude/Codex 默认值、显式完全权限、非法值、环境变量覆盖。
- `packages/control-plane/test/adapter.test.ts`：Claude `newSession` 会发送 `session/set_config_option`。
- `packages/control-plane/test/codex-acp.test.ts`：codex-acp 子进程收到 `INITIAL_AGENT_MODE`。
- 所有 `Config` 字面量已补两个新字段。

### 真实 Codex

写操作（隔离 daemon `127.0.0.1:8412`）：

- 会话：`codex:01a1e4af-bd48-7a72-9f6c-f5f9b6f37d8a`
- 任务：用 `Set-Content` 写 `E:\pi-workbench\tmp\perm-check\codex-write-cuvo4kop.txt`
- 结果文件存在，内容 `CODEX_WRITE_cuvo4kop`，assistant 回复 `CODEX_WRITE_OK_cuvo4kop`
- 无 `guardian assessment` 错误。

删除操作：

- 会话：`codex:01a1e4af-28e0-74b1-b81a-0e25a4dfac47`
- 任务：删除 `E:\pi-workbench\tmp\perm-check\codex-guardian-cuvo4kop.txt`
- Codex 先尝试带 `-Force` 的复合 PowerShell，被 Codex 自身命令安全策略以
  `rejected: blocked by policy` 拒绝；随后用简单 `Remove-Item -LiteralPath ...` 成功。
- 最终 `Test-Path` 为 `False`，assistant 回复 `CODEX_PERM_OK_cuvo4kop`。
- 说明：这里的 `blocked by policy` 是 Codex CLI 对 `-Force`/复杂命令的内建安全规则，
  不是 Guardian JSON 错误，也不是 pi-workbench 的 ACP 权限失败。普通写入和简单删除在
  `agent-full-access` 下可执行。

### 真实 Claude

简单写操作：

- 会话：`claude:f750ddf1-88a8-4724-b267-f0070ecb3f28`
- transcript `permissionMode:"bypassPermissions"`
- 工具：`PowerShell Set-Content` 写 `claude-write-cuvo4kop.txt`
- 文件内容 `CLAUDE_WRITE_cuvo4kop`，assistant 回复 `CLAUDE_WRITE_OK_cuvo4kop`。

复合命令（专门验证不再被 auto 分类器拦截）：

- 会话：`claude:de025a35-d5b8-4f98-a68c-8e9b328a4706`
- 任务：用 `foreach` 循环把 `A`、`B` 写入 `claude-compound-cuvo4kop.txt`
- transcript `permissionMode:"bypassPermissions"`
- 文件内容 `A\r\nB`，assistant 回复 `CLAUDE_COMPOUND_OK_cuvo4kop`。

## 结论与边界

- Codex 的 Guardian 路径已关闭：默认 Agent 模式不再使用 `auto_review`，本机使用
  `agent-full-access`，真实写/删任务不再出现 Guardian JSON 错误。
- Claude 的自动分类器路径已绕过：会话显式 `bypassPermissions`，复合命令实际通过。
- Codex 仍保留自己的命令安全策略（例如 `Remove-Item -Force` 或某些复杂引号/脚本会被拒绝）；
  这是 Codex 产品层限制，不在 pi-workbench 的 ACP 权限范围内。若以后需要无限制破坏性命令，
  应单独评估 Codex CLI 的 `--dangerously-bypass-approvals-and-sandbox`，不要默认开启。
