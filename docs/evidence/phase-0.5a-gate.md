# Phase 0.5-A · Gate 证据（A11）

- 日期：2026-11-15
- 阶段：Phase 0.5-A / A11（真实闭环验收）
- 分支 / commit：`feat/phase-0.5a`（Gate 主体证据采于 `bbfd200`；Gate #6、handback 复验与严格版 e2e 由控制者在其后补做，终审修复见 `git log`）
- 执行者：Task 10（Gate 执行代理）；Gate #6 原生 TUI 接管由控制者补做
- 结论：**9 条全部 ✅ 通过** → Gate 0.5-A **通过**（Gate #6 的原生 TUI 抓屏由控制者用 ConPTY 补做，见 §8；严格版 e2e 两轮 PASS 见 §12.5）
- 原始产物目录：`docs/evidence/phase-0.5a/`

> 条目编号沿用 task-10-brief **R49 的九条**（与 spec §10 一一对应，映射见总表下方的说明）；证据全部来自真实 `claude` 进程与真实 daemon，未使用 fixture。

## 1. 环境与版本

| 项 | 值 |
|---|---|
| OS | Windows 11（ConPTY） |
| Node | v24.16.0（`E:\nodejs\node.exe`） |
| pnpm | 12.3.4 |
| Claude Code | 2.1.325 |
| ACP adapter | @agentclientprotocol/claude-agent-acp 0.107.0 |
| ACP SDK | @agentclientprotocol/sdk 2.6.0 |
| HTTP / WS | fastify 5.12.8 / @fastify/websocket 11.3.7 |
| commit | `bbfd200cfa0ae0803635db52cdc51fb58a9cf83e`（branch `feat/phase-0.5a`） |
| daemon | `node packages/control-plane/src/index.ts`，`127.0.0.1:7331`，`PI_WORKBENCH_HOME=E:\pi-workbench\tmp\t10-home` |
| 会话 cwd | `E:\pi-workbench\spike\a00-workspace` |

```text
$ curl -s 127.0.0.1:7331/health
{"ok":true,"name":"pi-workbenchd","version":"0.0.1","pid":29060,"uptimeMs":220}
```

环境事实（供复现）：daemon 用 `PI_WORKBENCH_HOME` 的 **Windows 路径**；`PI_WORKBENCH_PORT=7331`；e2e 必须从 `spike/a00-workspace` 里跑（脚本把 `process.cwd()` 当 dispatch 的 cwd，见缺陷 D3）。

## 2. 九条总表

