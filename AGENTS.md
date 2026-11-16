---
id: pi-workbench
parent: global
summary: Pi Agent 工作台：Pi 控制面、Claude/Codex/Pi 会话接管、记忆与知识库
when: 开发 Pi Workbench、改控制面或扩展、查阶段证据与技术假设时
updated: 2026-11-17
---

# AGENTS.md — Pi Workbench

> 本工作区是 Pi Workbench 的开发根，不是 Pi 的 fork。全局 pi 保持原位，本工作区只开发 Pi 扩展和控制面。
> 当前状态：Phase 0.5-A、0.5-B Gate 已通过；下一步 Phase 0.5-C（控制面硬化）。

## 先读哪份

| 你要做的事 | 读这个 |
|---|---|
| 看需求、决策、FR 和分期 | [docs/PRD.md](docs/PRD.md) 第 0、3、7 节 |
| 看 Phase 0 技术假设与能力矩阵 | [docs/技术假设验证-2026-11-14.md](docs/技术假设验证-2026-11-14.md) |
| 看 Phase 0.5-A 九条 Gate 证据 | [docs/evidence/phase-0.5a-gate.md](docs/evidence/phase-0.5a-gate.md) |
| 看 Phase 0.5-B 七条 Gate 证据 | [docs/evidence/phase-0.5b-gate.md](docs/evidence/phase-0.5b-gate.md) |
| 看开发顺序、阶段目标和进入下一阶段的条件 | [docs/开发顺序与阶段门禁.md](docs/开发顺序与阶段门禁.md) |
| 看 A-prime 控制面方案与 ACP v2 取舍 | [docs/agent-control-plane-v0.3.md](docs/agent-control-plane-v0.3.md) |
| 看早期选型、市场扫描和复用评估 | [docs/方案评估与落地建议.md](docs/方案评估与落地建议.md) |
| 改控制面代码 | [packages/control-plane/src/index.ts](packages/control-plane/src/index.ts)、[packages/control-plane/src/server.ts](packages/control-plane/src/server.ts) |
| 改 Pi 扩展 | [packages/extension/src/index.ts](packages/extension/src/index.ts)、[packages/extension/pi-workbench.plugin.ts](packages/extension/pi-workbench.plugin.ts) |
| 跑三 Agent E2E | [scripts/e2e-three-agents.mjs](scripts/e2e-three-agents.mjs) |
| 复现 Claude 闭环 | [scripts/e2e-claude.mjs](scripts/e2e-claude.mjs) |

## 目录

- packages/control-plane/：控制面 daemon。SessionRegistry、LeaseManager、EventPipeline、Claude/Codex/Pi driver、REST/WS。
- packages/extension/：Pi 扩展。cp_* 工具、daemon 唤醒、通知。
- packages/shared/：跨包类型和协议。
- scripts/：E2E、启动、验证脚本。
- docs/：PRD、方案、specs、reviews、evidence。
- spike/acp-probe/：Phase 0 验证工具，只作证据，不是产品代码。
- scratch/、tmp/：临时产物；不要当入口，不要把正式文档放进去。

## 当前状态

- Phase 0：技术假设验证完成，报告见 docs/技术假设验证-2026-11-14.md。
- Phase 0.5-A：Claude 单 Agent 闭环 9/9 Gate 通过；证据见 docs/evidence/phase-0.5a-gate.md。
- Phase 0.5-B：Claude/Codex/Pi 三 Agent 统一接入 7/7 Gate 通过；证据见 docs/evidence/phase-0.5b-gate.md。
- 当前下一步：Phase 0.5-C，先做重启恢复、幂等、租约/进程治理和 API 冻结。
- Phase 1 Web 控制台在 0.5-C Gate 通过前不要开始。
- 环境：Windows 11、Node 24.16、pnpm 12.3.4、Pi 1.5.2、Claude Code 2.1.325、Codex 0.167.0。
- Pi 默认模型：zz/deepseek-v4.1-flash（本地 127.0.0.1:7864）。

## 红线

1. 不改全局 Pi 安装目录，不把 Pi 源码搬进本工作区；扩展用 peerDependency 和 pi -e 加载。
2. 不生成文档备份（.bak）；需要对比或回滚用 git 历史。
3. 任何 inject / interrupt / handoff / resume 必须先持有租约；单会话单 driver。
4. 原生 transcript 只读，控制面绝不改写 Claude/Codex/Pi 的会话文件。
5. 未实测的 SessionCaps 不注册工具、不在 UI 显示按钮。
6. 控制面默认只监听 127.0.0.1:7331；不要新增公网端口，远程访问走 Tailscale + token。
7. spike/ 是验证代码，不是产品入口；不要把临时脚本接到正式流程。
8. DSH 不是 MCP Server；DSH 接入后置，不阻塞主线。

## 验证

    pnpm -r build
    pnpm -C packages/control-plane test
    pnpm -C packages/extension test
    node scripts/e2e-claude.mjs
    node scripts/e2e-three-agents.mjs

E2E 会启动真实 claude / codex / pi 进程；先确认对应 CLI 已登录、Pi provider 可用。

## 上级

全局入口：C:/Users/huang/.dsh/AGENTS.md

