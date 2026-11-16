# Phase 0.5-B §18 实现期实测裁定 — Probe Findings

- 日期：2026-11-16 14:05–14:10 CST
- 分支：<code>feat/phase-0.5b-codex-pi</code>
- 环境：Windows；Git Bash；Node <code>v24.16.0</code>；<code>pi 1.5.2</code>；<code>codex-cli 0.167.0</code>
- 边界：只读调研。仅新增本文件；未修改产品代码、未 commit。工作区原有未提交改动保持原样。
- 说明：Windows 的 <code>pi</code> / <code>codex</code> 是 npm shim；Git Bash 下 <code>timeout ... pi</code> 会退出 126，以下统一用 <code>pi.cmd</code> / <code>codex.cmd</code>，且所有 codex 命令都带 timeout。

## 结论摘要

| # | 核实项 | 结论 | 一句话证据 |
|---|---|---|---|
| 1 | Pi provider 现状 | 成立 | <code>timeout 60s pi.cmd --print "say OK"</code> 退出 0、stdout <code>OK</code>、无 402；provider 为 <code>zz</code> / <code>deepseek-v4.1-flash</code>。 |
| 2 | Pi 会话文件 schema | 成立 | 3 个最新 <code>.jsonl</code> 首行均 <code>type=session</code>、<code>version=3</code>，含 <code>id</code>/<code>cwd</code>；assistant <code>content[]</code> 内嵌 <code>thinking</code>/<code>toolCall</code>，<code>toolResult</code> 是独立 message role。 |
| 3 | Pi attach 语义 | 不成立 | 文档只定义 <code>--session</code> 新进程打开/恢复会话文件、<code>switch_session</code> 在当前 RPC 进程内切换 session 文件；没有 attach 到运行中 Pi 进程的语义。 |
| 4 | RpcClient 构造参数与主要方法 | 成立 | <code>RpcClientOptions</code> 为 <code>{cliPath?,cwd?,env?,provider?,model?,args?}</code>；spawn 为 <code>node [cliPath, "--mode","rpc", ...]</code>；事件用 <code>onEvent(listener)</code> 订阅。 |
| 5 | Codex ACP 会话是否落 rollout | 成立 | 34 个 rollout 中 8 个 <code>thread_source</code> 非 <code>user</code>：<code>subagent</code> 7 个、字段缺失 1 个；缺失样本首行 originator 为 <code>pi-workbench-acp-probe</code>（0.166.0 历史文件，0.167.0 未另测）。 |
| 6 | codex-cli 0.167.0 resume 能力 | 成立 | <code>codex resume [SESSION_ID]</code>、<code>codex exec resume [SESSION_ID]</code>、全局及 resume 选项 <code>--no-alt-screen</code> 均在 0.167.0 的 help 中。 |

## 1. Pi provider 现状

复现命令：

~~~bash
cd /e/pi-workbench
timeout 60s pi.cmd --print "say OK"; echo "EXIT_CODE=$?"
~~~

实测输出：

~~~text
stdout:
OK

stderr:
[pi-workbench] 控制面未运行，已尝试自动启动：node E:\pi-workbench\packages\control-plane\dist\cli.js start（pid 27736）

EXIT_CODE=0
~~~

证据：退出码 0，stdout 为 <code>OK</code>，stderr 无 402 / Payment Required。本次 prompt 产生的 session（<code>2026-11-16T06-06-33-255Z_01a1e2f6-e326-7478-989b-6e4e291dfb8e.jsonl</code>）中，<code>model_change</code> 为 <code>provider=zz</code>、<code>modelId=deepseek-v4.1-flash</code>；assistant message 为 <code>provider=zz</code>、<code>model=deepseek-v4.1-flash</code>、<code>api=openai-completions</code>、<code>stopReason=stop</code>、content blocks <code>[text]</code>。第一次用 <code>timeout 60s pi --print "say OK"</code> 时 Git Bash 无法执行 npm shim，返回 126；改用 <code>pi.cmd</code> 后成功。该运行还触发仓库内 Pi 扩展的“控制面未运行，已尝试自动启动”提示（pid 27736），属运行副作用，不是代码改动。

