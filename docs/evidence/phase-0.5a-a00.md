# Phase 0.5-A · A00 证据：Claude handoff 会话载体

- 日期：2026-11-14
- 阶段：Phase 0.5-A / A00（写业务代码前的载体裁决）
- 结论：**方案 A 成立，但 attach 不适用** —— ACP 创建的会话用 `claude --resume <id>` 接管，`claude attach` 只对 `--bg` 后台会话有效
- 证据文件：
  - `spike/acp-probe/evidence/a00-claude-carrier.jsonl`
  - `spike/acp-probe/evidence/a00b-tui-takeover.jsonl`
- 探针脚本：`spike/acp-probe/src/a00.ts`、`spike/acp-probe/src/a00b.ts`

## 1. 问题

PRD / 开发顺序要求先确定 Claude 的 handoff 载体：

- 方案 A：ACP `session/new` 创建的会话，能否用 `claude --resume` / `claude attach` 在原生终端接上？
- 方案 B：若不行，改为 `claude --bg` 建原生后台会话，ACP 用 `session/resume` 控制，接管时先 quiesce 再 `claude attach`。

## 2. 实测环境

| 项 | 值 |
|---|---|
| OS | Windows 11（ConPTY） |
| Node | v24.16.0 |
| Claude Code | 2.1.325（原生二进制 `...\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`） |
| ACP SDK | @agentclientprotocol/sdk 2.6.0（experimental/v2） |
| Claude ACP adapter | @agentclientprotocol/claude-agent-acp 0.107.0（`CLAUDE_AGENT_ACP_PROTOCOL=v2`） |
| PTY | node-pty 1.1.0 + ConPTY |
| 测试 cwd | `E:\pi-workbench\spike\a00-workspace` |

## 3. 步骤与结果

会话 id：`7ce0f985-15e4-461a-82dc-f4051d48acff`，nonce：`A00_MWGJ5OP0`。

| # | 步骤 | 结果 | 证据 |
|---|---|---|---|
| 1 | ACP `initialize` | 通过，`protocolVersion=2`，adapter 声明 `promptQueueing=true`、`session.delete`、`session.systemPrompt.override` | a00 log `initialize` |
| 2 | ACP `session/new` | 返回原生 UUID `7ce0f985-…`（直接就是 Claude 原生 sessionId） | `session_new` |
| 3 | ACP `session/prompt` | 通过，返回 messageId，模型输出 `A00_MWGJ5OP0` | `prompt_response` |
| 4 | `claude agents --json --all` | 该会话可见：`kind="interactive"`、`status="busy"`、cwd 精确匹配 | `native_visibility.agentsHasSession=true` |
| 5 | 原生 transcript | `~/.claude/projects/E--pi-workbench-spike-a00-workspace/<id>.jsonl` 存在，标准 JSONL；两轮交互后 295,917 B | `transcriptBytes=295917` |
| 6 | 运行中 `claude attach <id>` | **失败**：`No job matching '<id>'. Run 'claude agents' to list running sessions.` | `attach_while_running.exitCode=1` |
| 7 | ACP `session/close`（quiesce） | 通过 | `session_close.ok=true` |
| 8 | 原生 `claude -p --resume <id>` 读旧上下文 | 通过，正确答出 `A00_MWGJ5OP0` | `resumeSawNonce=true` |
| 9 | 原生 `claude -p --resume <id>` 写新一轮 | 通过，输出 `A00_NATIVE_TAKEOVER_OK` | `native_resume_write` |
| 10 | 原生交互 TUI `claude --resume <id>`（ConPTY） | 通过：TUI 显示完整历史（含第 3/8/9 步的问答），可键盘输入并执行 | a00b `tuiShot1Tail` |
| 11 | 在 TUI 里注入一轮 prompt | 通过，输出 `A00_TUI_INJECT_OK` | a00b `tuiSawInjectOk=true` |
| 12 | ACP `session/resume` 交回 + prompt | 通过（交回后能继续同一会话） | `acpResumeAfterNative=true`、a00b `acpResumeOk=true` |
| 13 | 关闭后再 `claude attach` | 仍失败（同一 "No job matching"） | `attach_after_close` |

## 4. 结论

1. **载体可行（方案 A）**：ACP `session/new` 建的就是 Claude 原生会话，sessionId 与原生一致；transcript 落在标准位置；原生 `claude --resume`（TUI 与 `-p`）都能接上并保留上下文；ACP `session/resume` 能在人工操作后接回。**双向 handoff 在 Claude 上成立。**
2. **`claude attach` 不是 ACP 会话的接管入口**：attach 只匹配 `--bg` 后台 job（`kind="background"`）。ACP 会话的 `kind` 是 `interactive`，attach 报 "No job matching"。因此 HandoffManager 不能无条件用 attach。
3. **handoff 出口按 session kind 分流**：
   - ACP 会话（kind=interactive）→ PTY 内 `claude --resume <id>`；
   - `--bg` 会话（kind=background）→ `claude attach <id>`。
4. **SessionCaps 需要按来源区分**：ACP 会话 `attach=false`、`resume=true`；`--bg` 会话 `attach=true`、`resume` 需先 `claude stop`（Phase 0 已证）。UI 不能给 ACP 会话显示"attach"按钮。

## 5. 对实现的直接影响

- `adapters/claude.ts` 的 `handoff()` 返回两种接管方式：`{ mode: "resume-tui", cmd: ["claude","--resume", nativeId] }` 或 `{ mode: "attach", cmd: ["claude","attach", nativeId] }`，由 `SessionRef.kind` 决定。
- `SessionCaps.attach` 与 `SessionCaps.resume` 分开上报，不合并成"可接管"。
- 发现层：`claude agents --json --all` 能同时列出 interactive（ACP/本地）与 background 会话，可作为 Claude 的原生发现补充；ACP `session/list` 仍按 cwd 精确匹配。
- transcript 读取要注意**写入延迟**：prompt 结束后 ~1.5 s 内目录可能还是空的（本次首查为空，会话关闭后才落盘）。增量读取必须以"文件出现/变大"为准，不能把首次空目录当作无会话。

## 6. 环境注意事项（非阻塞）

- node-pty 在**无控制台**的分离进程里会打印 `conpty_console_list_agent: AttachConsole failed`（子进程报错），但 PTY 本身读写正常。正式实现应让 daemon 以带控制台的方式启动，或忽略该辅助进程错误。
- Claude ACP adapter 会打印 `failed to generate a session title: Query closed before response received`：会话被我们主动 close 后标题生成失败，属噪音，不影响会话可用性。
- 本次 cwd 的 Claude 运行在 `auto` 权限模式、模型 `deepseek-v4.1-flash`（走本机代理），与协议验证无关。

## 7. 下一步

A00 通过，可进入 A01（pnpm workspace 骨架）。A01–A03 不依赖 Claude 运行时，可先落 daemon 骨架与 SQLite 表。
