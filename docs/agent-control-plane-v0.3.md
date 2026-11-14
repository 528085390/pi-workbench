# Pi Agent 控制面 v0.3 复核：ACP v2 薄控制面方案

> 版本：v0.3-recheck（评估稿）
> 日期：2026-11-14
> 输入：`docs/PRD.md` v0.3.0（2026-11-13）、`docs/agent-control-plane.md` v0.2、`docs/方案评估与落地建议.md` v0.2
> 状态：评估完成，待拍板；本轮未安装依赖、未写产品代码

**一句话结论：不要再为每个 Agent 手写一套控制适配器。用 ACP v2 的官方适配器做“手脚”，Pi 只自研“治理层 + 控制台 + 记忆/知识层”。**

---

## 0. 一页结论

### 0.1 推荐路线：A′ — ACP v2 薄控制面

v0.2 评估把“全 ACP”评为 13/20，主要顾虑是适配器生态不成熟。这个前提在 2026-11 已经变了：

| 事实 | 证据 | 影响 |
|---|---|---|
| ACP 已到 v2，且 v2 把会话能力做成了基线 | `session/new`、`session/list`、`session/resume`、`session/close`、`session/prompt`、`session/cancel`、`session/update` 都是 v2 基线；`state_update` 区分 `running` / `requires_action` / `idle`，还带 `background` 列表 | “发现会话、恢复会话、看状态、取消、后台任务”不再需要我们发明协议 |
| Claude 有官方 ACP v2 适配器 | `@agentclientprotocol/claude-agent-acp@0.107.0`，README 明写 v2 提供 session baseline、`session/fork`、`session/status`、`session/options`，并直接运行 Claude Code | 不需要自己写 Claude adapter |
| Codex 有官方 ACP v2 适配器 | `@agentclientprotocol/codex-acp@2.6.0`，stdio ACP server，内部启动 Codex App Server；源码含 `AcpV2*`、`SessionIndexService`、`SteeringQueue` 与 v2 测试 | 不需要自己写 Codex adapter；还能拿到 mid-turn steering |
| Pi 自己有 SDK / RPC | `createAgentSession`、`SessionManager`、`pi --mode rpc`、JSONL 会话树 | Pi 自己的会话不需要 ACP 包装，直接进程内管理 |
| DSH 仍没有可用的 MCP Server 形态 | DSH 是 MCP Client；`windows-mcp` 可被 Pi 直连；DSH 插件/IM/Cron/Skills 没有现成 MCP Server | DSH 继续后置，走 pty 或 windows-mcp，不阻塞主线 |

**所以推荐架构变成：**

~~~text
Pi TUI / React 控制台 / 手机 PWA
            │  HTTP + WebSocket
   pi-workbenchd（Node 24 / TypeScript）
   ├─ SessionRegistry + EventStore（SQLite WAL）
   ├─ LeaseManager + CheckpointStore
   ├─ HandoffManager（原生终端接管/交回）
   ├─ ACP Host
   │   ├─ claude-agent-acp（ACP v2）→ Claude Code 原生会话
   │   └─ codex-acp（ACP v2）→ Codex App Server 原生线程
   ├─ Pi Runtime Adapter（Pi SDK / RPC）→ Pi 原生会话
   └─ Pty Adapter（node-pty）→ DSH / 其他无协议 CLI
            │  MCP
   AssetBridge（MCP 注册、skills 投影、memory 托管段落）
~~~

### 0.2 复用与自研的分界线

| 层 | 复用 | 自研 |
|---|---|---|
| Agent 运行时 | Claude Code、Codex、Pi 本身；不重写 agent loop | 无 |
| 会话协议 | ACP v2（Claude/Codex）；Pi SDK（Pi） | 只写 ACP Host 的连接/重连/版本协商 |
| 会话治理 | 无现成包 | SessionRegistry、EventStore、Lease、Checkpoint、Handoff |
| 工具/资产 | MCP、各家 skills 目录 | AssetBridge：MCP 注册、skills 投影、memory 托管段落 |
| 记忆/知识 | 可借鉴 pi-memory / pi-knowledge 的思路 | 按 PRD schema 自研薄扩展 + SQLite FTS5 |
| UI | 可借鉴 Happy / CloudCLI / Claude Squad 的交互 | React 控制台（会话矩阵、接管视图、事件流） |

**一句话：复用“Agent 的身体”，自研“Agent 的调度台和记忆”。**

### 0.3 成本与工期

| 阶段 | 内容 | 工期 |
|---|---|---|
| Phase 0 | ACP v2 + 原生接管 Spike，只验证 | 1–2 天 |
| Phase 1 | daemon 核心：ACP Host、SessionRegistry、EventStore、REST/WS | 3–5 天 |
| Phase 2 | React 控制台 MVP：会话矩阵、对话、接管、Agent 状态 | 2–3 天 |
| Phase 3 | 记忆 + 知识库：schema、工具、FTS5、页面 | 3–4 天 |
| Phase 4 | Handoff 原生终端、资产桥、DSH pty、打包 | 2–3 天 |
| **合计** | 到可用 MVP | **11–17 天**；含缓冲 15–20 天 |

