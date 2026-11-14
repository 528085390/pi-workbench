# Pi Workbench 控制面 Phase 0 Spike 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 用真实 Claude/Codex/Pi/pty 实验验证 ACP v2 薄控制面的能力矩阵，产出 docs/spike-control-plane-report.md，再决定是否进入 Phase 1。

**Architecture:** 在 spike/acp-probe 建一个只做观测的 TypeScript CLI。它通过 stdio 启动 ACP 适配器，发 initialize / session/new / session/prompt / session/list / session/resume / session/cancel / session/close，把每条 JSON-RPC 事件写进 JSONL，并汇总成能力矩阵。它不接 Web UI、不写产品数据库、不改产品代码。

**Tech Stack:** Node 24.16、TypeScript 6、@agentclientprotocol/sdk@2.6.0（experimental/v2）、@agentclientprotocol/claude-agent-acp@0.107.0、@agentclientprotocol/codex-acp@2.6.0、Node node:test、node-pty（单独实验）。

**Spec:** docs/PRD.md v0.3.0 + docs/agent-control-plane-v0.3.md

## Global Constraints

- ACP v2 仍是 draft；必须锁死适配器版本，不自动升级。
- 所有探测只读或最小写入：prompt 不要求修改文件；测试 cwd 用 E:/pi-workbench/spike/workspace。
- 不启动真实长时间任务；单次 prompt 限 120 秒，总实验限 30 分钟。
- 每个 Agent 必须记录：协议版本、初始化能力、session/new、session/list、prompt 流、idle、cancel、resume、close 的结果。
- 没有实测的能力在报告中写 no 或 blocked，不写“应该可以”。
- 证据统一放 spike/acp-probe/evidence/；不要提交 API key、token、完整环境变量。
- Windows 路径一律绝对路径；不依赖 WSL。
- 不修改 docs/PRD.md 的技术结论，直到 Phase 0 报告完成。

## Review Focus

- **ACP 适配器是否把用户原有的原生会话放进 session/list**：如果只列 adapter 自己创建的会话，PRD 的“发现已有会话”不成立。
- **ACP session id 与原生 session id 是否可映射**：不能映射则 handoff 接不回。
- **prompt 的完成语义**：session/prompt 返回不等于跑完，必须看 state_update 到 idle；不能把“已插入”误报成“已完成”。
- **cancel 后的会话是否还能 resume**：cancel 不能把会话弄坏。
- **Windows pty 是否稳定**：ConPTY 失败时必须有命名管道/Windows Terminal 兜底结论。

---

## 文件结构

- spike/acp-probe/package.json — 私有包与脚本
- spike/acp-probe/tsconfig.json — NodeNext + strict
- spike/acp-probe/src/types.ts — ProbeEvent、ProbeSummary、AgentName
- spike/acp-probe/src/summarize.ts — 把 SessionUpdate 变成可读摘要
- spike/acp-probe/src/connection.ts — 启动 adapter、ACP v2 连接、权限请求应答
- spike/acp-probe/src/probe.ts — CLI 与各 flow
- spike/acp-probe/test/summarize.test.ts — 纯函数测试
- spike/acp-probe/evidence/ — JSONL 与 summary（gitignore）
- spike/workspace/ — 探测用空工作目录
- docs/spike-control-plane-report.md — 最终报告

---

### Task 1: 脚手架、事件摘要与测试

**Files:** Create spike/acp-probe/package.json, tsconfig.json, src/types.ts, src/summarize.ts, test/summarize.test.ts, .gitignore

**Interfaces:** Produces AgentName = claude | codex；ProbeEvent = seq/ts/agent/kind/sessionId/data；summarizeUpdate(update) 返回 kind/text/state/stopReason/toolCallId。

- [ ] **Step 1: 初始化 git 与目录**

~~~bash
cd E:/pi-workbench
git init
mkdir -p spike/acp-probe/src spike/acp-probe/test spike/acp-probe/evidence spike/workspace
~~~

- [ ] **Step 2: 写 failing test**

~~~ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeUpdate } from '../src/summarize.js';

test('agent_message_chunk is text', () => {
  const r = summarizeUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
  assert.equal(r.kind, 'agent_message_chunk');
  assert.equal(r.text, 'hello');
});

