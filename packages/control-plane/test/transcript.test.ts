import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { claudeProjectDir, listClaudeSessions, readClaudeTranscript } from "../src/transcript/claude.ts";

/** A00 实测的 timestamp 形状 */
const TS = "2026-11-14T14:58:06.210Z";

function textLine(uuid: string, text: string, role: "user" | "assistant" = "user"): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: role,
    message: { role, content: [{ type: "text", text }] },
    uuid,
    timestamp: TS,
  });
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function tempFile(t: { after: (fn: () => void) => void }, name = "session.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

test("claudeProjectDir: cwd 的 ':' '/' '\\' 全部压成 '-'，拼在 ~/.claude/projects 下", () => {
  assert.equal(
    claudeProjectDir("E:\\pi-workbench\\spike\\a00-workspace"),
    join(homedir(), ".claude", "projects", "E--pi-workbench-spike-a00-workspace"),
  );
  assert.equal(claudeProjectDir("/home/huang/p"), join(homedir(), ".claude", "projects", "-home-huang-p"));
});

test("readClaudeTranscript: 从 cursor 0 读到 user+assistant 两条，nextCursor 为字节偏移", (t) => {
  const file = tempFile(t);
  const line1 = textLine("u1", "Reply with exactly A00_MWGJ5OP0");
  const line2 = textLine("a1", "A00_MWGJ5OP0", "assistant");
  writeFileSync(file, `${line1}\n${line2}\n`, "utf8");

  const page = readClaudeTranscript(file, "0");

  assert.equal(page.messages.length, 2);
  assert.equal(page.pending, false);
  assert.equal(page.nextCursor, String(bytes(line1) + bytes(line2) + 2));

  const first = page.messages[0];
  const second = page.messages[1];
  assert.equal(first.role, "user");
  assert.equal(first.kind, "text");
  assert.equal(first.text, "Reply with exactly A00_MWGJ5OP0");
  assert.equal(first.ts, TS);
  assert.equal(typeof first.id, "string");
  assert.ok(first.id.length > 0, "id 不能为空");
  assert.equal(second.role, "assistant");
  assert.equal(second.text, "A00_MWGJ5OP0");
  assert.notEqual(first.id, second.id, "不同消息的 id 必须不同");
});

test("readClaudeTranscript: 用 nextCursor 再读只拿到增量", (t) => {
  const file = tempFile(t);
  const line1 = textLine("u1", "第一行");
  const line2 = textLine("a1", "第二行", "assistant");
  writeFileSync(file, `${line1}\n${line2}\n`, "utf8");

  const page1 = readClaudeTranscript(file, "0");
  assert.equal(page1.messages.length, 2);

  const line3 = textLine("u3", "第三行");
  appendFileSync(file, `${line3}\n`, "utf8");

  const page2 = readClaudeTranscript(file, page1.nextCursor);
  assert.deepEqual(page2.messages.map((m) => m.text), ["第三行"]);
  assert.equal(page2.nextCursor, String(bytes(line1) + bytes(line2) + bytes(line3) + 3));

  const page3 = readClaudeTranscript(file, page2.nextCursor);
  assert.equal(page3.messages.length, 0);
  assert.equal(page3.pending, true, "没有新消息时 pending=true");
  assert.equal(page3.nextCursor, page2.nextCursor, "无新数据时游标不动");
});

test("readClaudeTranscript: 多字节字符按字节偏移计数（不是字符数）", (t) => {
  const file = tempFile(t);
  const line = textLine("u1", "回复 A00_MWGJ5OP0");
  writeFileSync(file, `${line}\n`, "utf8");

  const page = readClaudeTranscript(file, "0");
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].text, "回复 A00_MWGJ5OP0");
  assert.equal(page.nextCursor, String(bytes(line) + 1));
  assert.notEqual(page.nextCursor, String(line.length + 1), "中文占多字节，游标不能按字符数算");
});

test("readClaudeTranscript: 文件不存在返回 pending 空页，不抛异常", (t) => {
  const file = tempFile(t, "not-created-yet.jsonl");
  const page = readClaudeTranscript(file, "0");
  assert.deepEqual(page, { messages: [], nextCursor: "0", pending: true });
});

test("readClaudeTranscript: 空文件返回 pending 空页，不抛异常", (t) => {
  const file = tempFile(t);
  writeFileSync(file, "", "utf8");
  const page = readClaudeTranscript(file, "0");
  assert.deepEqual(page, { messages: [], nextCursor: "0", pending: true });
});