| # | 条目 | 结论 | 证据文件或命令片段 | 备注 |
|---|---|---|---|---|
| 1 | `cp_dispatch` 返回完整 SessionRef | ✅ | `phase-0.5a/e2e-run1.jsonl` 的 `dispatch` 行；`phase-0.5a/gate1-idempotent-dispatch.json` | 字段：`key,agent,nativeId,acpSessionId,cwd,transcriptPath,status,driver,capabilities,kind` |
| 2 | dispatch 后 2s 内出现事件（token/tool_call 可见） | ✅ | `phase-0.5a/health-run1.json`、`e2e-run1.jsonl`、`phase-0.5a/gate9-ws-capture.jsonl`（含 `token`×2、`thought`×4） | 首事件 +6 ms（`created_at 18:47:16.811` → `seq=1 @18:47:16.817`）；transcript 首条消息 +516 ms；`thought` +2.4 s |
| 3 | `cp_inject` 改下一轮行为；无 lease 被拒 | ✅ | `phase-0.5a/gate3-inject.json`、`phase-0.5a/gate3-nolease-409.json` | inject 200 `effective:"now"`，assistant 真的回出 `T10_INJ_82421d61`；无租约 inject/checkpoint 均 **409 `E_NO_LEASE`** |
| 4 | `cp_interrupt` 停住运行中回合并记 stopReason | ✅ | `phase-0.5a/gate4-interrupt.json` | `running → 200 {stopReason:"cancelled"} → idle`；WS `state_update{state:"idle",stopReason:"cancelled"}` seq 1018/1019 |
| 5 | `cp_see` 增量游标：不重复、游标前进 | ✅ | `phase-0.5a/gate5-cursor.json` | `after=0&limit=3` → 3 条 / cursor `188545`；`after=188545&limit=3` → 1 条 / cursor `191072`；重复 0 |
| 6 | `cp_handoff` → `claude --resume <id>`，原生 TUI 看历史并注入一轮 | ✅ | `phase-0.5a/gate7-handoff.json`；`phase-0.5a/tui-inject.jsonl` + `tui-inject-screen.txt`（ConPTY 抓屏） | `mode="resume-tui"` + `command=["claude","--resume",<nativeId>]`；原生 TUI 恢复历史（`sawHistoryMarker:true`），键盘注入 `TUI_INJECT_7788`，transcript 落 `assistant text "TUI_INJECT_7788"` |
| 7 | `cp_handback` 接回，`deltaSummary` 含 handoff 期间增量 | ✅ | `phase-0.5a/gate7-handback-delta.json` | `resumed=true`；`deltaSummary` 两行：`user: …T10_NATIVE_e3fbdcbb` / `assistant: T10_NATIVE_e3fbdcbb` |
| 8 | 重启后 sessions/leases/checkpoints 从 SQLite 恢复；同幂等键同会话 | ✅ | `phase-0.5a/gate8-crash-recovery.json`、`sqlite-counts-before.json`、`sessions-after-crash-recovery.json` | `taskkill /F` 真杀 60100 → 重启 47444：6 会话全在、checkpoint 原文可取、同 `idempotencyKey` 同 key |
| 9 | WS `seq` 单调；`after=` 重连补拉不重复 | ✅ | `phase-0.5a/gate9-ws.json`、`phase-0.5a/gate9-ws-capture.jsonl` | 45 条 seq 严格递增且无重复；`after=1019` 收到 0 条；`after=1016` 正好补 2 条（1018/1019） |

映射：R49 ① = spec 1、② = 2、③ = 3、④ = 4、⑤ = /transcript 增量要求、⑥ = spec 5 的 TUI 部分、⑦ = spec 6、⑧ = spec 7 + 崩溃恢复、⑨ = spec 9 的 seq 部分；spec 8（单 driver / 错误码）见 §12 的 `E_LEASE_CONFLICT` 用例。

---

## 3. Gate #1 · `cp_dispatch` 返回完整 SessionRef

```json
// e2e-run1.jsonl（dispatch 行）
{"step":"dispatch","ok":true,"detail":"{\"key\":\"claude:3569f43e-…\",\"status\":\"running\",\"nativeId\":\"3569f43e-…\"}"}
```

`GET /api/cp/sessions/:key` 的完整 SessionRef（`gate1-idempotent-dispatch.json`）：

```text
key            claude:19983001-3253-4a22-9bbb-350819eee2c8
agent          claude
nativeId       19983001-3253-4a22-9bbb-350819eee2c8
acpSessionId   19983001-3253-4a22-9bbb-350819eee2c8
cwd            E:\pi-workbench\spike\a00-workspace
transcriptPath C:\Users\huang\.claude\projects\E--pi-workbench-spike-a00-workspace\19983001-….jsonl
status         idle
driver         pi
capabilities   {transcript:true,stream:true,inject:true,interrupt:true,resume:true,attach:false,permissions:true,background:false}
kind           interactive
```

## 4. Gate #2 · dispatch 后 2 秒内出现事件

| 观测点 | 值 |
|---|---|
| sessions.created_at（run1） | `2026-11-14T18:47:16.811Z` |
| 首事件 `seq=1`（`notice`） | `18:47:16.817Z` → **+6 ms** |
| `seq=2` `state_update{state:"running"}` | `18:47:16.820Z` → +9 ms |
| transcript 首条消息（e2e `see-ready`） | +516 ms（`18:46:39.997` dispatch → `18:46:40.513`） |
| `seq=4` `thought` | `18:47:19.225Z` → +2.4 s |
| WS 抓包 `type` 直方图 | `{notice:5, state_update:34, thought:4, token:2}` |