这比 v0.2 的“每 Agent 一个 adapter”少写 2–3 个适配器，但控制台和治理层仍是实打实的工作量。**不要把“复用 ACP”误当成“没有自研”。**

### 0.4 对 v0.2 结论的三处修正

1. **v0.2 说“控制面没有现成包，必须自研 1.2–1.8k 行”。** 结论仍成立一半：治理层没有现成包；但“每 Agent 的协议适配”已经有官方 ACP v2 适配器，不需要自己写 Claude/Codex adapter。
2. **v0.2 说“ACP 只作未来出口，不进 v1”。** 现在应改为“ACP 作 v1 主干的会话协议”，因为 v2 的 session baseline 正好覆盖 PRD 的 see/inject/resume/cancel。
3. **v0.2 把 Claude Code 的 `attach/logs/agents --json` 当作主控制通道。** 这些仍是原生接管的关键，但不应成为 Pi 内部唯一的控制方式；Pi 内部用 ACP，原生终端接管用 `claude attach` / `claude --resume`。两者是“控制面”和“人工接管面”，不是二选一。

### 0.5 需要拍板的 6 件事

1. 接受 **A′：ACP v2 薄控制面** 作为主线，不再按 Agent 手写 adapter。
2. 接受 v1 的 **Handoff = 先 quiesce 再交驱动权**，不承诺两个 driver 同时写同一条会话。
3. 接受 **SQLite WAL 事件库 + FTS5**，不再用 JSON 索引 + MiniSearch 作为主存储。
4. Pi 自己的会话走 **Pi SDK/RPC**，不用 ACP 包一层；ACP 只接 Claude/Codex。
5. DSH 继续后置：先做 `windows-mcp` 直连和 pty 兜底，不在主线上做 DSH 插件移植。
6. 先做 Phase 0，产出能力矩阵后再写产品代码。

---

## 1. 需求翻译：控制面到底要什么

PRD v0.3.0 把需求从“Pi 是唯一入口”升级为“Pi 是唯一控制面”。这不是一句口号，它要求 Pi 同时承担四种职责：

| 职责 | 具体含义 | 失败表现 |
|---|---|---|
| **发现** | 知道 Claude/Codex/Pi/DSH 现在有哪些会话、各自什么状态、在哪个 cwd | 只能看到自己刚派出去的那条，看不到用户原来就在跑的会话 |
| **看见** | 读 transcript、订阅实时事件、看到工具调用和权限请求 | 只能等最终文本，无法判断它卡在哪 |
| **插入** | 在任务运行中追加指令、回答权限问题、改变方向 | 只能 kill 重来，上下文丢失 |
| **交接** | 把驱动权交给原生终端，人干完再交回 Pi；全程不丢上下文 | 人和 Pi 各写各的，会话损坏或上下文断裂 |

PRD 的 `see / inject / handoff` 三动作、`Lease`、`Checkpoint`、`SessionCaps` 都是对的。需要补的是：**这些能力不应该由每个 Agent 各实现一遍，而应该由统一的会话协议提供。**

### 1.1 “接管资产”要拆成四件事，不要混为一谈

| 资产 | 能标准化的部分 | 不能标准化的部分 | 结论 |
|---|---|---|---|
| 工具 | MCP（stdio / HTTP） | 各家的内置工具、权限模型 | 用 MCP 统一注册；内置工具只做能力声明，不强行搬家 |
| 插件 | MCP server + Markdown skills | 二进制插件、宿主专属钩子 | 只承诺 MCP + skills；DSH 11000+ 插件不移植 |
| 会话 | ACP v2 session baseline | 各家原生 TUI 的按键/布局 | 借读不搬家；原生终端只做 handoff |
| 记忆 | 文件格式 + 注入协议 | 各家内部记忆实现 | Pi 是唯一 source of truth；向 AGENTS.md/CLAUDE.md 投影托管段落 |

**重要判断：** “Pi 全权接管”不等于“把所有东西搬进 Pi 的数据库”。会话仍然住在原生 Agent 里，Pi 拿的是**寻址权、事件流、租约和检查点**。这就是 PRD 说的“借读不搬家”。

---

## 2. 复核方法与证据

本轮做了三类核验：

1. **本机 CLI 实测**：Claude Code 2.1.323、Codex 0.167.0、Pi 1.5.2；只读 `--help`、`agents --json`、`daemon status` 等无副作用命令；未启动真实长任务。
2. **协议与适配器核验**：ACP v2 官方文档、schema、prompt lifecycle；npm 上三个适配器的版本、README、源码目录结构。
3. **成熟方案扫描**：GitHub 2026-11-13/14 数据；重点看“多端会话管理 / 远程接管 / 控制面”，不把通用聊天 UI 混进来。

### 2.1 本机关键事实

