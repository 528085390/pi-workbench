# Phase 0.5-B · Gate 证据（B08）

- 日期：2026-11-16
- 阶段：Phase 0.5-B / B08（三 Agent 统一接入）
- 分支 / commit：`feat/phase-0.5b-codex-pi`（E2E run `b17be07c` 采于 2026-11-16 15:58Z；Claude 严格回归 `15:56Z`；含 B08 评审修复、复审 P0-1/P1-1/P2-*、r4 P1/P2/P3 与 r5 收尾）
- 执行者：控制者（T1–T9 由子代理实施，控制者逐任务复验并补做 E2E）
- 结论：**七条全部 ✅ 通过** → Gate 0.5-B **通过**
- 原始产物目录：`docs/evidence/phase-0.5b/`

> 条目编号对应 spec `docs/specs/2026-11-16-phase-0.5b-codex-pi.md` §14；证据全部来自真实 `claude` / `codex` / `pi` 进程与真实 daemon，未使用 fixture 代替业务验收（单测中的 fixture 仅作 CI 级补充，见各条备注）。

## 1. 环境与版本

| 项 | 值 |
|---|---|
| OS | Windows 11（ConPTY） |
| Node | v24.16.0 |
| pnpm | 12.3.4 |
| Claude Code | 2.1.325 |
| codex-cli | 0.167.0 |
| Pi | 1.5.2（@earendil-works/pi-coding-agent） |
| @agentclientprotocol/codex-acp | 2.6.0（save-exact） |
| @agentclientprotocol/claude-agent-acp | 0.107.0 |
| @agentclientprotocol/sdk | 2.6.0 |
| fastify / @fastify/websocket | 5.12.8 / 11.3.7 |
| commit | E2E run `b17be07c` 采于 r4 修复工作树；r4/r5 修复见 `review-fixes-r4-2026-11-16.md` / `review-fixes-r5-2026-11-17.md`（最终 HEAD 见 `git log`） |

复现环境：

- 三 Agent E2E：`node scripts/e2e-three-agents.mjs`，脚本自起 daemon（随机端口），`PI_WORKBENCH_HOME=E:\pi-workbench\tmp\t9-e2e`，会话 cwd `tmp/t9-workspace`。
- Claude 回归：daemon 跑在 `127.0.0.1:8407`，`PI_WORKBENCH_HOME=E:\pi-workbench\tmp\t9-claude-home`，e2e 会话 cwd `tmp/t9-claude-workspace`。
- 单测/构建：`pnpm -r build` + `pnpm -C packages/control-plane test` + `pnpm -C packages/extension test`（EXIT=0；control-plane 367 tests / 366 pass / 1 skip，extension 58 pass）。

## 2. 七条总表

| # | 条目 | 结论 | 证据文件（行号） | 关键观测值 |
|---|---|---|---|---|
| 1 | Claude 0.5-A Gate 无回归 | ✅ | `claude-regression-run1.jsonl`；`claude-regression-run2.jsonl`；各 14 步的 `step=summary` 行 | 两轮各 14 步全 ok、exit 0、PASS；control-plane 367 tests / 366 pass / 1 skip / 0 fail；extension 58 pass |
| 2 | Codex rollout 发现 + 原生 id resume | ✅ | `e2e-three-agents.jsonl` 的 `step=discover`、`resume-by-native-id`、`inject`、`wait-turn`、`see` 行 | run=b17be07c；不在此复制易漂移数值 |
| 3 | Pi 经 RPC 打开；lease 拦第二写者 | ✅（provider 可用性条件已满足） | `e2e-three-agents.jsonl` 的 `step=pi-rpc-attach`、`pi-see`、`pi-lease-conflict`、`pi-dispatch` 行；`pi-rpc.md` §4 | run=b17be07c；不在此复制易漂移数值 |
| 4 | 三 Agent caps 正确；不支持能力不暴露 | ✅ | `e2e-three-agents.jsonl` 的 `step=agents`、`step=attach-422-codex` / `step=attach-422-pi` / `step=attach-422-claude-interactive`、`step=handoff-codex` / `step=handoff-pi` / `step=handoff-codex-driver`；`packages/control-plane/test/api-agents.test.ts` L732（P0-1 写路径） | `/agents` 三行 caps；`/attach` 对 codex/pi/claude(interactive) 均 422 `E_CAP_UNSUPPORTED`；handoff 对 codex/pi 200 返回 resume-tui；codex HTTP inject/interrupt/handoff/handback 在 pi:<pid> 租约下全 200（P0-1 单测，修复前 409） |
| 5 | 每 Agent 至少一条 handoff 或 resume 实测 | ✅（Pi 条件同上） | `e2e-three-agents.jsonl` 的 `step=handoff-codex` / `step=handoff-pi` / `step=handoff-codex-driver` / `step=handoff-pi-driver` | Claude handoff → `claude --resume <id>`；Codex resume-by-native-id + handoff；Pi handoff → `pi --session <abs file>`（handoff 前关闭 RPC，进程 2→1） |
| 6 | 事件统一渲染；未知事件不崩 | ✅（transcript 与事件流分别取证） | transcript：`step=unified-claude` / `unified-codex` / `unified-pi` / `unknown-event`；事件流：`step=events-claude` / `events-codex` / `events-pi` | 见 `e2e-three-agents.jsonl`（run=b17be07c） |
| 7 | 四类结构化错误 | ✅ | `e2e-three-agents.jsonl` 的 `step=lease-conflict-http` / `step=pi-lease-conflict`、`step=agent-unavailable` / `step=session-not-found` / `step=resume-rejected` | E_AGENT_UNAVAILABLE 422 / E_SESSION_NOT_FOUND 404 / E_LEASE_CONFLICT 409 / E_RESUME_REJECTED（cause: Internal error） |

