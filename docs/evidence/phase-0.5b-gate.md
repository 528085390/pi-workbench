# Phase 0.5-B · Gate 证据（B08）

- 日期：2026-11-16
- 阶段：Phase 0.5-B / B08（三 Agent 统一接入）
- 分支 / commit：`feat/phase-0.5b-codex-pi`（Gate 证据采于 `92edc27`；本文档在其后补写）
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
| commit | `92edc27`（branch `feat/phase-0.5b-codex-pi`） |

复现环境：

- 三 Agent E2E：`node scripts/e2e-three-agents.mjs`，脚本自起 daemon（随机端口，本次 127.0.0.1:38848），`PI_WORKBENCH_HOME=E:\pi-workbench\tmp\t9-e2e`，会话 cwd `tmp/t9-workspace`。
- Claude 回归：daemon 跑在 `127.0.0.1:8407`，`PI_WORKBENCH_HOME=E:\pi-workbench\tmp\t9-claude-home`，e2e 会话 cwd `tmp/t9-claude-workspace`。
- 单测/构建：`pnpm -r build` + `pnpm -C packages/control-plane test` + `pnpm -C packages/extension test`，日志 `tmp/final-verify.log`（EXIT=0）。

## 2. 七条总表

| # | 条目 | 结论 | 证据文件（行号） | 关键观测值 |
|---|---|---|---|---|
| 1 | Claude 0.5-A Gate 无回归 | ✅ | `claude-regression-run1.jsonl` 1–14；`claude-regression-run2.jsonl` 1–14；`tmp/final-verify.log` 341–408 | 两轮各 14 步全 ok、exit 0、PASS；control-plane 332 tests / 331 pass / 1 skip / 0 fail；extension 53 pass |
| 2 | Codex rollout 发现 + 原生 id resume | ✅ | `e2e-three-agents.jsonl` L3、L5、L44–L47 | discover 15 条（`codex:01a1e34b-8a8c-74c2-8567-f5645d2a22d9`）；resume-by-native-id 1510ms；inject → end_turn；see 6 条含 `T9_CODEX_RESUME_dac57517` |
| 3 | Pi 经 RPC 打开；lease 拦第二写者 | ✅ | `e2e-three-agents.jsonl` L50–L53；`pi-rpc.md` §4 | RPC attach 1720ms；inject/see 5 条；第二客户端 409 `E_LEASE_CONFLICT`，`newProcesses=0`、`before=after=2` |
| 4 | 三 Agent caps 正确；不支持能力不暴露 | ✅ | `e2e-three-agents.jsonl` L11–L13、L32、L36、L41 | `/agents` 三行 caps；`/attach` 对 codex/pi/claude(interactive) 均 422 `E_CAP_UNSUPPORTED`；handoff 对 codex/pi 200 返回 resume-tui |
| 5 | 每 Agent 至少一条 handoff 或 resume 实测 | ✅ | `e2e-three-agents.jsonl` L27、L44、L48、L54 | Claude handoff → `claude --resume <id>`；Codex resume-by-native-id + handoff；Pi handoff → `pi --session <abs file>` |
| 6 | 事件统一渲染；未知事件不崩 | ✅ | `e2e-three-agents.jsonl` L14–L16、L31 | 三 Agent shape 均为 `id,kind,role,text,ts`；未知 type fixture 正常返回 2 条 |
| 7 | 四类结构化错误 | ✅ | `e2e-three-agents.jsonl` L40、L56–L58 | E_AGENT_UNAVAILABLE 422 / E_SESSION_NOT_FOUND 404 / E_LEASE_CONFLICT 409 / E_RESUME_REJECTED（cause: Internal error） |

## 3. 逐条细节

### Gate #1 · Claude 无回归

0.5-A 的九条闭环路径用**严格版 e2e**（`scripts/e2e-claude.mjs`）连续两轮复跑：

```text
round 1: exit 0 · PASS · 证据 tmp/e2e-2026-11-16T07-41-26-719Z.jsonl
round 2: exit 0 · PASS · 证据 tmp/e2e-2026-11-16T07-41-35-485Z.jsonl
```