`token` / `thought` 事件在同一份 `gate9-ws-capture.jsonl` 里可见，满足「2 秒内出现事件、token 可见」。

## 5. Gate #3 · inject 改变下一轮行为 + 无租约被拒

`gate3-inject.json`（会话 `claude:422c46b8-…`，nonce `82421d61`）：

```text
POST …/inject {"text":"请只回答这一行，不要加任何别的内容：T10_INJ_82421d61","clientId":"t10-g3-82421d61"}
→ 200 {"messageId":"43c3f43c-d112-42d0-a007-25219d2f9ce1","effective":"now"}

随后 transcript 出现 assistant 文本："T10_INJ_82421d61"
（同会话此前的 assistant 文本：            "T10_READY_82421d61"）
```

`gate3-nolease-409.json`（会话 `claude:9325ca39-…` 从未取租约）：

```text
POST …/inject {"text":"T10_SHOULD_FAIL","clientId":"t10-rogue"}
→ 409 {"error":{"code":"E_NO_LEASE","message":"无有效租约：claude:9325ca39-…","details":{…}}}
POST …/checkpoint {…} → 409 E_NO_LEASE
```

## 6. Gate #4 · interrupt 停住运行中回合

`gate4-interrupt.json`（会话 `claude:96b22896-…`，nonce `37f65616`，任务「从 1 数到 400，每行一个数字」）：

```text
GET  /api/cp/sessions/:key            → status = "running"
POST /api/cp/sessions/:key/interrupt  → 200 {"stopReason":"cancelled"}
GET  /api/cp/sessions/:key            → status = "idle"
打断前已有 578 字符 assistant 文本："The user wants me to count from 1 to 400, one number per line…"
WS：
  {"seq":1018,"type":"state_update","payload":{"state":"idle"},"ts":"…18:50:01.568Z"}
  {"seq":1019,"type":"state_update","payload":{"state":"idle","stopReason":"cancelled","clientId":"t10-g4-37f65616"},"ts":"…18:50:01.577Z"}
```

## 7. Gate #5 · 增量游标

`gate5-cursor.json`（会话 `claude:422c46b8-…`）：

```text
GET …/transcript?after=0&limit=3
→ [user:"…T10_READY_82421d61", assistant:"T10_READY_82421d61", user:"…T10_INJ_82421d61"], nextCursor="188545"
GET …/transcript?after=188545&limit=3
→ [assistant:"T10_INJ_82421d61"], nextCursor="191072"
重复 id：0；游标 188545 → 191072（前进）
```

## 8. Gate #6 · handoff 出口 + 原生 TUI 接管（控制者补做）

`gate7-handoff.json`：

```text
POST /api/cp/sessions/claude:2937f287-…/handoff {"to":"human","clientId":"t10-g7-e3fbdcbb", …}
→ 200 {"mode":"resume-tui","command":["claude","--resume","2937f287-81d2-4ac2-a08c-7c9b6c59570b"],"checkpoint":{…}}
```

**支撑证据（不是 TUI 证明）** —— `gate6-supporting-native-resume.json`：

```text
$ claude -p --resume 2937f287-81d2-4ac2-a08c-7c9b6c59570b "请只回答这一行，不要加任何别的内容：T10_NATIVE_e3fbdcbb"
（exit 0）T10_NATIVE_e3fbdcbb
```

原生进程能接上 ACP 会话、读旧上下文并写新一轮。

**原生 TUI 接管（ConPTY，2026-11-15 02:42，控制者执行）** —— `phase-0.5a/tui-inject.jsonl` + `tui-inject-screen.txt`：

```text
# 会话 claude:cf05e902-d8df-4a1e-a542-4480b41961e0（handoff 出的 resume-tui）
$ node scratch/t10-tui/tui-probe.mjs cf05e902-… TUI_INJECT_7788 E:/pi-workbench/spike/a00-workspace …
{"kind":"shot1","data":{"sawHistoryMarker":true, …}}           ← TUI 起来就看到历史
{"kind":"inject","data":{"text":"TUI_INJECT_7788"}}             ← 键盘注入一轮
{"kind":"shot2","data":{"sawNonce":true,"tail":"…⏵⏵ auto mode on… 请只回复这个字符串：TUI_INJECT_7788 …"}}
```