**结论：成立。Pi provider 当前可用，最小 prompt 退出码 0、输出 <code>OK</code>、无 402。**

## 2. Pi 会话文件 schema

采样文件（按 mtime 最新→次新）：

| 文件 | 行数 | type | version | id | cwd | 首行键 |
|---|---:|---|---|---|---|---|
| <code>2026-11-16T06-06-33-255Z_01a1e2f6-e326-7478-989b-6e4e291dfb8e.jsonl</code> | 6 | session | 3 | <code>01a1e2f6-e326-7478-989b-6e4e291dfb8e</code> | <code>E:\pi-workbench</code> | type,version,id,timestamp,cwd |
| <code>2026-11-16T05-10-42-812Z_01a1e2c3-c37c-7767-afc7-51253a716fe1.jsonl</code> | 8 | session | 3 | <code>01a1e2c3-c37c-7767-afc7-51253a716fe1</code> | <code>E:\pi-workbench</code> | type,version,id,timestamp,cwd |
| <code>2026-11-16T04-32-46-104Z_01a1e2a1-0617-70b9-89bc-610cdfababdc.jsonl</code> | 8 | session | 3 | <code>01a1e2a1-0617-70b9-89bc-610cdfababdc</code> | <code>E:\pi-workbench</code> | type,version,id,timestamp,cwd |

首行形状：

~~~json
{"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO-8601>","cwd":"E:\\pi-workbench"}
~~~

3 个文件共 13 条 <code>message</code>：3 system / 3 user / 5 assistant / 2 toolResult。

| 文件 | message 角色序列 | assistant content block types |
|---|---|---|
| 06-06-33 文件 | system → user → assistant | <code>[text]</code> |
| 05-10-42 文件 | system → user → assistant → toolResult → assistant | <code>[thinking, toolCall]</code> / <code>[text]</code> |
| 04-32-46 文件 | system → user → assistant → toolResult → assistant | <code>[toolCall]</code> / <code>[thinking, text]</code> |

结构结论：

- <code>message.content</code> 在 system 中是字符串；在 user / assistant / toolResult 中是 content block 数组。
- assistant <code>content[]</code> **内嵌 thinking 和工具调用**：<code>thinking</code> block 为 <code>{type:"thinking", thinking, thinkingSignature}</code>；工具调用 block 的实际类型名是 <code>toolCall</code>（不是 <code>toolUse</code>），为 <code>{type:"toolCall", id, name, arguments}</code>。
- <code>toolResult</code> **不内嵌在 assistant content 中**；它是独立 message，<code>role="toolResult"</code>，键为 <code>role, toolCallId, toolName, content, details, isError, durationMs, timestamp</code>，其 <code>content</code> 通常是 <code>[{type:"text", text}]</code>。
- 因此 B05 枚举应覆盖 assistant 的 <code>text</code> / <code>thinking</code> / <code>toolCall</code>，并把 <code>toolResult</code> 当作独立消息角色处理。

复现命令：

~~~bash
cd /e/pi-workbench
find "$HOME/.pi/agent/sessions" -name '*.jsonl' -printf '%T@ %p\n' | sort -rn | head -3