| 事实 | 证据 |
|---|---|
| Claude Code 有后台会话主管 | `claude --help` 明写 `--bg/--background`、`agents`、`attach`、`logs`、`stop`、`rm`、`respawn`；`claude daemon --help` 有 `run/status/logs/uninstall/stop` |
| `claude agents --json` 可用 | 实测返回 JSON 数组；观察到 `pid`、`cwd`、`kind`、`startedAt`、`sessionId`、`name`、`status` 字段；`--all` 含已完成；不需要 TTY |
| Claude 支持“在后台继续同一条会话” | `--bg` 帮助原文：配合 `--resume <session-id>` 会在同一 ID 下继续；如果会话已在运行，会起一个副本并明确提示 |
| Codex 有官方 App Server | `codex app-server` 是 JSON-RPC 2.0，支持 stdio/unix/ws，含 `daemon`、`proxy`、`generate-ts`、`generate-json-schema`；`--listen ws://` 可暴露 WebSocket |
| Codex 有队列/恢复/分叉 | `codex queue --thread <id> --message <text>`、`codex resume`、`codex exec resume`、`codex fork` |
| Pi 有原生会话恢复 | `pi --session <path|id>`、`--resume`、`--fork`、`--continue`；会话是 JSONL 树 |
| Pi RPC 是单控制通道 | `pi --mode rpc` 的 stdout 专用于协议；双客户端会冲突，必须租约 |

### 2.2 ACP v2 的关键能力

ACP v2 是 JSON-RPC 2.0，Agent 和 Client 双向请求；v2 的 session 基线包括：

| 方法/通知 | 作用 | 对 PRD 的意义 |
|---|---|---|
| `session/new` | 新建会话 | dispatch 即建可寻址会话 |
| `session/list` | 列出已知会话 | 发现用户已有的原生会话，不只是 Pi 派出去的 |
| `session/resume` | 恢复会话，可 replay 历史 | handoff 交回 Pi 后恢复上下文 |
| `session/close` | 关闭会话，取消前台/后台工作 | 交接前安全释放驱动权 |
| `session/prompt` | 发送用户消息，返回 messageId | inject 的标准入口 |
| `session/cancel` | 取消前台工作 | interrupt |
| `session/update` | 流式消息、工具调用、计划、终端、状态、权限 | 控制台事件流 |
| `state_update` | `running` / `requires_action` / `idle`，带 stopReason 和 background 列表 | 会话矩阵的原子状态 |
| `session/request_permission` | Agent 向 Client 要权限 | UI 弹权限卡片 |

v2 仍是 **draft**。这意味着：要锁版本、做 capability negotiation、保留 v1 回退；不能把“今天能跑”当成“永远稳定”。

### 2.3 三个适配器的成熟度

| 适配器 | 版本（2026-11-14） | 协议 | 作用 | 结论 |
|---|---|---|---|---|
| `@agentclientprotocol/claude-agent-acp` | 0.107.0 | ACP v2（也服务 v1） | 用 Claude Agent SDK/Claude Code 提供 ACP agent；v2 有 session/list、resume、close、fork、status、options、subagents | **推荐作为 Claude adapter** |
| `@agentclientprotocol/codex-acp` | 2.6.0 | ACP v2（源码含 v2 路由） | stdio ACP server，启动 Codex App Server；支持 steering、background tasks、session index | **推荐作为 Codex adapter**；Phase 0 用 `initialize protocolVersion=2` 实测 |
| `pi-acp` | 0.0.34 | ACP v1（MVP） | 把 `pi --mode rpc` 桥成 ACP；session/load 映射 Pi 会话文件 | 可作参考/备选；主线用 Pi SDK/RPC 直连，不依赖它 |

**为什么不用 `pi-acp` 作 Pi 的主适配器？** Pi 本身就是控制面的宿主，进程内 `createAgentSession` 比“再包一层 ACP 子进程”更简单，也更容易拿到完整事件和 session 树。`pi-acp` 留作“Pi 作为 ACP agent 被 Zed 等外部客户端驱动”的出口。

---

## 3. 成熟方案扫描：为什么没有直接可用的底座

### 3.1 开源项目对比

| 项目 | 数据（2026-11-14） | 它解决什么 | 为什么不能直接当 Pi 控制面 | 可借鉴什么 |
|---|---|---|---|---|
| **Happy**（slopus/happy） | 24.6k stars，MIT，Swift，2026-11-13 活跃 | 手机/Web/桌面远程控制 Claude/Codex/Gemini/ACP agents，E2E 加密，多人协作 | 它是“远程客户端 + relay”，不是 Pi 的本地控制面；没有 Pi 会话/记忆/知识库；引入它会多一个云端信任边界 | 移动端配对、断线重连、E2E 会话同步、极简接管 UX |
| **Omnara** | 3.4k stars，Apache-2.0，Go，2026-11-13 活跃 | Managed agent platform/control plane：REST/SDK、Postgres 事件日志、workers、approvals、machines | 它要托管自己的 agent runtime，不是接管原生 CLI 会话；会把 Pi 变成它的一个 worker | 事件溯源、审批模型、机器/沙箱抽象 |
| **CloudCLI / claudecodeui** | 14.6k stars，AGPL-3.0，TS | Claude Code/Cursor CLI/Codex 的桌面+手机 Web UI、终端、文件/Git | 没有 Pi 控制面；AGPL 对闭源分发不友好；以“终端会话”为中心，不是租约/检查点 | 会话列表、移动端布局、终端面板 |
| **Claude Squad** | 8.8k stars，AGPL-3.0，Go | tmux + git worktree 的多 Agent TUI 管理 | Windows 需要 tmux/WSL；没有 Web/手机；没有跨 Agent 统一事件 | “会话 supervisor + worktree”模型、handoff 交互 |
| **Yepanywhere** | 550 stars，MIT，TS | Claude/Codex 自托管 Web UI、推送、复用已有会话历史 | 功能面窄，没有控制面治理层 | 推送、历史会话复用、轻量 Web 结构 |
| **Vibe Kanban** | 28.7k stars，Apache-2.0，Rust | 多 Agent 任务看板 | README 明写 **sunsetting**，不应作为底座 | 任务卡片/看板视图 |
| **Tether / Morndo** | 18 / 1 stars，early | “远程控制 AI agents”概念 | 太早期，不能承担个人主控面 | 概念验证、审批/passkey 思路 |
| **pi-subagents** | 0.88.1，MIT | Pi 内子代理、并行、workflow、外部 CLI profiles | 工具调用式投递，不可接管；只适合快任务 | 快任务通道、agent 定义、递归 guard |
| **pi-web（@ygncode）** | 0.0.1-beta.38 | Pi 的 Go 单二进制 Web/PWA、多会话、SSE、Tailscale | 聊天 UI，不是控制台；没有会话矩阵/租约/接管 | PWA、Tailscale、移动端、单二进制部署 |
| **pi-memory / pi-knowledge** | 0.4.2 / 0.14.0 | Pi 记忆 / 本地 RAG | schema、存储、中文检索与 PRD 不一致；直接采用会改需求 | 记忆注入、daily/scratchpad、索引/检索的工程经验 |

