import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readPiTranscript } from "../src/transcript/pi.ts";
import { readTranscript } from "../src/transcript/index.ts";

const SAMPLE = fileURLToPath(new URL("./fixtures/pi/pi-records-sample.jsonl", import.meta.url));
const SESSION_TS = "2026-11-15T16:24:08.473Z";

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function tempFile(t: { after: (fn: () => void) => void }, name = "session-test.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-pi-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function userLine(text: string, id = "u1", ts = "2026-11-16T10:00:00.000Z"): string {
  return jsonLine({
    type: "message",
    id,
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function assistantLine(text: string, id = "a1", ts = "2026-11-16T10:00:01.000Z"): string {
  return jsonLine({
    type: "message",
    id,
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

test("readPiTranscript: 按 §10.3 映射 user/assistant/thinking/toolCall/toolResult", () => {
  const page = readPiTranscript(SAMPLE, "0");

  assert.equal(page.messages.length, 5);
  assert.equal(page.pending, false);
  assert.equal(page.skipped, 4, "model_change + thinking_level_change + system + custom_message");
  assert.equal(page.nextCursor, String(statSync(SAMPLE).size), "游标消费到 EOF");

  assert.deepEqual(
    page.messages.map((m) => `${m.role}:${m.kind}`),
    [
      "user:text",
      "assistant:thinking",
      "assistant:tool_call",
      "user:tool_result",
      "assistant:text",
    ],
  );
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["只回复 OK", "先看看目录", '{"command":"ls"}', "file.txt", "OK"],
  );
  assert.deepEqual(
    page.messages.map((m) => m.toolName),
    [undefined, undefined, "bash", "bash", undefined],
  );
  assert.equal(page.messages[0]!.ts, "2026-11-15T16:24:08.676Z");
  assert.equal(page.messages[1]!.ts, "2026-11-15T16:24:09.000Z");
  assert.equal(new Set(page.messages.map((m) => m.id)).size, 5, "同页消息 id 唯一");

  const result = page.messages[3] as { toolCallId?: string; isError?: boolean };
  assert.equal(result.toolCallId, "call_00_abc");
  assert.equal(result.isError, false);
});

test("readPiTranscript: 首行 session 只作元数据；缺行时间戳时回退 session.timestamp", (t) => {
  const file = tempFile(t);
  const header = jsonLine({
    type: "session",
    version: 3,
    id: "01a1e005-f219-7337-baa4-9470afbc39b3",
    timestamp: SESSION_TS,
    cwd: "E:\\pi-workbench",
  });
  const user = jsonLine({
    type: "message",
    id: "u1",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
  writeFileSync(file, `${header}\n${user}\n`, "utf8");

  const page = readPiTranscript(file, "0");
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0]!.ts, SESSION_TS);
  assert.equal(page.skipped, 0, "session 是元数据，不计入 skipped");
  assert.equal(page.nextCursor, String(bytes(header) + bytes(user) + 2));
  assert.ok(!page.messages.some((m) => m.role === "system"));
});

test("readPiTranscript: system message（content 为字符串）整条跳过并计数", (t) => {
  const file = tempFile(t);
  const system = jsonLine({
    type: "message",
    id: "s1",
    timestamp: "2026-11-16T10:00:00.000Z",
    message: { role: "system", content: "You are a coding assistant running inside pi." },
  });
  const user = userLine("只有这条该留下");
  writeFileSync(file, `${system}\n${user}\n`, "utf8");

  const page = readPiTranscript(file, "0");
  assert.deepEqual(page.messages.map((m) => m.text), ["只有这条该留下"]);
  assert.equal(page.skipped, 1);
  assert.ok(!page.messages.some((m) => m.role === "system"));
});

test("readPiTranscript: 未知 type（含真实 custom_message）只跳过计数，不抛", (t) => {
  const file = tempFile(t);
  const custom = jsonLine({
    type: "custom_message",
    customType: "pi-workbench",
    content: "[pi-workbench] 1 个会话有更新",
    display: true,
    id: "c1",
    parentId: "a2",
    timestamp: "2026-11-16T10:00:02.000Z",
  });
  const future = jsonLine({ type: "future_record", id: "x1", payload: { anything: true } });
  const notObject = "[1,2,3]";
  writeFileSync(file, `${custom}\n${future}\n${notObject}\n`, "utf8");

  const page = readPiTranscript(file, "0");
  assert.deepEqual(page.messages, []);
  assert.equal(page.skipped, 3);
  assert.equal(page.pending, true);
  assert.equal(page.nextCursor, String(statSync(file).size), "跳过后游标仍推进到 EOF");
});

test("readPiTranscript: 字节偏移游标增量读，不重复不丢行", (t) => {
  const file = tempFile(t);
  const line1 = jsonLine({ type: "session", version: 3, id: "s1", timestamp: SESSION_TS, cwd: "E:\\pi-workbench" });
  const line2 = userLine("第一行");
  writeFileSync(file, `${line1}\n${line2}\n`, "utf8");

  const page1 = readPiTranscript(file, "0");
  assert.deepEqual(page1.messages.map((m) => m.text), ["第一行"]);
  assert.equal(page1.nextCursor, String(bytes(line1) + bytes(line2) + 2));

  const line3 = assistantLine("第二行");
  appendFileSync(file, `${line3}\n`, "utf8");

  const page2 = readPiTranscript(file, page1.nextCursor);
  assert.deepEqual(page2.messages.map((m) => m.text), ["第二行"]);
  assert.equal(page2.nextCursor, String(bytes(line1) + bytes(line2) + bytes(line3) + 3));

  const page3 = readPiTranscript(file, page2.nextCursor);
  assert.equal(page3.messages.length, 0);
  assert.equal(page3.pending, true);
  assert.equal(page3.nextCursor, page2.nextCursor);
});

test("readPiTranscript: 多字节字符按 UTF-8 字节计数", (t) => {
  const file = tempFile(t);
  const line = userLine("回复 A00_MWGJ5OP0");
  writeFileSync(file, `${line}\n`, "utf8");

  const page = readPiTranscript(file, "0");
  assert.equal(page.nextCursor, String(bytes(line) + 1));
  assert.notEqual(page.nextCursor, String(line.length + 1));
});

test("readPiTranscript: limit 截断，下一页从剩余行继续", (t) => {
  const file = tempFile(t);
  const lines = [userLine("一", "u1"), assistantLine("二", "a1"), userLine("三", "u2")];
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""), "utf8");

  const page1 = readPiTranscript(file, "0", 1);
  assert.deepEqual(page1.messages.map((m) => m.text), ["一"]);
  assert.equal(page1.nextCursor, String(bytes(lines[0]!) + 1));

  const page2 = readPiTranscript(file, page1.nextCursor, 10);
  assert.deepEqual(page2.messages.map((m) => m.text), ["二", "三"]);
});

test("readPiTranscript: 文件不存在 / 空文件返回 pending 空页", (t) => {
  const missing = tempFile(t, "not-created.jsonl");
  assert.deepEqual(readPiTranscript(missing, "0"), {
    messages: [],
    nextCursor: "0",
    pending: true,
    skipped: 0,
  });

  const empty = tempFile(t, "empty.jsonl");
  writeFileSync(empty, "", "utf8");
  assert.deepEqual(readPiTranscript(empty, "0"), {
    messages: [],
    nextCursor: "0",
    pending: true,
    skipped: 0,
  });
});

test("readPiTranscript: 坏 JSON 行跳过并推进游标", (t) => {
  const file = tempFile(t);
  const line1 = userLine("完整一行");
  const bad = "{ this is not json";
  const line3 = assistantLine("再来一行");
  writeFileSync(file, `${line1}\n${bad}\n${line3}\n`, "utf8");

  const page = readPiTranscript(file, "0");
  assert.deepEqual(page.messages.map((m) => m.text), ["完整一行", "再来一行"]);
  assert.equal(page.skipped, 1);
  assert.equal(page.nextCursor, String(bytes(line1) + bytes(bad) + bytes(line3) + 3));
});

test("readPiTranscript: 末尾半行不消费，补全后才读到", (t) => {
  const file = tempFile(t);
  const line1 = userLine("先到的");
  const line2 = assistantLine("后到的");
  const head = line2.slice(0, 20);
  const tail = line2.slice(20);
  writeFileSync(file, `${line1}\n${head}`, "utf8");

  const page1 = readPiTranscript(file, "0");
  assert.deepEqual(page1.messages.map((m) => m.text), ["先到的"]);
  assert.equal(page1.nextCursor, String(bytes(line1) + 1));

  appendFileSync(file, `${tail}\n`, "utf8");
  const page2 = readPiTranscript(file, page1.nextCursor);
  assert.deepEqual(page2.messages.map((m) => m.text), ["后到的"]);
});

test("readPiTranscript: toolResult 错误回合保留 toolCallId/toolName/isError", (t) => {
  const file = tempFile(t);
  const result = jsonLine({
    type: "message",
    id: "r1",
    timestamp: "2026-11-16T10:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_error_1",
      toolName: "bash",
      content: [{ type: "text", text: "command failed" }],
      details: {},
      isError: true,
      durationMs: 12,
      timestamp: 1763229603000,
    },
  });
  writeFileSync(file, `${result}\n`, "utf8");

  const page = readPiTranscript(file, "0");
  assert.equal(page.messages.length, 1);
  const message = page.messages[0]!;
  assert.equal(message.role, "user");
  assert.equal(message.kind, "tool_result");
  assert.equal(message.text, "command failed");
  assert.equal(message.toolName, "bash");
  assert.equal(message.ts, "2026-11-16T10:00:03.000Z");
  const meta = message as { toolCallId?: string; isError?: boolean };
  assert.equal(meta.toolCallId, "call_error_1");
  assert.equal(meta.isError, true);
});

test("readPiTranscript: assistant content 为空（402 错误回合）不产出消息，只计数", (t) => {
  const file = tempFile(t);
  const emptyAssistant = jsonLine({
    type: "message",
    id: "a402",
    timestamp: "2026-11-16T10:00:04.000Z",
    message: {
      role: "assistant",
      content: [],
      api: "pi-messages",
      provider: "radius",
      model: "balanced",
      stopReason: "error",
      errorMessage: "402 Payment Required",
    },
  });
  writeFileSync(file, `${emptyAssistant}\n`, "utf8");

  const page = readPiTranscript(file, "0");
  assert.deepEqual(page.messages, []);
  assert.equal(page.skipped, 1);
  assert.equal(page.pending, true);
});

test("readTranscript: pi 已注册，对象与位置参数两种调用一致，skipped 透传", () => {
  const objectForm = readTranscript({ agent: "pi", path: SAMPLE, cursor: "0" });
  const positionalForm = readTranscript("pi", SAMPLE, "0");

  assert.deepEqual(objectForm, positionalForm);
  assert.equal(objectForm.messages.length, 5);
  assert.equal(objectForm.skipped, 4);
  assert.equal(objectForm.pending, false);
});

test("readPiTranscript: 文件变短时游标归零并产出 notice", (t) => {
  const path = tempFile(t);
  writeFileSync(path, jsonLine({ type: "session", version: 3, id: "s1", timestamp: SESSION_TS, cwd: "E:\\proj" }) + "\n" + userLine("第一行") + "\n" + assistantLine("第二行") + "\n", "utf8");
  const first = readPiTranscript(path, "0");

  writeFileSync(path, jsonLine({ type: "session", version: 3, id: "s1", timestamp: SESSION_TS, cwd: "E:\\proj" }) + "\n" + userLine("替换后的短文件") + "\n", "utf8");
  const page = readPiTranscript(path, first.nextCursor);

  assert.equal(page.messages[0]?.kind, "notice");
  assert.ok(page.messages.some((message) => message.text === "替换后的短文件"));
});