两轮逐步骤结果（`docs/evidence/phase-0.5b/claude-regression-run1.jsonl` / `run2.jsonl`，各 14 行）：`start, health, dispatch, lease, see-ready, inject, see-inject, interrupt, checkpoint, handoff, human-turn, lease-handback, handback, summary` 全 `ok:true`；summary 行 `result:"PASS"`，handback 的 `deltaSummary` 含 `E2E_HUMAN_<nonce>` 回显，证明原生接管期间增量被接回。

单测与构建（`tmp/final-verify.log`）：

```text
control-plane: tests 332 / pass 331 / fail 0 / skipped 1
extension:     tests 53  / pass 53  / fail 0
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

1. 造会话：`codex exec` 种子（`e2e-three-agents.jsonl` L3，status 0）。
2. 发现：L5 `{"count":15,"key":"codex:01a1e34b-8a8c-74c2-8567-f5645d2a22d9"}`——只读 rollout 首行 `session_meta`，cwd 取 `payload.cwd`。
3. 原生 id resume（driver 级）：L44 `{"nativeId":"01a1e34b-8a8c-74c2-8567-f5645d2a22d9","ms":1510}`；L45 inject `effective:"now"`；L46 `stopReason:"end_turn"`；L47 see 6 条且最后一条为 `T9_CODEX_RESUME_dac57517`。
4. 协议层细节（含 `session/resume` 请求/响应原始帧、`session/load` 在 ACP v2 返回 `-32601 Method not found` 的裁定）见 `codex-acp.md` §2–§3；`probe-findings.md` §5 证明 ACP `session/new` 会落 rollout，故新建会话的 `transcriptPath` 允许为空、由 `see` 懒解析。

### Gate #3 · Pi RPC 打开 + lease 双写拦截

- RPC attach：L50 `{"ms":1720,"session":"C:\\Users\\huang\\.pi\\agent\\sessions\\--E--pi-workbench-tmp-t9-workspace--\\2026-11-16T07-39-08-531Z_01a1e34b-a773-76e2-99fc-3abcafd3f127.jsonl"}`。
- 注入与读回：L51 `effective:"now"`；L52 see 5 条，最后一条 `T9_PI_ATTACH_dac57517`。
- 第二写者：L53 `{"conflict":{"code":"E_LEASE_CONFLICT"},"before":2,"after":2,"newProcesses":0}`——冲突发生在**拉起客户端之前**，进程数与 prompt 计数均未变；HTTP 侧同样 409（L40，`heldBy":"t9-dac57517"`）。
- 驱动与 lease 细则见 `pi-rpc.md` §4（lease 硬约束：inject/interrupt/resume/handoff 触碰客户端前先 `LeaseManager.acquire` + `assertWriter`）。

### Gate #4 · caps 矩阵与能力门

`GET /api/cp/agents`（L11）三行：

| agent | available | version | stream | inject | interrupt | attach | resume | transcript | permissions | background |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | true | 0.107.0 | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| codex | true | 0.167.0 | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| pi | true | 1.5.2 | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |

能力门实测：

- `POST /api/cp/sessions/:key/attach`：codex 422（L12，`details:{agent:"codex",cap:"attach"}`，4ms）、pi 422（L13，1ms）、claude 交互式 422（L32）——**未调用 driver**。
- `POST /api/cp/sessions/:key/handoff`：codex 200 `["codex","resume","01a1e34b-fc6d-7dd3-b5fa-bab1cdefa974","--no-alt-screen"]`（L36）；pi 200 `["pi","--session",<abs jsonl>]`（L41）。

> 说明：spec §14 Gate #4 原措辞「对 attach 调 handoff 期望 422」与 §13「handoff 是分流」冲突，已按 §13 修正为**独立的 /attach 能力门**，并同步改了 spec 原文；handoff 对 codex/pi 是正常出口，不返回 422。