node -e 'const fs=require("fs");for(const f of process.argv.slice(1)){const a=fs.readFileSync(f,"utf8").trim().split(/\r?\n/).map(JSON.parse);console.log("\n"+f);console.log({type:a[0].type,version:a[0].version,id:a[0].id,cwd:a[0].cwd,keys:Object.keys(a[0])});for(const r of a)if(r.type==="message")console.log(" ",r.message.role,Array.isArray(r.message.content)?r.message.content.map(b=>b.type):typeof r.message.content)}' \
  "$HOME/.pi/agent/sessions/--E--pi-workbench--/2026-11-16T06-06-33-255Z_01a1e2f6-e326-7478-989b-6e4e291dfb8e.jsonl" \
  "$HOME/.pi/agent/sessions/--E--pi-workbench--/2026-11-16T05-10-42-812Z_01a1e2c3-c37c-7767-afc7-51253a716fe1.jsonl" \
  "$HOME/.pi/agent/sessions/--E--pi-workbench--/2026-11-16T04-32-46-104Z_01a1e2a1-0617-70b9-89bc-610cdfababdc.jsonl"
~~~

**结论：成立。首行字段为 <code>type/version/id/timestamp/cwd</code>（均 version 3）；assistant content 内嵌 <code>thinking</code> 与 <code>toolCall</code>，<code>toolResult</code> 为独立 message role。**

## 3. Pi attach 语义

文档原文：

- <code>docs/cli.md:92-93</code>：<code>--session &lt;path|id&gt;</code> — “Opens a session by file path or full/partial ID, and resumes it in its working directory.”
- <code>docs/sessions.md:21</code>：<code>--resume</code>、<code>/resume</code>、<code>--session</code>、<code>/import</code> 的 working directory 是 “The session's working directory, which can differ from the current directory”。
- <code>docs/rpc-commands.md:592-608</code>：<code>switch_session</code> — “Load a different session file. Can be canceled by a <code>session_before_switch</code> extension event handler.” 请求 <code>{"type":"switch_session","sessionPath":"/path/to/session.jsonl"}</code>，响应 <code>{"cancelled":false|true}</code>。
- 对 <code>rpc.md</code> / <code>rpc-commands.md</code> / <code>sessions.md</code> / <code>cli.md</code> 搜索 <code>lock|locked|another process|concurrent|in use|already running</code>：无相关命中。

判断：文档没有“连接/控制另一个运行中 Pi 进程”的 attach 语义。<code>pi --session</code> 是启动新进程按路径或 ID 打开并恢复会话文件；<code>switch_session</code> 是在当前 RPC 进程内部把活动会话切换为另一个 session 文件，不连接另一个运行中的进程；文档也未承诺同一 session 文件可被两个进程同时操作，未提锁或并发写安全。因此若需与运行中的 Pi 会话交互，只能复用同一个 RPC 进程，不能从第二个进程 attach。

复现命令：

~~~bash
cd /e/pi-workbench
grep -n -A2 -E -- '--session|switch_session' \
  "$HOME/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/cli.md" \
  "$HOME/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md" \
  "$HOME/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/rpc-commands.md"
~~~

**结论：不成立。Pi 没有 attach 到运行中会话的语义；<code>--session</code> 只打开/恢复会话文件，<code>switch_session</code> 只在当前 RPC 进程内切换会话文件。**

## 4. RpcClient 的构造参数与主要方法

来源：<code>dist/modes/rpc/rpc-client.d.ts:14-27,35-247</code>；<code>dist/modes/rpc/rpc-client.js:31-46</code>。