## 3. 逐条细节

### Gate #1 · Claude 无回归

0.5-A 的九条闭环路径用**严格版 e2e**（`scripts/e2e-claude.mjs`）连续两轮复跑：

```text
round 1: exit 0 · PASS · 证据 `docs/evidence/phase-0.5b/claude-regression-run1.jsonl`（2026-11-16T15:56:00Z）
round 2: exit 0 · PASS · 证据 `docs/evidence/phase-0.5b/claude-regression-run2.jsonl`（2026-11-16T15:56:10Z）
```

两轮逐步骤结果（`docs/evidence/phase-0.5b/claude-regression-run1.jsonl` / `run2.jsonl`，各 14 行）：`start, health, dispatch, lease, see-ready, inject, see-inject, interrupt, checkpoint, handoff, human-turn, lease-handback, handback, summary` 全 `ok:true`；summary 行 `result:"PASS"`，handback 的 `deltaSummary` 含 `E2E_HUMAN_<nonce>` 回显，证明原生接管期间增量被接回。

会话建立耗时（JSONL 的 `start` → `dispatch` 时间差）：旧基线 09:46 run 为 1.891s；本次 run1 2.385s（adapter 冷启动）、run2 1.922s（热启动）；热启动与旧基线差 31ms，无显著回归。

单测与构建（`tmp/final-verify.log`）：

```text
control-plane: tests 367 / pass 366 / fail 0 / skipped 1
extension:     tests 58  / pass 58  / fail 0
pnpm -r build: 三包 Done（EXIT=0）
```

复现：

```powershell
# 终端 1（daemon）
$env:PI_WORKBENCH_HOME="E:\pi-workbench\tmp\t9-claude-home"; $env:PI_WORKBENCH_PORT="8407"
node --experimental-strip-types packages/control-plane/src/index.ts
# 终端 2（两轮）
$env:PI_WORKBENCH_URL="http://127.0.0.1:8407"; $env:PI_WORKBENCH_E2E_CWD="E:\pi-workbench\tmp\t9-claude-workspace"
node scripts/e2e-claude.mjs   # 连续执行两次
```

### Gate #2 · Codex 发现 + 原生 id resume

1. 造会话：`codex exec` 种子（`e2e-three-agents.jsonl` 的 `step=codex-exec-seed`，status 0）。
2. 发现：`step=discover` 行（run=b17be07c）——**经 HTTP `GET /api/cp/sessions/discover?agent=codex` 发现并登记**，不直接写库；只读 rollout 首行 `session_meta`，cwd 取 `payload.cwd`，默认只列 `thread_source=user`（缺失字段保留）。
3. 原生 id resume（driver 级）：`step=resume-by-native-id` / `step=inject` / `step=wait-turn` / `step=see` 行（run=b17be07c）。
4. 协议层细节（含 `session/resume` 请求/响应原始帧、`session/load` 在 ACP v2 返回 `-32601 Method not found` 的裁定）见 `codex-acp.md` §2–§3；`probe-findings.md` §5 证明 ACP `session/new` 会落 rollout，故新建会话的 `transcriptPath` 允许为空、由 `see` 懒解析。