test('state_update exposes idle', () => {
  const r = summarizeUpdate({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
  assert.equal(r.state, 'idle');
  assert.equal(r.stopReason, 'end_turn');
});
~~~

- [ ] **Step 3: 建 package.json / tsconfig，跑测试确认失败**

~~~json
{
  "name": "@pi-workbench/acp-probe",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "tsx --test test/*.test.ts",
    "build": "tsc -p tsconfig.json",
    "probe": "node dist/probe.js"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "2.6.0",
    "@agentclientprotocol/claude-agent-acp": "0.107.0",
    "@agentclientprotocol/codex-acp": "2.6.0"
  },
  "devDependencies": {
    "@types/node": "24.10.1",
    "tsx": "4.21.0",
    "typescript": "6.0.3"
  }
}
~~~

~~~json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
~~~

预期：npm install && npm test 失败，因为 src/summarize.ts 不存在。

- [ ] **Step 4: 实现 summarizeUpdate 与 types**

~~~ts
export type AgentName = 'claude' | 'codex';
export type ProbeEvent = { seq: number; ts: string; agent: AgentName; kind: string; sessionId?: string; data: unknown };

export function summarizeUpdate(update: unknown): {
  kind: string; text?: string; state?: string; stopReason?: string; toolCallId?: string;
} {
  const u = update as Record<string, any>;
  const out: any = { kind: String(u?.sessionUpdate ?? 'unknown') };
  const content = u?.content;
  if (content?.type === 'text' && typeof content.text === 'string') out.text = content.text;
  if (typeof u?.state === 'string') out.state = u.state;
  if (typeof u?.stopReason === 'string') out.stopReason = u.stopReason;
  if (typeof u?.toolCallId === 'string') out.toolCallId = u.toolCallId;
  return out;
}
~~~

- [ ] **Step 5: 跑测试并提交**

~~~bash
cd spike/acp-probe && npm test
cd E:/pi-workbench && git add .gitignore spike/acp-probe && git commit -m 'chore: scaffold ACP probe spike'
~~~

预期：2 tests PASS。

---

### Task 2: ACP v2 连接与 probe CLI

**Files:** Create spike/acp-probe/src/connection.ts, src/probe.ts；Modify src/types.ts

**Interfaces:** Produces connectAgent(agent, cwd, onEvent) 与 runFlow(agent, flow, prompt)。

- [ ] **Step 1: 写 connection.ts**

~~~ts
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientApp, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/experimental/v2';
import type { AgentName } from './types.js';

const BIN: Record<AgentName, string> = { claude: 'claude-agent-acp', codex: 'codex-acp' };

export function spawnAgent(agent: AgentName, cwd: string) {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(command, ['-y', BIN[agent]], { cwd, stdio: ['pipe','pipe','pipe'], env: process.env });
  child.stderr.on('data', (b) => process.stderr.write('[' + agent + '] ' + b));
  return child;
}

export async function connectAgent(agent: AgentName, cwd: string, onUpdate: (n: any) => void) {
  const child = spawnAgent(agent, cwd);
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );
  const app = new ClientApp({ name: 'pi-workbench-acp-probe' })
    .onNotification(methods.client.session.update, (ctx) => onUpdate(ctx.params))
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      const options = ctx.params.options ?? [];
      const option = options.find((o: any) => o.kind === 'allow_once') ?? options[0];
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
    });
  const conn = app.connect(stream);
  const init = await conn.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    info: { name: 'pi-workbench-acp-probe', version: '0.1.0' },
  });
  return { child, conn, init };
}
~~~

- [ ] **Step 2: 写 probe.ts 参数与事件记录**

支持：
~~~text
node dist/probe.js --agent claude --flow full --prompt 'Reply with exactly ACP_OK' --out evidence/claude-full.jsonl
node dist/probe.js --agent codex --flow full --prompt 'Reply with exactly ACP_OK' --out evidence/codex-full.jsonl
~~~

规则：每条 session/update 追加 JSONL；stdout 打印 kind=...；最后写同名 .summary.json。

- [ ] **Step 3: full flow 顺序**

~~~text
initialize -> session/new -> session/prompt -> wait for idle (max 120s)
-> session/list -> session/cancel (if still running) -> close -> resume -> close
~~~

session/prompt 的返回只表示插入；必须等 state_update 且 state === idle。没有 idle 记 no_idle。

- [ ] **Step 4: 构建并验证帮助**

~~~bash
cd spike/acp-probe && npm run build && node dist/probe.js --help
~~~

预期：打印用法，退出码 0。

- [ ] **Step 5: 提交**

~~~bash
git add spike/acp-probe/src && git commit -m 'feat: add ACP v2 probe connection and CLI'
~~~

---

### Task 3: Claude ACP v2 全流程

- [ ] **Step 1: 确认 Claude 可用**：claude --version; claude agents --json。预期 2.1.323；JSON 数组（可为空）。
- [ ] **Step 2: 跑 full flow**：

~~~bash
cd spike/acp-probe
node dist/probe.js --agent claude --flow full --prompt 'Reply with exactly ACP_OK and do not modify any files.' --out evidence/claude-full.jsonl
~~~