对应的 transcript（`after=187328`）：

```text
user       text      "请只回复这个字符串：TUI_INJECT_7788"
assistant  thinking  "The user is asking me to reply with a specific string. …"
assistant  text      "TUI_INJECT_7788"
```

→ 原生交互 TUI 能恢复历史、接受键盘输入、把新一轮写回同一会话的 transcript，Gate #6 成立。

同一轮随后 handback：`{"resumed":true,"deltaSummary":"user: 请只回复这个字符串：TUI_INJECT_7788 … assistant: TUI_INJECT_7788"}`，租约与 driver 回到 pi。

## 9. Gate #7 · handback 的 deltaSummary

`gate7-handback-delta.json`（与上图同一条会话）：

```text
handoff → 期间用原生 claude -p --resume 写了一轮 T10_NATIVE_e3fbdcbb
GET  /api/cp/sessions/:key → lease.clientId = "handoff-t10-g7-e3fbdcbb"
POST /api/cp/sessions/:key/handback {"clientId":"handoff-t10-g7-e3fbdcbb"}
→ 200 {"resumed":true,
       "deltaSummary":"user: 请只回答这一行，不要加任何别的内容：T10_NATIVE_e3fbdcbb\nassistant: T10_NATIVE_e3fbdcbb"}
```

`deltaSummary` 精确包含 handoff 期间那一轮的 prompt 与回答 → spec §10 #6 成立。

**修复后复验（commit `92e4b5e`，控制者执行）** —— `phase-0.5a/handback-fix-*.json`：

```text
lease acquire {"driver":"pi","clientId":"pi-42"}            → 200
handoff       {"to":"human","clientId":"pi-42"}             → 200, mode=resume-tui
GET session   → lease {"driver":"human","clientId":"handoff-pi-42"}
（人类回合）claude -p --resume fe1eb6fc-… "回答 HB_NATIVE_9911" → exit 0，答出 HB_NATIVE_9911
POST handback {"clientId":"handoff-pi-42"} → 200 {"resumed":true,
   "deltaSummary":"user: 回答 HB_NATIVE_9911\nassistant: …\nassistant: HB_NATIVE_9911 不是我记录的暗号。你让我记住的暗号是 **HB_ANCHOR_55**。"}
GET session   → driver=pi status=idle lease.clientId="pi-42"   ← 剥掉 handoff- 前缀，租约回到 pi 侧身份
POST inject   {"text":"回复 HB_AFTER_22","clientId":"pi-42"} → 200 {"effective":"now"}
```

修复内容：旧实现 handback 后把租约挂在 `handback-<id>` / `handoff-<id>` 这类派生 id 上，Pi 扩展用原 clientId 立刻 `E_NO_LEASE`；现在一律还给 pi 侧身份（`takeover.ts` 的 `HANDOFF_CLIENT_PREFIX` 剥离）。这是 Gate #6/#7 流程能继续驱动的前提，回归用例见 `test/takeover.test.ts` 的 handback 段。

## 10. Gate #8 · 崩溃恢复（真杀进程）

dispatch 长计数任务（`T10_CRASH 37f65616`，1→600）→ 取租约 → 写 checkpoint → `taskkill /F /PID 60100` → 同一 home 重启（pid 47444）：

```text
sessionsListed      6 条（含 claude:888279e4-3340-4035-8ea8-e1b285d1b1c6）
crashSessionListed  true
GET …/checkpoint    √ "T10_CRASH 37f65616 崩溃前检查点：长计数任务进行中"（cursor / createdAt / path 齐全）
POST /api/cp/dispatch {"idempotencyKey":"t10-crash:37f65616", …}
→ key = claude:888279e4-3340-4035-8ea8-e1b285d1b1c6（崩溃前同一会话，sameKey=true）
```

