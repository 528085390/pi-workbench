# Phase 0.5-B Pi transcript 记录枚举（T7 证据）

- 日期：2026-11-16
- 分支：<code>feat/phase-0.5b-codex-pi</code>（HEAD <code>3bda2a2</code>）
- 环境：Windows；Git Bash；Node <code>v24.16.0</code>；<code>pi 1.5.2</code>
- 数据源：<code>C:\Users\huang\.pi\agent\sessions</code>（真实会话文件，只读扫描）
- 边界：只读取 <code>~/.pi/agent/sessions</code> 下的 <code>*.jsonl</code>；未修改任何 Pi 会话文件、未触发 Pi 运行。

## 0. 样本规模

| 项 | 值 |
|---|---:|
| Pi session 文件 | 21 |
| 记录（行）总数 | 404 |
| JSON 解析失败行 | 0 |
| 首行 type=session 的文件 | 21 / 21 |
| session.version | 3（21 / 21） |
| 首行键集合 | <code>type,version,id,timestamp,cwd</code>（21 / 21） |

## 1. 记录 type 枚举（全部出现值）

| 记录 type | 次数 | 样本（文件:行号） | readPiTranscript 映射 |
|---|---:|---|---|
| <code>session</code> | 21 | F1:1 | 不发消息；<code>timestamp</code> 作为缺省 ts 回退；skipped 0 |
| <code>message</code> | 339 | F1:5 | 按 <code>message.role</code> 分派（见 §2） |
| <code>model_change</code> | 21 | F1:3 | 噪声，跳过并计 skipped |
| <code>thinking_level_change</code> | 22 | F1:2 | 噪声，跳过并计 skipped |
| <code>custom_message</code> | 1 | F3:9 | 未知 type，跳过并计 skipped（不抛） |

样本文件别名：

| 别名 | 文件（相对 <code>~/.pi/agent/sessions</code>） |
|---|---|
| F1 | <code>2026-11-13T12-49-11-828Z_01a1d4f4-7093-72dc-a080-0b0c65ad49ae.jsonl</code> |
| F2 | <code>2026-11-15T16-31-55-190Z_01a1e00d-1135-75a4-b87b-a4e567eb7bb0.jsonl</code> |
| F3 | <code>2026-11-16T00-22-10-901Z_01a1e1bb-9ad5-76c2-acc4-94621b7d91d0.jsonl</code> |

首行 session 实例（F1:1）：

~~~json
{"type":"session","version":3,"id":"01a1d4f4-7093-72dc-a080-0b0c65ad49ae","timestamp":"2026-11-13T12:49:11.828Z","cwd":"C:\\Users\\huang"}
~~~

噪声记录实例：

~~~json
{"type":"thinking_level_change","id":"821e78f2","parentId":null,"timestamp":"2026-11-13T12:49:11.878Z","thinkingLevel":"off"}
{"type":"model_change","id":"8c20c17b","parentId":"821e78f2","timestamp":"2026-11-13T12:50:20.835Z","provider":"radius","modelId":"balanced"}
{"type":"custom_message","customType":"pi-workbench","content":"[pi-workbench] 1 个会话有更新（未读共 7 条）…","display":true,"id":"2e9250e2","parentId":"82ae023a","timestamp":"2026-11-16T00:22:46.556Z"}
~~~

## 2. message.role 枚举

| message.role | 次数 | content 形状 | 样本（文件:行号） | readPiTranscript 映射 |
|---|---:|---|---|---|
| <code>system</code> | 21 | 字符串（含空串 + <code>sections</code> 对象） | F1:5 | 跳过并计 skipped；不产出 system 消息 |
| <code>user</code> | 29 | content block 数组，仅 <code>text</code> | F1:6 | <code>user</code> / <code>text</code> |
| <code>assistant</code> | 159 | content block 数组 | F2:6 | 拆分 <code>text</code> / <code>thinking</code> / <code>toolCall</code>（见 §3） |
| <code>toolResult</code> | 130 | content block 数组，仅 <code>text</code> | F2:7 | <code>user</code> / <code>tool_result</code>；<code>toolName</code> 透传；<code>toolCallId</code>/<code>isError</code> 作为附加元数据保留 |

合计 339 条 message：21 + 29 + 159 + 130 = 339。

关键实例：

