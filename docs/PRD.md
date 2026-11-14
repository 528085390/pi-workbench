# Pi Workbench — 个人智能体工作台

## 需求文档 (PRD)

**版本:** 0.3.2  
**日期:** 2026-11-14  
**作者:** huang  
**状态:** 需求已确认（v0.3.2 已完成 Phase 0 技术假设验证；A′ ACP v2 薄控制面进入实施准备）

> **v0.3.0 变更摘要**
> 需求从「Pi 是唯一入口 + 子代理按需调度」升级为「**Pi 是唯一控制面**」：
> 1. Pi 要能**全权接管**其他 Agent 的**工具、插件、会话、记忆**；
> 2. Pi 派发给 Agent 的任务，**人和 Pi 都必须能随时接管这条会话**（可在 Pi 控制台接管，也可在对应 Agent 原生终端接管）；
> 3. 结论：**子代理（工具调用式投递）只能作为任务分发途径之一**，无法承载"接管"需求，需新增控制面。
>
> 配套文档：
> - 可行性评估与落地方案 → `docs/agent-control-plane-v0.3.md`（v0.3 复核）
> - Phase 0 spike 计划 → `docs/superpowers/plans/2026-11-14-control-plane-phase0-spike.md`
> - 技术选型与骨架评估 → `docs/方案评估与落地建议.md`

> **v0.3.1 变更摘要（2026-11-14）**
> 基于 docs/agent-control-plane-v0.3.md 的复核结论，已确认：
> 1. 控制面路线采用 **A′：ACP v2 薄控制面**；Claude/Codex 用官方 ACP adapter，Pi 自身走 SDK/RPC，不自研 adapter。
> 2. v1 handoff 语义：先 quiesce（cancel/close）交出驱动权，再 session/resume + replay 接回；不承诺两个 driver 同时写。
> 3. 知识库主存储改为 **SQLite WAL + FTS5**（trigram + 2 字 LIKE 回退），不再以 JSON + MiniSearch 为主。
> 4. DSH 后置：走 windows-mcp + pty/tmux 兜底，不阻塞主线。
> 5. 先执行 Phase 0 能力 spike（1–2 天），再进入 Phase 1。

> **v0.3.2 变更摘要（2026-11-14）**
> Phase 0 技术假设验证完成，报告见 docs/技术假设验证-2026-11-14.md。关键修正：
> 1. ACP v2 官方 Claude/Codex adapter 的 initialize/new/prompt/list/close/resume 均通过；但 session/list 只覆盖 ACP 自建会话，Codex 原生 codex exec thread 必须从 rollout 文件/状态库发现；Claude 可列出原生会话但要求 cwd 精确匹配。
> 2. Claude 原生后台会话运行中不能直接 ACP resume，必须先 claude attach 或 claude stop；stop 后 resume 保留上下文。v1 handoff 的 quiesce 语义实测成立。
> 3. Codex 原生 thread 可按 id 走 ACP session/resume，也可走 codex exec resume；codex resume TUI 可接管并显示完整 transcript。
> 4. Pi RPC 无 session 锁：两个客户端可同时打开同一 session 并产生分支；LeaseManager 为硬要求。
> 5. Windows node-pty/ConPTY 可用：claude attach、codex resume、pi --session 均可打开真实 TUI；Pi 默认模型改为 zz/deepseek-v4.1-flash，已实测可用。
> 6. DSH 路径未验证：系统 Python 无 windows_mcp，DSH 插件 disabled；继续后置。

---

## 〇、已确认决策

| # | 决策项 | 结论 | 状态 |
|---|--------|------|------|
| 1 | **入口形式** | **保持 `pi` 为唯一入口**，并升级为**唯一控制面**：所有 Agent 的会话调度、状态查看、接管动作都从 Pi 发起。Claude Code / Codex / DSH 挂载到 Pi，但不再只是"工具"，而是"**可接管的工作单元**" | ✅ 已确认 |
| 2 | **记忆归属** | **Pi 的记忆是唯一 source of truth**。其他 Agent 保留各自记忆，第一期**不做跨 Agent 同步**、不做自动对齐。冲突由 Pi 自行纠正，记忆对齐留作后期功能 | ✅ 已确认 |
| 3 | **DSH 接入** | **能力按需接入，路径按实测选**：① windows-mcp 直连路径尚未验证（系统 Python 无 windows_mcp，DSH 插件当前 disabled），需先确认 DSH 自带 Python 或独立安装；② DSH 自身的插件 / IM / Cron / Skills 目前不提供 MCP Server，需 DSH 侧做插件，或走 pty 接管；③ 优先级低于 Claude / Codex | ✅ 已确认（路径待验证） |
| 4 | **知识库规模** | **中型（100–500 篇）**。主存储改为 **SQLite WAL + FTS5**（trigram + 2 字 LIKE 回退），不引入向量数据库；JSON 索引不再作为主方案 | ✅ 已确认（v0.3.1 更新，v0.3.2 回写） |
| 5 | **界面形态** | **Web UI 优先，一步到位**。一套后端 + 一套响应式前端，三端可用：PC（Tauri 壳）/ 手机（PWA）/ 任意浏览器 | ✅ 已确认 |
| 6 | **接管范围** | Pi 必须能接管其他 Agent 的**工具、插件（MCP server / skills）、会话、记忆**四类资产 | ✅ 已确认 |
| 7 | **接管方向** | **双向可接管**：① Pi → Agent：派发的任务可被 Pi 和人接管；② 人 → 会话：可在 Pi 控制台接管，也可在对应 Agent 的原生终端接管**同一条**会话 | ✅ 已确认 |
| 8 | **委派形态** | **两种并存**：**快任务**＝工具调用式投递（`pi-subagents`，不可接管，适合一次性探索）；**长任务**＝**派发即建可寻址会话**（可看、可插话、可打断、可交接） | ✅ 已确认 |
| 9 | **界面定位** | Web 层从「聊天窗」升级为「**控制台**」：会话矩阵（Agent × 会话 × 状态）＋ 实时事件流 ＋ 接管/派发面板 | ✅ 已确认（自研控制台，Phase 2 实现） |
| 10 | **控制面自研** | 采用 **A′：ACP v2 薄控制面**。Claude/Codex 用官方 ACP adapter，Pi 自身走 SDK/RPC，不自研 adapter；只自研 `pi-workbench` 治理层（SessionRegistry / EventStore / LeaseManager / CheckpointStore / HandoffManager / REST+WS / UI），约 1.5–2.5k 行 TS | ✅ 已确认 |
| 11 | **会话策略** | **借读不搬家**：Pi 能读、能引用、能摘要其他 Agent 的会话；需要继续执行时回原生 Agent 跑，不做语义降级的会话搬家。v1 handoff：先 quiesce（cancel/close）交出驱动权，再 `session/resume` + replay 接回；不承诺两个 driver 同时写 | ✅ 已确认 |
| 12 | **首个接管对象** | **Claude Code 优先**（上游已内置 `agents --json` / `attach` / `logs` / `respawn` / `daemon`）；Codex 第二；DSH 后置（`windows-mcp` + pty 兜底），不阻塞主线 | ✅ 已确认 |
| 13 | **Phase 0** | 已完成 2026-11-14 真实能力 spike（Claude/Codex/Pi/pty + ACP v2 能力矩阵），报告见 docs/技术假设验证-2026-11-14.md；通过 Gate 后进入 Phase 1 | ✅ 已完成 |

