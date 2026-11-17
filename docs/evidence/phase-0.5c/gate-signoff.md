# Gate 0.5-C 签字记录（gate-signoff）

- 日期：2026-11-17（CST）
- 分支：`feat/phase-0.5c-control-plane-hardening`（基线 `master` @ 2dd18f0，36 个提交）→ 合并回 `master`
- 规格：`docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md` v1.0
- 计划：`docs/superpowers/plans/2026-11-17-phase-0.5c-control-plane-hardening.md`（15 个任务、74 步）
- 结论：**Gate 0.5-C 通过，允许进入 Phase 1（Web 控制台）**

## 1. 评审链

| 轮次 | 文档 | 结论 | 处理 |
|---|---|---|---|
| r1 | `docs/reviews/2026-11-17-phase-0.5c-review.md` | 2×P1 + 7×P2 + 11×P3 | resume 路由、证据对齐、e2e 断言加固、handoff 门禁前移（b51c022 / 2b3e899 / 0df05e4） |
| r2 | `docs/reviews/2026-11-17-phase-0.5c-review-r2.md` | 1×P1（resume 无租约）+ 3×P2 | resume 下沉 `TakeoverEngine.resume`（状态闸门 → assertWriter → #driverWrite → driver.resume → 审计），e2e 串 lease→resume→inject（0af64ab / 3389296） |
| r3（终审） | `docs/reviews/2026-11-17-phase-0.5c-review-r3.md` | **可以合入 master，Gate 可以签字** | 剩余 P3 按约定随 Phase 1 第一周收；`E_INTERNAL` handler 当场收口（cb24df8） |

## 2. C01–C08 证据

| 条目 | 证据 | 结论 |
|---|---|---|
| C01 重启恢复 | `restart-20261117-0352.md`（含 review r2 段） | PASS：杀 daemon 重启后会话/transcript 不丢；无租约 resume 409，取租约后 resume→inject→transcript 回显（e2e-restart **24 checks**） |
| C02 幂等与并发 | `idempotency-20261117-0352.md`、`e2e-concurrency-20261117-1039.*` | PASS：同 dispatch 3 次只 1 个会话；不同会话并行、同会话 FIFO |
| C03 checkpoint / handoff | `checkpoint-20261117-0352.md`、`handoff-roundtrip-20261117-0352.md` | PASS：checkpoint v2 原子写（tmp+rename、key 短哈希）、一次真实往返 + 单测级第二次往返（不宣称两次真实往返） |
| C04 错误与进程治理 | `faults-20261117-0352.md`、`e2e-faults-20261117-1040.*` | PASS 15 checks（1 skip：Windows 优雅关闭不可测）；进程树清理、日志轮转、/health 快照 |
| C05 资产桥只读清单 | `api-v1-20261117-0352.md`（assets.test.ts 5 条 + `GET /api/cp/assets`） | PASS：不做写回与双向同步 |
| C06 API v1 冻结 | `api-v1-20261117-0352.md`、`docs/api/cp-v1.md` | PASS：23 条路由（含 `GET /health`、v1 additive `POST /sessions/:key/resume`）运行时逐条相等 |
| C07 全量回归 | `regression-20261117-0352.md` | PASS：build / 529+59 测试 / 5 个 E2E（claude、three-agents、restart、concurrency、faults）均在本分支实跑 |
| C08 技术债与测试形状 | `regression-*.md` §C08、`operation-matrix.test.ts` | PASS：jsonl 公共层（3 解析器 −417 行）、15 条解析矩阵、30 格操作矩阵（driver 半区为调用形状覆盖，真实 driver 由 e2e-three-agents 覆盖） |

## 3. 签字时的验证基线（HEAD 2be436f）

```
pnpm -r build                       → exit 0，三包 Done
pnpm -C packages/control-plane test → 529 tests / 526 pass / 0 fail / 3 skip
pnpm -C packages/extension test     → 59 tests / 59 pass / 0 fail
node scripts/e2e-restart.mjs        → PASS 24 checks（lease → resume → inject → transcript）
node scripts/e2e-claude.mjs         → PASS（14/14 步，真 Claude 闭环）
node scripts/e2e-three-agents.mjs   → PASS（Claude / Codex / Pi 三腿全绿）
node scripts/e2e-concurrency.mjs    → PASS 16 checks
node scripts/e2e-faults.mjs         → PASS 15 checks（1 skip：Windows 优雅关闭）
```

## 4. 已知偏差（显式断言 / SKIP，不美化）

1. **Claude interactive attach=false**：`POST /attach` 在能力闸门返回 `422 E_CAP_UNSUPPORTED`，e2e-restart 保留负向断言；重启后的接管由 `POST /resume` 正向演练（无租约 409 → 取租约 → 200 → inject 200 → transcript 回显）。
2. **Windows 优雅关闭不可测**：`SIGTERM` = `TerminateProcess`，`e2e-faults` 的 `graceful-shutdown-ended-at` 显式 SKIP（需 POSIX + `PI_WORKBENCH_E2E_SHUTDOWN=1`）。
3. **单机单 daemon**：实例锁依赖 pid 存活判断，跨用户 / 容器不保证。
4. **测试 skip 3 条**：真 adapter 冒烟（默认跳过，`PI_WORKBENCH_REAL_ADAPTER=1` 才跑）、2 条 POSIX-only 进程组测试在 Windows 上按 `process.platform` 跳过。

## 5. 移交 Phase 1 的遗留项（r3 §3，开工第一周收）

- `attach` 仍不要求租约、也不进写队列（同族唯一例外，与 resume/handback 合并收口）。
- `#driverWrite` 的 `finally` 会把调用方自定义 `ttlMs` 重置成默认值。
- `/health.uptimeMs` 用 `Date.now()` 而非注入时钟。
- `GET /sessions` 的 unread 仍全量解析 transcript（P2-6，进 Phase 1 设计）。
- `assets` passthrough、`audit.record` 每次 prepare、`write-queue` 的 `unref`、`jsonl` 的 `pending` 双义。
- spec §8 错误码表未补 `E_SESSION_BUSY` 的新用途（契约文档已写清）。

## 6. 合并

- 方式：`git merge --no-ff feat/phase-0.5c-control-plane-hardening` → `master`，合并后删除已合并分支（本地 + 远端）。
- Phase 1 以本记录作为「0.5-C 已通过」的依据。