**结论：** 没有任何开源项目同时满足“Pi 唯一控制面 + Claude/Codex/DSH + 原生会话接管 + 租约/检查点 + 记忆/知识库”。但“会话协议 + 两个官方适配器”已经成熟，剩下的是**治理层和控制台**，这正是应该自研的部分。

### 3.2 为什么不用 Open WebUI / LibreChat / LobeHub

这三个是“聊天/Agent 平台”，它们自己就是 agent runtime：模型通过 OpenAI 兼容接口接入，会话、工具、RAG 都在平台内。把它们作为底座会把架构反转成“平台是主，Pi 是模型/工具”，与“Pi 是唯一控制面”直接冲突。它们适合做“通用聊天 UI 参考”，不适合做本项目的底座。

---

## 4. 方案对比：A′ 为什么胜出

| 路线 | 做法 | 资产接管 | 双向会话 | 可接管分派 | 可维护 | 结论 |
|---|---|---:|---:|---:|---:|---|
| **A′ ACP v2 薄控制面** | ACP Host + 官方 Claude/Codex adapter + Pi SDK；自研治理/UI | 4 | 4 | 5 | 5 | **推荐** |
| **B 原生 adapter 聚合** | 每 Agent 手写 daemon/RPC/CLI adapter | 4 | 5 | 5 | 2 | 可用，但重复造轮子；只保留 Pi/DSH 的 native adapter |
| **C tmux/pty 万用** | 所有 Agent 跑 pty，读写屏幕 | 2 | 3 | 5 | 4 | 兜底；无结构化事件，不适合做主路径 |
| **D 现状 subagent** | `pi-subagents` 投递 | 1 | 1 | 1 | 5 | 只做快任务 |

**A′ 的关键优势不是“少写代码”，而是“把会话语义放在标准协议上”**：

- 新增一个 ACP agent（未来某个编辑器/IDE/新 CLI）时，只加一个 adapter 配置，不改核心。
- 权限、取消、计划、工具调用、后台任务都有标准事件，UI 不需要为每家写解析器。
- 会话恢复/关闭/列表是协议基线，不是某家 CLI 的私有条目。
- 官方适配器由上游维护，Claude/Codex 升级时我们跟着升级版本，而不是逆向私有条目。

**B 仍然保留在两个地方：** Pi 自己的会话（SDK 直连）和 DSH 的 pty（没有 ACP）。这不是“路线摇摆”，而是“有标准就用标准，没标准才写 native”。

---

## 5. 目标架构

### 5.1 分层

~~~text
┌─────────────────────────────────────────────────────────────┐
│ 客户端层                                                     │
│  Pi TUI  │  React 控制台（PC/PWA/浏览器）  │  手机 PWA       │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP / WebSocket（localhost 免鉴权，远程 token）
┌──────────────────────────▼──────────────────────────────────┐
│ pi-workbenchd（单实例 daemon，端口 7331）                    │
│                                                             │
│  API 层：/api/cp/sessions、transcript、inject、interrupt、   │
│          lease、handoff、checkpoint、dispatch、agents        │
│  WS：token / tool_call / tool_result / done /                │
│      session_status / needs_input / lease_changed            │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ SessionRegistry│ │ EventStore   │  │ LeaseManager     │   │
│  │ + Capability  │  │ SQLite WAL   │  │ + Checkpoint     │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         └─────────────────┼───────────────────┘             │
│                    ┌──────▼───────┐                          │
│                    │ HandoffManager│                         │
│                    └──────┬───────┘                          │
│         ┌─────────────────┼──────────────────┐              │
│  ┌──────▼──────┐   ┌──────▼──────┐   ┌───────▼───────────┐  │
│  │ ACP Host    │   │ Pi Runtime  │   │ Pty Adapter       │  │
│  │ Claude/Codex│   │ SDK / RPC   │   │ DSH / other CLI   │  │
│  └──────┬──────┘   └──────┬──────┘   └───────┬───────────┘  │
└─────────┼─────────────────┼──────────────────┼──────────────┘
          │ stdio JSON-RPC  │ in-process       │ ConPTY
   ┌──────▼──────┐   ┌──────▼──────┐   ┌───────▼───────────┐
   │claude-agent-│   │ Pi sessions │   │ DSH desktop       │
   │acp / codex- │   │ JSONL tree  │   │ (terminal only)   │
   │acp          │   │             │   │                   │
   └─────────────┘   └─────────────┘   └───────────────────┘

   AssetBridge → MCP servers / skills / AGENTS.md / CLAUDE.md
