# Pi 通知自激循环修复（2026-11-16）

## 症状

用户报告 Pi 主会话不断收到如下消息，且每次回复后又收到同类消息，计数持续增加：

    [pi-workbench] 1 个会话有更新（未读共 23 条）：
    - pi:01a1e4cf-e03d-76d6-afd0-52aeed053694 本轮结束，游标 0 之后有 23 条
    用 cp_see <key> 读取（peek:true 只看不标记）。

用户同时要求排查整条链路，而不只是压住表面症状。

## 根因

1. PiDriver 启动的 Pi RPC 子进程没有禁用宿主扩展。用户级安装的 pi-workbench 插件因此被加载进每个 cp_dispatch 出来的 Pi 子进程；子 Pi 自己连接 daemon、注册 cp_* 工具，并把“自己的会话”当成远程会话监听。
2. TurnNotifier 与 cp_sessions 没有排除当前 Pi 自己的 session key。子 Pi 调用 cp_sessions 能看到自己，调用 cp_see 读取自己又会把 toolCall/toolResult 写回同一个 jsonl，产生新的未读事件，形成正反馈。
3. wrapToolExecute 对每个 cp_* 调用 noteToolActivity，而 noteToolActivity 会把连续唤醒计数清零。目标是每轮都调 cp_sessions/cp_see，导致 maxConsecutiveWakes=5 永远不触发。
4. TurnNotifier 没有按事件 seq 去重；重连或重复投递时同一事件可以再次唤醒。连续唤醒计数也是全局的且没有时间窗口，长期运行会永久压住后续正常唤醒。

涉及的代码位置：

- E:\pi-workbench\packages\control-plane\src\agents\pi-driver.ts：PiDriver.#createClient 的 RpcClient args。
- E:\pi-workbench\packages\extension\pi-workbench.plugin.ts：currentSessionKey、excludeSessionKeys、startNotifier 生命周期。
- E:\pi-workbench\packages\extension\src\index.ts：WorkbenchClient.sessions 的 excludeSessionKeys 过滤、wrapToolExecute 的工具名传递。
- E:\pi-workbench\packages\extension\src\notify.ts：noteToolActivity、seq 去重、唤醒窗口。

## 修复

### 1. 受控 Pi 子进程隔离宿主扩展

PiDriver 的受控 RPC 子进程默认追加 --no-extensions；只有用户在 rpcCmd 中显式配置 --no-extensions 时才不重复追加。若显式配置 --extension，--no-extensions 仍会保留显式 -e 路径（Pi 1.5.2 的帮助语义），不会被重新加载的宿主插件绕过。

这使得 cp_dispatch agent=pi 出来的子 Pi 只拥有内置 read/bash/edit/write 等工具，不再拥有 cp_* 工具，也不会连接 daemon。

### 2. 当前 Pi 自己的会话过滤

插件在 session_start 用 ctx.sessionManager.getSessionId() 得到当前 session id，存为 pi:<id>；WorkbenchClient.sessions() 过滤这个 key，cp_sessions 与 TurnNotifier.listSessions 共用同一过滤逻辑。

### 3. 观察型工具不再重置连击上限

noteToolActivity 对 cp_sessions、cp_see 直接返回；只有推进型 cp_* 工具才把连续唤醒计数清零并重置窗口。

### 4. 事件去重与唤醒窗口

- handleEvent 对同一 session 的非递增 seq 直接跳过。
- #flushOnce 跳过已通知过的相同或更小 seq。
- 连续唤醒计数超过 wakeWindowMs（默认 60s）后自动恢复。
- session_start/session_shutdown 重新建立/释放通知器，覆盖 /new、/resume、reload。

### 5. 跨会话 AdapterUpdate 隔离

一个 ACP adapter 进程可能同时服务多个 Codex/Claude 会话（Pi 也有一个 driver 监听多条 RPC 流）。原实现只按 attach 的 sessionKey 写事件，不检查 update 的来源，A 会话的 token/tool_call 可能被写进 B 会话，制造假未读并重复唤醒。

修复：

- AdapterUpdate 增加可选的 sessionId；
- ClaudeAdapter 的 #onSessionUpdate / #onPermissionRequest 填入 params.sessionId（Codex 复用同一个 ClaudeAdapter）；
- PiDriver 的 client.onEvent 通过闭包把 ref.nativeId 带进 #emit，newSession 拿到真实 id 后同步改写 pseudo ref；
- EventPipeline.#handleUpdate 在写入前比对 update.sessionId 与 SessionRef.nativeId，不匹配只记 debug 日志并丢弃。

对应测试：packages/control-plane/test/pipeline.test.ts 的“会话隔离”用例、test/adapter.test.ts 的 sessionId 断言、test/pi-driver.test.ts 的 update sessionId 断言。

## 自动化验证

命令与结果：

    pnpm -r build
    # 三包 Done

    pnpm --filter @pi-workbench/control-plane test
    # 362 tests / 361 pass / 1 skip / 0 fail

    pnpm --filter @pi-workbench/extension test
    # 58 tests / 58 pass / 0 fail

新增或更新的测试：

