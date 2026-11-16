# Phase 0.5-B r4 复审修复记录

日期：2026-11-16
报告：`docs/reviews/2026-11-16-phase-0.5b-review-r4.md`
结论：报告中的 P1-1 / P1-2 已处理；P2-1 / P2-2 / P2-3 已修复；P3-1 / P3-2 / P3-3 已补注释或类型检查。

## P1-1 证据漂移

- `docs/evidence/phase-0.5b-gate.md` 已改为按 **run + step** 引用，不再抄录容易漂移的计数、session id、耗时和 nonce。
- 当前 E2E 证据 run：`b17be07c`；`e2e-three-agents.jsonl` 中按 `step=discover`、`resume-by-native-id`、`pi-rpc-attach` 等行查阅。
- 单测计数已更新为当前值（见下）。

## P1-2 Claude 严格回归

在本轮代码改动之后重新跑了两轮：

| 轮次 | 时间（UTC） | nonce | 结果 | 证据 |
|---|---|---|---|---|
| 1 | 2026-11-16T15:56:00Z | b655b501 | PASS，14 步全 ok | `claude-regression-run1.jsonl` |
| 2 | 2026-11-16T15:56:10Z | 72558495 | PASS，14 步全 ok | `claude-regression-run2.jsonl` |

两轮均覆盖 health → dispatch → lease → see → inject → interrupt → checkpoint → handoff → human-turn → handback → summary；每次 `summary.result=PASS`。

会话建立耗时（JSONL 的 `start` → `dispatch` 时间差）：旧基线 09:46 run 为 1.891s；本次 run1 2.385s（adapter 冷启动）、run2 1.922s（热启动）；热启动与旧基线差 31ms，无显著回归。

## P2-1 列表触发重复发现扫描

`TakeoverEngine.refreshTranscriptPath` 增加：

- 同一会话并发解析 single-flight；
- 非 `running` / `starting` 会话的解析失败负缓存 30s；
- 解析成功后清除负缓存。

这样列表和通知周期不会对同一个永久解析不出来的 Codex 会话反复做全量 rollout 扫描，同时不会把刚创建、rollout 尚未落盘的新会话误缓存。

## P2-2 resume 重置权限模式

`ClaudeAdapter.resume` 不再调用 `#applyInitialPermissionMode`；权限模式只在 `newSession` 时设置。handoff 后人类在原生 TUI 里改过的模式在 handback 时会被保留，不再被 daemon 静默覆盖。新增回归测试：

`packages/control-plane/test/adapter.test.ts` → “resume 不重置 initialPermissionMode（保留 handoff 期间的人类设置）”。

Codex 的 `INITIAL_AGENT_MODE` 仍由 adapter 进程启动环境控制；该值不是逐 session 的 resume 参数。

## P2-3 插件入口类型检查

- 新增 `packages/extension/tsconfig.plugin.json`（`rootDir: "."`，include 插件入口、`src/**/*.ts` 和最小 Pi API 声明）。
- 新增 `packages/extension/types/pi-coding-agent.d.ts`，只声明插件实际使用的 `ExtensionAPI` 表面；真实 Pi 包安装在本机全局，不把机器路径写进仓库。
- `packages/extension/package.json` 的 `typecheck` 现在同时跑 `tsconfig.json`、`tsconfig.test.json`、`tsconfig.plugin.json`。`pnpm --filter @pi-workbench/extension typecheck` 通过。

## P3

- P3-1：`codex-acp.ts` 注明 `initialPermissionMode: "auto"` 只是 ClaudeAdapter 配置形状，Codex 沙箱/审批由 `INITIAL_AGENT_MODE` 控制。
- P3-2：`child-process.ts` 头注释写明静态 import 的 `claude.ts` 显式传 `windowsHide`、动态 import 的 Pi RpcClient 依赖全局 patch。
- P3-3：`TurnNotifier.consecutiveWakes` getter 注释注明读取会触发过期窗口归零。

## 验证

- `pnpm -r build`：三包 Done。
- `pnpm --filter @pi-workbench/control-plane typecheck`：通过。
- `pnpm --filter @pi-workbench/extension typecheck`：通过（包含 plugin 入口）。
- control-plane：**364 tests / 363 pass / 1 skip / 0 fail**。
- extension：**58 pass / 0 fail**。
- 三 Agent E2E：PASS（run `b17be07c`，证据 `e2e-three-agents.jsonl`，2026-11-16T15:58Z，r4 修复工作树）。
- Claude 严格回归：两轮 PASS（见上表）。