~~~

### 5.2 核心数据

| 实体 | 关键字段 | 说明 |
|---|---|---|
| `SessionRef` | `key`、`agent`、`nativeId`、`acpSessionId`、`cwd`、`status`、`driver`、`capabilities`、`lineage`、`transcriptPath` | `key` 是 Pi 的稳定标识；`nativeId` 是 Claude session UUID / Codex thread ID / Pi session file id |
| `SessionEvent` | `seq`、`sessionKey`、`type`、`payload`、`source`、`ts`、`idempotencyKey` | append-only；UI 状态由事件投影，不直接改库 |
| `Lease` | `sessionKey`、`driver`（pi/human/none）、`clientId`、`expiresAt`、`heartbeatAt` | 单会话单 writer；`see` 可以多读者 |
| `Checkpoint` | `summary`、`touchedFiles`、`nextStep`、`transcriptCursor`、`createdAt` | 落 `~/.pi-workbench/handoffs/<key>-<ts>.md`；交接必写 |
| `Capability` | `stream`、`inject`、`interrupt`、`attach`、`resume`、`transcript`、`permissions`、`background` | 启动时由 adapter 探测；没有的能力不注册工具、不显示按钮 |

### 5.3 状态机

~~~text
starting ──► running ──► needs_input ──► running
   │            │              │
   │            ├──► idle ─────┘
   │            │
   └────────────┴──► handoff ──► running（human 交回）
                         │
                         └──► exited（关闭/崩溃）
~~~

驱动权：`pi` → `human` → `pi`；`none` 只用于已退出/未启动。任何 `inject`/`interrupt`/`handoff` 都必须持有 lease。

### 5.4 事件与幂等

- 所有 adapter 事件先写 `SessionEvent`，再广播 WS；UI 断线重连用 `seq` 补拉。
- 事件带 `idempotencyKey`（adapter + native event id + session key），重复投递不产生重复消息。
- `SessionRef.status` 是投影结果，不是独立真相；daemon 重启后从事件库 + `session/list` 重建。
- 每个会话的 transcript 读取是**增量**的：记录 byte offset / JSONL line cursor；只读，不修改原生文件。

---

## 6. 关键流程

### 6.1 dispatch：派发即建会话

1. Pi 调 `dispatch(agent, task, cwd, options)`。
2. Control plane 选择 adapter：Claude/Codex 走 ACP；Pi 走 SDK；DSH 走 pty。
3. 调 `session/new`（或 Pi `createAgentSession`）创建会话，拿到 `nativeId`/`acpSessionId`。
4. 写入 `SessionRef`，状态 `starting`；调 `session/prompt` 发送任务。
5. 返回 `SessionRef` 给 Pi；Pi 不再等最终文本，而是拿到一个可寻址句柄。
6. 事件流持续写库并广播；Pi 可以在任意时刻 `see`/`inject`/`handoff`。

**禁止：** 长任务用 `claude --print` 或 `codex exec` 一次性进程作为唯一投递方式；那只能作为“快任务/一次性问答”通道。

### 6.2 see：读，不抢驱动权

1. `session/list` 刷新会话索引（包括用户之前就在跑的会话）。
2. 读 `SessionEvent` 和原生 transcript（Claude JSONL / Codex rollout / Pi session JSONL）。
3. 返回统一消息模型：user/assistant/thought/tool_call/tool_result/notice/plan/state。
4. `see` 不需要 lease；但 UI 要显示当前 driver，避免“看着看着以为自己在控制”。

### 6.3 inject：在运行中插话

1. 先取 lease；没有 lease 只能排队等。
2. 优先 `session/prompt`（ACP 接受后返回 messageId；前台继续）。
3. Codex 可用 `session/steering` 扩展做 mid-turn 插话；Claude 依赖其 prompt 队列/下一轮；Pi 用 `steer`/`follow_up` RPC。
4. 如果 adapter 只支持 turn 边界注入，UI 明确显示“将在下一轮生效”，不要假装实时。

### 6.4 interrupt：取消，不销毁

1. `session/cancel`（ACP）或 Pi `abort`。
2. 等待 `state_update` 的 `idle/cancelled`。
3. 保留会话和历史；不自动 `session/close`，除非用户选择“结束并释放”。

### 6.5 handoff：交驱动权（v1 的核心语义）

**v1 不做“两个 driver 同时写”。** 正确顺序是：