---

## 一、项目背景

### 1.1 现状

当前拥有 6 个独立运行的 AI 工具，彼此割裂：

| 工具 | 版本 | 角色 | 记忆系统 |
|------|------|------|----------|
| **Pi Agent** | 1.5.2 | 编码 Agent，支持 extensions / MCP / SDK / RPC | `~/.pi/`（尚未配置记忆） |
| **Claude Code** | 2.1.325 | 深度编码，插件市场 | ~/.claude/projects/*/memory/ |
| **Codex CLI** | 0.167.0 | 编码 + computer-use | `~/.codex/memories/` |
| **DSH (DeepSeek Harness)** | 0.2.2-rc.2 | 插件平台，11000+ 插件，Cordis 框架 | `~/.dsh/AGENTS.md` + superpowers skills |
| **cc-connect** | 1.5.0 | Agent 桥接 | — |
| **cli-wechat-bridge** | 1.0.4 | 微信消息桥接 | — |

共同基础设施：本地 API 代理 `127.0.0.1:1337`，统一管理密钥与模型路由。

> Pi 默认模型已切到 zz/deepseek-v4.1-flash（本地 127.0.0.1:7864，2026-11-14 实测可用；原 Radius 默认模型余额为 0）。


### 1.2 痛点

1. **入口分散** — 4 个 CLI/App 来回切换，心智负担大
2. **记忆孤岛** — 各 Agent 记忆互不可见，同一个偏好要重复教
3. **知识零散** — 项目经验、技术笔记散落在不同工具的 session 历史里
4. **路由靠人** — 哪个任务派给哪个 Agent，全凭人工判断
5. **上下文断裂** — 任务做一半换 Agent 就丢上下文
6. **设备割裂** — 只能在电脑前用，手机端只能靠 IM 发消息，看不到记忆和知识库
7. **派出去的活收不回来** — 一旦把任务交给某个 Agent，就变成了"等它跑完"。看不到实时进度、插不进话、打断不了，跑完只剩一段文本，上下文全丢（v0.3.0 新增）
8. **Agent 资产用不上** — 别的 Agent 装好的 MCP 工具、skills、历史会话、积累的记忆，Pi 一概用不了，只能在各自窗口里重复配置（v0.3.0 新增）

### 1.3 目标

构建 **Pi Workbench**：以 Pi 为核心的单入口智能体工作台

- **一个入口** — `pi` 调度所有 Agent
- **一套记忆** — Pi 为中心的持久化个人记忆
- **一个知识库** — 可检索的个人知识资产
- **三端可用** — PC / 手机 / 浏览器实时互通
- **智能编排** — Pi 的 LLM 自主决定何时调用哪个子代理
- **全权接管** — 其他 Agent 的工具、插件、会话、记忆，Pi 都能看见、能用、能接管（v0.3.0）
- **可接管的委派** — Pi 派出去的任务是"**有 id 的活会话**"，人和 Pi 随时能接手：在 Pi 控制台接管，或在对应 Agent 原生终端接管同一条会话（v0.3.0）

---

## 二、核心架构

### 2.1 架构总览

```
┌───────────────────────────────────────────────────────────┐
│                    客户端层（三端 · 控制台）                 │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ PC: Tauri/PWA │  │ 手机: PWA     │  │ 任意浏览器       │ │
│  └───────┬──────┘  └───────┬──────┘  └────────┬────────┘ │
│          └─────────────────┼──────────────────┘          │
└────────────────────────────┼──────────────────────────────┘
                             │ HTTP + WebSocket
                    ┌────────▼─────────┐
                    │ Tailscale / LAN  │  ← 远程可达（无需公网IP/域名）
                    └────────┬─────────┘
┌────────────────────────────▼──────────────────────────────┐
│            控制台服务端（/api/cp + WebSocket 事件流）        │
│            会话矩阵 · 接管视图 · 记忆/知识库 · 派发面板       │
└────────────────────────────┬──────────────────────────────┘
                             │
┌────────────────────────────▼──────────────────────────────┐
│                 Pi（编排者 / 唯一控制面）                   │
│                                                           │
│  LLM 可调用的工具集（由 pi-workbench extension 注册）：      │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 原生:   read / write / edit / bash                    │ │
│  │ 快任务: delegate_claude / delegate_codex / delegate_pi │ │
│  │ 长任务: dispatch(agent, task) → SessionRef            │ │
│  │ 接管:   see / inject / interrupt / handoff            │ │
│  │ 记忆:   memory_search / memory_write / memory_list    │ │
│  │ 知识库: kb_search / kb_read / kb_add                  │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  控制面（control-plane）：                                  │
│  SessionRegistry 会话注册表 · LeaseManager 单 driver 租约   │
│  TakeoverEngine 检查点/交接 · AssetBridge 资产桥            │
└────────────────────────────┬──────────────────────────────┘
                             │ adapter
┌────────────────────────────▼──────────────────────────────┐
│ Pi 会话(树/RPC) │ Claude(daemon/attach) │ Codex(exec) │ DSH(pty) │
└────────────────────────────┬──────────────────────────────┘
                             │
┌────────────────────────────▼──────────────────────────────┐
│  持久化（唯一数据源，全部在本机）：                          │
│  ~/.pi-workbench/memory/     个人记忆（Markdown）            │
│  ~/.pi-workbench/knowledge/  知识库（原文 + 检索索引）        │
│  ~/.pi-workbench/handoffs/   接管检查点                     │
│  ~/.pi/sessions/             Pi 原生会话                    │
└───────────────────────────────────────────────────────────┘
```

### 2.2 委派形态一：子代理 = Pi 的工具调用（快任务）

这不是比喻。**Claude/Codex/DSH 在技术上就是 Pi LLM 的一个工具**，与 `read`、`bash` 地位相同：

```typescript
// ~/.pi/agent/extensions/pi-workbench/subagents.ts
pi.registerTool({
  name: "delegate_claude",
  label: "Delegate to Claude Code",
  description: "将需要深度推理的子任务委派给 Claude Code。适用于：架构设计、复杂重构、代码审查。成本高，谨慎使用。",
  parameters: Type.Object({
    task:      Type.String({ description: "完整的任务描述，需自包含" }),
    cwd:       Type.Optional(Type.String({ description: "工作目录" })),
    timeout_ms: Type.Optional(Type.Number({ default: 300000 })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 用 claude --print 非交互模式执行
    const result = await execa("claude", ["--print", params.task], {
      cwd: params.cwd ?? ctx.cwd,
      cancelSignal: signal,
      timeout: params.timeout_ms,
    });
    return {
      content: [{ type: "text", text: result.stdout }],
      details: { agent: "claude", exitCode: result.exitCode },
    };
  },
});
```

**好处**：

- Pi 的 LLM 自己判断该不该委派、派给谁 —— 这就是"智能路由"，不用手写规则引擎
- 子代理的输入输出天然进入 Pi 的对话上下文
- 不需要新命令、不需要新心智模型 —— 你还是只用 `pi`

**这条路的天花板（v0.3.0 新增）**：

| 局限 | 后果 |
|------|------|
| 一次性子进程（`claude --print`） | 进程退出后**没有可寻址的会话**，想接管时它已经不存在 |
| 结果是"一段最终文本" | 中间过程不可见、不可插话、不可打断 |
| 不是 A2A 意义上的 Agent 协作 | 丢失"多轮协商 / 请求澄清 / 中途改主意"的能力（A2A 文档专门有 "Why Agents Are Not Tools" 一节） |
| 递归与上下文 | 子代理的会话与父会话是两条隔离的真相，无法互相接手 |

**结论**：快任务通道保留（便宜、简单），但需要第二条通道 —— 见下节。

### 2.3 三端互通的本质：Hub + 瘦客户端

**数据只有一份，存在你的电脑上。手机不"同步"数据，只"访问"数据。**

```
     你的电脑 (Hub — 唯一数据源)
              │
     ┌────────┼────────┐
  PC 浏览器  手机浏览器  Telegram/微信
  (localhost) (远程)    (已有桥接)
```

这样彻底回避了分布式同步、冲突合并、离线一致性等问题。

### 2.4 远程可达方案

| 方案 | 场景 | 成本 | 推荐度 |
|------|------|------|--------|
| 局域网直连 | 同一 WiFi | 免费 | 备用 |
| **Tailscale** | 任何网络 | 免费（个人） | ⭐ **首选** |
| Cloudflare Tunnel | 任何网络，需域名 | 免费 | 备选 |
| 云服务器 | 7×24，电脑关机也能用 | 月费 + 数据外出 | 不推荐 |

---

### 2.5 委派形态二：可接管会话（长任务）—— v0.3.0 核心

**一句话：接管能力不是"更聪明的分派"，而是"别用一次性进程"。**

只要 Pi 派的活是**有 id 的后台会话**，接管就自动成立；只要是 `--print` 一次性进程，做多少 UI 都接管不了。

```
                    ┌────────────────────────────────┐
                    │  Pi（唯一控制面 / 编排者）        │
                    └───────────────┬────────────────┘
                                    │ dispatch(agent, task) → SessionRef
        ┌───────────────┬───────────┴────────┬────────────────┐
        ▼               ▼                    ▼                ▼
   ┌─────────┐    ┌──────────┐        ┌──────────┐    ┌──────────┐
   │  Pi     │    │  Claude  │        │  Codex   │    │   DSH    │
   │ (RPC)   │    │ (daemon/ │        │ (exec /  │    │ (tmux /  │
   │         │    │  attach) │        │  resume) │    │  pty)    │
   └────┬────┘    └────┬─────┘        └────┬─────┘    └────┬─────┘
        │              │                   │               │
   会话文件(树)    ~/.claude/         ~/.codex/        进程/终端
                   projects/*.jsonl   sessions/*.jsonl   屏幕
        │              │                   │               │
        └──────────────┴─────────┬─────────┴───────────────┘
                                 ▼
                        ┌──────────────────┐
                        │  会话注册表        │  统一寻址 + 能力矩阵
                        │  SessionRegistry │
                        └────────┬─────────┘
                                 │ see / inject / handoff
                        ┌────────▼─────────┐
                        │  控制台（Web/PWA） │  会话矩阵 · 事件流 · 接管
                        └──────────────────┘
```

**三个原子动作**（任何 Agent 实现其中任意子集即可被接管到对应程度）：

| 原语 | 含义 | 依赖能力 |
|------|------|---------|
| `see` | 读 transcript + 订阅实时事件（只读） | transcript 文件或事件流 |
| `inject` | 向运行中的会话插入消息/指令 | 控制通道（RPC / SDK / ACP） |
| `handoff` | 把驱动权交给人或交回 Pi | attach / resume / 终端 |

**两条必备机制**：

1. **租约（Lease）** —— 同一会话同一时刻**只允许一个 driver**。Pi 的 RPC 明写 stdout 是协议专用单通道；Claude 的 `attach` 也独占终端。双 driver 同时写必坏。心跳超时自动释放（人关了终端不会永久锁死会话）。
2. **检查点（Checkpoint）** —— 接管前抓一次"我在干什么"快照：本 turn 动作摘要 + 触碰过的文件 + 待办下一步，落盘成 Markdown。没有快照的接管＝让人从头读几千行 transcript。

**能力矩阵优于功能假设**：每条会话带一份 `SessionCaps`（`stream` / `inject` / `interrupt` / `attach` / `resume` / `transcript` / `permissions`），由 adapter 实测声明。UI 按矩阵决定显示哪些按钮，**不假设所有 Agent 一样**。这是整个设计最重要的一条约束。

> 详细技术评估、协议选型（ACP / A2A / MCP）与分期方案见 docs/agent-control-plane-v0.3.md。

---

## 三、功能需求

### 3.0 Agent 控制面（P0）—— v0.3.0 新增

> 这一节是 v0.3.0 的主线。§3.1 的子代理降级为"快任务通道"。

#### FR-0.1 会话注册表

Pi 必须能**发现并统一寻址**所有 Agent 的会话：

| 来源 | 发现方式 |
|------|---------|
| Pi 自己 | `~/.pi/agent/sessions/` 会话文件（树结构，支持 fork/clone） |
| Claude Code | ~/.claude/projects/*/*.jsonl 历史会话 + claude agents --json 活跃后台会话 + ACP session/list（cwd 精确匹配，原生 sessionId 一致） |
| Codex | ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（fork 血缘在文件名中）+ 状态库；ACP session/list 不覆盖原生 codex exec thread，原生会话需按 id 调 session/resume 或 codex resume |
| 无控制通道的 Agent（如 DSH） | tmux/pty 进程扫描 |