| 项 | 内容 |
|---|---|
| 构造参数 <code>RpcClientOptions</code> | <code>cliPath?: string</code>（默认 <code>"dist/cli.js"</code>）、<code>cwd?: string</code>、<code>env?: Record&lt;string,string&gt;</code>、<code>provider?: string</code>、<code>model?: string</code>、<code>args?: string[]</code> |
| spawn | <code>spawn("node", [cliPath, "--mode","rpc", ...(provider?["--provider",provider]:[]), ...(model?["--model",model]:[]), ...(args??[])], {cwd, env:{...process.env,...env}, stdio:["pipe","pipe","pipe"]})</code> |
| 事件订阅 | <code>type RpcEventListener = (event: JsonAgentSessionEvent) =&gt; void; onEvent(listener: RpcEventListener): () =&gt; void</code>；返回取消订阅函数；辅助 <code>waitForIdle(timeout?)</code>、<code>collectEvents(timeout?)</code>、<code>promptAndWait(message, images?, timeout?)</code> |
| 生命周期 | <code>start()</code>、<code>stop()</code>、<code>getStderr()</code>、<code>onEvent()</code> |
| prompt / 队列 | <code>prompt()</code>、<code>steer()</code>、<code>followUp()</code>、<code>abort()</code>、<code>clearQueue()</code> |
| session | <code>newSession()</code>、<code>getState()</code>、<code>switchSession()</code>、<code>fork()</code>、<code>clone()</code>、<code>getForkMessages()</code>、<code>getEntries()</code>、<code>getTree()</code>、<code>getLastAssistantText()</code>、<code>setSessionName()</code>、<code>getMessages()</code>、<code>getCommands()</code>、<code>exportHtml()</code>、<code>getSessionStats()</code> |
| model / thinking | <code>setModel()</code>、<code>cycleModel()</code>、<code>getAvailableModels()</code>、<code>setThinkingLevel()</code>、<code>cycleThinkingLevel()</code>、<code>getAvailableThinkingLevels()</code>、<code>setSteeringMode()</code>、<code>setFollowUpMode()</code> |
| compaction / retry | <code>compact()</code>、<code>setAutoCompaction()</code>、<code>setAutoRetry()</code>、<code>abortRetry()</code> |
| bash | <code>bash()</code>、<code>abortBash()</code> |

注意：<code>cliPath</code> 默认值是相对路径，按 spawn 的 <code>cwd</code> 解析；从 <code>E:\pi-workbench</code> 这类非包根目录使用时，应显式传包内 <code>dist/cli.js</code> 的绝对路径（或把 cwd 指到包根），否则 <code>node dist/cli.js</code> 找不到入口。

附注：<code>newSession(parentSession?)</code> 的 .d.ts 返回类型只有 <code>{cancelled:boolean}</code>（<code>rpc-client.d.ts:87-93</code>）；新建后的 id / 文件路径需再调 <code>getState()</code>。<code>RpcSessionState</code> 含 <code>sessionId: string</code> 和可选 <code>sessionFile?: string</code>（<code>rpc-types.d.ts:148-161</code>）。

复现命令：

~~~bash
P="$HOME/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent"
sed -n '14,27p;35,247p' "$P/dist/modes/rpc/rpc-client.d.ts"
sed -n '26,46p' "$P/dist/modes/rpc/rpc-client.js"
sed -n '148,161p' "$P/dist/modes/rpc/rpc-types.d.ts"
~~~

**结论：成立。构造参数 6 个，spawn 使用 <code>node [cliPath, "--mode","rpc", ...]</code>，事件通过 <code>onEvent(listener)</code> 订阅，主要方法如上表。**

## 5. Codex ACP 会话是否落 rollout

扫描 <code>~/.codex/sessions</code> 下全部 <code>*.jsonl</code>，只解析每个文件首行 <code>session_meta.payload</code>：

| thread_source | 数量 | 占比 |
|---|---:|---:|
| <code>user</code> | 26 | 76.5% |
| <code>subagent</code> | 7 | 20.6% |
| 缺失（payload 无字段） | 1 | 2.9% |
| **总计** | **34** | **100%** |

非 <code>user</code> 样本共 8 个：7 个为 <code>thread_source=subagent</code>、<code>source=object(thread_spawn)</code>、<code>originator=Codex Desktop</code>、<code>cli_version=0.167.0-alpha.3.2</code>、cwd 为 <code>E:\z7z8\resume-internship\scratch</code>；另 1 个为：

| 文件 | thread_source | source | originator | cli_version | cwd |
|---|---|---|---|---|---|
| <code>rollout-2026-11-14T09-56-39-01a1d7c5-6010-7a71-ba7d-686a54eedb7c.jsonl</code> | **缺失** | vscode | <code>pi-workbench-acp-probe</code> | 0.166.0 | <code>E:\pi-workbench\spike\workspace</code> |