test("readClaudeTranscript: 损坏行被跳过，其余照常归一化", (t) => {
  const file = tempFile(t);
  const line1 = textLine("u1", "完整一行");
  const line3 = textLine("a1", "再来一行", "assistant");
  writeFileSync(file, `${line1}\n{ this is not json\n${line3}\n`, "utf8");

  const page = readClaudeTranscript(file, "0");
  assert.deepEqual(page.messages.map((m) => m.text), ["完整一行", "再来一行"]);
  assert.equal(page.nextCursor, String(bytes(line1) + Buffer.byteLength("{ this is not json") + bytes(line3) + 3));
});

test("readClaudeTranscript: queue-operation 等噪声行被跳过但仍推进游标", (t) => {
  const file = tempFile(t);
  const noise = JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: TS, sessionId: "s1" });
  const line = textLine("u1", "真消息");
  writeFileSync(file, `${noise}\n${line}\n`, "utf8");

  const page = readClaudeTranscript(file, "0");
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].text, "真消息");
  assert.equal(page.nextCursor, String(bytes(noise) + bytes(line) + 2), "噪声行也要被消费掉");
});

test("readClaudeTranscript: 末尾半行不消费，补全后才读到", (t) => {
  const file = tempFile(t);
  const line1 = textLine("u1", "先到的");
  const line2 = textLine("u2", "后到的");
  const head = line2.slice(0, 20);
  const tail = line2.slice(20);
  writeFileSync(file, `${line1}\n${head}`, "utf8");

  const page1 = readClaudeTranscript(file, "0");
  assert.deepEqual(page1.messages.map((m) => m.text), ["先到的"], "半行不能解析成消息");
  assert.equal(page1.nextCursor, String(bytes(line1) + 1), "游标停在半行起点");

  appendFileSync(file, `${tail}\n`, "utf8");
  const page2 = readClaudeTranscript(file, page1.nextCursor);
  assert.deepEqual(page2.messages.map((m) => m.text), ["后到的"]);
  assert.equal(page2.nextCursor, String(bytes(line1) + bytes(line2) + 2));
});

test("readClaudeTranscript: limit 截断并留下后续行给下一次读", (t) => {
  const file = tempFile(t);
  const lines = [textLine("u1", "一"), textLine("a1", "二", "assistant"), textLine("u3", "三")];
  writeFileSync(file, lines.map((l) => `${l}\n`).join(""), "utf8");

  const page1 = readClaudeTranscript(file, "0", 2);
  assert.deepEqual(page1.messages.map((m) => m.text), ["一", "二"]);
  assert.equal(page1.nextCursor, String(bytes(lines[0]) + bytes(lines[1]) + 2));

  const page2 = readClaudeTranscript(file, page1.nextCursor);
  assert.deepEqual(page2.messages.map((m) => m.text), ["三"]);
});

test("readClaudeTranscript: assistant 的 text/thinking/tool_use 与 user 的 tool_result 分别归一化", (t) => {
  const file = tempFile(t);
  const assistant = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "我来跑一下" },
        { type: "thinking", thinking: "先看目录" },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
    uuid: "a1",
    timestamp: TS,
  });
  const result = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" }],
    },
    uuid: "u2",
    timestamp: TS,
  });
  writeFileSync(file, `${assistant}\n${result}\n`, "utf8");

  const page = readClaudeTranscript(file, "0");
  assert.deepEqual(page.messages.map((m) => m.kind), ["text", "thinking", "tool_call", "tool_result"]);
  assert.deepEqual(page.messages.map((m) => m.role), ["assistant", "assistant", "assistant", "user"]);
  assert.equal(page.messages[0].text, "我来跑一下");
  assert.equal(page.messages[1].text, "先看目录");
  assert.equal(page.messages[2].toolName, "Bash");
  assert.ok(page.messages[2].text.includes("ls"), "tool_call 的 text 保留入参内容");
  assert.equal(page.messages[3].text, "file.txt");
  assert.equal(new Set(page.messages.map((m) => m.id)).size, 4, "同一行拆出的块 id 也要唯一");
});

test("readClaudeTranscript: message.content 为字符串时也归一化", (t) => {
  const file = tempFile(t);
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: "裸字符串内容" },
    uuid: "u1",
    timestamp: TS,
  });
  writeFileSync(file, `${line}\n`, "utf8");

  const page = readClaudeTranscript(file, "0");
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].kind, "text");
  assert.equal(page.messages[0].text, "裸字符串内容");
});