统一结构：

```ts
interface SessionRef {
  key: string;            // 全局唯一：`${agent}:${nativeId}`
  agent: "pi" | "claude" | "codex" | "dsh" | string;
  nativeId: string;       // 各 Agent 原生会话 id
  cwd: string;
  transcriptPath?: string;
  status: "running" | "idle" | "needs-input" | "exited" | "unknown";
  driver: "pi" | "human" | "none";   // 当前驱动者（来自租约）
  capabilities: SessionCaps;
  lineage?: { parent?: string; forkedFrom?: string };
}
```

#### FR-0.2 transcript 归一化（只读）

- 各 Agent 的会话格式 → 统一消息模型（role / content blocks / 工具调用 / 时间戳）
- **只读映射，绝不改写原生会话文件**
- 支持增量读取（只追加新条目），5000 行以上的会话不整体重解析

#### FR-0.3 接管协议

| 原语 | 行为 | 要求 |
|------|------|------|
| `see` | 读 transcript + 订阅实时事件 | 无副作用，可多人同时看 |
| `inject` | 向运行中会话插入消息/指令 | 需持有租约；能力不支持时降级为"下一个 turn 前注入" |
| `handoff` | 把驱动权交给人或交回 Pi | 交接前必须生成检查点 |

- **租约**：单会话单 driver，`acquire / release / heartbeat`，超时自动释放
- **检查点**：`~/.pi-workbench/handoffs/<sessionKey>-<ts>.md`，含动作摘要、触碰文件、下一步
- **归还**：release 时读回增量，生成 diff 摘要注入 Pi 上下文；不可读则显式告警（不允许"静默失去上下文"）

#### FR-0.4 派发即建会话

- `dispatch(agent, task) → SessionRef`：**返回可寻址句柄，不是一段文本**
- 长任务**禁止**使用一次性子进程（`claude --print` 之类）
- 派发出去的会话，Pi 与人**双向**可接管（在 Pi 控制台，或对应 Agent 原生终端）
- 快任务仍可走 §3.1 的 subagent 通道，但 UI 必须**显式标注"不可接管"**

