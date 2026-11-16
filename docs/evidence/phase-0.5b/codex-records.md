# Codex rollout 记录枚举（0.5-B B05-a 证据）

- 日期：2026-11-16
- 语料：本机 34 个 rollout 文件（~/.codex/sessions/**/rollout-*.jsonl），20,731 条非空 JSONL 行
- 解析失败：0 行
- 结论：共 23 种 type|payload.type 组合；T4 解析器按 spec §10.3 映射，未覆盖的类型一律 skip + skipped 计数，不抛异常
- 对应实现：packages/control-plane/src/transcript/codex.ts
- 对应 fixture：packages/control-plane/test/fixtures/codex/rollout-sample.jsonl
- 对应测试：packages/control-plane/test/transcript-codex.test.ts

## 1. 复现命令（PowerShell + Node）

以下脚本只读首行/逐行 JSON.parse，不写任何文件。输出按记录数倒序。

~~~powershell
$script = @'
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(process.env.USERPROFILE, ".codex", "sessions");
const files = [];
(function walk(dir, depth) {
  if (depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1);
    else if (entry.name.endsWith(".jsonl")) files.push(full);
  }
})(root, 0);
const counts = new Map();
const samples = new Map();
let total = 0;
let bad = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    total++;
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { bad++; continue; }
    const payloadType = obj.payload && typeof obj.payload === "object" ? String(obj.payload.type || "") : "";
    const key = String(obj.type || "") + "|" + payloadType;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!samples.has(key)) samples.set(key, path.relative(root, file) + ":" + (i + 1));
  }
}
const rows = Array.from(counts.entries())
  .sort((a, b) => b[1] - a[1])
  .map((entry) => ({ key: entry[0], count: entry[1], sample: samples.get(entry[0]) }));
console.log(JSON.stringify({ files: files.length, total, bad, rows }, null, 1));
'@
$script | node -
~~~

## 2. 全量 type|payload.type 枚举与映射裁定

计数来自上述 34 个文件；样本行号为该组合首次出现的位置（相对 ~/.codex/sessions）。

| # | type | payload.type | 记录数 | 映射 UnifiedKind | 裁定/备注 | 样本（文件:行） |
|---|---|---|---|---|---|---|
| 1 | event_msg | item_completed | 4668 | skip | 噪声；item 内容与 response_item 重复 | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:15 |
| 2 | response_item | reasoning | 2792 | thinking | 取 payload.summary[].summary_text；content[] 仅在含文本时兜底 | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:19 |
| 3 | response_item | function_call_output | 2777 | tool_result | output 可能是 string 或 block[] | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:52 |
| 4 | response_item | function_call | 2755 | tool_call | name + arguments（实测 arguments 恒为 JSON 字符串） | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:49 |
| 5 | event_msg | token_count | 2395 | skip | 噪声，占比最高的 event_msg 之一 | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:26 |
| 6 | token_usage_record | （无） | 2249 | skip | 噪声（计费记录） | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:23 |
| 7 | response_item | message | 786 | text(user/assistant) | role=developer 跳过；user 取 input_text/text，assistant 取 output_text | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:4 |
| 8 | response_item | custom_tool_call_output | 666 | tool_result | output 可能是 string 或 block[] | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:25 |
| 9 | response_item | custom_tool_call | 644 | tool_call | name + input（实测 input 恒为字符串） | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:22 |
| 10 | event_msg | thread_settings_applied | 155 | skip | 噪声（线程设置快照） | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:9 |
| 11 | turn_context | （无） | 139 | skip | 噪声（turn 级上下文） | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:8 |
| 12 | inter_agent_communication_metadata | （无） | 137 | skip | 噪声（多 agent 通信元数据） | 2026/10/22/rollout-2026-10-22T22-06-28-01a163ef-4727-78d2-a164-266d91bfbca8.jsonl:249 |
| 13 | response_item | agent_message | 129 | text(assistant) | 实测与 message(role=assistant) 同 turn_id 双写；按 turn_id+文本去重 | 2026/10/22/rollout-2026-10-22T22-06-28-01a163ef-4727-78d2-a164-266d91bfbca8.jsonl:250 |
| 14 | event_msg | task_started | 127 | skip | 仅状态事件（state_update），不计入消息数 | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:2 |
| 15 | event_msg | task_complete | 112 | skip | 仅状态事件（state_update），不计入消息数 | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:297 |
| 16 | world_state | （无） | 74 | skip | 噪声（多 agent 环境状态） | 2026/10/22/rollout-2026-10-22T22-06-28-01a163ef-4727-78d2-a164-266d91bfbca8.jsonl:226 |
| 17 | session_meta | （无） | 41 | 不发消息 | 发现层取元信息；41 = 34 个首行 + 7 个文件中段（fork/subagent 边界） | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:1 |
| 18 | response_item | web_search_call | 29 | skip | 未知/未映射（工具调用类），按 Gate 要求跳过不抛 | 2026/11/10/rollout-2026-11-10T17-23-43-01a1c4aa-6a7e-7841-b6cb-373039f0b1f3_01a1c4c5-40e4-76e2-8939-7eb6f708797e.jsonl:14 |
| 19 | response_item | additional_tools | 16 | skip | 噪声（工具清单） | 2026/10/22/rollout-2026-10-22T21-39-16-01a163d6-606c-7943-b402-5bd1651b4fd4.jsonl:3 |
| 20 | event_msg | turn_aborted | 16 | skip | 未知/未映射（状态类），跳过不抛 | 2026/11/10/rollout-2026-11-10T17-05-30-01a1c4b4-91b5-7633-a41d-21d17bbeb979.jsonl:4 |
| 21 | compacted | （无） | 12 | skip | 噪声（压缩摘要） | 2026/11/10/rollout-2026-11-10T22-07-48-01a1c5c7-55f9-7aa1-ac52-29df3263cff1_01a1c5c9-5561-78b1-bb40-6c9136a86eed.jsonl:550 |
| 22 | response_item | tool_search_call | 6 | skip | 未知/未映射（工具检索），跳过不抛 | 2026/11/11/rollout-2026-11-11T08-42-34-01a1c601-15e9-75d2-af88-d63bb9dc45c4_01a1c80e-7c66-7a83-b6e1-51fca08b78f1.jsonl:1285 |
| 23 | response_item | tool_search_output | 6 | skip | 未知/未映射（工具检索结果），跳过不抛 | 2026/11/11/rollout-2026-11-11T08-42-34-01a1c601-15e9-75d2-af88-d63bb9dc45c4_01a1c80e-7c66-7a83-b6e1-51fca08b78f1.jsonl:1287 |