1. 取 lease，状态改 `handoff`。
2. 写 checkpoint：摘要、最后几条消息、触碰文件、下一步、transcript cursor。
3. 若会话在跑：`session/cancel` 或等待当前 turn 结束（按用户选择）；然后 `session/close` 释放 adapter 连接。
4. 打开原生终端：
   - Claude：`claude attach <id>`（后台会话）或 `claude --resume <session-id>`（普通会话）。
   - Codex：`codex resume <thread-id>`。
   - Pi：`pi --session <path|id>`。
   - DSH：`pi-workbench attach <key>` 接 pty。
5. lease 转 `human`；控制台显示“人工接管中”，Pi 只读。
6. 人干完，运行 `pi-workbench handback <key>`（或 UI 点“交回”）。
7. `session/resume` + replay 增量；读原生 transcript 的 delta；生成“人工期间变更摘要”写入 checkpoint；lease 转 `pi`。

**为什么不直接 hot attach？** Claude 的 `attach` 可以做到；Codex/Pi 的原生 TUI 与 ACP/app-server 同时写同一条线程没有稳定保证。v1 用“quiesce → transfer → resume”换取确定性；Claude 可以在 UI 里提供“直接 attach”快捷方式，但仍受 lease 保护。

### 6.6 资产桥

- **MCP**：Pi 维护 MCP server 注册表；`session/new` 时通过 ACP `mcpServers` 注入；Claude/Codex 都能消费。
- **Skills**：Markdown skills 以 Pi 为 source of truth，投影到 Claude/Codex 的 skills 目录；用 manifest 记录来源/版本，不覆盖用户手写文件。
- **Memory**：Pi 记忆写 `~/.pi/agent/memory`；向 `AGENTS.md` / `CLAUDE.md` 写“托管段落”（带 `<!-- pi-workbench:begin/end -->` 标记），冲突按 `updated` 新者为准；写前备份。
- **插件**：只承诺 MCP server + skills；DSH 的 11000+ 插件不移植。

### 6.7 Pi 侧工具

按 `Capability` 注册，不注册“看起来有但实际没有”的工具：

| 工具 | 作用 | 依赖 |
|---|---|---|
| `delegate_claude` | 长任务派发到 Claude 可寻址会话 | ACP Claude adapter |
| `delegate_codex` | 长任务派发到 Codex 线程 | ACP Codex adapter |
| `delegate_pi` | Pi 子会话/并行任务 | Pi SDK |
| `delegate_dsh` | DSH pty/computer-use | pty / windows-mcp（后置） |
| `session_list` / `session_read` | 发现/读取所有会话 | SessionRegistry |
| `session_inject` / `session_interrupt` | 插话/打断 | Lease + adapter caps |
| `session_handoff` / `session_resume` | 交给人/交回 Pi | HandoffManager |
| `memory_*` | 记忆 CRUD/搜索 | Pi 记忆扩展 |
| `kb_*` | 知识库增删查 | FTS5 |

快任务仍走 `pi-subagents`（scout/researcher/worker），不建 SessionRef；UI 明确标注“不可接管”。

---

## 7. 能力矩阵（Phase 0 要实测的版本）

> 下表是**预期值**，不是已验证值。Phase 0 的产出就是把 `?` 变成 `yes/no`，并记录证据。

| Agent | 协议 | list | stream | inject | interrupt | native handoff | permissions | 备注 |
|---|---|---|---|---|---|---|---|---|
| Claude Code | ACP v2（`claude-agent-acp` 0.107.0） | ? | ? | ? | ? | `claude attach` / `claude --resume` | ? | 重点验 session/list 是否覆盖已有原生会话、session id 映射 |
| Codex | ACP v2（`codex-acp` 2.6.0） | ? | ? | ?（steering） | ? | `codex resume` | ? | 重点验 steering 扩展、app-server 线程 ID 映射 |
| Pi | Pi SDK/RPC | yes（设计） | yes | yes（steer/follow_up） | yes（abort） | `pi --session` | yes（Pi 权限） | 进程内，最容易 |
| DSH | pty | no（仅进程） | 终端文本 | pty 写入 | Ctrl-C | `pi-workbench attach` | 终端 | 后置；不作为主线 |

**Phase 0 通过标准：** 每个 Agent 至少满足 `list + stream + inject + interrupt + resume`；native handoff 可以降级为 pty，但必须明确标注。任何一个 Agent 不满足，就把它降为“只读/快任务”，不要在 UI 上假装可接管。

---

## 8. 实施计划

### Phase 0 — ACP v2 与接管 Spike（1–2 天，只验证）