#### FR-0.5 资产桥（工具 / 插件 / 会话 / 记忆）

| 资产 | 接管方式 | 方向 |
|------|---------|------|
| **工具** | 各 Agent 使用的 **MCP server 统一注册给 Pi**（Pi 已内置 MCP Client，stdio + streamable HTTP） | ✅ 双向共用 |
| **插件** | 拆两块：MCP server → 走工具路径；`skills/` `agents/` `prompts/`（本质都是 Markdown）→ 双向同步 | ✅ 基本双向 |
| **会话** | Pi 能读、能引用、能摘要；继续执行时**回原生 Agent**（借读不搬家） | ⚠️ 读为主 |
| **记忆** | Pi 的 Markdown 记忆为主库；**生成 `AGENTS.md` / `CLAUDE.md` 托管段落**，让原生 Agent 启动即继承 | ⚠️ 下行为主 |

**非目标（明确排除）**：插件**运行时**（Claude 插件市场、DSH 的一万多个插件）不可移植，不做承诺；跨 Agent 记忆实时同步不做（沿用决策 2）。

#### FR-0.6 能力矩阵与降级

- 每个 adapter 声明并**实测**自己的 `SessionCaps`（`stream` / `inject` / `interrupt` / `attach` / `resume` / `transcript` / `permissions`）
- **未实现的能力不注册对应工具、UI 不显示对应按钮**（避免 LLM 调用到不存在的功能）
- 失败必有降级路径：`inject` 不可 → turn 边界注入；无控制通道 → tmux/pty；`attach` 不可 → 只读 + logs

- **能力矩阵按 Agent 分项**：Claude 支持 ACP session/list（cwd 精确匹配）+ session/resume（运行中需先 quiesce）+ attach；Codex 支持 ACP session/resume by id 与 native codex resume，但 ACP session/list 不覆盖 native；Pi 支持 SDK/RPC + native pi --session，但 RPC 无锁，必须租约。


---

### 3.1 子代理编排（P0，v0.3.0 降级为快任务通道）

#### FR-1.1 子代理工具注册

| 工具名 | 后端 | 适用场景 | 实现方式 |
|--------|------|---------|---------|
| `delegate_claude` | Claude Code CLI | 架构设计、复杂重构、深度代码审查 | `claude --print` 子进程 |
| `delegate_codex` | Codex CLI | computer-use、浏览器操作、OpenAI 生态任务 | `codex exec` 子进程 |
| `delegate_dsh` | DSH Desktop | 插件调用、IM 推送、Cron 管理、computer-use | 直连 `windows-mcp` / DSH 侧 MCP Server / pty 兜底（见 §3.6） |
| `delegate_pi` | Pi 自身子会话 | 并行探索、隔离上下文的独立子任务 | Pi SDK `createAgentSession()` |

每个工具需声明：

```typescript
interface SubAgentSpec {
  name: string;
  binary?: string;              // CLI 路径
  capabilities: string[];       // 能力标签
  costTier: "low" | "medium" | "high";
  timeoutMs: number;
  available(): Promise<boolean>;  // 可用性探测
}
```

#### FR-1.2 可用性探测与降级

- Pi 启动时探测各子代理是否可用（`claude --version` 等）
- 不可用的子代理**不注册工具**，避免 LLM 调用到不存在的工具
- 输出到 stderr 诊断：`[workbench] claude: unavailable (binary not found)`

#### FR-1.3 子任务结果回传

- 子代理的 stdout 作为工具结果返回给 Pi LLM
- 超长输出自动截断并附摘要提示
- stderr 单独捕获，追加到结果末尾（标注 `[stderr]`）
- 非零退出码在 `details.exitCode` 中体现，LLM 可感知失败

#### FR-1.4 并行子代理（P1）

- 当 LLM 在一次响应中调用多个 `delegate_*` 时，并发执行
- 各自独立的超时与取消（Pi 的 `signal` 会传播）

---

### 3.2 统一记忆系统（P0）

#### FR-2.1 设计原则

**Pi 的记忆是唯一事实来源。** 第一期不读取其他 Agent 的记忆目录。

```
~/.pi-workbench/memory/
├── MEMORY.md                 # 索引：一行一条，供快速检索
├── user-profile.md           # 用户画像：角色、技术栈、沟通偏好
├── preferences/              # 稳定偏好
│   ├── coding-style.md
│   ├── tooling.md
│   └── workflow.md
├── projects/                 # 项目级上下文
│   ├── yu-picture-ai.md
│   └── ...
├── knowledge/                # 技术知识沉淀
└── feedback/                 # 工作方式反馈
    └── corrections.md        # "下次别这样做"
```

#### FR-2.2 记忆格式

沿用 Claude Code 的 frontmatter 约定，保证可读性、Git 友好、未来可迁移：

```markdown
---
name: typescript-strict-preference
description: 用户偏好 TypeScript 严格模式；JS 项目中也倾向加 JSDoc 类型标注
metadata:
  type: preference | user | project | knowledge | feedback
  updated: 2026-11-13
  confidence: high | medium | low
---

具体内容。可用 [[other-memory]] 互链。
```

`MEMORY.md` 索引格式（每行一条）：

```markdown
- [typescript-strict-preference](preferences/coding-style.md) — 偏好 TS 严格模式
- [yu-picture-ai](projects/yu-picture-ai.md) — PDS 云相册项目，阿里云 + Chrome 优先
```

#### FR-2.3 记忆工具（暴露给 Pi LLM）

| 工具 | 说明 |
|------|------|
| `memory_search` | 按关键词 / 标签 / 类型检索记忆，返回摘要 + 文件路径 |
| `memory_read` | 读取指定记忆的完整内容 |
| `memory_write` | 创建或更新记忆（自动维护 MEMORY.md 索引） |
| `memory_list` | 列出全部记忆（可按 type 过滤） |
| `memory_forget` | 删除记忆（软删除到 `.trash/`） |

#### FR-2.4 记忆注入

- **会话启动时**：自动注入 `user-profile.md` + 高置信度 `preferences/*` 到 system prompt（通过 extension 的 `session_start` 事件）
- **按需检索**：Pi LLM 判断需要背景信息时主动调 `memory_search`
- **写入时机**：Pi 判断学到了新偏好/事实时主动调 `memory_write`；用户的明确纠正优先落盘

#### FR-2.5 记忆纠正

第一期不自动合并冲突。策略：

- 同一主题多条记忆并存时，以 `updated` 时间较新者为准（检索结果按时间倒序）
- Pi 发现矛盾时，由 Pi 判断并调用 `memory_write` 覆盖旧条目（旧的归档到 `.archive/`）
- 提供 `pi memory conflicts` 列出疑似冲突条目，供人工复核

> 跨 Agent 记忆对齐（从 Claude/Codex/DSH 导入）作为 **Phase 6 可选功能**，不在第一期范围。

---

### 3.3 个人知识库（P0）

#### FR-3.1 存储结构

```
~/.pi-workbench/knowledge/
├── index.sqlite              # SQLite WAL + FTS5 索引（trigram + 2 字 LIKE 回退）
├── docs/
│   ├── tech/                 # 技术笔记
│   ├── projects/             # 项目文档
│   ├── references/           # 参考资料
│   ├── blog-notes/           # 收集的技术博客摘要
│   └── course/               # 课程资料
└── raw/                      # 原始文件（PDF/HTML 等，不直接检索）
```

#### FR-3.2 检索方案（中型规模 100–500 篇）