SQLite 行数（`sqlite-counts-before.json` + 崩溃后磁盘复算）：

| 表 | 崩溃前（kill 前快照） | 崩溃后磁盘（daemon 已死） | 重启后 |
|---|---|---|---|
| sessions | 6 | 6 | 6 |
| events | 51 | **53** | 53 |
| leases | 5 | 5 | 5 |
| checkpoints | 5 | 5 | 5 |
| dispatches | 6 | 6 | 6 |

`events` 51→53：杀进程前最后两条事件已进 WAL，崩溃后仍在（不丢）；`leases` 5 行全留（含 `t10-crash-` 那条 30 分钟租约），租约不因崩溃丢失。

## 11. Gate #9 · WS seq 单调 + `after=` 重连不重复

`gate9-ws.json`：

```text
ws://127.0.0.1:7331/api/cp/ws?after=0   → 45 条，firstSeq=1，lastSeq=1019，monotonic=true，distinctSeq=true
ws://…?after=1019                       → 0 条（不重放任何 seq <= 1019）
ws://…?after=1016                       → 2 条，seq = [1018, 1019]（精确补拉，不越界）
```

抓包全文（payload 已裁剪）：`phase-0.5a/gate9-ws-capture.jsonl`。

## 12. spec §10 #8 补充 · 单 driver 保护与错误码

`gate8-lease-conflict.json`（`claude:422c46b8-…` 已被 `t10-g3-82421d61` 持有）：

```text
POST …/lease {"action":"acquire","driver":"pi","clientId":"t10-intruder-82421d61"}
→ 409 {"error":{"code":"E_LEASE_CONFLICT","message":"租约被其他客户端持有：claude:422c46b8-…",
        "details":{"heldBy":"t10-g3-82421d61","expiresAt":"2026-11-14T19:19:35.086Z"}}}
```

同幂等键连打两次 `POST /api/cp/dispatch`（`gate1-idempotent-dispatch.json`）→ 两次都返回 `claude:19983001-…`，与 run2 的会话 key 一致（`sameKey=true`），未建出第二个会话。

## 12.5 严格版 e2e 复跑（D1/D2/D3 修复后，控制者执行）

脚本修掉三处「假绿」后（详见 §15），在 `PI_WORKBENCH_HOME=E:\pi-workbench\tmp\t10-e2e` 的新库上连跑两轮，均 **PASS**：

| 轮次 | 证据 | 关键断言 |
|---|---|---|
| run 1 | `phase-0.5a/e2e-strict-run1.jsonl` | `see-ready` 等到 **assistant** 消息；`human-turn` exit 0 回出 `E2E_HUMAN_bfd230d1`；`deltaSummary` 含该 nonce |
| run 2 | `phase-0.5a/e2e-strict-run2.jsonl` | 同一 daemon（未重启）、不同 nonce，同上全绿 |

`e2e-strict-run0-quoting-bug.jsonl` 保留了一次**真实失败**：Windows 下 `shell:true` 把带空格的 prompt 拆散，claude 只收到 "回答"，脚本因「deltaSummary 不含人类 nonce」报 FAIL —— 说明新断言确实有判别力（不是写死的绿灯）。

## 13. 两轮连续跑通（R51）

| 轮次 | e2e 结果 | sessionKey | nonce | 证据 |
|---|---|---|---|---|
| run 1（全新 home、空 DB 启动） | **PASS**（exit 0，9.9 s） | `claude:3569f43e-…` | `f476fc43` | `phase-0.5a/e2e-run1.jsonl`、`e2e-run1.stdout.log` |
| run 2（**同一 daemon 实例 pid 29060，未重启**） | **PASS**（exit 0，6.3 s） | `claude:19983001-…` | `69d6fc6c` | `phase-0.5a/e2e-run2.jsonl`、`e2e-run2.stdout.log` |