| 实验 | 做法 | 通过标准 | 失败则 |
|---|---|---|---|
| P0-1 Claude ACP v2 | 用 `@agentclientprotocol/sdk` 写最小 client；启动 `claude-agent-acp@0.107.0`（`CLAUDE_AGENT_ACP_PROTOCOL=v2`）；依次 `initialize`、`session/new`、`session/prompt`、`session/list`、`session/cancel`、`session/close`、`session/resume` | 七步都通；能列出 Pi 启动前就存在的 Claude 会话 | 降到 ACP v1；再不行走 `claude --bg` native adapter |
| P0-2 Claude 原生接管 | `claude --bg -p` 起会话；`claude agents --json` 找 id；`claude logs`；`claude attach`；`claude --bg --resume <id> -p` 续跑 | 同一 id 能看到输出、能 attach、能在后台续跑 | native handoff 只做 `--resume`，不做 attach |
| P0-3 Codex ACP v2 | 启动 `codex-acp@2.6.0`；同样跑七步；测 steering 扩展；`codex app-server generate-ts` 对照 thread 方法 | 七步都通；mid-turn 插话有事件 | 降到 v1；或 native app-server adapter |
| P0-4 Codex 原生接管 | 从 ACP session 拿 thread id；`codex resume` 打开 TUI；改一句话；回 Pi `session/resume` | 历史连续、无重复消息 | 只做只读 + 重新派发 |
| P0-5 Pi 原生会话 | `createAgentSession` 起会话；`pi --session <file>` 打开；`pi --mode rpc` 测 `steer`/`abort`/`get_state` | 同一 JSONL 树可续、可 abort | 用 SDK 单进程，不做外部 attach |
| P0-6 Windows pty | `node-pty` + ConPTY 起一个 shell；写入/读取/缩放；子进程退出检测 | 能稳定读写 | 用 Windows Terminal + `pi-workbench attach` 的命名管道方案 |
| P0-7 事件/租约 | 模拟两个客户端同时 inject；验证 lease 拒绝第二个 writer | 第二个被拒绝且不破坏会话 | 改为 UI 单写队列 |

**产出：** `docs/spike-control-plane-report.md`，含每个 Agent 的 `SessionCaps` 实测表、命令、截图/日志、失败降级结论。**没有这份报告，不进入 Phase 1。**

### Phase 1 — daemon 核心（3–5 天）

- `packages/control-plane`：Node 24 + TypeScript + Fastify + `better-sqlite3` 或 `node:sqlite`。
- `AcpHost`：spawn/握手/版本协商/重连/进程退出；每个 agent 一个 host，多 session 复用。
- `SessionRegistry`：`session/list` + 原生 transcript 扫描 + 手动登记。
- `EventStore`：append-only、幂等、按 `seq` 补拉；WS 广播。
- `LeaseManager` / `CheckpointStore`：租约、心跳、检查点文件。
- REST/WS API：按 PRD §3.5 的路径；先实现 sessions/transcript/inject/interrupt/lease/handoff/dispatch/agents。
- 测试：mock ACP agent + 一个真实 Claude/Codex smoke；daemon 重启恢复测试。

**验收：** 两个真实会话（Claude + Codex）能出现在 `/api/cp/sessions`；能读 transcript；能 inject；能 interrupt；kill daemon 后重启，会话索引和事件不丢。

### Phase 2 — React 控制台 MVP（2–3 天）

- 页面：Chat、Sessions（矩阵）、Takeover、Agents、Settings；Memory/Knowledge 先留占位。
- 会话矩阵：Agent × 会话 × 状态 × driver；能力徽章；needs-input 高亮。
- 对话页：流式消息、工具调用卡片、权限卡片、checkpoint 卡片、快任务“不可接管”标注。
- 接管页：checkpoint 预览、handoff 按钮、原生终端命令复制/启动、handback。
- 移动端：先做响应式 + PWA manifest；Tauri 后置。

**验收：** 手机浏览器能看会话矩阵、进对话、点 handoff；桌面能完成一次“派发 → 插话 → 打断 → 接管 → 交回”。

### Phase 3 — 记忆 + 知识库（3–4 天）

- 记忆：frontmatter（name/description/metadata.type/updated/confidence）、`MEMORY.md` 一行索引、5 工具、`session_start` 注入 user-profile/preferences；冲突按 `updated`；`.archive`/`.trash`。
- 知识库：`index.json` 可保留为导出/兼容；主索引用 SQLite FTS5（trigram + 2 字 LIKE 回退）；`docs/{tech,projects,references,blog-notes,course}` + `raw`；4 工具；<500ms。
- UI：Memory 列表/编辑/搜索；Knowledge 导入/搜索/打开。

**验收：** 500 篇中文合成文档检索 P95 <500ms；2 字查询有结果；记忆写入后新会话能注入；冲突覆盖有测试。

### Phase 4 — Handoff 原生终端、资产桥、DSH、打包（2–3 天）

- `HandoffManager` 完整实现：Claude attach/resume、Codex resume、Pi session、DSH pty。
- `AssetBridge`：MCP 注册表、skills 投影、AGENTS.md/CLAUDE.md 托管段落。
- DSH：先 `pi mcp add windows -- python -m windows_mcp` 验证 computer-use；DSH 插件/IM 走 pty，不移植。
- 打包：`pi-workbench` CLI（start/stop/status/attach/handback）、PID/单实例/日志、localhost 免鉴权/远程 token、Tailscale 文档。

**验收：** 一条 Claude 长任务从 Pi 派发 → 控制台插话 → 人用 `claude attach` 接管 → 交回 Pi → Pi 能读到人工期间的 transcript delta。

### 工期与 PRD 对齐

PRD 的 15–20 工作日是合理的；本方案把“每 Agent adapter”省掉，换成 ACP 版本兼容和 handoff 实测，净节省约 2–4 天。**建议按 15–18 天排，不要按 11 天承诺。**

---

