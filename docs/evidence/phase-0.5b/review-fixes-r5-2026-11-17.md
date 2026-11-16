# Phase 0.5-B r5 终审收尾记录

日期：2026-11-17
报告：`docs/reviews/2026-11-16-phase-0.5b-review-r5.md`
结论：r5 判定可合并；两项收尾已在本提交中完成。

## 1. 门禁文档引用方式

- Gate #4 / #5 / #7 的 `L12–L14`、`L28`、`L42`、`L61–L63` 等行号引用已改为 `step=` 引用。
- Gate #4 中已失效的 codex handoff session id 已删除，改为引用 `step=handoff-codex` / `step=handoff-pi`。
- Gate #6 的 `L32` / `L15` / `L16` / `L17`、Gate #2 的 `L8` / `L49–L52`、Gate #3 的 `L59` 也一并改成 step 引用，避免同一张表混用两种定位方式。
- 现在证据按 `run + step` 查阅，不再依赖脚本行号。

## 2. P2-1 缓存测试

在 `packages/control-plane/test/takeover.test.ts` 新增 3 条：

1. 同一 key 并发调用 `refreshTranscriptPath`：`resolveTranscriptPath` 只调用 1 次；
2. `status=idle` 解析失败：30s 内不再调用 driver，时钟推进 30s 后重新调用；
3. `status=running` 解析失败：下一次立即重试，不落负缓存。

测试通过 `makeRefreshHarness` 注入只包含 `refreshTranscriptPath` 所需表面的假 Codex driver，不启动真实 adapter。

## 3. 验证

- `pnpm -r build`：三包 Done。
- `pnpm --filter @pi-workbench/control-plane typecheck`：通过。
- control-plane：**367 tests / 366 pass / 1 skip / 0 fail**。
- extension：**58 pass / 0 fail**。
- 三 Agent E2E：PASS（run `b17be07c`，65 行，`failures: []`）。
- Claude 严格回归：两轮 PASS（`claude-regression-run1/2.jsonl`）。

## 4. 备注

r5 建议的「agent × 操作 × 入口矩阵测试」和「证据按 run 命名」属于 0.5-C 的 DoD 改进项，不在本次合并前代码修复范围。