该样本首行 <code>payload</code> 明确没有 <code>thread_source</code> 字段；<code>originator</code> 为 <code>pi-workbench-acp-probe</code>，会话 id 为 <code>01a1d7c5-6010-7a71-ba7d-686a54eedb7c</code>。这是目前能找到的最接近 ACP <code>session/new</code> 的 rollout 样本；它是 <code>cli_version=0.166.0</code> 的历史文件，未在 0.167.0 上重新创建 ACP 会话验证。

复现命令：

~~~bash
find "$HOME/.codex/sessions" -name '*.jsonl' | wc -l

find "$HOME/.codex/sessions" -name '*.jsonl' -print0 \
  | xargs -0 -n1 sh -c 'head -1 "$0"' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c={};for(const l of s.trim().split(/\n/)){const p=JSON.parse(l).payload||{};const k=p.thread_source??"(missing)";c[k]=(c[k]||0)+1}console.log(c)})'
~~~

**结论：成立。存在非 <code>user</code> 的 rollout：34 个中 8 个，7 个 <code>subagent</code>、1 个 <code>thread_source</code> 缺失且 originator 为 <code>pi-workbench-acp-probe</code>。**

## 6. codex-cli 0.167.0 的 resume 能力

版本：<code>timeout 30s codex.cmd --version</code> → <code>codex-cli 0.167.0</code>。

实测 help（全部带 timeout，均退出 0）：

| 能力 | 证据 | 结论 |
|---|---|---|
| <code>codex resume &lt;id&gt;</code> | <code>timeout 15s codex.cmd help resume</code> 输出：<code>Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]</code>；SESSION_ID 为 “Session id (UUID) or session name”。 | 存在 |
| <code>codex exec resume &lt;id&gt;</code> | <code>timeout 15s codex.cmd exec help resume</code> 输出：<code>Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]</code>；SESSION_ID 为 “Conversation/session id (UUID) or thread name”。 | 存在 |
| <code>--no-alt-screen</code> | <code>timeout 30s codex.cmd --help</code> 与 <code>codex help resume</code> 均列出：<code>--no-alt-screen</code> — “Disable alternate screen mode. Runs the TUI in inline mode, preserving terminal scrollback history.” | 存在 |

补充：<code>codex --help</code> 的 Commands 包含 <code>resume</code>（“Resume a previous interactive session (picker by default; use --last to continue the most recent)”）；<code>codex exec --help</code> 的 Commands 包含 <code>resume</code>（“Resume a previous session by id or pick the most recent with --last”）。包内只有 <code>README.md</code>、<code>bin/codex.js</code>、<code>package.json</code>，没有可 grep 的 CLI 文档/源码，因此以 <code>codex help</code> 输出为准。未裸跑 <code>codex resume --help</code>，使用带 15s timeout 的 <code>codex help resume</code> 替代。

复现命令：

~~~bash
timeout 30s codex.cmd --version
timeout 30s codex.cmd --help
timeout 30s codex.cmd exec --help
timeout 15s codex.cmd help resume
timeout 15s codex.cmd exec help resume
~~~

**结论：成立。<code>codex resume &lt;id&gt;</code>、<code>codex exec resume &lt;id&gt;</code> 和 <code>--no-alt-screen</code> 在 codex-cli 0.167.0 均存在。**

## 附：边界与副作用

- 本次仅新增 <code>docs/evidence/phase-0.5b/probe-findings.md</code>，未修改其他文件、未 commit。
- 调研开始时 <code>git status --porcelain</code> 已有他人的未提交改动（<code>packages/control-plane</code> 等）；本次未触碰。
- 运行 <code>pi.cmd --print "say OK"</code> 时，Pi 扩展提示“控制面未运行，已尝试自动启动”（pid 27736）；这是运行副作用，不是代码改动。检查时该 pid 已不存在。