## 9. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| ACP v2 仍是 draft，适配器升级破坏兼容 | 高 | 中 | 锁版本 + `initialize` 版本协商 + v1 回退；adapter 接口收窄到 7 个方法 |
| ACP session id 与原生 session id 对不上，handoff 接不回 | 中 | 高 | Phase 0 先测映射；Adapter 暴露 `nativeId`；不行就降级 pty attach，UI 标注 |
| 两个 driver 同时写导致会话损坏 | 中 | 高 | 租约 + 心跳；handoff 先 close 再开原生；没有租约的 adapter 只给 see |
| ACP 子进程崩溃/挂起 | 中 | 中 | supervisor 重启；事件幂等；`session/list` 重建；UI 显示 exited |
| Windows 路径/认证/ConPTY 问题 | 中 | 中 | Phase 0 在 Windows 实测；路径统一绝对路径；不依赖 WSL |
| 控制台 UI 范围膨胀 | 高 | 中 | MVP 只做矩阵/对话/接管/状态；Memory/KB 分阶段；Tauri 后置 |
| 记忆投影覆盖用户手写内容 | 中 | 高 | 只写托管标记段；写前备份；冲突按 updated；提供 dry-run |
| DSH 插件不可移植被反复提起 | 高 | 低 | 明确边界：只做 windows-mcp + pty；不承诺 11000+ 插件 |
| Token 成本/重复会话 | 中 | 中 | UI 显示每个会话的 token/成本；handoff 不复制会话；禁止自动重派 |

---

## 10. 与 PRD 的差异清单

| PRD v0.3.0 | 本方案 | 原因 |
|---|---|---|
| 控制面自研 1.2–1.8k 行 TS | 治理层 1.5–2.5k 行 + UI 2–3k + 记忆/KB 0.8–1.2k | 原估算只算后端；ACP 省掉 Claude/Codex adapter，但 UI/记忆/KB 仍要写 |
| 服务端 Pi SDK 优先、RPC 备选 | 保持；Claude/Codex 走 ACP，Pi 走 SDK | Pi 是宿主，不需要 ACP 包一层 |
| JSON 索引 + MiniSearch，可换 FTS5 | 直接 SQLite FTS5 + trigram + 2 字 LIKE | 500 篇实测 0.3–0.6ms；中文 2 字查询必须回退 |
| DSH 三条路径 | 保留，但后置；先 windows-mcp + pty | DSH 没有 MCP Server，插件不可移植 |
| Web UI 一步到位 Tauri/PWA/浏览器 | PWA/浏览器优先，Tauri 后置 | 控制台逻辑先稳定，打包不阻塞 |
| Phase 0 1–1.5 天 | 1–2 天，增加 ACP v2 七步与 handoff 映射 | ACP v2 是新技术面，必须实测 |

---

## 11. 参考与证据

### 协议与适配器

- ACP v2 总览：https://agentclientprotocol.com/protocol/v2/overview
- ACP v2 Prompt Lifecycle（含 background/state_update）：https://agentclientprotocol.com/protocol/v2/prompt-lifecycle
- ACP v2 Schema：https://agentclientprotocol.com/protocol/v2/schema
- `claude-agent-acp`：https://github.com/agentclientprotocol/claude-agent-acp（npm 0.107.0，Apache-2.0）
- `codex-acp`：https://github.com/agentclientprotocol/codex-acp（npm 2.6.0，Apache-2.0）
- `pi-acp`：https://github.com/svkozak/pi-acp（npm 0.0.34，MIT，ACP v1）
- ACP TypeScript SDK：`@agentclientprotocol/sdk` 2.6.0

### 本机 CLI

- Claude Code 2.1.323：`claude --help`、`claude agents --json`、`claude daemon --help`、`claude daemon status`
- Codex 0.167.0：`codex app-server --help`、`codex app-server generate-ts`、`codex resume`、`codex queue`
- Pi 1.5.2：`pi --help`、`pi --session`、`pi --resume`、`pi --mode rpc`

### 市场参考

- Happy：https://github.com/slopus/happy
- Omnara：https://github.com/omnara-ai/omnara
- CloudCLI：https://github.com/siteboon/claudecodeui
- Claude Squad：https://github.com/smtg-ai/claude-squad
- Yepanywhere：https://github.com/kzahel/yepanywhere
- Vibe Kanban：https://github.com/BloopAI/vibe-kanban（README 标注 sunsetting）
- pi-subagents：https://github.com/nicobailon/pi-subagents
- pi-memory：https://github.com/nicobailon/pi-memory
- pi-knowledge：https://github.com/nicobailon/pi-knowledge

---

## 12. 附：v0.2 文档的状态

`docs/agent-control-plane.md` 保留为 v0.2 历史底稿：它关于“subagent 不够、需要 see/inject/handoff、租约/检查点”的判断仍然有效；其中“每 Agent 手写 adapter”“ACP 只作未来出口”“Claude attach 未验证”的部分，以本文 v0.3 复核为准。

`docs/方案评估与落地建议.md` 保留为技术选型底稿：pi-subagents、pi-web、FTS5、中文检索的结论仍可参考；其“pi-web 足够做 UI”的结论不适用于控制台，以 PRD §5 和本文为准。
