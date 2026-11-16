# Phase 0.5-B 复审修复记录（P0-1 / P1 / P2 / P3）

- 日期：2026-11-16
- 复审输入：`docs/reviews/2026-11-16-phase-0.5b-review-final.md`（Claude Code，只读，12262 B）
- 分支：`feat/phase-0.5b-codex-pi`
- 基线：`795e0a7`（B08 评审修复后提交）
- 结论：复审 1 个 P0、2 个 P1 与 P2-1/P2-2/P2-3/P3-1 全部处理；P2-2 的缓存上限与 adapter 重建单测补齐；剩余两项大范围清理记录为 0.5-C 技术债。

## P0-1（阻断）：codex 写操作在 HTTP 身份下必然 409

**问题**：`TakeoverEngine.#driverWrite` 只对 `driver.agent === "pi"` 做租约换名；CodexDriver 的 `authorizeWrite` 却用固定引擎身份 `"pi"` 比较。HTTP 调用方身份是 `pi:<pid>`，因此 codex 的 inject/interrupt/handback 在租约检查处 409；handoff 后的 handback 还会被包装成 `E_RESUME_REJECTED`。

**修复**：
- `packages/control-plane/src/takeover.ts`：`#driverWrite` 改为对所有非 Claude driver（Codex / Pi）临时把租约换成引擎身份 `"pi"`，写操作结束后还给调用方；Claude 保持 0.5-A 行为不变。
- `packages/control-plane/src/index.ts`：抽出并导出 `makeCodexWriteGuard(leases)`，`CodexDriver` 使用它；`handoff` / `close` 直接放行（这两个动作发生在租约转交 human 后），其余动作只在租约属于其他 writer 时拒绝。
- `packages/control-plane/test/api-agents.test.ts`：
  - `P0-1 codex 的 inject/interrupt/handoff/handback 在 pi:<pid> 租约下全部 200`：使用真实 CodexDriver + `makeCodexWriteGuard`，断言四个 HTTP 写操作均 200、handoff 租约为 `handoff-pi:7`、handback 后回到 `pi:7`。
  - Pi 用例扩展为 inject/interrupt/handoff/handback 四条路径，断言 driver 内部看到的租约持有人始终是 `"pi"`。

## P1-1：发现/登记不得覆盖活跃会话状态

**问题**：`GET /sessions/discover` 与 `POST /sessions` 走整行 upsert，会把 registry 里正在 running 的会话打回 `status:"idle" / driver:"none"`，导致 handoff 跳过 quiesce。

**修复**：
- `packages/control-plane/src/registry.ts`：新增 `registerDiscovered(ref)`。不存在 key → 插入并返回 `created:true`；已存在 key → 保留原 status/driver/kind/caps，只在原 transcriptPath 缺失时补入参路径，返回 `created:false` 与 `transcriptPathUpdated`。
- `packages/control-plane/src/server.ts`：discover 与 POST /sessions 都改走 `registerDiscovered`；discover 不再强制把非 idle 结果改成 idle；POST /sessions 返回 `{ session, created }`。
- `packages/control-plane/test/api-agents.test.ts`：新增「discover 不覆盖已存在会话的 status/driver，只补 transcriptPath」；重复 POST key 断言 `created:false` 且 status/driver/已有 transcriptPath 不变。

## P1-2：门禁勾选与修复记录自述不符

**问题**：`docs/开发顺序与阶段门禁.md` 的 Gate 0.5-B 七条仍是 `- [ ]`，而 `review-fixes-2026-11-16.md` 自述已勾选。

**修复**：
- `docs/开发顺序与阶段门禁.md`：七条改为 `- [x]`，补 Gate 0.5-B 结论与证据指针。
- 本文件作为复审修复的独立记录，避免再次出现「记录先行、事实未落」。
- `docs/evidence/phase-0.5b-gate.md`：同步更新测试数字、E2E run ID/耗时与复审修复说明。

## P2-1：notice 未进入事件管线 / Claude 解析器未同步

**修复**：
- `packages/control-plane/src/pipeline.ts`：`TRANSCRIPT_KIND_TO_TYPE` 增加 `["notice", "notice"]`。
- `packages/control-plane/src/transcript/claude.ts`：文件比游标短时游标归零并产出 `kind:"notice"` 消息（与 codex/pi 对齐）。
- 测试：`pipeline.test.ts` 新增 notice→notice 映射；`transcript.test.ts` 新增 Claude 文件变短游标归零 + notice。