合计 20,731 条，覆盖全部非空行，无未归类记录。

## 3. 关键字段形状（同一脚本可扩展验证）

### 3.1 response_item / message（786 条）

| role | 条数 | content block 类型分布 | 映射 |
|---|---|---|---|
| developer | 233 | input_text（350 块） | skip（系统提示词） |
| user | 153 | input_text（240 块）、input_image（42 块） | text(user)，image 忽略 |
| assistant | 400 | output_text（400 块） | text(assistant) |

样本行号：developer 见 2026/10/22/rollout-2026-10-22T21-39-16-...jsonl:4；user 见同文件:7；assistant 见同文件:17。

### 3.2 response_item / reasoning（2792 条）

- 文本载体是 payload.summary[]，元素 type 全为 summary_text（共 2531 个文本块）。
- payload.content 字段在 2219 条里存在，但内容为空/无文本块；解析器先读 summary，content 仅作兜底。
- 这是对 spec §10.3「content[] 取 summary_text」的实测修正（两者都兼容）。

### 3.3 tool call / output

- function_call 2755 条：arguments 100% 为 string（JSON 字符串），name 均存在。
- custom_tool_call 644 条：input 100% 为 string，name 均存在。
- function_call_output + custom_tool_call_output 共 3443 条：output 为 string 3042 条、为 block[] 401 条（block.type = input_text）。

### 3.4 session_meta

- 首行 34 条：thread_source = user 26 / subagent 7 / 缺字段 1（originator=pi-workbench-acp-probe，0.166.0 样本）。
- payload.session_id 与 payload.id 在 7 个文件里不同（fork/subagent 文件）：session_id 指根会话，id 指当前 thread（rollout 文件名后缀）。
- T3 发现层按 payload.id（thread id）生成 codex:<id>，不按 thread_source 过滤；cwd 一律取首行 payload.cwd。

## 4. 解析器裁定与 skipped 口径

- skipped 统计「本次消费但未产出消息的行」，包含：developer 消息、event_msg 噪声、未知 type/payload.type、坏 JSON 行；不包含 session_meta（元数据行，不计为跳过）。
- 未知 type/payload.type 一律 skip + skipped++，绝不抛异常（Gate「未知事件不崩」）。
- 文件缺失/为空：{ messages: [], nextCursor: "0", pending: true, skipped: 0 }。
- 游标：UTF-8 字节偏移字符串；末尾半行不消费；limit 截断后下次从剩余行继续（与 readClaudeTranscript 语义一致）。
- agent_message 去重：同一 turn_id + 相同文本视为双写，只保留 message(role=assistant) 版本。