- **索引**：**SQLite FTS5**（trigram + 2 字 LIKE 回退）；列权重见下；无需向量库
- **检索字段权重**：`title`(3) > `tags`(2) > `summary`(1.5) > `body`(1)
- **中文支持**：trigram 覆盖 3 字及以上；2 字查询回退 `LIKE`；`Intl.Segmenter` 仅用于摘要/展示
- 检索耗时目标 < 500ms

#### FR-3.3 知识库工具（暴露给 Pi LLM）

| 工具 | 说明 |
|------|------|
| `kb_search` | 全文检索，返回 top-N 片段 + 路径 + 相关度 |
| `kb_read` | 读取文档完整内容 |
| `kb_add` | 添加文档（支持本地文件 / URL 抓取 / 直接文本） |
| `kb_list` | 按标签/目录列出文档 |

#### FR-3.4 知识注入

- 不自动注入（避免污染上下文、浪费 token）
- 由 Pi LLM 判断需要时主动 `kb_search`
- 支持手动指定：`pi "参考 @kb/mcp-protocol 实现一个 MCP Server"`

---

### 3.4 Web 控制台（P0）

#### FR-4.1 三端形态

| 平台 | 形态 | 说明 |
|------|------|------|
| PC 桌面 | **Tauri 壳** | 打包同一套 Web UI，~5MB，远轻于 Electron |
| 手机 | **PWA** | 浏览器"添加到主屏幕"，全屏、图标、启动页，无需应用商店 |
| 任意设备 | **浏览器直开** | 响应式布局 |

一套代码，三端复用。

#### FR-4.2 核心页面

| 页面 | 功能 |
|------|------|
| **对话** | Pi 自己的会话：列表 + 消息流 + 输入框；实时流式输出；显示当前调用了哪个子代理 |
| **会话矩阵**（新增） | 所有 Agent 的全部会话一屏可见：Agent × 会话 × 状态（running / needs-input / idle / exited）× 当前 driver |
| **接管视图**（新增） | 进入单条会话：实时事件流 + 检查点快照 + `接管 / 插话 / 打断 / 交回` 按钮（按能力矩阵显示） |
| **记忆** | 记忆列表（按 type 分组）+ 搜索 + 编辑 + 新建 |
| **知识库** | 文档列表 + 搜索 + 预览 + 上传/导入 |
| **Agent 状态** | 各 Agent 可用性、版本、能力矩阵（支持哪些原语）、当前是否有活会话 |
| **设置** | 模型、路由偏好、远程访问（Tailscale 状态） |

#### FR-4.3 交互要求

- **流式渲染**：Pi 的 token 流通过 WebSocket 实时推送
- **工具调用可视化**：显示出 `🔧 delegate_claude` 等调用卡片，可展开看输入/输出
- **会话续接**：任意设备打开都能接上同一个会话（数据在 Hub 上）
- **移动端适配**：单列布局、底部输入框、大触控目标
- **原子状态可见**（新增）：每条会话常显 running / needs-input / idle / exited，以及**当前由谁驱动**（Pi / 人 / 无人）
- **能力驱动 UI**（新增）：`接管` `插话` `打断` `查看日志` 按钮**按该会话的能力矩阵显示**，能力不足就不显示，不做假按钮
- **检查点可见**（新增）：接管前展示"它干到哪了"快照，避免接手即失忆
- **不可接管要明说**（新增）：快任务（subagent 通道）的调用卡片上显著标注"不可接管"

#### FR-4.4 鉴权

- 本地访问（localhost）无需鉴权
- 远程访问需 token（首次配对生成，存 localStorage）
- WebSocket 同样校验 token

---

### 3.5 控制台服务端（P0）

#### FR-5.1 技术形态

服务端承载两件事：**Pi 自己的会话** + **控制面 API（代理其他 Agent 的会话）**。

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

// Pi 自身的 Web 会话：一个 Web 会话 ↔ 一个 AgentSession
const { session } = await createAgentSession({ cwd: workspacePath });

await session.prompt(message);   // 流式事件通过 listener 转发到 WS
```

- **Pi 会话**：优先 Pi SDK（进程内，事件流齐全）；备选 `pi --mode rpc` 子进程（隔离更强，控制面按 JSONL 单通道驱动）
- **他方会话**：不走 SDK，由 `control-plane` 的 adapter 代理（RPC / CLI / pty），归一化成**同一条** WS 事件流
- **实现形态两条路**：自研服务端，或改造现成 Pi Web 产物（`@ygncode/pi-web` / `@gang-of-beads/pi-web`）。裁决依据＝能力矩阵；**控制台需要会话矩阵与接管视图，纯聊天 UI 不够用**

#### FR-5.2 API 设计

```
GET    /api/sessions                 列出会话
POST   /api/sessions                 新建会话
GET    /api/sessions/:id             会话详情 + 历史消息
POST   /api/sessions/:id/prompt      发送消息（返回 run id）
POST   /api/sessions/:id/abort       中断当前运行
DELETE /api/sessions/:id             删除会话

GET    /api/memory                   列出/搜索记忆
POST   /api/memory                   新建记忆
PUT    /api/memory/:name             更新记忆
DELETE /api/memory/:name             删除记忆

GET    /api/kb                       列出/搜索文档
POST   /api/kb                       添加文档
GET    /api/kb/:id                   读取文档

GET    /api/agents                   子代理状态

# —— v0.3.0 控制面（前缀 /api/cp，避免与 Pi 自身会话 API 冲突）——
GET    /api/cp/sessions              全 Agent 会话矩阵（SessionRef[]，支持 ?agent=&status=）
GET    /api/cp/sessions/:key         单条会话详情：能力矩阵 + 当前 driver + 租约状态
GET    /api/cp/sessions/:key/transcript   归一化历史消息（增量：?after=<entryId>）
POST   /api/cp/sessions/:key/inject       向运行中会话插话
POST   /api/cp/sessions/:key/interrupt    打断当前 turn
POST   /api/cp/sessions/:key/lease        租约：{action:"acquire"|"release"|"heartbeat", driver, ttl}
POST   /api/cp/sessions/:key/handoff      交接：{to:"human"|"pi"} → 返回检查点 + 接管方式
GET    /api/cp/sessions/:key/checkpoint   当前检查点快照
POST   /api/cp/dispatch                   派发任务 → 返回 SessionRef（不是文本）
GET    /api/cp/agents                     各 Agent 能力矩阵（SessionCaps）

WS     /ws                          事件流：token / tool_call / tool_result / done
                                    v0.3.0 追加：session_status / needs_input / lease_changed
