# C03 handoff 往返证据（handoff-roundtrip）

- 运行时间：2026-11-17 03:46:30–03:46:42（CST）；单元层 03:52
- 环境：Windows 11 / Node v24.16.0 / Claude Code 2.1.325
- 分支与基线：`feat/phase-0.5c-control-plane-hardening` @ `769ede5`
- 规格：spec §7.3；计划 Task 8 / Task 14
- 工件：`e2e-claude-20261117-0346.jsonl`（真 Claude 闭环）、`control-plane-test-20261117-0352.txt`

## 命令

```bash
# daemon：PI_WORKBENCH_HOME=tmp/t14-claude-home，PI_WORKBENCH_PORT=8407
PI_WORKBENCH_URL=http://127.0.0.1:8407 node scripts/e2e-claude.mjs
```

## 结果（真 Claude，PASS）

14 个步骤全 `ok=true`，summary `{"result":"PASS"}`；handoff 段原样输出：

```json
{"step":"checkpoint","ok":true,"detail":"... transcriptCursor 211015, version 1, path ...\\handoffs\\claude-ce6f92cc-...-1.md"}
{"step":"handoff","ok":true,"detail":"{\"mode\":\"resume-tui\",\"command\":\"claude --resume ce6f92cc-9efb-4d3c-9810-a63c3bca0257\"}"}
{"step":"human-turn","ok":true,"detail":"{\"status\":0,\"sample\":\"E2E_HUMAN_55acf38d\"}"}
{"step":"handback","ok":true,"detail":"{\"resumed\":true,\"deltaSummary\":\"assistant: No response requested.\\nuser: 回答E2E_HUMAN_55acf38d\\nassistant: E2E_HUMAN_55acf38d\"}"}
```

即：checkpoint（v1、游标 211015）→ handoff 交人类（`claude --resume <nativeId>`）→ 原生 claude 完成人类回合 → handback 恢复并返回 deltaSummary，人类回合 nonce `E2E_HUMAN_55acf38d` 出现在增量里（上下文连续）。

## 两次往返（连续 handoff → native → resume）

- `takeover.test.ts`：`handoff/handback 两次往返：第三次 checkpoint 游标严格前进，see 能读到人类回合（spec §7.3）` ✔
- `takeover.test.ts`：`handback: 真重启（全新 store/registry/leases + loadFromDb）仍用库里 checkpoint 的游标读增量，不报 E_SESSION_NOT_FOUND` ✔
- `e2e-three-agents`（C07）里 Claude 腿同样跑了 dispatch→checkpoint→handoff→原生 human-turn→handback，`deltaSummary` 含人类回合 nonce。

## 已知限制

- handoff 只能把控制权交给人类/原生 TUI，不承诺"原生进程复活"；原生会话被丢弃时返回结构化 `E_RESUME_REJECTED`。
- Claude interactive `attach=false`，handoff 用 `--resume` 而非 attach 模式。