```text
run 1 summary: {"result":"PASS","sessionKey":"claude:3569f43e-…","nonce":"f476fc43"}
run 2 summary: {"result":"PASS","sessionKey":"claude:19983001-…","nonce":"69d6fc6c"}
```

> 脚本断言口径偏松（缺陷 D1/D2）：§5 / §9 的 inject 与 handback 结论是按 `role==="assistant"` 过滤后独立复核的。

## 14. 复现命令

```bash
# 1) daemon（Windows 路径！）
PI_WORKBENCH_HOME='E:\pi-workbench\tmp\t10-home' PI_WORKBENCH_PORT=7331 \
  node packages/control-plane/src/index.ts
curl -s 127.0.0.1:7331/health

# 2) 两轮 e2e（从 a00-workspace 跑；脚本用 process.cwd() 当 dispatch 的 cwd）
cd spike/a00-workspace && PI_WORKBENCH_URL=http://127.0.0.1:7331 \
  node E:/pi-workbench/scripts/e2e-claude.mjs     # 再跑一次 = run 2（不重启 daemon）

# 3) 同幂等键重复 dispatch
curl -s -XPOST 127.0.0.1:7331/api/cp/dispatch -H 'content-type: application/json' \
  -d '{"agent":"claude","task":"<run2 同一 task 原文>","cwd":"E:\\pi-workbench\\spike\\a00-workspace","idempotencyKey":"e2e:<run2 nonce>"}'

# 4) 崩溃恢复：Stop-Process -Id <pid> -Force（或 taskkill /F /PID <pid>）后同一 home 重启
curl -s 127.0.0.1:7331/api/cp/sessions
curl -s 127.0.0.1:7331/api/cp/sessions/<key>/checkpoint

# 5) WS：ws://127.0.0.1:7331/api/cp/ws?after=0 收流记 lastSeq → ?after=<lastSeq> 应静默
```

## 15. 发现的缺陷（D1–D3 已由控制者修复；D4–D7 留待 0.5-C）

| ID | 位置 | 现象 | 影响 | 建议 |
|---|---|---|---|---|
| ~~D1~~ ✅ | `pollSee` 谓词 | 旧：任意非空 text 即算命中（自己的 user prompt 就满足） | 假绿 | 已改为要求 `role === "assistant"`；idle 早退同样要求 assistant |
| ~~D2~~ ✅ | 第 10 步 handback | 旧：只记录 `deltaSummary`，空串也算 PASS | Gate #7 无法自证 | 脚本新增「人类回合」（`claude -p --resume` + `E2E_HUMAN_<nonce>`）并断言 deltaSummary 非空且含该 nonce |
| ~~D3~~ ✅ | dispatch 的 cwd | 旧：取 `process.cwd()`，从仓库根跑会漂 | 幂等哈希 / slug 随运行目录变 | 固定为 `<repo>/spike/a00-workspace`，可用 `PI_WORKBENCH_E2E_CWD` 覆盖 |
| D4 | `interrupt` → `idle` 之间 | interrupt 返回 200 后约 0.5–1 s 状态才落 `idle` | e2e 在 interrupt 后立即 checkpoint/handoff（靠 handoff 内部 cancel+等 idle 兜底），存在竞态 | 文档化「interrupt 异步」，或让 interrupt 等到 idle 再返回 |
| D5 | `events.seq` | 本次抓到 `seq 4 → 42` 跳号 | 幂等 `INSERT OR IGNORE` 冲突消耗自增 id；单调/补拉不受影响，但「seq 连续」类断言会挂 | 明示 seq 允许跳号（spec 只承诺单调） |
| D6 | `packages/control-plane/src/lease.ts` | 无后台清扫，`expires_at` 到期仅读取时惰性判定；崩溃后过期租约行仍在表里（本次 5 行全留） | `leases` 表持续增长；不破坏单 driver 保护 | 后续加 TTL 清扫或归档 |
| D7 | spec §10 #7「崩溃后租约不永久锁死」 | 只证了「租约行不丢 + 到期即视为无租约」，没有等 30 s 租约自然过期后重新 acquire 的实测 | 该条 TTL 回收仍是推理而非实测 | 补一条 TTL 到期后重新 acquire 的用例 |