### Gate #3 · Pi RPC 打开 + lease 双写拦截

- RPC attach：见 `step=pi-rpc-attach` 行（run=b17be07c）。
- 注入与读回：见 `step=pi-inject` / `pi-see` 行（run=b17be07c）。
- 第二写者：见 `step=pi-lease-conflict` 行（run=b17be07c；冲突发生在拉起客户端之前，进程数与 prompt 计数不变）。
- 产品出口：见 `step=pi-dispatch` 行（run=b17be07c；`POST /dispatch agent=pi` 200）。
- handoff 单写者：`step=handoff-pi-driver` 的 `rpcProcessesBefore:2 / After:1`，PiDriver.close 先断开自己的 RPC 子进程再交原生终端（B08 M1）。
- 驱动与 lease 细则见 `pi-rpc.md` §4（lease 硬约束：inject/interrupt/resume/handoff 触碰客户端前先 `LeaseManager.acquire` + `assertWriter`）。

### Gate #4 · caps 矩阵与能力门

`GET /api/cp/agents`（`step=agents`）三行：

| agent | available | version | stream | inject | interrupt | attach | resume | transcript | permissions | background |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | true | 0.107.0 | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| codex | true | 0.167.0 | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| pi | true | 1.5.2 | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |

能力门实测：

- `POST /api/cp/sessions/:key/attach`：codex 422（`step=attach-422-codex`，`details:{agent:"codex",cap:"attach"}`）、pi 422（`step=attach-422-pi`）、claude 交互式 422（`step=attach-422-claude-interactive`）——**未调用 driver**。
- `POST /api/cp/sessions/:key/handoff`：codex 200（`step=handoff-codex`，命令为 `codex resume <nativeId> --no-alt-screen`）；pi 200（`step=handoff-pi`，命令为 `pi --session <abs jsonl>`）。
- P0-1 写路径回归：`packages/control-plane/test/api-agents.test.ts` L732 用真实 CodexDriver + `pi:7` 租约，inject / interrupt / handoff / handback 全 200；修复前均在 ACP 请求前 409。

> 说明：spec §14 Gate #4 原措辞「对 attach 调 handoff 期望 422」与 §13「handoff 是分流」冲突，已按 §13 修正为**独立的 /attach 能力门**，并同步改了 spec 原文；handoff 对 codex/pi 是正常出口，不返回 422。

### Gate #5 · 每 Agent 一条 handoff / resume 实测

| Agent | 实测 | 证据 |
|---|---|---|
| Claude | handoff → `claude --resume`；随后 human-turn 与 handback 成功 | `claude-regression-run1/2.jsonl` 的 `step=handoff` / `human-turn` / `lease-handback` / `handback` 行 |
| Codex | driver 级 resume-by-native-id → inject → end_turn → see nonce；handoff 命令 | `e2e-three-agents.jsonl` 的 `step=resume-by-native-id` / `inject` / `wait-turn` / `see` / `handoff-codex-driver` 行（run=b17be07c） |
| Pi | handoff → `pi --session <abs jsonl>`；此前 RPC attach 与 HTTP dispatch 已实测 | `e2e-three-agents.jsonl` 的 `step=pi-handoff` / `pi-rpc-attach` / `pi-dispatch` 行（run=b17be07c） |

### Gate #6 · 统一渲染与未知事件

- `step=unified-claude`：7 条，shape `id,kind,role,text,ts`。
- `step=unified-codex`：3 条；`step=unified-pi`：3 条；shape 同上。
- 未知事件 fixture（人为塞入未知 `type`/坏的 payload 行）：`step=unknown-events` 正常返回 2 条（`UNKNOWN_EVENT_USER` / `UNKNOWN_EVENT_OK`），未抛错、未中断游标。
- **事件流**：见 `e2e-three-agents.jsonl` 的 `step=events-claude` / `events-codex` / `events-pi` 行（run=b17be07c）。三 Agent 的事件都经 `EventPipeline.attach(source)` 落到同一个 `SessionEvent` 形状——B08 M2 修复前 codex/pi 只声明 `stream:true` 却无人订阅，本表把「transcript」与「事件流」分开取证。
- 解析器口径：`codex-records.md` §2/§4（23 种 type|payload.type 枚举、developer 角色跳过、reasoning 取 summary）、`pi-records.md` §1–§3（21 文件 / 404 记录 / 0 坏行，custom_message 未知类型不抛）。