```

#### FR-5.3 进程管理

- 守护进程启动后写 PID 文件、占用固定端口（默认 7331，可配）
- 同一时间只允许一个实例（文件锁）
- 日志写入 `~/.pi-workbench/logs/`

---

### 3.6 DSH 能力接入（P0，路径已修正）

**事实**：本机 DSH 0.2.2-rc 是 Electron 桌面应用；~/.dsh/dsh-windows-mcp 当前为 toolchain 0.8.8 + enabled:false，系统 Python 无 windows_mcp 模块。DSH 自己不对外提供 MCP Server，也没有独立 CLI；Web GUI 127.0.0.1:11643 需鉴权且非 OpenAI 兼容 API。

**三条可行路径（按成本排序）**：

| # | 路径 | 拿到什么 | 代价 |
|---|------|---------|------|
| 1 | **Pi 直连 windows-mcp**：pi mcp add windows -- python -m windows_mcp | computer-use（鼠标 / 键盘 / 窗口 / 截图） | 待验证；系统 Python 无模块，需 DSH 自带 Python 或独立安装；无需 DSH 运行 |
| 2 | **DSH 侧实现 MCP Server 插件**（若其插件 API 支持） | 插件调用 / IM 推送 / Cron / Skills | 中；需先验证插件 API |
| 3 | **pty / tmux 接管 DSH**（兜底） | 只有屏幕文本 | 小；无结构化事件 |

**能力映射（目标态）**：

| DSH 能力 | 接入方式 |
|----------|---------|
| computer-use | 路径 1（待验证） |
| IM 桥接（Telegram / 微信） | 路径 2 或 3 |
| Cron 定时任务 | 路径 2 或 3 |
| Superpowers Skills | 复制为 Pi skills（Markdown 可移植） |
| 11000+ 插件 | **不可移植，不承诺** |

**要求**：三条路径都不通时 `delegate_dsh` 不注册，UI 明示"DSH 未接入"。**DSH 不阻塞主线。**

---

### 3.7 配置管理（P0）

```yaml
# ~/.pi-workbench/config.yaml

workbench:
  version: "0.3.2"

proxy:
  base_url: "http://127.0.0.1:1337"

server:
  port: 7331
  host: "127.0.0.1"        # 远程访问由 Tailscale 处理
  auth:
    remote_token_required: true

subagents:
  claude:
    enabled: true
    binary: "claude"
    cost_tier: "high"
    timeout_ms: 600000
  codex:
    enabled: true
    binary: "codex"
    cost_tier: "medium"
    timeout_ms: 600000
  dsh:
    enabled: true
    mode: "mcp"
    cost_tier: "low"
    timeout_ms: 120000
  pi:
    enabled: true
    mode: "sdk"
    cost_tier: "low"
    timeout_ms: 300000

memory:
  store_dir: "~/.pi-workbench/memory"
  auto_inject:
    - "user-profile.md"
    - "preferences/*.md"

knowledge:
  store_dir: "~/.pi-workbench/knowledge"
  search_engine: "sqlite-fts5"
  max_results: 5

ui:
  theme: "dark"
  default_workspace: "~"
```

---

## 四、非功能需求

### 4.1 性能

| 指标 | 目标 |
|------|------|
| 子代理委派开销（不含模型耗时） | < 200ms |
| 记忆检索 | < 50ms |
| 知识库检索（500 篇） | < 500ms |
| Web 首屏加载（局域网） | < 1.5s |
| token 流式首字延迟增量 | < 50ms |

### 4.2 可靠性

- 数据全部本地，无外部依赖
- 子代理失败不影响 Pi 主流程（工具返回错误，LLM 自行处理）
- 守护进程崩溃后会话可从 Pi 原生 session 文件恢复
- 记忆/知识库写入使用原子操作（临时文件 + rename）

### 4.3 安全

- API Key 全部由代理管理，不落任何配置文件
- 控制台服务端默认只监听 `127.0.0.1`，远程访问依赖 Tailscale 私有网络
- 远程访问强制 token 鉴权
- 知识库支持 `.gitignore` 排除敏感文档

### 4.4 兼容性

- 主平台 Windows 11 + Git Bash
- Node.js >= 22.19（Pi Agent 硬性要求）
- 浏览器：Chrome/Edge 最新版、iOS Safari 16+、Android Chrome 最新版

---

## 五、技术选型

| 层 | 技术 | 理由 |
|----|------|------|
| **Pi 扩展** | TypeScript + `@earendil-works/pi-coding-agent`（ExtensionAPI） | 唯一能注册工具给 Pi LLM 的方式 |
| **服务端** | Node.js + **Pi SDK** (`createAgentSession`) | 官方进程内集成，事件流齐全 |
| **HTTP 框架** | **Fastify** | 轻量、高性能、内置 schema 校验、WebSocket 支持 |
| **WebSocket** | `@fastify/websocket` | 与 Fastify 一体 |
| **前端框架** | **React 19 + Vite** | 生态成熟、组件丰富、Vite 开发体验好 |
| **前端状态** | **Zustand** | 轻量，无 boilerplate |
| **前端样式** | **Tailwind CSS** | 响应式开发最快，适合三端适配 |
| **全文检索** | **SQLite FTS5**（trigram + 2 字 LIKE 回退） | 与决策 4 一致；FTS5 列权重 + LIKE 回退，无需向量库 |
| **配置** | YAML (`yaml`) | 可读、可注释 |
| **进程调用** | `execa` | 取消信号、超时、输出捕获完善 |
| **桌面壳** | **Tauri 2** | ~5MB，远轻于 Electron |
| **手机端** | **PWA** (vite-plugin-pwa) | 零开发成本获得"类 App"体验 |
| **远程网络** | **Tailscale** | 免费、免公网 IP、点对点加密 |
| **Monorepo** | pnpm workspace | 已有 pnpm 12.3.4 |
| **控制面**（v0.3.2） | **自研**（TypeScript） | SessionRegistry / EventStore / LeaseManager / CheckpointStore / HandoffManager / REST+WS / UI；约 1.5–2.5k 行 |
| **控制通道：Pi** | **Pi SDK 优先；pi --mode rpc 备选** | SDK 进程内集成；RPC 用于隔离进程。RPC 无 session 锁，必须配合 LeaseManager |
| **控制通道：Claude** | **ACP v2**（@agentclientprotocol/claude-agent-acp 0.107.0）+ claude attach / agents --json / logs / stop / resume | ACP 统一会话协议；运行中 resume 被拒时先 stop，attach 走 ConPTY |
| **控制通道：Codex** | **ACP v2**（@agentclientprotocol/codex-acp 2.6.0）+ codex exec --json / codex resume / rollout 文件解析 | ACP session/resume 可按 id 接原生 thread；session/list 不覆盖原生，发现走 rollout |
| **控制通道：兜底** | **node-pty / ConPTY**（tmux 仅 Linux/macOS） | 已验证 Windows 可打开 Claude attach / codex resume / pi --session 真实 TUI |
| **协议** | **ACP v2**（主协议）、MCP（工具）、A2A（仅参考） | ACP v2 统一 Claude/Codex 会话；A2A 不进入 v1 |
| **跨 Agent 工具层** | **MCP**（Pi 内置 Client） | 接管"工具"的唯一通用层，各 Agent 都在向 MCP 收敛 |

---

## 六、项目结构

```
pi-workbench/
├── package.json                    # pnpm workspace 根
├── pnpm-workspace.yaml
├── README.md
│
├── packages/
│   ├── control-plane/               # v0.3.2 控制面（自研核心）
│   │   └── src/
│   │       ├── registry.ts          # SessionRegistry：四类会话来源统一寻址
│   │       ├── lease.ts             # 租约 / 心跳 / 单 driver 保障
│   │       ├── takeover.ts          # see / inject / handoff / checkpoint
│   │       ├── event-bus.ts         # 归一化事件流（token/tool/status/needs-input）
│   │       ├── assets.ts            # AssetBridge：MCP 汇总 / skills 同步 / 记忆投影
│   │       └── adapters/
│   │           ├── pi.ts            # SDK/RPC + lease
│   │           ├── claude.ts        # ACP v2 + attach/logs/stop/resume
│   │           ├── codex.ts         # ACP v2 + exec --json / rollout / resume
│   │           └── pty.ts           # node-pty/ConPTY（tmux 仅 Linux/macOS）
│   ├── extension/                  # Pi 扩展（核心）—— 注册工具给 Pi LLM
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts            # 扩展入口
│   │       ├── subagents/
│   │       │   ├── claude.ts       # delegate_claude
│   │       │   ├── codex.ts        # delegate_codex
│   │       │   ├── dsh.ts          # delegate_dsh (MCP)
│   │       │   └── pi.ts           # delegate_pi (SDK)
│   │       ├── memory/
│   │       │   ├── store.ts
│   │       │   ├── tools.ts        # memory_* 工具注册
│   │       │   └── inject.ts       # session_start 注入
│   │       ├── knowledge/
│   │       │   ├── store.ts
│   │       │   ├── indexer.ts      # SQLite FTS5 索引
│   │       │   ├── ingest.ts       # md/url/pdf 导入
│   │       │   └── tools.ts        # kb_* 工具注册
│   │       └── config.ts
│   │
│   ├── server/                     # 控制台服务端（控制面 API + WS 事件流）
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts            # 启动入口
│   │       ├── session-manager.ts  # AgentSession 池
│   │       ├── routes/
│   │       │   ├── sessions.ts
│   │       │   ├── memory.ts
│   │       │   ├── kb.ts
│   │       │   └── agents.ts
│   │       ├── ws.ts               # WebSocket 事件桥
│   │       └── auth.ts
│   │
│   ├── web/                        # 前端（React + Vite）
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── public/
│   │   │   └── manifest.webmanifest  # PWA
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── pages/
│   │       │   ├── Chat.tsx
│   │       │   ├── Memory.tsx
│   │       │   ├── Knowledge.tsx
│   │       │   ├── Agents.tsx
│   │       │   └── Settings.tsx
│   │       ├── components/
│   │       │   ├── MessageStream.tsx
│   │       │   ├── ToolCallCard.tsx
│   │       │   └── ...
│   │       ├── stores/
│   │       └── lib/
│   │           └── api.ts
│   │
│   ├── desktop/                    # Tauri 桌面壳
│   │   ├── src-tauri/
│   │   └── package.json
│   │
│   └── shared/                     # 共享类型与常量
│       └── src/types.ts
│
├── docs/
│   ├── PRD.md                      # 本文档
│   └── architecture.md             # 架构详解
│
└── scripts/
    ├── dev.sh
    ├── install-extension.sh        # 链接扩展到 ~/.pi/agent/extensions/
    └── build.sh