- packages/control-plane/test/pi-driver.test.ts：attach 的 argv 包含 --no-extensions；rpcCmd 透传测试同步更新。
- packages/extension/test/notify.test.ts：观察型工具不重置上限、窗口过期恢复、同一 seq 重放不二次唤醒。
- packages/extension/test/extension.test.ts：excludeSessionKeys 过滤自身会话、wrapToolExecute 传递工具名。
- packages/control-plane/test/pipeline.test.ts：带其他 sessionId 的 AdapterUpdate 不写入当前会话。
- packages/control-plane/test/adapter.test.ts / pi-driver.test.ts：ACP/Pi 的 update 必须携带来源 sessionId。

## 真实 Pi 验证

### A. 旧自激循环已停止

旧目标会话：

    C:\Users\huang\.pi\agent\sessions\--C--Users-huang--\2026-11-16T14-43-11-037Z_01a1e4cf-e03d-76d6-afd0-52aeed053694.jsonl

该文件停在 34 行，最后记录为 2026-11-16T14:44:17.471Z 的 assistant “Understood. 停止操作，结束。”；之后没有再增长。此前 23/25/27/29/31 条的自激序列已终止。

### B. 新 Pi 子进程没有 cp_* 工具

通过 live daemon 发送：

    POST /api/cp/dispatch
    {
      "agent": "pi",
      "cwd": "E:\\pi-workbench",
      "idempotencyKey": "noext-NOEXT_t833goad",
      "task": "检查是否拥有 cp_sessions 工具；没有就回复 NO_CP_TOOLS_NOEXT_t833goad"
    }

返回：

    key=pi:01a1e4db-2966-73e8-8f22-4a4ebf248e84
    transcriptPath=C:\Users\huang\.pi\agent\sessions\--E--pi-workbench--\2026-11-16T14-55-30-662Z_01a1e4db-2966-73e8-8f22-4a4ebf248e84.jsonl

会话最终为 idle，transcript 只有 6 行：
- user 任务；
- assistant thinking 明确说 “My tools are read, bash, edit, write”；
- assistant text 为 NO_CP_TOOLS_NOEXT_t833goad。

没有 cp_* toolCall，也没有任何 [pi-workbench] custom_message。对应的 Pi RPC 进程命令行为：

    node ...pi-coding-agent\dist\cli.js --mode rpc --no-extensions

### C. 显式加载插件的 Pi 仍能自我过滤

为了单独验证 self-filter（而不是只依赖 --no-extensions），用 RpcClient 启动一个显式加载 pi-workbench.plugin.ts 的真实 Pi 会话，设置 PI_WORKBENCH_NOTIFY=0 避免它向别人发消息：

    sessionId=01a1e4dd-7f54-75f3-9da6-83c524ad50a4
    transcript=C:\Users\huang\.pi\agent\sessions\--E--pi-workbench--\2026-11-16T14-58-03-732Z_01a1e4dd-7f54-75f3-9da6-83c524ad50a4.jsonl

提示模型调用一次 cp_sessions。工具结果列出了其他会话（pi:01a1e4db-2966、pi:01a1e4cf-e03d、codex:01a1e4d0、claude:2ea681f8、claude:09f15542 等），但没有列出当前会话自身 pi:01a1e4dd-7f54-75f3-9da6-83c524ad50a4。证明 cp_sessions 的 excludeSessionKeys 真实生效。

### D. 主 Pi 侧

主 Pi 的旧会话在修复前已有 28 条历史 [pi-workbench] custom_message；修复后新目标 pi:01a1e4db 完成时只产生一条正常通知（2026-11-16T14:55:33.527Z），随后主 Pi 读取该目标并结束，没有再次产生同 key 的循环通知。旧历史消息不能被追溯删除，但新的循环已停止。

## 三 Agent E2E

运行：

    E:\nodejs\node.exe --experimental-strip-types scripts/e2e-three-agents.mjs

结果 PASS，nonce=70e351c1，证据：

    E:\pi-workbench\docs\evidence\phase-0.5b\e2e-three-agents.jsonl

关键通过项：Claude dispatch/see/inject/interrupt/checkpoint/handoff/handback；Codex discover 33、HTTP dispatch、handoff、resume-by-native-id；Pi discover 16、RPC attach 2044ms、inject、see、lease conflict before=after=2/newProcesses=0、handoff 后 RPC 进程 2→1；gate7 四种结构化错误。--no-extensions 没有破坏 Pi dispatch 或 handoff。

## 已知边界与后续

- --no-extensions 会关闭 Pi 的扩展发现与内建扩展；受控子进程只保留内置工具。若未来确实需要在子进程内加载其他 Pi 扩展，应改用显式的 --extension <path> 白名单，而不是恢复宿主插件自动发现。
- 修复只对新建或重启后的 Pi 进程生效；正在运行且已加载旧插件的 Pi 进程需要重启 Pi（或重新加载扩展）才会使用新代码。旧测试目标 pi:01a1e4cf 已结束，不会复活。
- 主 Pi 历史里已有的旧通知不会被自动清理；这是用户可见的历史噪声，不影响新事件。
- 本轮仍未把 TurnNotifier 的连续唤醒计数改成 per-session；当前全局窗口足以阻止自激循环，但多会话同时结束时可能提前消耗预算。此项归入 0.5-C 的事件管线技术债。
- 跨会话 AdapterUpdate 隔离已在本轮修复；这是防止假未读 / 重复唤醒的链路级保护，不等同于把通知器的预算策略做到最终形态。
- renderMessage 在未建立读游标时显示“游标 0”是实际游标值，不是循环根因；后续可在文案上说明“尚未读取”。