## P2-2：adapter 重建与发现缓存上限

**修复**：
- `packages/control-plane/src/agents/codex-driver.ts`：`#ensureAdapter` 的 spawn promise 链增加 `.finally(() => { this.#spawnPromise = null; })`。复审指出的不只是缺测试：原实现成功后 `#spawnPromise` 永不清空，ACP 死亡后重建会拿到已死的旧 promise，实际无法重新 spawn。
- `packages/control-plane/src/discover/codex.ts`：`DIR_CACHE` / `META_CACHE` 增加 LRU 上限（512 / 4096）与 `remember()` 淘汰。
- 测试：`codex-driver.test.ts` 新增「ACP adapter 退出后下一次写操作会重建新 adapter」，断言第二次 spawn、旧 adapter dispose、prompt 落到新 adapter；`codex-discovery.test.ts` 在 `beforeEach` 调用 `clearCodexDiscoveryCache()`，让导出的清缓存入口进入真实调用点并隔离用例。

## P2-3：发现/登记/恢复会话的事件流

**修复**：
- `packages/control-plane/src/server.ts`：抽出 `attachPipeline(session)`，discover、POST /sessions、handback、dispatch 统一调用；有 driver 挂 driver 的 `onUpdate`，无 driver 的 Claude 路径回落 `deps.adapter`。
- `packages/control-plane/test/api-agents.test.ts`：新增「discover / register / handback 都会把会话挂到事件管线」，断言三条 key 与 source 都是对应 driver。
- 边界：没有 dispatch 的既有会话在 discover/register/handback 后会挂上事件流；事件流是否产生数据取决于该 driver 后续是否收到 update（不伪造事件）。

## P3-1：可复现的发现性能脚本

- 新增 `scripts/bench-codex-discovery.mjs`：临时生成 1000 个 rollout，连续两次调用 `discoverCodexSessions`，输出 `count/cachedCount/firstMs/cachedMs`，结束清理临时目录。
- 实测：`{"count":1000,"cachedCount":1000,"firstMs":114,"cachedMs":18}`，见 `discovery-bench.md`。

## 验证

- `pnpm -r build`：三包 Done（EXIT=0）。
- control-plane：347 tests / 346 pass / 1 skip / 0 fail。
- extension：53 pass / 0 fail。
- 三 Agent E2E：PASS（nonce `8b0084aa`，65 行证据 `e2e-three-agents.jsonl`，daemon `127.0.0.1:28897`）。
  - Codex：discover 27 条、resume-by-native-id 1224ms、see 6 条含 `T9_CODEX_RESUME_8b0084aa`；handoff 命令正确。
  - Pi：RPC attach 3187ms、lease 冲突 `newProcesses=0`、dispatch 回显 `T9_PI_DISPATCH_8b0084aa`、handoff 前后 RPC 进程 2→1。
  - Gate #7：E_AGENT_UNAVAILABLE 422 / E_SESSION_NOT_FOUND 404 / E_LEASE_CONFLICT 409 / E_RESUME_REJECTED（1670ms）。
- Claude 严格回归两轮：均 exit 0 / PASS；证据 `claude-regression-run1.jsonl` / `run2.jsonl`（2026-11-16T09-46-25-266Z / 09-46-37-479Z）。
- 复现命令：
  ```powershell
  pnpm -r build
  pnpm --filter @pi-workbench/control-plane test
  pnpm --filter @pi-workbench/extension test
  node --experimental-strip-types scripts/bench-codex-discovery.mjs
  node scripts/e2e-three-agents.mjs
  node --experimental-strip-types tmp/claude-regression.mjs
  ```

## 仍留给 0.5-C 的技术债

- 三解析器约 350 行重复（scanJsonl/readBytes/parseCursor/emptyPage）尚未抽公共模块，避免复审修复窗口内大范围重排。
- attach 判定仍有两处：`/sessions/:key/attach` 按 `SessionRef.capabilities.attach`，handoff 的 `mode=attach` 按 `driver.caps.attach`；数据源同自 `capsOf`，语义不同（路由门 vs handoff 出口），保留并加注释。