```

---

## 七、分期计划

> 按"Web UI 优先"决策，Phase 1 就交付可对话的最小 Web UI，之后持续填肉。
>
> **v0.3.0 排序调整**：控制面（§3.0）**前置**。先验证"能不能接管"，再决定 Web 层改造还是自研，最后补记忆/知识库。
> 下面新增 Phase 0 / Phase 0.5 为控制面主线；原 Phase 1–6 顺延，其中 Phase 1 的 Web UI 部分并入控制台（见 Phase 0.5 与 §3.4）。
每个实验的通过标准见 docs/agent-control-plane-v0.3.md §7。

### Phase 0 — 控制面 Spike（1–1.5 天，只验证，不写产品代码）— ✅ 已完成 2026-11-14

**产出**：docs/技术假设验证-2026-11-14.md（能力矩阵 + 证据）。核心结论：

- [x] Claude：agents --json、logs、attach 在 ConPTY 中可用
- [x] Claude：ACP v2 initialize/new/prompt/list/close/resume 通过；运行中 resume 被拒，stop 后成功并保留上下文
- [x] Codex：ACP v2 全流程通过；session/list 不覆盖 native exec thread，但 session/resume 可按 id 接原生 thread
- [x] Codex：codex exec resume / codex resume TUI 保留上下文
- [x] Pi：RPC 双客户端无锁，确认必须做租约
- [x] Windows node-pty/ConPTY 可用
- [x] ACP 官方 adapter（claude-agent-acp 0.107.0 / codex-acp 2.6.0）通过 v2 生命周期
- [ ] DSH windows-mcp 直连（待验证，后置）

**Gate**：核心路径通过；Codex 发现走 native rollout；DSH 不影响主线。

### Phase 0.5 — 控制面主线（6–9 天）

- [ ] **会话注册表**：扫描并订阅四类会话来源（Pi / Claude / Codex / tmux），统一 `SessionRef`
- [ ] **transcript 归一化**：三种 JSONL → 统一消息模型，增量读取，只读不改原文
- [ ] **只读接管 `see`**：一屏看到所有 Agent 在干什么
- [ ] **控制通道**：Adapter:Pi（SDK/RPC + 租约）、Adapter:Claude（ACP v2 + attach/stop/resume）、Adapter:Codex（ACP v2 + native rollout/resume）、Adapter:pty（node-pty/ConPTY）
- [ ] **派发即建会话**：`dispatch(agent, task) → SessionRef`，长任务禁用一次性进程
- [ ] **`inject` / `interrupt`**：中途插话、打断
- [ ] **租约 + 检查点 + 交接**：单 driver、心跳释放、`handoff` 双向交接
- [ ] **资产桥**：MCP server 汇总注册；skills 双向同步；记忆向 `AGENTS.md` / `CLAUDE.md` 投影
- [ ] **验收**：Pi 派给 Claude 一个任务 → 控制台出现活会话 → 实时可见 → 能插话改方向 → 能打断 → 点"接管"看到检查点 → 在原生终端接着干 → 交回后 Pi 知道发生了什么

### Phase 1 — 骨架 + 最小可用 Web UI（3–4 天）

- [ ] pnpm monorepo 初始化
- [ ] `extension/` 骨架，能被 Pi 加载（`pi -e` 验证）
- [ ] 配置文件加载与 schema 校验
- [ ] `server/`：Fastify + 单会话的 `createAgentSession`
- [ ] `POST /api/sessions/:id/prompt` + WebSocket token 流式推送
- [ ] `web/`：极简对话页（输入框 + 消息流）
- [ ] **验收：手机浏览器打开，能和 Pi 对话并看到流式输出**

### Phase 2 — 子代理编排（3–4 天）

- [ ] `delegate_claude` / `delegate_codex` / `delegate_pi`
- [ ] 可用性探测、超时、取消、stderr 捕获
- [ ] 前端工具调用卡片可视化
- [ ] **验收：让 Pi"用 claude 审查这个文件"，能在 UI 里看到委派过程与结果**

### Phase 3 — 记忆系统（3–4 天）

- [ ] 记忆存储（frontmatter 格式、原子写入、MEMORY.md 索引自动维护）
- [ ] `memory_*` 五个工具
- [ ] `session_start` 自动注入 user-profile 与 preferences
- [ ] 记忆 REST API + 前端记忆页（列表/搜索/编辑）
- [ ] `pi memory` CLI 子命令（供终端使用）
- [ ] **验收：在 Web UI 里新增一条偏好，新会话中 Pi 会自动遵守**

### Phase 4 — 知识库（3–4 天）

- [ ] 文档导入（md / txt / url 抓取）
- [ ] SQLite FTS5 索引（trigram + 2 字 LIKE 回退）
- [ ] `kb_*` 四个工具
- [ ] 知识库 REST API + 前端知识库页（列表/搜索/预览/上传）
- [ ] **验收：导入 50 篇笔记，中英文关键词/短语查询能命中**

### Phase 5 — 多端分发 + DSH 接入（3–4 天）

- [ ] DSH 接入按 §3.6 逐条验：先 `pi mcp add windows -- python -m windows_mcp` 直连
- [ ] PWA 配置（manifest、service worker、图标）
- [ ] Tauri 桌面壳打包
- [ ] Tailscale 接入引导（设置页显示连接的远程地址 + 二维码）
- [ ] 远程 token 鉴权
- [ ] **验收：手机 PWA 图标打开即可用；PC 双击桌面应用即可用**

### Phase 6 — 可选增强（持续）

- [ ] 会话 fork / handover
- [ ] 从 Claude/Codex/DSH 导入记忆（记忆对齐）
- [ ] 知识库自动提炼（从会话历史提取高价值内容）
- [ ] 路由学习（基于历史统计优化子代理选择）
- [ ] 向量检索升级（sqlite-vec）
- [ ] IM 双向桥接（在微信里直接操作 workbench）

**总工期估算（v0.3.0 修订）**：

| 范围 | 工期 |
|------|------|
| 控制面主线（Phase 0 + 0.5） | **7–10.5 天** |
| 含记忆 / 知识库 / 集成 / 控制台 UI | **约 15–20 个工作日** |

> 拆分看：**不含控制面**的骨架 + 记忆 + 知识库约 **8–12 天**（见 `方案评估与落地建议.md` 的拆装口径）；控制面 7–10.5 天是本次需求新增的**真实增量**，不是估算误差。

---

## 八、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Pi 扩展 API 不稳定（1.5.x 仍在演进） | 升级 Pi 可能破坏扩展 | 锁定 Pi 版本；扩展层薄化，核心逻辑放 server 侧 |
| `claude --print` / `codex exec` 非交互行为差异 | 子代理输出格式不一致 | 每种子代理写适配层，统一结构化返回 |
| 中文全文检索效果差 | 知识库搜不准 | `Intl.Segmenter` 分词 + 标签加权；Phase 6 可升级向量检索 |
| Tailscale 在校园网/受限网络下不通 | 手机远程访问失效 | 备选 Cloudflare Tunnel；或退化为局域网 + IM 桥接 |
| Web UI 工时超预期 | 拖慢整体进度 | Phase 1 只做极简对话页，UI 精致化放到最后 |
| 子代理递归调用失控 | token 爆发 | 子代理内**不注册** delegate_* 工具（禁止递归）；设置最大调用深度与单次超时 |
| **上游控制接口是未文档化的内部实现**（如 `claude daemon` 的 socket 协议） | 高 | 只用文档化 CLI（`agents --json` / `attach` / `logs` / `respawn`），不碰 socket；接口一坏立刻可见（命令失败） |
| **双 driver 写同一条会话** | 高 | 租约 + 心跳 + 超时释放；**没有租约的 adapter 只给 `see` 权限** |

| **ACP session/list 覆盖不全** | 中 | 不能把 ACP list 当唯一发现源；Codex 原生 session 走 rollout/状态库，Claude 用 list + transcript 交叉校验 |
| **Pi RPC 无 session 锁** | 高 | 所有 Pi 路径强制 LeaseManager；单 driver；心跳/超时释放 |
| **Pi 默认模型/网关余额不可用** | 中 | 默认改用 zz/deepseek-v4.1-flash；启动前做 provider health check，失败显式告警 |

| **接管后上下文不一致**（人干的事 Pi 不知道） | 高 | 归还时强制读增量 + 生成 diff 摘要注入 Pi 上下文；不可读则显式告警，不允许静默失去上下文 |
| **跨 Agent 会话搬家语义降级** | 高 | 策略上"借读不搬家"；确需 import 时明确标注"语义已降级" |
| **能力被高估**（UI/LLM 以为能接管，实际不能） | 中 | 能力矩阵驱动：未实现的能力不注册工具、UI 不显示按钮；快任务卡片显著标注"不可接管" |
| **控制面自己变成新的单体** | 中 | adapter 接口收窄为 6 个方法（see/inject/interrupt/attach/resume/caps），新增 Agent 不得改核心 |
| **tmux 在 Windows 上不稳** | 中 | 用 `node-pty` 自建 pty（跨平台），tmux 只作 Linux/macOS 优选 |

---

## 附录 A：现有环境清单

```
OS:          Windows 11 Home China 10.0.26200
Shell:       Git Bash (MSYS2)
Node.js:     v24.16.0        （满足 Pi 要求的 >= 22.19）
npm:         12.0.2
pnpm:        12.3.4
Go:          1.25.4
Python:      3.7.0 (Anaconda)
Git:         2.49.0

