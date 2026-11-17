> 本文是 `d023f07`（final review fixes）的终审修复清单；该提交的提交信息为空（仅 `(final review fixes)`）。正文自 `.superpowers/sdd/2026-11-17-phase-0.5c-control-plane-hardening/reports/final-fixes.md` 原样搬入（2026-11-17）。

# Final review fixes — Phase 0.5-C

- 日期：2026-11-17（CST）
- 分支：`feat/phase-0.5c-control-plane-hardening`
- 基线：`c1b413c`
- 最终提交：`d023f070af8d5376bfeee956f7b91883c1875daf` — `(final review fixes)`
- 状态：**DONE**；BLOCKING / MAJOR / MINOR 全部处理，未 push。

## 门禁命令结果

| 命令 | 结果 |
|---|---|
| `pnpm -r build` | exit 0；shared / extension / control-plane 均 `build: Done` |
| `pnpm -C packages/control-plane test` | exit 0；**tests 514 / pass 512 / fail 0 / skipped 2** |
| `pnpm -C packages/extension test` | exit 0；**tests 59 / pass 59 / fail 0 / skipped 0** |
| `node scripts/e2e-restart.mjs` | exit 0；**PASS 18 checks**；daemon#1 / daemon#2 的 `/health.adapters` 三个 agent 均 `available=true` |
| `node --test --experimental-strip-types test/operation-matrix.test.ts`（补跑） | exit 0；**30 tests / 30 pass / 0 fail** |

2 个 skip：真 adapter 冒烟（既有设计）、POSIX-only 进程组测试（Windows 上按 `process.platform` 跳过）。`git diff --check` 通过；提交后工作区干净。

## 逐项修复

1. **C08 矩阵（BLOCKING）**
   - 新增 `packages/control-plane/test/operation-matrix.test.ts`：表驱动 3 agents（claude/codex/pi）× 5 操作（inject/interrupt/attach/handoff/resume）× 2 入口（API route/driver method）= 30 个独立测试。
   - 每个格子断言成功响应形状或错误集合；API 侧复用 `TakeoverEngine` 与脚本化 driver/adapter test double，driver 侧直接调用 driver 方法。`attach` 的 API 能力闸门断言 `422 E_CAP_UNSUPPORTED` 且不调用 driver。
   - 保留 `matrix.test.ts` 的 15 条 transcript 解析矩阵不动。
   - `docs/evidence/phase-0.5c/gate-summary-20261117-0352.md` 与 `regression-20261117-0352.md` 的 C08 已改为引用真实 `operation-matrix.test.ts` 30 格运行，不再把 transcript 矩阵当作操作矩阵。

2. **POST /attach 可用性闸门（MAJOR）**
   - `packages/control-plane/src/server.ts` 在 driver 注册检查之后、能力闸门之前调用与 `/agents` 同源的 `currentAgents()`；`available=false` 时返回 `422 E_AGENT_UNAVAILABLE`（details 含 `agent` / `cap=attach` / `reason`），不再落到 `E_ADAPTER_DOWN`。
   - 新增测试：`POST /attach：agent available=false → 422 E_AGENT_UNAVAILABLE，先于能力闸门且不调用 driver`。

3. **POSIX 进程组 kill（MAJOR）**
   - `process-registry.ts` 的 `defaultTreeKill` POSIX 分支改为 `process.kill(-pid, signal)`；`ESRCH` 时回退直接杀 pid。
   - `child-process.ts` 的 spawn 包装在 POSIX 注入 `detached: true`（Windows 不加，避免新建控制台）；`adapters/claude.ts` 显式 spawn 同样设置 `detached: process.platform !== "win32"`。
   - 新增 `killAll` POSIX 进程组测试：父进程 detached 启动并再 spawn 孙进程，`killAll` 后两者均退出；测试以 `process.platform === "win32"` 跳过。

4. **transcript pending 字段（MINOR）**
   - `GET /sessions/:key/transcript` 的两个文件分页分支都返回 `pending: page.pending`；无路径且无 driver.see 的兜底空页返回布尔 `pending: true`（与空页语义一致）。
   - `api.test.ts` 的 transcript 用例改为断言 `pending: true`，覆盖文件分支透传。

5. **E_ADAPTER_CRASHED（MINOR）**
   - `errors.ts` 的 `WorkbenchErrorCode` 增加 `E_ADAPTER_CRASHED`；`STATUS_BY_CODE` 映射 503。
   - `api.test.ts` 的状态码全表断言、`docs/api/cp-v1.md` 错误表均补充 503 行。

6. **/health.adapters 状态源（MINOR）**（历史记录：本条描述 d023f07 当时实现；`4b42e4e` 已改为只读快照 + 后台探测，当前实现见 `restart-20261117-0352.md`）
   - `server.ts` 的 health 改用 `currentAgents()`，与 `/agents` 共用 30s 探测缓存快照（探测未完成时回退注册表快照）。
   - 新增测试 `GET /health.adapters 与 /agents 共用同一探测缓存（快照语义一致）`，断言两者一致且只探测一次。

7. **文档修正**
   - `restart-20261117-0352.md` / `regression-20261117-0352.md` 删除「e2e-restart 未补 winEnv」旧说法；脚本 `scripts/e2e-restart.mjs:221` 确实注入 `winEnv`，本次复跑三个 agent 均 `available=true`。
   - `docs/api/cp-v1.md`：413 / 415 保留原状态码、code 归一到 `E_BAD_REQUEST`；assets 示例的 `exists` 只留在 skills；checkpoint 示例路径 `.json` → `.md`；health adapters 节说明共享探测缓存快照。

8. **e2e-restart 陈旧 pid 保护（MINOR）**
   - `scripts/e2e-restart.mjs` 的 `killStaleFromHome` 增加命令行 guard：pid 存活但命令行不含 `control-plane` 时只清 pid 文件，不 taskkill / 不发信号。

## 证据位置

- 新增测试：`packages/control-plane/test/operation-matrix.test.ts`
- 关键修改：`packages/control-plane/src/server.ts`、`errors.ts`、`process-registry.ts`、`child-process.ts`、`adapters/claude.ts`
- 测试补充：`api-agents.test.ts`、`api.test.ts`、`process-registry.test.ts`
- 文档：`docs/api/cp-v1.md`、`docs/evidence/phase-0.5c/gate-summary-20261117-0352.md`、`regression-20261117-0352.md`、`restart-20261117-0352.md`