### Gate #5 · 每 Agent 一条 handoff / resume 实测

| Agent | 实测 | 证据 |
|---|---|---|
| Claude | handoff → `["claude","--resume","3c6a498a-73b0-4556-85b0-65b1b4ff6140"]` mode=resume-tui；随后 human-turn 与 handback 成功 | L27–L29；`claude-regression-run1/2.jsonl` 第 10–13 行 |
| Codex | driver 级 resume-by-native-id（L44，1510ms）→ inject → end_turn → see nonce（L45–L47）；handoff 命令（L48） | `e2e-three-agents.jsonl` L44–L48 |
| Pi | handoff → `["pi","--session",<abs jsonl>]`（L54）；此前 RPC attach 已实测（L50） | `e2e-three-agents.jsonl` L54、L50 |

### Gate #6 · 统一渲染与未知事件

- `unified-claude`（L31）：8 条，shape `id,kind,role,text,ts`。
- `unified-codex`（L14）：3 条，shape 同上；`unified-pi`（L15）：3 条，shape 同上。
- 未知事件 fixture（人为塞入未知 `type`/坏的 payload 行）：L16 正常返回 2 条（`UNKNOWN_EVENT_USER` / `UNKNOWN_EVENT_OK`），未抛错、未中断游标。
- 解析器口径：`codex-records.md` §2/§4（23 种 type|payload.type 枚举、developer 角色跳过、reasoning 取 summary）、`pi-records.md` §1–§3（21 文件 / 404 记录 / 0 坏行，custom_message 未知类型不抛）。

### Gate #7 · 四类结构化错误

| 场景 | 证据 | 状态码与错误码 |
|---|---|---|
| adapter / agent 不存在 | L56 | 422 `E_AGENT_UNAVAILABLE`（agent `t9-no-such-agent`） |
| 会话不存在 | L57 | 404 `E_SESSION_NOT_FOUND`（`claude:t9-missing-dac57517`） |
| lease 冲突 | L40 / L53 | 409 `E_LEASE_CONFLICT`（`heldBy:"t9-dac57517"`；driver 级 `newProcesses=0`） |
| resume 被拒 | L58 | `E_RESUME_REJECTED`（1535ms，`cause:"resume 被 agent 拒绝：Internal error"`，`details.sessionId=00000000-…`） |

## 4. 偏差与说明

1. **证据文件命名**：spec §14 拟名（`codex-discover-resume.json`、`caps-matrix.json`、`attach-422.json` 等）在实际执行中合并为一条端到端流水 `e2e-three-agents.jsonl`（60 行，每行 `{ts,phase,step,ok,detail}`），Gate #1 单独用两轮 `claude-regression-run*.jsonl`；映射见上表行号。
2. **Codex 会话发现数量**：15 条来自本机 30 天窗口内的 rollout（含历史会话），不是只有本次 seed；这正是「发现」要验证的能力。
3. **Pi attach 语义**：caps.attach 保持 false（打开同一会话文件 ≠ 接管运行中进程），spec §9/§10 已按实测修订；`/attach` 对 Pi 的 422 是预期行为，不是缺陷。
4. **未覆盖项**：Codex 运行中 ACP resume 的 quiesce 路径目前只有单测（cancel→idle→resume，15s 超时）；Pi `new_session` 的落盘路径未在真实进程上复测（见 spec §18 未决项 #7）。实验记录在 `probe-findings.md` §附。
5. **测试与构建**：最终证据 run 在 `92edc27` 上执行；332/331+1 skip 与 extension 53 与 T9 交付时的数字一致，Gate 期间未再改代码。

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

七条 Gate 全部满足：Claude 无回归（两轮 PASS + 332 单测）、Codex 原生 id resume、Pi RPC + lease 双写拦截、三 Agent caps 与能力门、每 Agent 至少一条 handoff/resume、统一事件渲染与未知事件容错、四类结构化错误。**Gate 0.5-B 通过**，可进入 0.5-C 或按计划收尾合并；遗留项见 §4 第 4 条与 spec §18。