Agent CLI:
  claude     2.1.323    @anthropic-ai/claude-code
  pi         1.5.2      @earendil-works/pi-coding-agent
  codex      0.167.0    @openai/codex
  cc-connect 1.5.0

Desktop:
  DSH        0.2.2-rc.2   DeepSeek Harness (Electron)
  Codex      Desktop      OpenAI Codex Desktop

Proxy:
  127.0.0.1:1337          统一 API 代理

配置路径:
  Claude:   ~/.claude/settings.json
  Codex:    ~/.codex/config.toml
  DSH:      ~/.dsh/
  Pi:       ~/.pi/          （记忆待建）
```

## 附录 B：Pi Agent 关键能力索引

| 能力 | 文档 | 用途 |
|------|------|------|
| Extensions | `docs/extensions.md` | `pi.registerTool()` / `registerCommand()` / 事件钩子 |
| SDK | `docs/sdk.md` | `createAgentSession()` 进程内集成 |
| RPC Mode | `docs/rpc.md` | `pi --mode rpc` JSONL 子进程协议（备选） |
| MCP | `docs/mcp.md` | MCP Server 管理（连 DSH） |
| Sessions | `docs/sessions.md` / `session-format.md` | 会话持久化格式 |
| Skills | `docs/skills.md` | 可复用能力包 |
| JSON 事件 | `docs/json.md` | 事件流格式（WS 桥接用） |

## 附录 C：已排除的方案

| 方案 | 排除原因 |
|------|---------|
| 独立 CLI（`pw` 命令） | 用户明确要求保留 `pi` 为入口 |
| 扩展 pi 以外再造入口 | 违背"单一入口"目标 |
| 第一期做跨 Agent 记忆同步 | 复杂度高，用户明确要求后期再做 |
| 向量数据库（第一期） | 100–500 篇规模用 SQLite FTS5 足够 |
| 纯 Electron 桌面壳 | Tauri 体积小一个数量级 |
| 云服务器部署 | 数据要留在本地，且无 7×24 需求 |
| LangChain/LangGraph 等框架 | Pi 自身已是完整 Agent 框架，引入重量级框架徒增复杂度 |
| **一次性 `--print` 子进程作为主流派**（v0.3.0） | 不可接管：进程退出即无会话，看不到、插不进、打断不了 |
| **把其他 Agent 的会话搬进 Pi 继续跑**（v0.3.0） | 语义降级（工具调用、缓存、权限模型都不等价）；改为"借读不搬家" |
| **只把 Agent 包成一个 tool**（v0.3.0） | A2A 明确反对：丢失多轮协商 / 请求澄清 / 中途改主意的能力 |
| **重造后台会话主管**（v0.3.0） | Claude Code 已内置 daemon / attach / logs / respawn，重造等于抄一遍还会永远落后 |