## 15.5 终审修复（整分支评审 FIX-FIRST，commit `6438f3e`）

| ID | 问题 | 修法 | 验证 |
|---|---|---|---|
| I-1 | daemon 只认 `PI_WORKBENCH_AUTH_TOKEN`，CLI/扩展/e2e 只认 `PI_WORKBENCH_TOKEN` → 用后者启动等于**静默无鉴权** | `config.ts` 两个名字都认（AUTH_TOKEN 优先）；spec §6 写明唯一名字 | 新增 `config.test.ts` 用例 3 attrs；真机 `0.0.0.0` + `PI_WORKBENCH_TOKEN=s3cr3t`：无 header 401、未知路由 401、带 header 200 |
| I-2 | spec 里 checkpoint / handoff 表体没写 `clientId`，实现却要求 | spec §6 两行补 `clientId` | 与 `server.ts` 的 `requireString("clientId")` 对齐 |
| I-3 | Pi 扩展 7 个 `cp_*` 无取租约入口 → 真实宿主里写工具全 `E_NO_LEASE` | 新增第 8 个工具 `cp_lease`（acquire/release/heartbeat，driver/ttlMs 校验）+ client 方法；2026-11-16 分支评审后再补第 9 个 `cp_handback` | `extension.test.ts` 用例断言 URL/body/错误文案；本轮 47 pass |

回归：`pnpm -r build`/typecheck 三包 Done；control-plane 212 tests / 211 pass / 1 skip；extension 16 pass。

## 16. 遗留与下一步

1. **Gate #6 已补**：ConPTY 打开 `claude --resume <id>` → 看到历史 → 注入 `TUI_INJECT_7788` → transcript 落 assistant 文本（§8）。Gate 0.5-A 据此翻为 ✅。
2. **脚本自证已成立**：D1–D3 修好后连跑两轮 PASS（§12.5），并且保留了一次真实 FAIL 作为判别力证据。
3. 待 0.5-C 处理：D4（interrupt 异步落 idle 的竞态）、D6（租约无后台清扫）、D7（TTL 到期重取未实测）；另有 handback 失败后 `complete` 已写但会话被关的边角（见 T7 round-3 评审 N1 备注）。
4. 已知非阻塞项：CLI 无 `--json` 开关（恒打 JSON）；e2e 只取一次 30 分钟租约、无心跳；WS 无连接数上限。

## 17. 清理

- 探针脚本只在 `scratch/t10/`（未入库）；daemon 已停，`netstat -ano | findstr :7331` 为空。
- `docs/evidence/phase-0.5a/` 24 个文件、约 44 KB；不含任何 auth token（本次部署回环、无 token）。

## 18. `.gitignore` A00 证据入库校验

```text
$ git ls-files spike/acp-probe/evidence
spike/acp-probe/evidence/a00-claude-carrier.jsonl
spike/acp-probe/evidence/a00b-tui-takeover.jsonl

$ git check-ignore -v spike/acp-probe/evidence/a00-claude-carrier.jsonl   → 无输出（未被忽略，否定规则生效）
$ git check-ignore -v spike/acp-probe/evidence/claude-full.jsonl          → .gitignore:3:spike/acp-probe/evidence/*（同目录其他文件仍被忽略）
```

当前 `.gitignore` 第 3–4 行已是 `spike/acp-probe/evidence/*` + `!spike/acp-probe/evidence/a00*.jsonl`，否定规则**已生效**、两个 A00 JSONL 都已在库中，因此本次无需改 `.gitignore`（仅做校验）。
## 19. Gate 后追加：读语义 v2（未读 + 每读者游标，2026-11-16）

用户提出的读模型改造（"别让 Pi 靠轮询盯会话，登记未读即可"）已落地，属 Gate 0.5-A 之后的增量，不影响上表九条结论。

