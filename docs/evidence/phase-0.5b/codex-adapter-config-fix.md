# Codex ACP 启动失败修复（2026-11-16）

## 症状

Pi 里执行 `cp_dispatch`，`agent=codex` 返回：

```text
E_AGENT_UNAVAILABLE: codex-acp 启动失败（adapter 状态 失败：adapter 已退出（子进程不可用：spawn npx ENOENT））
```

同一轮 `agent=claude` 正常启动。`GET /api/cp/agents` 仍显示 codex available，因为可用性探测只跑 `codex --version` 与 auth 文件，不启动 ACP adapter。

## 根因

`C:\Users\huang\.pi-workbench\config.yaml` 的 `codex.adapterCmd` 是早期自动生成的 npx 回落命令：

```yaml
codex:
  adapterCmd:
    - npx
    - -y
    - "@agentclientprotocol/codex-acp@2.6.0"
```

当时 codex-acp 包尚未安装。现在包已经安装在 pnpm store，但 Windows 的 `child_process.spawn("npx", ...)` 不会解析 `npx.cmd`，于是 `spawn npx ENOENT`。

## 修复

- `packages/control-plane/src/config.ts`：读取配置时，如果文件中的 adapter 命令仍等于旧 fallback（`npx -y ...`），而本地包已可解析，则改用本地入口 `[node, node_modules/.../codex-acp/dist/index.js]`，并把迁移结果回写 config.yaml。
- `packages/control-plane/src/adapters/claude.ts`：ACP 子进程 spawn 增加 `windowsHide: true`，避免后台 daemon 启动 Claude/Codex adapter 时弹控制台。
- `packages/control-plane/test/config.test.ts`：新增旧 npx 配置自动迁移用例。

## 验证

- `GET /api/cp/agents`：claude/codex/pi 均 available。
- `POST /api/cp/dispatch`，`agent=codex`：200，返回 `codex:01a1e42b-e49f-7df2-ae17-373432b25161`。
- 同一会话 transcript 4 条消息，assistant 原文回显 `CODEX_TRANSCRIPT_mwj73x8s`（含 reasoning + text），证明 adapter 启动、prompt、transcript 全链路可用。
- `pnpm -r build` 三包通过；control-plane 349 tests / 348 pass / 1 skip；extension 53 pass。

## 备注

旧的 config.yaml 已在迁移前备份为 `C:\Users\huang\.pi-workbench\config.yaml.bak-20261116-1945`。