- user（F1:6）：<code>{"role":"user","content":[{"type":"text","text":"你好"}],"timestamp":1794574230018}</code>
- assistant（F2:6，含 thinking + toolCall）：
  <code>{"role":"assistant","content":[{"type":"thinking","thinking":"…","thinkingSignature":"reasoning_content"},{"type":"toolCall","id":"call_00_h60nxVnW3OL4pFi89MNz0731","name":"cp_dispatch","arguments":{…}}],…}</code>
- toolResult（F2:7）：
  <code>{"role":"toolResult","toolCallId":"call_00_h60nxVnW3OL4pFi89MNz0731","toolName":"cp_dispatch","content":[{"type":"text","text":"dispatched claude:…"}],"details":{},"isError":false,"durationMs":2031,"timestamp":1794760406986}</code>

注意：记录级 <code>timestamp</code> 是 ISO-8601 字符串；<code>message.timestamp</code> 是 epoch 毫秒数字。解析器优先用记录级时间戳。

## 3. content block type 枚举（assistant/user/toolResult content[]）

| block type | 次数 | 出现位置 | 样本（文件:行号） | 映射 |
|---|---:|---|---|---|
| <code>text</code> | 209 | user / assistant / toolResult | F1:6、F2:8 | <code>text</code>（assistant/user）或拼进 <code>tool_result.text</code> |
| <code>thinking</code> | 88 | assistant | F2:6 | <code>thinking</code>（取 <code>thinking</code> 字段） |
| <code>toolCall</code> | 130 | assistant | F2:6 | <code>tool_call</code>；<code>name</code> → <code>toolName</code>，<code>arguments</code> → JSON 文本，<code>id</code> 作消息 id |
| （字符串 content，不是 block） | 21 | 仅 system | F1:5 | 整条 system 跳过 |

未出现其他 block type（无 image / audio / file 等）。block 总数 427 = 209 + 88 + 130；承接 318 条数组 content 的 message（29 user + 159 assistant + 130 toolResult）。

## 4. 与规格 §10.3 的逐项对照

| 规格条目 | 实测 | 解析器行为 | 测试 |
|---|---|---|---|
| <code>session</code> 不发消息、首行元数据 | 21/21 文件首行，version 3 | 只更新 <code>sessionTimestamp</code> | <code>transcript-pi.test.ts</code>「首行 session…」 |
| <code>message</code>/role=user → text(user) | 29 条，仅 text block | user/text，按 block 拆 id | 同上 + 样例 fixture |
| <code>message</code>/role=assistant → text + thinking + toolCall | 159 条；text 50、thinking 88、toolCall 130 | 逐 block 拆分，一条消息可产多条 UnifiedMessage | 同上 |
| <code>message</code>/role=toolResult → tool_result | 130 条，独立 message | user/tool_result；toolCallId/isError 附加 | 「toolResult 错误回合…」 |
| <code>message</code>/role=system → 跳过（计 skipped） | 21 条，content 为字符串 | 跳过 +1 | 「system message…」 |
| <code>model_change</code> / <code>thinking_level_change</code> 噪声 | 21 + 22 | 跳过 +1 | 样例 fixture skipped=4 |
| 未知 type 不抛 | 真实 <code>custom_message</code> 1 条 | 跳过 +1，游标继续推进 | 「未知 type…」 |

## 5. 复现命令

统计全部记录 / role / block（输出与 §0–§3 一致）：

~~~bash
cd /e/pi-workbench
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const root=path.join(os.homedir(),".pi","agent","sessions");
const files=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(".jsonl"))files.push(p);}})(root);
const types={},roles={},blocks={},versions={},headerKeys={},first={};
let total=0,bad=0;
for(const f of files){const a=fs.readFileSync(f,"utf8").split(/\r?\n/);
  for(let i=0;i<a.length;i++){const l=a[i];if(!l.trim())continue;total++;let r;try{r=JSON.parse(l)}catch{bad++;continue;}
    types[r.type]=(types[r.type]??0)+1;
    if(i===0){first[r.type]=(first[r.type]??0)+1;versions[r.version]=(versions[r.version]??0)+1;headerKeys[Object.keys(r).join(",")]=(headerKeys[Object.keys(r).join(",")]??0)+1;}
    if(r.type==="message"){const m=r.message??{};roles[m.role]=(roles[m.role]??0)+1;
      if(Array.isArray(m.content))for(const b of m.content)blocks[b.type]=(blocks[b.type]??0)+1;else blocks["(string)"]=(blocks["(string)"]??0)+1;}}}
