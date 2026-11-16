# Phase 0.5-B 评审修复记录（B08）

- 日期：2026-11-16
- 评审输入：`docs/reviews/2026-11-16-phase-0.5b-review.md`（Claude Code，只读，118 行）
- 分支：`feat/phase-0.5b-codex-pi`
- 基线：`59ab314`（0.5-B 交付）
- 结论：评审 4 条必修（M1–M4）与 6 条该修（S1–S6）全部修复；清理项完成 5 项、2 项记录为后续技术债。

## 必修

| # | 问题 | 修复 |
|---|---|---|
| M1 | Pi handoff 不关闭 daemon 的 RPC 子进程，原生终端与 daemon 双写同一 jsonl | `PiDriver.close()` 调用 `#dropClient`；`handoff` 先 `#claim`，再 `await #dropClient`，最后返回 `pi --session` 命令。`takeover.#closeDriverRef` 对实现 close 的 driver 统一调用。E2E 断言 handoff 前后 RPC 进程 2→1（`e2e-three-agents.jsonl` L59）。 |
| M2 | codex/pi 的 `onUpdate` 无生产订阅者，`/agents` 却报 `stream:true`；pipeline 只收 Claude `AgentAdapter` | `pipeline.ts` 新增结构类型 `UpdateSource`，`attach(source, sessionKey)` 同时接受 adapter 与 `AgentDriver`；`server.ts` dispatch 后对任意已注册 driver 统一 `pipeline.attach(driver, ref.key)`，仅无 driver 的 Claude 路径回落 `deps.adapter`。E2E 新增 WS 事件流取证：codex L37、pi L47。 |
| M3 | `PiDriver` 无 `newSession`，`POST /dispatch agent=pi` 必 422；扩展本地预检却会放行 | `PiDriver.newSession(cwd)`：无 `--session` 起 RPC → `new_session` → `get_state` 取 sessionId/sessionFile → 注册 client；`takeover.dispatch` 接收返回的 `transcriptPath`。E2E `POST /dispatch agent=pi` 成功（L46），transcript 回显 `T9_PI_DISPATCH_*`。 |
| M4 | `AgentDriver.discover` 生产零调用，E2E 直接 `openDb + registry.upsert` 绕过 API | `server.ts` 新增 `GET /sessions/discover?agent=&cwd=&limit=`（driver.discover → registry.upsert）与 `POST /sessions` 登记入口；E2E 改为 HTTP discovery + register（L8–L10），不再 import 发现函数写库。 |

## 该修

| # | 问题 | 修复 |
|---|---|---|
| S1 | dispatch 每次重新跑启动探测，30s TTL 只作用于 `/agents` | dispatch handler 先 `await deps.agentStatuses()`（`index.ts` in-flight 复用 + 30s TTL）。新增测试「dispatch 两次只探测一次」。 |
| S2 | Codex 发现无索引，see 每次重扫；1000 rollout ≤1.5s 未实现未测量 | `discover/codex.ts` 增加目录 mtime 列表缓存 + 文件 mtime/size 首行缓存；1000 个 rollout 实测首扫 116ms、缓存扫描 16ms（`discovery-bench.md`）。 |
| S3 | 去掉 `thread_source` 过滤，解析出的字段悬空 | 默认只列 `thread_source=user`；缺失字段保留（ACP 新会话实测缺字段）；`includeSubagents:true` 才列子代理。新增测试覆盖 user/subagent/missing 三种。 |
| S4 | `config.pi.rpcCmd` 是死配置 | `PiDriver` 接收 `rpcCmd`，解析首个绝对路径为 cliPath，并透传 `--mode` 之外的参数；`index.ts` 注入 `config.pi.rpcCmd`。新增测试断言参数透传。 |
| S5 | Codex 缓存 adapter 无存活判定，ACP 退出后永久 `E_ADAPTER_DOWN` | `AgentAdapter` 增可选 `isAlive()`；ClaudeAdapter 实现（未 dispose/未 markDown/子进程未退出）；`CodexDriver.#ensureAdapter` 发现失效则退订、dispose、重建。 |
| S6 | `CodexDriver.authorizeWrite` 生产未注入 | `index.ts` 注入租约守卫：`inject`/`interrupt`/`resume` 前若已有其他 writer → `E_LEASE_CONFLICT`；无租约的 dispatch 首轮放行（保持 0.5-A 口径）；`handoff`/`close` 发生在租约转交 human 之后，不按 writer 拦。仍由 `TakeoverEngine.assertWriter` 兜底。 |

## 清理项

- ✅ 文件变短：codex/pi 解析器游标归零时产出 `kind:notice` 消息，不再静默；补两条单测。`UnifiedKind` 增 `notice`。
- ✅ 发现层 `driver` 字段统一：Pi 发现由 `pi` 改为 `none`（与 codex/claude 一致；发现到的会话尚未被控制面持有）。
- ✅ `DEFAULT_CODEX_SESSIONS_ROOT` 去重：`codex-driver.ts` 从 `discover/codex.ts` 导入并再导出。
- ✅ `AgentStatus.version` 与扩展 `AgentDescriptor.version` 对齐为 `string | null`。
- ✅ Pi 发现增加 `maxDepth`（默认 4）、`sinceDays`（默认 30）与 `now` 注入。
- ⏳ 三解析器约 350 行重复（scanJsonl/readBytes/parseCursor/emptyPage）：暂未抽公共模块，记录为 0.5-C 技术债，避免在评审修复窗口内做大范围重排。
- ⏳ attach 判定仍有两处：`/sessions/:key/attach` 按 `SessionRef.capabilities.attach`，handoff 的 `mode=attach` 按 `driver.caps.attach`。两者数据源同自 `capsOf`，语义不同（路由门 vs handoff 出口），保留并加注释。

## 文档

- `docs/开发顺序与阶段门禁.md`：Gate 0.5-B 七条勾选并写结论（注：该勾选在复审修复提交 `5f8243a` 实际落盘；本记录最初写于 `795e0a7`，当时尚未落盘）。
- `docs/evidence/phase-0.5b-gate.md`：更新测试数字、E2E 行号、Gate #3/#5 的 Pi 可用性条件、Gate #6 拆分 transcript 与事件流、record-enumeration 实际拆分说明。
- `docs/specs/2026-11-16-phase-0.5b-codex-pi.md` §10.4：说明记录枚举证据实际拆成 `codex-records.md` + `pi-records.md`。

## 验证

- `pnpm -r build`：三包 Done。
- control-plane：341 tests / 340 pass / 1 skip / 0 fail；extension：53 pass。（本记录是 B08 时快照；复审后最终数字为 347 / 346 / 1 skip / 0 fail，见 `review-fixes-final-2026-11-16.md`。）
- 三 Agent E2E：PASS（65 行，`docs/evidence/phase-0.5b/e2e-three-agents.jsonl`）。
- Claude 严格回归两轮：均 exit 0 / PASS（`claude-regression-run1/2.jsonl`）。

## 复现

```powershell
pnpm -r build
pnpm --filter @pi-workbench/control-plane test
pnpm --filter @pi-workbench/extension test
node scripts/e2e-three-agents.mjs
```

S2 基准：临时生成 1000 个 rollout，连续调用发现两次；可复现脚本为 `scripts/bench-codex-discovery.mjs`（复审 P3-1 补），结果写入 `discovery-bench.md`。
