# Pi 作为 Agent 控制面：方案评估与落地建议

> 版本：v0.2（评估稿，方案已并入 `docs/PRD.md` v0.3.0）
> 日期：2026-11-13
> 输入：`docs/PRD.md` v0.3.0、`docs/方案评估与落地建议.md` v0.2（技术底稿）
> 需求变更：Pi 不仅是唯一入口，还要**全权接管其他 Agent 的工具/插件/会话/记忆**，且**Pi 派出去的任务必须能被人和 Pi 双向接管**。
> 结论：subagent 模式确实不够用。需要的是 **Agent Control Plane（控制面）**，而不是更强的 subagent。

---

## 0. 一页结论

**你的直觉是对的，而且有官方背书。** A2A 协议文档专门有一节叫 [Why Agents Are Not Tools](https://a2a-protocol.org/latest/topics/what-is-a2a/)：把 Agent 包成一个 tool 会丢失它"多轮协商、请求澄清、中途改主意"的能力。subagent 是**单向任务投递**（发出去 → 等结果 → 收文本），而你要的是**双向会话控制**（看见→插入→交接）。

**关键发现：最难的那一半，别人已经做完了。**

| 你要的能力 | 现实 | 可用原语 |
|---|---|---|
| 看见别的 Agent 在干嘛 | **Claude Code 2.1.323 已内置后台会话主管** | `claude agents --json`、`claude logs <id>`、`claude attach <id>` |
| 接管它的会话 | 同上 + 会话可恢复 | `claude attach`（进交互终端）、`claude -r "<id>"`、`claude respawn` |
| 程序化驱动/打断 | Claude Agent SDK **streaming input 模式** | 持久会话、mid-session 中断、权限回调、resume |
| Pi 自己被接管 | **Pi RPC 模式**（JSONL 长驻子进程） | `pi --mode rpc`，命令/响应/事件/extension UI 四族记录 |
| 跨 Agent 标准化 | **ACP**（Zed）已有 `session/load`/`session/cancel`/`request_permission` | 本地 JSON-RPC over stdio，有兼容性测试套件 |
| 跨 Agent 任务协议 | **A2A**：Task 生命周期 + SSE + push + `input-required` | Agent Card 发现、contextId 分组、artifacts |

**方案：三件事**

1. **不重造会话，只建索引**：`SessionRef` 注册表把每个 Agent 的原生会话（Claude 的 id、Codex 的 rollout 文件、Pi 的 session 文件、DSH 的进程）统一寻址。
2. **分派即建会话**：Pi 派任务时**不用 `claude --print` 一次性子进程**，而是让 Claude 起**后台会话**（有 id、可 attach、可 logs、可 respawn）。这一步就把"可接管"从愿望变成结构保证。
3. **接管 = 租约 + checkpoint + 三动作协议**：`see`（读 transcript）/ `inject`（控制通道写指令或打断）/ `handoff`（把驱动权交给人或交回 Pi），全程单一写入者，靠 lease + heartbeat 防双写。

**代价**：控制面是**自研**的（约 1.2–1.8k 行），没有现成包。这是这个需求真正的成本，也是它真正的价值。

**必须先拍板的一件事**：这个需求把 Web 层从"聊天壳"升级成"控制台"（会话矩阵、接管按钮、实时事件流），`@ygncode/pi-web` 这类聊天 UI **不够用**——这是结构性差异，不是加一页能补的。

---

## 1. 需求翻译：到底要什么

你描述的能力可以拆成三个独立能力，它们的实现难度和依赖完全不同：

| # | 能力 | 一句话 | 本质 |
|---|---|---|---|
| **A** | **资产接管** | 其他 Agent 的工具、插件、会话、记忆，Pi 都能看到并用 | **读取 + 转换 + 投影**（不需要控制通道） |
| **B** | **双向会话** | Pi 和那条会话不是一问一答，而是可读、可插话、可打断、可续 | **控制通道 + 事件流**（需要协议/进程级接口） |
| **C** | **可接管的分派** | Pi 派出去的活，人和 Pi 随时能接手，且接手不丢上下文 | **会话可寻址 + checkpoint + 租约** |

**为什么 subagent 只覆盖了 1/3**：subagent 解决的是"调用"，它把 B 压缩成"发一句话，等一段文本"。C 完全没覆盖——`claude --print` 起的是一次性进程，进程退出后没有可寻址的会话，你想接管时它已经没了。

**判断标准**：如果一条派发出去的会话，你**拿不到 id、看不到实时输出、插不进话、打断不了**，那它就不是"可接管"，只是"可等待"。

---

## 2. 最佳实践扫描

### 2.1 协议层：三个协议覆盖三种关系

| 协议 | 解决的关系 | 关键原语（已核实） | 对我们的意义 |
|---|---|---|---|
| **MCP** | 模型 ↔ 工具/数据 | stdio + streamable HTTP、OAuth、tool exposure 控制 | **接管"工具"的唯一通用层**。所有 Agent 都在往 MCP 收敛 |
| **ACP**（Agent Client Protocol） | 客户端 ↔ Agent | `initialize`、`session/new`、**`session/load`（恢复已有会话）**、`session/prompt`、**`session/cancel`**、`session/set_mode`、`session/update` 通知、Client 侧 `session/request_permission`、`fs/read_text_file`、`fs/write_text_file`、`terminal/*`、`elicitation/create` | **最贴合"接管"语义的标准**：Agent 主动向客户端要权限、要信息；客户端能取消、能切模式、能加载历史会话。有 Test Compatibility Kit |
| **A2A**（Agent2Agent） | Agent ↔ Agent | Agent Card 发现、Task（有生命周期 + `contextId` 分组）、Message/Part、**Artifact**、SSE 流式、push notification、长任务（LRO） | **跨 Agent 任务的标准形态**：不是"调用工具"，而是"建 Task、订阅、必要时补充输入"。明确反对把 Agent 当 tool |

**三者不冲突，是三层**：MCP 管工具，ACP 管"人在前端驱动 Agent"，A2A 管"Agent 之间协作"。我们的场景是"Pi 作为前端驱动多个 Agent"，**主用 ACP 思路，A2A 借任务模型，MCP 管工具**。

### 2.2 工程层：可接管会话的既有实现（这是最有价值的部分）

**① Claude Code 已经内置了后台会话主管**（`claude` 2.1.323 的 CLI 参考实测）：

| 命令 | 作用 |
|---|---|
| `claude agents --json` | 列出活跃后台会话，**机器可读 JSON**（`--all` 含已完成的） |
| `claude attach <id\|name>` | **在当前终端接管一条后台会话** |
| `claude logs <id\|name>` | 拉取后台会话最近的输出 |
| `claude respawn <id>` | 重启后台会话 |
| `claude daemon status/run/stop` | 后台会话主管进程（有 socket 目录、worker 数）；`--keep-workers` 让会话跨主管重启存活 |
| `claude -r "<id\|name>" "query"` / `claude -c` | 按 id/名字恢复会话 |
| `claude import [source]` | **从其他 coding agent 导入配置**（如 `claude import codex`） |
| `claude remote-control` | 用 claude.ai/App 远程控制 |

**这意味着**：对 Claude Code，"接管"不需要我们实现，**只需要我们做它的客户端**。Pi 通过 `agents --json` 发现会话、`logs` 追输出、`attach` 把控制权交给人、`respawn` 兜底。

**② Claude Agent SDK 的 streaming input 模式**是程序化接管的正确形态：持久会话、消息队列、实时中断、权限请求回调、会话恢复。**一-shot 的 `query(prompt)` 反而是"不可接管"的那一侧**。

**③ Pi 自己就是可接管的**：RPC 模式是"长驻子进程 + stdin 命令 + stdout 事件"，有 `get_state`、prompt、abort、session 管理，连扩展的 UI 请求都能转发给客户端。**注意约束**：stdout 是协议专用通道，且**一个会话只有一个控制通道**——两个客户端同时驱动会互相踩，所以必须有租约（见 §4.3）。

**④ Pi 的会话是树，不是线性日志**：`/tree` `/fork` `/clone` `/import` `/export`，`~/.pi/agent/sessions/`，每条会话记录 cwd 且不改。**这给了我们"接管后分叉"的能力**：接管别人的会话 → fork 成 Pi 会话来试别的走法，原会话不动。

**⑤ Codex 的会话是可导入的文件**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，**fork 血缘直接编码在文件名里**（`<root>_<child>.jsonl`）。Codex 的插件目录结构是 `.mcp.json` + `skills/*/SKILL.md`——**说明 Codex 的"插件"本质上也是 MCP + Skills**。

**⑥ 通用兜底：pty/tmux**。任何 CLI Agent 都能塞进 tmux pane，Pi 用 `tmux send-keys` 写入、`capture-pane` 读取，用户 `tmux attach` 接管。**零协议适配、零版本依赖，但只能拿到"屏幕文本"，没有结构化事件**。

### 2.3 方法论层：多 Agent 系统的可靠性原则

- **12-Factor Agents**（已核实 factor 清单）：**Factor 5 统一执行状态与业务状态**（一条会话的状态必须是可序列化的一份真相，不能散在三个进程的堆里）、**Factor 6 Launch/Pause/Resume 用简单 API**、**Factor 7 用工具调用联系人类**（human-in-the-loop 要走结构化通道，不是让人盯着屏幕看）、**Factor 11 从任何地方触发、在用户所在处会面**（手机/IM/浏览器都是入口）。
- **Anthropic《Building effective agents》**：先用 orchestrator-workers 这类可组合模式，别一上来全自主。
- **A2A 的 `input-required` 任务状态**是最值得抄的设计：Agent 缺信息时**不是猜**，而是把 Task 显式置为"需要输入"并返回；等输入到了再续。这正是"人接管"的协议化表达。

---

## 3. 关键事实核验表（含未验证项）

| 事实 | 证据等级 | 说明 |
|---|---|---|
| Pi 1.5.2 有 RPC 模式（JSONL 长驻子进程） | ✅ 本机文档 | `docs/rpc.md` 实测阅读 |
| Pi 会话为树结构、支持 fork/clone/import/export | ✅ 本机文档 | `docs/sessions.md` |
| Pi 内置 MCP Client（stdio + streamable HTTP） | ✅ 本机文档 | `docs/mcp.md` |
| Claude Code 有 `agents --json` / `attach` / `logs` / `respawn` / `daemon` | ✅ 官方 CLI 参考 | 2.1.323 文档；**本机未用过后台会话**（无 `~/.claude/daemon.log`），链路待实测 |
| Claude Agent SDK 支持 streaming input / 中断 / 权限回调 / resume | ✅ 官方文档 | — |
| ACP 有 `session/load`、`session/cancel`、`session/request_permission` | ✅ 官方文档 | 远程场景仍 WIP |
| A2A 有 Task 生命周期 / contextId / artifact / SSE / push | ✅ 官方文档 | 已并入 Agentic AI Foundation |
| Codex 会话是 rollout JSONL，fork 血缘在文件名 | ✅ 本机文件系统 | 37 个会话文件实测；**文件内 record schema 未解析** |
| Codex 插件 = `.mcp.json` + `SKILL.md` | ✅ 本机文件系统 | `~/.codex/plugins/cache/**` |
| `codex resume` / `codex exec --json` 双向能力 | ⚠️ 未验证 | 文档站被 SSRF 拦截；**Phase 0 必须实测** |
| `claude-code-acp` / `codex-acp` / `pi-acp` 的成熟度 | ⚠️ 未验证 | 只知道存在，没验版本/完整性 |
| ACP 能承载"接管人正在用的交互式终端会话" | ⚠️ 存疑 | ACP 是给"新建或加载会话"的，接管一个**正在跑的交互 TUI** 属另一件事 |

**诚实结论**：Claude Code 这条线证据最硬（官方 CLI 有 `attach`，这是明写的"接管"语义）。Codex 这条线证据中等。ACP 的"接管"能力需要一次真实验证才能定案——**这是 Phase 0 的第一优先级实验**。

---

## 4. 方案候选与评分

### 4.1 四条路线

| 路线 | 做法 | 能接管 | 自研量 | 风险 |
|---|---|---|---|---|
| **A. 全 ACP** | Pi 实现 ACP Client（host），所有 Agent 通过 `*-acp` 适配器接入 | ✅ 新建/加载会话，✅ 权限/取消，❓接管正在跑的 TUI | 中（ACP client ~600–900 行，但要依赖第三方 `*-acp` 适配器） | 适配器生态成熟度未知；ACP 面向"编辑器驱动"而非"会话接管" |
| **B. 原生控制面聚合** | 每个 Agent 一个 adapter，走各家**官方** headless/daemon 接口 | ✅ Claude（attach/logs/json），✅ Pi（RPC），⚠️ Codex（待验） | 中（每 adapter 150–300 行） | 每家接口会变；但接口是官方的，语义最贴 |
| **C. tmux/pty 万用** | 所有 Agent 跑在 tmux 里，Pi 读写 pane | ✅ 任何 CLI ✅ 真·接管（就是终端） | 小（~200 行） | 只有屏幕文本，无结构化事件；Windows 需 WSL/psmux |
| **D. 现状 subagent** | `pi-subagents` 投递 | ❌ 不可接管 | 0 | 不满足需求 |

### 4.2 评分（按你的三条能力 + 工程现实）

| 路线 | A 资产接管 | B 双向会话 | C 可接管分派 | 可维护 | 总分 |
|---|---:|---:|---:|---:|---:|
| A 全 ACP | 3 | 4 | 3 | 3 | **13/20** |
| **B 原生聚合** | **4** | **5** | **5** | 3 | **17/20** |
| C tmux | 2 | 3 | 5 | 4 | **14/20** |
| D subagent | 1 | 1 | 1 | 5 | **8/20** |

### 4.3 推荐：**B 为主干，A 为标准化出口，C 为兜底**

- **主干（B）**：谁有官方控制通道就用谁的。Claude Code 已经给了 `attach/logs/agents --json`，Pi 自己有 RPC，Codex 待验。**这条路把"接管"外包给上游，我们只做聚合。**
- **标准化出口（A）**：对外（未来接 Zed、接别的编辑器、接别人写的 Agent）用 ACP 包装。**不在 v1 就上**，但 adapter 接口按 ACP 的概念设计（session/load/cancel/permission），将来能平滑加一层。
- **兜底（C）**：任何没有控制通道的 Agent（比如 DSH 桌面版）用 tmux/pty。**这是"永不失望"的那一层**。
- **D 保留**：快问快答、无需接管的探索性任务继续用 subagent——**它便宜**。

> **一句关键判断**：接管能力不是"更聪明的分派"，而是"**别用一次性进程**"。只要 Pi 派的活是"有 id 的后台会话"，接管就自动成立；只要是 `--print` 一次性进程，做多少 UI 都接管不了。

---

## 5. 目标架构

### 5.1 分层图

```
┌──────────────────────────────────────────────────────────────────┐
│                     控制台 (Web/PWA/CLI/TUI)                       │
│   会话矩阵 · 实时事件流 · 接管按钮 · 派发面板 · 记忆/知识管理         │
└───────────────────────────────┬──────────────────────────────────┘
                                │ HTTP + WS
┌───────────────────────────────▼──────────────────────────────────┐
│                   pi-workbench 控制面（自研, 扩展形态）              │
│                                                                   │
│  SessionRegistry   会话注册表：SessionRef[]（统一寻址）             │
│  LeaseManager      租约：同一会话同一时刻只有一个 driver            │
│  EventBus          归一化事件流：token/tool/status/needs-input      │
│  TakeoverEngine    接管协议：see / inject / handoff / checkpoint    │
│  AssetBridge       资产桥：tools(MCP) / skills / memory / sessions  │
│  PolicyGate        权限与审批：谁可以写、写到哪、要不要人批          │
└──────┬───────────────┬───────────────┬───────────────┬───────────┘
       │               │               │               │
┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼─────┐
│ Adapter:Pi │  │Adapter:Claude│ │Adapter:Codex│ │ Adapter:DSH │
│ RPC JSONL  │  │ daemon/agents│ │ exec/resume │ │ tmux/pty    │
│            │  │ --json/attach│ │ rollout fs  │ │ (兜底)      │
└──────┬─────┘  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘
       │               │                 │                │
   Pi 会话文件     ~/.claude/        ~/.codex/         DSH 进程
   (树/fork)      projects/*.jsonl   sessions/*.jsonl   (GUI)
```

### 5.2 核心数据结构

```ts
type AgentId = "pi" | "claude" | "codex" | "dsh" | string;

interface SessionRef {
  key: string;                  // 全局唯一：`${agent}:${nativeId}`
  agent: AgentId;
  nativeId: string;             // claude session id / codex rollout 文件名 / pi session uuid
  cwd: string;
  title?: string;
  transcriptPath?: string;      // 原始文件（只读，用于 see）
  createdAt: string;
  updatedAt: string;
  status: "running" | "idle" | "needs-input" | "exited" | "unknown";
  driver: "pi" | "human" | "none";   // 谁在驱动（来自租约）
  capabilities: SessionCaps;    // 由 adapter 声明，见下
  lineage?: { parent?: string; forkedFrom?: string };  // Codex 文件名 / Pi fork
}

interface SessionCaps {
  stream: boolean;      // 有实时结构化事件？
  inject: boolean;      // 能中途插入消息？
  interrupt: boolean;   // 能打断？
  attach: boolean;      // 能在终端接管？
  resume: boolean;      // 能恢复已结束会话？
  transcript: boolean;  // 能读到完整历史？
  permissions: boolean; // 有权限请求通道？
}

// 能力矩阵（capabilities）让上层 UI 知道"这条会话能做什么"，
// 而不是假设所有 Agent 一样。这是整个设计最重要的一条。
```

### 5.3 接管协议（Takeover）

**定义三个原子动作**，任何 Agent 只要实现其中任意子集，就能被接管到对应程度：

```
see(sessionKey)        → 读 transcript + 订阅事件（只读，无副作用）
inject(sessionKey,msg) → 向运行中的会话插入一条用户消息或指令
handoff(sessionKey,to)→ to="human" 把驱动权交给终端/控制台；to="pi" 交回
```

**完整接管（human 接手）的时序**：

```
1. acquire lease      Pi 请求独占：拿不到（人正在用）就只给 see 权限
2. quiesce            优雅打断当前 turn（claude: 中断；pi: abort；无能力则跳到 4）
3. checkpoint         抓一次"我在干什么"快照：
                        - 本 turn 的动作摘要
                        - 触碰过的文件（从工具事件里提取）
                        - 待办/下一步（模型自述 or 从计划里取）
                        → 写成 Markdown 快照，落盘到 ~/.pi-workbench/handoffs/
4. handoff             Claude: 打开 `claude attach <id>` / 或把控制台切到该会话
                       Pi:     把 RPC 通道的控制权交给控制台
                       Codex:  --resume / TUI
5. 人类操作中          Pi 侧显示 "由你接管"，事件流继续只读，禁止 inject
6. 归还                release lease → Pi 读回 session 的增量 diff → 更新自己的上下文
```

**为什么要 checkpoint**：这是 12-Factor 的 Factor 5/6。**没有快照的接管 = 上下文丢失**，接手的人要从头读 5000 行 transcript。有快照，接管才是"接着干"而不是"重来"。

**为什么要租约**：Pi 的 RPC 文档明写 stdout 是协议专用、单一控制通道；Claude 的 `attach` 也是独占终端。**两个 driver 同时写一条会话是必坏**。租约 = 单写入者，心跳超时自动释放（人关了终端不会永久锁住会话）。

### 5.4 四类资产的接管路径（能做什么、不能做什么）

| 资产 | 接管方式 | 双向？ | 诚实边界 |
|---|---|---|---|
| **工具** | **MCP 统一**。Pi 已内置 MCP Client，把各 Agent 用的 MCP server 全部注册给 Pi → 工具对 Pi 立即可用 | ✅ 双向（共用同一批 server） | 非 MCP 的内置工具（如 Claude 的 Read/Edit）**不能跨 Agent 用**，Pi 用等价原生工具替代 |
| **插件** | **拆成两块**：`.mcp.json`/MCP server → 走工具路径；`SKILL.md`/prompts/agents/*.md → **都是 Markdown，可复制到 Pi 的 skills 目录或反向生成** | ✅ 基本双向 | 插件**运行时**（Claude 插件市场、DSH 的 11000 插件）**不可移植**，别承诺。本机实测：Codex 插件目录就是 `.mcp.json`+`skills/`，说明"插件"本来就是这两个东西的打包 |
| **会话** | **transcript 适配器 + 原生 resume**：读 JSONL → 归一化成 Pi 的消息模型 → 需要继续时用**原生** `--resume`（不搬家，只借读） | ⚠️ 单向为主 | 跨 Agent "把 Claude 的会话变成 Pi 的会话继续跑"技术上可行（Pi 有 `/import`、`--fork`），但**会丢工具调用语义、丢缓存、语义不等价**。推荐"**借读不搬家**"：Pi 能看、能引用、能摘要，继续跑还是回原 Agent |
| **记忆** | **Pi 为唯一写入者 + 向各 Agent 生成投影**：Pi 的 Markdown 记忆是主库；自动生成 `AGENTS.md` / `CLAUDE.md` 的托管段落，让原生 Agent 一启动就继承 Pi 的决定 | ⚠️ 下行为主 | 反向（把 Claude/Codex 的记忆**导入** Pi）只做一次性迁移 + 定期摘要，**不做实时同步**（PRD 已决策：第一期不做跨 Agent 同步，这条仍然成立） |

**这套设计的核心取舍**：**记忆与"谁说了算"由 Pi 独占，会话与执行留在原生 Agent 里。** 前者保证一致性，后者保证不丢能力。

---

## 6. 实施计划

### Phase 0 — Spike（1–1.5 天，只验证，不写产品代码）

| 实验 | 命令/探针 | 通过标准 | 失败则 |
|---|---|---|---|
| **P0-1 Claude 可接管性** | 起一个后台会话 → `claude agents --json` 能否列出 → `claude logs` 追到输出 → `claude attach` 真能进终端 | 三件事都成立 | 降级为 SDK streaming input 自建会话 |
| **P0-2 Claude 中途注入** | SDK streaming 模式下发消息、打断、再续 | 中断后会话仍活着、能续 | 只能用 turn 边界注入 |
| **P0-3 Codex 控制面** | `codex exec --json`、`codex resume`、rollout 文件解析 | 能拿到结构化事件 + 能恢复 | 归到 tmux 兜底 |
| **P0-4 Pi RPC 单通道** | RPC 起 Pi，`get_state`/prompt/abort，同时开第二个客户端 | 验证"双客户端会冲突"→ 确认必须做租约 | — |
| **P0-5 ACP 适配器成熟度** | 装 `pi-acp` / `claude-code-acp`，跑一次 ACP 会话；看 `session/load` | 能 `session/load` 恢复历史会话 | ACP 只作未来出口，不进 v1 |
| **P0-6 tmux 兜底** | Windows 下 tmux/psmux 可用性；send-keys + capture-pane | 能读能写 | 用 Windows Terminal + pty (`node-pty`) |

**产出**：`docs/spike-report-2.md`，给出**每个 Agent 的能力矩阵（SessionCaps 实测值）**。**这张表是整个项目的设计输入**——没有它，后面的 UI 和协议都是猜的。

### Phase 1 — 会话注册表 + 只读接管（2 天）

- `SessionRegistry`：扫描 + 订阅四类会话来源（Pi 会话目录、`~/.claude/projects`、`~/.codex/sessions`、`claude agents --json`）
- `transcript adapter`：Pi / Claude / Codex 三种 JSONL → 统一消息模型
- `see()`：只读接管，控制台能看到"所有 Agent 现在在干嘛"
- **验收**：一条命令/一个页面列出**全部** Agent 的会话与状态，点进去能看到完整历史并实时跟到新消息

### Phase 2 — 控制通道 + 派发即建会话（2–3 天）

- `Adapter:Pi`（RPC）、`Adapter:Claude`（daemon/agents/attach）、`Adapter:Codex`（exec --json + resume）
- `dispatch(agent, task) → SessionRef`：**返回可寻址句柄**，不再是文本结果
- `inject()` / `interrupt()`
- **验收**：Pi 派给 Claude 一个任务 → 控制台里出现一条"跑着的会话" → 能实时看 → 能中途插一句话改变它的方向 → 能打断

### Phase 3 — 接管协议 + 资产桥（2–3 天）

- `LeaseManager`（租约 + 心跳 + 自动释放）
- `checkpoint` → `handoff`（human/pi 双向交接）
- `AssetBridge`：MCP server 汇总注册；skills 双向同步；记忆向 `AGENTS.md`/`CLAUDE.md` 投影
- **验收**：Pi 派出的任务，你在控制台点"接管" → 看到 checkpoint 快照 → 在原生 Agent 里接着干 → 干完交回 → Pi 的上下文里有你干的事

### Phase 4 — 控制台 UI（2–3 天，可后置）

会话矩阵（Agent × 会话 × 状态）、事件流、接管/派发/记忆页。**这一层要不要用 pi-web 改造、还是自研，等 Phase 0 的能力矩阵出来再定**。

**总计：7–11 天到"可接管的 Pi"**（不含 Phase 4 UI 打磨）。

---

## 7. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 上游控制接口是**未文档化的内部实现**（如 `claude daemon` 的 socket 协议） | 中 | 高 | 只用文档化的 CLI（`agents --json`/`attach`/`logs`），不碰 socket；接口变了立刻发现（命令失败） |
| 双 driver 导致会话损坏 | 中 | 高 | 租约 + 心跳；**没有租约的 adapter 只给 see 权限** |
| 接管后上下文不一致（人干的事 Pi 不知道） | 高 | 中 | release 时强制读增量 + 生成 diff 摘要注入 Pi 上下文；不可读则显式告警 |
| 跨 Agent 会话搬家语义不等价 | 高 | 中 | **策略上不搬家**（借读不搬家），只对明确要求的场景做 import + 明确标注"语义已降级" |
| tmux 在 Windows 上不稳 | 中 | 中 | 用 `node-pty` 自建 pty（跨平台），tmux 只作 Linux/macOS 优选 |
| 控制面自己变成新的单体 | 中 | 中 | adapter 接口收窄为 6 个方法（see/inject/interrupt/attach/resume/caps），**任何新 Agent 不许改核心** |
| 工具面 / 提示词膨胀 | 高 | 中 | 能力矩阵驱动 UI 暴露；未实现的 cap 不注册对应工具 |

---

## 8. 待拍板

1. **接受"控制面自研"这个前提吗？** 这是本需求唯一没有现成包的部分（~1.2–1.8k 行）。如果不接受，就得接受"只能接管 Claude Code 一家"（因为只有它已经给了完整原语）。
2. **第一个要接管的 Agent 选谁？** 推荐 **Claude Code**（证据最硬，`attach/logs/agents --json` 全是官方命令），Codex 第二，DSH 走 tmux 兜底。
3. **会话策略：借读不搬家，还是允许搬家？** 推荐**借读不搬家**（Pi 能看能引用，继续跑回原生 Agent）。搬家技术上可行但语义降级。
4. **记忆是否向其他 Agent 投影？** 推荐**是**（生成 `AGENTS.md`/`CLAUDE.md` 托管段落），否则"接管"后各 Agent 行为不一致。
5. **Phase 4 的 UI**：pi-web 改造 vs 自研控制台？**建议 Phase 0 之后再定**。

---

## 附录 A：参考链接（本轮联网核实）

- ACP 协议总览：https://agentclientprotocol.com/protocol/overview
- ACP 简介：https://agentclientprotocol.com/overview/introduction
- A2A「What is A2A」：https://a2a-protocol.org/latest/topics/what-is-a2a/
- A2A 核心概念：https://a2a-protocol.org/latest/topics/key-concepts/
- 12-Factor Agents：https://github.com/humanlayer/12-factor-agents
- Claude Code CLI 参考（`agents`/`attach`/`logs`/`respawn`/`daemon`）：https://docs.claude.com/en/docs/claude-code/cli-reference
- Claude Agent SDK streaming input：https://docs.claude.com/en/docs/agent-sdk/streaming-vs-single-mode
- 本机文档：Pi `docs/rpc.md`、`docs/sessions.md`、`docs/mcp.md`、`docs/packages.md`、`docs/extensions.md`

## 附录 B：本机实测记录

- Pi 1.5.2（`@earendil-works/pi-coding-agent`），文档齐全，`~/.pi/agent/` 已有 settings/mcp/models，**无 packages 声明**（干净起点）
- `~/.codex/sessions/2026/{10,11}/**/rollout-*.jsonl` 共 37 个会话文件，fork 血缘编码于文件名
- `~/.codex/plugins/cache/**`：插件 = `.mcp.json` + `skills/*/SKILL.md`
- `~/.dsh/dsh-windows-mcp/toolchain/0.8.8/windows-mcp/` 为 Python venv，含 `windows_mcp/__main__.py` + `fastmcp` → 是 **MCP Server**（被 DSH 作为 client 消费），可被 Pi 直连
- `~/.claude/daemon.log` **不存在** → 本机尚未使用过后台会话，`attach` 链路属未验证