预期：initialize 返回 protocolVersion 2；session/new 返回 sessionId；至少一条 agent_message_chunk；有 state_update idle；session/list 包含该 sessionId；close/resume 不报错。
- [ ] **Step 3: 记录失败模式**：npx 找不到或初始化失败时记录 stderr 前 50 行，尝试 npx -y @agentclientprotocol/claude-agent-acp@0.107.0；仍失败标 blocked，不猜。
- [ ] **Step 4: 提交证据**：git add evidence/claude-full.jsonl evidence/claude-full.summary.json && git commit -m 'test: capture Claude ACP v2 full flow'。

---

### Task 4: Claude 原生会话发现与 handoff 映射

- [ ] **Step 1: 创建后台原生会话**：claude --bg -p 'Reply with exactly BG_OK and do not modify any files.'；claude agents --json。记录 sessionId/pid/cwd/status。
- [ ] **Step 2: 用 ACP session/list 查同一 cwd**：node dist/probe.js --agent claude --flow list --cwd E:/pi-workbench --out evidence/claude-list-native.jsonl。若 sessions[] 没有刚才的 sessionId，明确记录“ACP session/list 不覆盖已有原生会话”。
- [ ] **Step 3: 检查 native id 映射**：claude logs <sessionId>，确认与 ACP list id 一致或能对应；否则记 native_id_map=no。
- [ ] **Step 4: 记录 native_discovery=yes|no|partial 与证据路径。**

---

### Task 5: Codex ACP v2 全流程

- [ ] **Step 1: 确认 Codex 可用**：codex --version; codex login status。预期 0.167.0；记录登录状态。
- [ ] **Step 2: 跑 full flow**：node dist/probe.js --agent codex --flow full --prompt 'Reply with exactly ACP_OK and do not modify any files.' --out evidence/codex-full.jsonl。预期 initialize protocolVersion 2；session/new；至少一条 agent_message；有 idle；list/resume/close 不报错。
- [ ] **Step 3: 版本冲突时**：设置 CODEX_PATH=C:/Users/huang/AppData/Roaming/npm/codex.cmd 重跑；仍失败记 blocked。
- [ ] **Step 4: 提交证据。**

---

### Task 6: Pi RPC 与双客户端冲突

- [ ] **Step 1: 查 Pi RPC 协议**：pi --help；读 C:/Users/huang/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md（若存在）。
- [ ] **Step 2: 起一个 RPC 进程**：pi --mode rpc --session E:/pi-workbench/spike/workspace/pi-session.jsonl。
- [ ] **Step 3: 模拟两个客户端**：两个 Node 脚本同时向同一 stdin 发请求，或第二进程用同一 session 文件启动。记录拒绝/冲突/锁行为；决定 Lease 是否必须。
- [ ] **Step 4: 写入报告 Pi 行。**

---

### Task 7: node-pty Windows 实验

- [ ] **Step 1: 安装**：cd spike/acp-probe && npm install node-pty@1.1.0。失败则尝试 @homebridge/node-pty-prebuilt-multiarch。
- [ ] **Step 2: 最小测试**：spawn cmd.exe /c echo PTY_OK，cols 80 rows 24；预期 out 含 PTY_OK，exitCode 0。
- [ ] **Step 3: 失败则结论 pty_fallback=windows-terminal-named-pipe，不把 tmux 当 Windows 主路径。**

---

### Task 8: 产出能力矩阵与报告

**Files:** Create docs/spike-control-plane-report.md

- [ ] **Step 1: 汇总证据**：每个 agent 一行，列协议、initialize、new、list、stream、inject、interrupt、resume、close、native handoff、备注；只填实测值，未跑写 not_tested。
- [ ] **Step 2: 写 Gate 结论**：Claude 通过→Phase 1 Claude adapter；Codex 通过→Phase 1 Codex adapter，失败则只做只读/快任务；Pi 通过→SDK 直连，RPC 冲突则强制 Lease；pty 通过→DSH 兜底可用，失败则 DSH 继续后置。
- [ ] **Step 3: 更新 PRD 技术假设**：只把实测结论写进 docs/PRD.md 对应决策行；未验证保持 ?。
- [ ] **Step 4: 提交**：git add docs/spike-control-plane-report.md docs/PRD.md && git commit -m 'docs: add Phase 0 control-plane capability report'。

---

## 验收

- docs/spike-control-plane-report.md 存在，包含 4 个 agent 行和证据路径。
- 每条 yes 都有对应 JSONL 或命令输出；每条 no/blocked 都有失败原因。
- 不把 ACP v2 draft 的能力写成稳定承诺。
- 没有修改产品代码；spike/acp-probe 可独立删除。