- 表 `read_cursors`（schema v3），游标 = transcript 字节偏移，`unread` = 游标后剩余消息条数。
- 路由：`GET /sessions?clientId=`、`GET /sessions/:key?clientId=`、`GET /sessions/:key/unread?clientId=&limit=&ack=`、`POST /sessions/:key/read`。
- `cp_see` 默认走未读 + 标记已读，`peek:true` 只看不标记，`after=` 仍走 transcript 分页。
- 证据（含真机数字、CLI 与 Pi 插件实录）：`docs/evidence/phase-0.5a/read-semantics-v2.md`。
- 测试：control-plane 226（225 pass / 1 skip）、extension 19 全绿。

## 20. daemon 自动拉起（2026-11-16 增量）

- Pi 插件加载时探活 `http://127.0.0.1:7331/health`，没在跑就以 detached 方式
  `node <repo>/packages/control-plane/dist/cli.js start` 拉起，端口从 baseUrl 推导（`PI_WORKBENCH_HOST/PORT`），轮询到就绪为止。
- 非回环地址不代管；`PI_WORKBENCH_AUTOSTART=0` 关闭；入口不存在/超时抛 `E_DAEMON_DOWN` 并给手工命令。
- 不阻塞 Pi 启动：工厂函数 fire-and-forget，第一个 `cp_*` 调用前经 `beforeCall` 钩子等待就绪。
- 证据（含冷启动真机实录、schema 校验）：`docs/evidence/phase-0.5a/daemon-autostart.md`。
- 测试：extension 27 全绿（新增 daemon 6 + beforeCall 2）。

## 21. 事件推送与唤醒（2026-11-16 增量，spec §6.6）

- Pi 扩展订阅 `WS /api/cp/ws`，claude 回合结束 / needs-input / error 时用 `pi.sendMessage(..., { deliverAs, triggerTurn })` 叫醒 Pi 主对话；
  默认 `followUp`（本轮结束后投递），`PI_WORKBENCH_NOTIFY_MODE` 可改 `steer|nextTurn`，`PI_WORKBENCH_NOTIFY=0` 全关。
- 防"提醒你看已经看完的东西"：投递前复查未读（0 则静默丢弃）、消息是指针不含完成断言、`cp_see`/`cp_read` 成功即清账、连续唤醒上限 5。
- 真机闭环：Pi 派发任务后不轮询即结束本轮 → 20 秒后 claude 答完 → Pi 收到"1 个会话有更新（未读共 7 条）"并自行调用 `cp_see`，读到即结清。
- 证据：`docs/evidence/phase-0.5a/event-wake.md` + `pi-wake-screen.txt`；extension 40 tests 全绿（notify 13）。

## 22. 分支评审修复（2026-11-16）

独立分支评审（`review-branch-2026-11-16.md`，master...HEAD 30 commits）结论 FIX-FIRST：
2 阻塞（B1 未读被 200 上限截断、B2 通知器复核清空连击计数）+ 4 Important（I1 未读口径、I2 徽标被静音、I3 自动拉起错误码、I4 缺 `cp_handback`/租约身份不匹配）+ 3 Minor（C1 旧 schema、C2 token 双名、C3 端口优先级）。
已全部修复并补回归用例；另补显式游标校验。全量：control-plane 229（228 pass / 1 skip）、extension 47 全绿；`pnpm -r build` 三包 Done。
复审 r2（`review-branch-2026-11-16-r2.md`）再补 5 项：R1 无 `schemaVersion` 的旧 daemon 也判过旧、R2 peek 的 unread 不再按本页之后计、R3 token 双名优先级两侧统一、R4 `cp_handback` 支持指定 clientId、R5 清死代码。
逐项清单与验证输出：`docs/evidence/phase-0.5a/review-fixes-2026-11-16.md`。九条 Gate 结论不变（修复只加强未读/通知路径）。

**合并**：2026-11-16 经用户确认，`feat/phase-0.5a`（40 commits）以 `--no-ff` 合并入 `master`（`e22304f`）；合并后在 master 复跑 `pnpm -r build`（三包 Done）与两包测试（control-plane 229/228 pass/1 skip、extension 49 pass），工作树干净。
