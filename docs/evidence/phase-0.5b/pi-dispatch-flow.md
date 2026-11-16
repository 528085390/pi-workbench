# Pi 派发流程实测与 dispatch 租约修复

日期：2026-11-16
分支：feat/phase-0.5b-codex-pi
测试 nonce：c93f6908（修复后）；16b3760e（修复前）

## 结论

真实 daemon + 真实 Pi 的 3 轮 dispatch 全部通过；修复一个会阻塞多轮操作的租约问题后，同一 session 的第二次 inject 也通过。当前 Pi 派发主链路可用，但还不是“无运维即可长期运行”的成熟状态，剩余风险见文末。

## 修复前发现的问题

3 轮 dispatch 本身都成功，但在第 3 轮之后用普通 clientId 继续注入时：

```text
POST /api/cp/sessions/<key>/lease
{"action":"acquire","driver":"pi","clientId":"flow-16b3760e"}
→ HTTP 409 E_LEASE_CONFLICT，heldBy="pi"
```

根因：

- `TakeoverEngine.dispatch` 通过 `#driverWrite(ref, this.#piClientId, ...)` 调 `PiDriver.inject`。
- `PiDriver.inject` 的 `#claim` 以内部身份 `"pi"`（`PI_AGENT_CLIENT_ID`）acquire 租约，但 dispatch 返回前没有释放。
- `TakeoverEngine.inject` 先执行 `leases.assertWriter(key, clientId)`，普通 `flow-*` 客户端会先被这个内部租约挡住，409 发生在 `#driverWrite` 的临时换租约逻辑之前。
- 因此 dispatch 后的 cp_inject / interrupt / checkpoint 对普通调用方不可用，属于真实流程缺陷，不是测试脚本问题。

## 修复

文件：`packages/control-plane/src/takeover.ts`

`dispatch` 的 driver 投递增加 `finally`：投递结束（成功或失败）后，如果当前租约仍是内部 `piClientId`，释放该租约。这样 dispatch 只持有本次投递所需的租约，返回后调用方可以正常 acquire 并继续 inject/interrupt/checkpoint。

新增回归测试：`packages/control-plane/test/api-agents.test.ts`

- 名为“Pi dispatch 投递后释放内部 pi 租约，普通 clientId 可以继续 inject”。
- 假 Pi driver 在 inject 时模拟 `#claim` 获取 `"pi"` 租约；断言 dispatch 返回后租约为空、普通 client 可 acquire、第二次 inject 成功、写操作结束后租约回到扩展身份。

## 修复后真实流程

测试环境：真实 `pi-workbenchd`（同一测试程序内启动，最后 taskkill）、真实 Pi 1.5.2、cwd=E:/pi-workbench/tmp/pi-flow-c93f6908。

| 轮次 | session key | 耗时 | transcript | 工具 | 结果 |
|---|---|---|---|---|---|
| 1 | pi:01a1e4f0-7e08-73db-8bed-f6a6bf9ce954 | 3277ms | 3 条 | 无 | FLOW1_c93f6908，unread 3 |
| 2 | pi:01a1e4f0-89ed-730c-b853-f6cdd807e27c | 3872ms | 5 条 | read | FLOW2_c93f6908，unread 5 |
| 3 | pi:01a1e4f0-990c-7495-a444-5dce925e1b05 | 2238ms | 3→5 条 | 无 | FLOW3A_c93f6908，inject 后 FLOW3B_c93f6908，unread 2 |

第 3 轮的多轮操作：

```text
POST /lease (flow-c93f6908)  → 200
POST /inject               → 200，effective=now
等待回合结束               → status=idle
POST /lease release        → 200
```

三轮回合均为 `status=idle`，transcript 无 `cp_*` 工具调用，子 Pi 无 `[pi-workbench]` 自通知。主 Pi 会话文件在测试前后保持 276 行 / 29 条历史通知，未产生新的刷屏；但本次测试时主 Pi 进程未运行（进程表没有 pi-coding-agent），因此主 Pi 的“回合结束唤醒”没有被这次实机测试重新观察，历史唤醒证据见 `notification-self-loop.md` 与 Codex 唤醒证据。

## 验证

- `pnpm --filter @pi-workbench/control-plane typecheck`：exit 0。
- `pnpm --filter @pi-workbench/control-plane test`：363 tests / 362 pass / 1 skip / 0 fail。
- `pnpm --filter @pi-workbench/extension test`：58 pass / 0 fail。
- `pnpm -r build`：三包 Done。
- `scripts/e2e-three-agents.mjs`：PASS，包含 Claude、Codex、Pi dispatch/attach/inject/handoff/lease/error gates；证据已更新到 `e2e-three-agents.jsonl`。

## 剩余风险 / 后续

1. daemon stderr 中跨会话事件过滤的 debug 日志较频繁（`AdapterUpdate 属于其他会话...`）；过滤正确，但应在事件量上来后降级为采样/调试开关。
2. 主 Pi 需要重新启动或 reload 扩展才能加载最新的 self-filter/通知器代码；旧进程继续运行时不会自动更新。
3. 当前 daemon 在测试程序中启动并在结束时停止，不做长期常驻验证。生产由 Pi 插件 `ensureDaemon` 启动；启动环境必须带标准 `PATHEXT`，否则探测子进程可能误报 Agent unavailable。
4. 租约释放只覆盖 dispatch 投递后的内部 `pi` 租约；若显式用 `rpcCmd --extensions` 加载插件，子 Pi 仍可能重新引入自通知风险，需继续保持受控子进程默认 `--no-extensions`。