### Gate #7 · 四类结构化错误

| 场景 | 证据 | 状态码与错误码 |
|---|---|---|
| adapter / agent 不存在 | `step=agent-unavailable` | 422 `E_AGENT_UNAVAILABLE`（agent `t9-no-such-agent`） |
| 会话不存在 | `step=session-not-found` | 404 `E_SESSION_NOT_FOUND`（`claude:t9-missing-b17be07c`） |
| lease 冲突 | `step=lease-conflict-http` / `step=pi-lease-conflict` | 409 `E_LEASE_CONFLICT`（`heldBy:"t9-b17be07c"`；driver 级 `newProcesses=0`） |
| resume 被拒 | `step=resume-rejected` | `E_RESUME_REJECTED`（`cause:"resume 被 agent 拒绝：Internal error"`，`details.sessionId=00000000-…`） |

## 4. 偏差与说明

1. **证据文件命名**：spec §14 拟名（`codex-discover-resume.json`、`caps-matrix.json`、`attach-422.json` 等）在实际执行中合并为一条端到端流水 `e2e-three-agents.jsonl`（65 行，每行 `{ts,phase,step,ok,detail}`），Gate #1 单独用两轮 `claude-regression-run*.jsonl`；映射见上表 step 引用。
2. **Codex 会话发现数量**：来自本机 30 天窗口内的 rollout（含历史会话），不是只有本次 seed；这正是「发现」要验证的能力。
3. **Pi attach 语义**：caps.attach 保持 false（打开同一会话文件 ≠ 接管运行中进程），spec §9/§10 已按实测修订；`/attach` 对 Pi 的 422 是预期行为，不是缺陷。
4. **未覆盖项**：Codex 运行中 ACP resume 的 quiesce 路径目前只有单测（cancel→idle→resume，15s 超时）；实测的是 idle 会话按原生 id resume。实验记录在 `probe-findings.md` §附。Pi `new_session` 已由 `step=pi-dispatch` 的真实 `POST /dispatch agent=pi` 覆盖。
5. **测试与构建**：单测/构建在当前 r5 收尾工作树执行（control-plane 367 tests / 366 pass / 1 skip / 0 fail，extension 58 pass，`pnpm -r build` 三包 Done）；三 Agent E2E run `b17be07c` 采于 r4 修复工作树，Claude 严格回归两轮采于当前工作树。
6. **评审修复（B08）**：`docs/reviews/2026-11-16-phase-0.5b-review.md` 的 M1–M4 与 S1–S6 已修，逐条记录见 `review-fixes-2026-11-16.md`。复审 `docs/reviews/2026-11-16-phase-0.5b-review-final.md` 的 P0-1/P1-1/P2-1/P2-2/P2-3/P3-1 也已修复，记录见 `review-fixes-final-2026-11-16.md`。r4 的 P1/P2/P3 已全部处理：Claude 严格回归两轮已重跑（`claude-regression-run1/2.jsonl`，各 14 步 PASS），本文件的易漂移数值已改为按 run/step 引用。r5 收尾：Gate #4/#5/#7 的行号引用已全部改为 `step=`，P2-1 缓存补 3 条测试（367/366）。

## 5. 复现命令汇总

```powershell
# 构建 + 全量单测
pnpm -r build
pnpm -C packages/control-plane test
pnpm -C packages/extension test

# 三 Agent 端到端（自动起 daemon、清 home、写 evidence jsonl）
node scripts/e2e-three-agents.mjs

# Claude 严格回归两轮（见 §3 Gate #1 的 daemon 环境）
node scripts/e2e-claude.mjs   # 跑两次
```

## 6. 结论

七条 Gate 全部满足：Claude 无回归（两轮 PASS + 367 单测）、Codex 原生 id resume、Pi RPC + lease 双写拦截、三 Agent caps 与能力门、每 Agent 至少一条 handoff/resume、统一 transcript 与事件流渲染、未知事件容错、四类结构化错误。**Gate 0.5-B 通过**，可进入 0.5-C 或按计划收尾合并；遗留项见 §4 第 4 条与 spec §18。