/** A00 探针实测的 claude agents --json --all 输出 */
const AGENTS_JSON = JSON.stringify([
  {
    sessionId: "d8c11ae0-8927-42b3-9e56-daa441d8bb83",
    name: "bg_ok exact reply",
    kind: "background",
    cwd: "E:\\pi-workbench\\spike\\workspace",
  },
  {
    sessionId: "7ce0f985-15e4-461a-82dc-f4051d48acff",
    name: "a00-workspace-6d",
    status: "busy",
    kind: "interactive",
    cwd: "E:\\pi-workbench\\spike\\a00-workspace",
  },
]);

function fakeRunner(stdout: string): {
  run: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    run: async (cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push([cmd, ...args].join(" "));
      return { stdout };
    },
  };
}

test("listClaudeSessions: 解析 claude agents --json --all 并映射成 SessionRef", async () => {
  const fake = fakeRunner(AGENTS_JSON);
  const refs = await listClaudeSessions({ run: fake.run });

  assert.deepEqual(fake.calls, ["claude agents --json --all"], "只调一次且参数固定");
  assert.equal(refs.length, 2);

  const background = refs.find((r) => r.kind === "background");
  const interactive = refs.find((r) => r.kind === "interactive");
  assert.ok(background !== undefined && interactive !== undefined);

  assert.equal(background.key, "claude:d8c11ae0-8927-42b3-9e56-daa441d8bb83");
  assert.equal(background.agent, "claude");
  assert.equal(background.nativeId, "d8c11ae0-8927-42b3-9e56-daa441d8bb83");
  assert.equal(background.cwd, "E:\\pi-workbench\\spike\\workspace");
  assert.equal(background.driver, "none");
  assert.equal(background.status, "unknown", "缺 status 字段 → unknown");
  assert.equal(
    background.transcriptPath,
    join(claudeProjectDir("E:\\pi-workbench\\spike\\workspace"), "d8c11ae0-8927-42b3-9e56-daa441d8bb83.jsonl"),
  );

  assert.equal(interactive.key, "claude:7ce0f985-15e4-461a-82dc-f4051d48acff");
  assert.equal(interactive.status, "running", "busy → running");
  assert.equal(interactive.kind, "interactive");

  for (const ref of refs) {
    assert.equal(ref.capabilities.stream, true);
    assert.equal(ref.capabilities.inject, true);
    assert.equal(ref.capabilities.interrupt, true);
    assert.equal(ref.capabilities.resume, true);
    assert.equal(ref.capabilities.transcript, true);
    assert.equal(ref.capabilities.permissions, true);
  }
  assert.deepEqual(background.capabilities, {
    stream: true,
    inject: true,
    interrupt: true,
    attach: true,
    resume: true,
    transcript: true,
    permissions: true,
    background: true,
  });
  assert.deepEqual(interactive.capabilities, {
    stream: true,
    inject: true,
    interrupt: true,
    attach: false,
    resume: true,
    transcript: true,
    permissions: true,
    background: false,
  });
});

test("listClaudeSessions: status 映射 busy→running / idle→idle / 缺省→unknown", async () => {
  const stdout = JSON.stringify([
    { sessionId: "s-busy", status: "busy", kind: "interactive", cwd: "/tmp/a" },
    { sessionId: "s-idle", status: "idle", kind: "interactive", cwd: "/tmp/a" },
    { sessionId: "s-none", kind: "background", cwd: "/tmp/a" },
  ]);
  const refs = await listClaudeSessions({ run: fakeRunner(stdout).run });
  const status = new Map(refs.map((r) => [r.nativeId, r.status]));
  assert.equal(status.get("s-busy"), "running");
  assert.equal(status.get("s-idle"), "idle");
  assert.equal(status.get("s-none"), "unknown");
});

test("listClaudeSessions: cwd 过滤只保留该目录下的会话", async () => {
  const refs = await listClaudeSessions({
    cwd: "E:\\pi-workbench\\spike\\a00-workspace",
    run: fakeRunner(AGENTS_JSON).run,
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].key, "claude:7ce0f985-15e4-461a-82dc-f4051d48acff");
});

test("listClaudeSessions: 输出不是数组时返回空数组（不抛异常）", async () => {
  const refs = await listClaudeSessions({ run: fakeRunner("{}").run });
  assert.deepEqual(refs, []);
});