console.log(JSON.stringify({files:files.length,total,bad,types,versions,headerKeys,first,roles,blocks},null,1));
'
~~~

列出 session 文件：

~~~bash
find "$HOME/.pi/agent/sessions" -name '*.jsonl' | wc -l
find "$HOME/.pi/agent/sessions" -name '*.jsonl' -printf '%T@ %p\n' | sort -rn | head -3
~~~

打印每类记录 / 每个 role 的第一条样本（文件:行号 + JSON 截断）：

~~~bash
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const root=path.join(os.homedir(),".pi","agent","sessions");
const files=[];(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(".jsonl"))files.push(p);}})(root);
const seen={};
for(const f of files){const a=fs.readFileSync(f,"utf8").split(/\r?\n/);
  a.forEach((l,i)=>{if(!l.trim())return;const r=JSON.parse(l);
    const key=r.type==="message"?"role:"+r.message.role:"type:"+r.type;
    if(!seen[key])seen[key]={file:path.basename(f),line:i+1,json:JSON.stringify(r).slice(0,300)};
    if(r.type==="message"&&Array.isArray(r.message.content))for(const b of r.message.content){const k="block:"+r.message.role+":"+b.type;if(!seen[k])seen[k]={file:path.basename(f),line:i+1,json:JSON.stringify(b).slice(0,200)};}});}
console.log(JSON.stringify(seen,null,1));
'
~~~

## 6. 解析器落地

- 实现：<code>packages/control-plane/src/transcript/pi.ts</code>（<code>readPiTranscript</code>）
- 注册：<code>packages/control-plane/src/transcript/index.ts</code> → <code>registerTranscriptParser("pi", readPiTranscript)</code>
- 测试：<code>packages/control-plane/test/transcript-pi.test.ts</code>（13 用例全绿；含 ESM <code>.ts</code> 导入、字节游标、坏行、未知 type、system 跳过、toolResult 元数据）
- fixture：<code>packages/control-plane/test/fixtures/pi/pi-records-sample.jsonl</code>（按本文件 §1–§3 的真实形状构造）
- 契约备注：<code>UnifiedMessage</code> 无 <code>toolCallId</code>/<code>isError</code> 字段；Pi toolResult 的这两个源字段以运行时附加属性保留（<code>PiToolResultMessage</code>），公开类型不变。

## 7. 真实会话冒烟（解析器对 21 个文件的实测）

<code>readPiTranscript(path, "0", Infinity)</code> 跑全部 21 个真实文件，结果：

| 指标 | 值 | 对账 |
|---|---:|---|
| messages | 420 | 29 user:text + 43 assistant:text + 88 assistant:thinking + 130 assistant:tool_call + 130 user:tool_result |
| skipped | 67 | system 21 + model_change 21 + thinking_level_change 22 + custom_message 1 + 空 assistant content 2（402 错误回合） |
| pending | 0 | 每个文件都读到 EOF |

说明：枚举中 text block 共 209 个；其中 29 个是 user、130 个在 toolResult、43 个是 assistant 非空 text，另有 7 个 assistant 空 text block 被忽略。只有整条消息没有任何可映射块时才计 1 次 skipped（本次命中 2 条 <code>content: []</code> 的 402 错误回合）。默认 limit=200 时，最大的 189-message 文件会在 200 条消息处截断，下一页从字节游标继续——与 Codex 解析器一致。

~~~bash
cd /e/pi-workbench
node --experimental-strip-types --input-type=module -e "import { readPiTranscript } from './packages/control-plane/src/transcript/pi.ts'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; const root=path.join(os.homedir(),'.pi','agent','sessions'); const files=[]; (function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p); else if(e.name.endsWith('.jsonl'))files.push(p);}})(root); let messages=0,skipped=0,kinds={}; for(const f of files){const p=readPiTranscript(f,'0',Infinity); messages+=p.messages.length; skipped+=p.skipped; for(const m of p.messages)kinds[m.role+':'+m.kind]=(kinds[m.role+':'+m.kind]??0)+1;} console.log(JSON.stringify({files:files.length,messages,skipped,kinds},null,1));"
~~~
