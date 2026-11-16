import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkbenchError } from "../src/errors.ts";
import { readClaudeTranscript } from "../src/transcript/claude.ts";
import { readCodexTranscript } from "../src/transcript/codex.ts";
import { readTranscript } from "../src/transcript/index.ts";

const SAMPLE = fileURLToPath(new URL("./fixtures/codex/rollout-sample.jsonl", import.meta.url));

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function tempFile(t: { after: (fn: () => void) => void }, name = "rollout-test.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-codex-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

function userLine(text: string, id = "u1", ts = "2026-11-16T10:00:00.000Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", id, role: "user", content: [{ type: "input_text", text }] },
  });
}

function assistantLine(text: string, id = "a1", ts = "2026-11-16T10:00:01.000Z"): string {
  return JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] },
  });
}

test("readCodexTranscript: 按 §10.3 映射 user/assistant/thinking/tool_call/tool_result", () => {
  const page = readCodexTranscript(SAMPLE, "0");

  assert.equal(page.messages.length, 8);
  assert.equal(page.pending, false);
  assert.equal(page.skipped, 6, "developer + token_count + task_started + 未知 type + web_search_call + 重复 agent_message");
  assert.equal(page.nextCursor, String(statSync(SAMPLE).size), "游标消费到 EOF");

  assert.deepEqual(
    page.messages.map((m) => `${m.role}:${m.kind}`),
    [
      "user:text",
      "assistant:text",
      "assistant:thinking",
      "assistant:tool_call",
      "user:tool_result",
      "assistant:tool_call",
      "user:tool_result",
      "assistant:text",
    ],
  );
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["你好", "我来看看", "先列目录", '{"command":"ls"}', "file.txt", "console.log(1)", "done", "最终回答"],
  );
  assert.deepEqual(
    page.messages.map((m) => m.toolName),
    [undefined, undefined, undefined, "shell", undefined, "exec", undefined, undefined],
  );
  assert.equal(page.messages[0]!.ts, "2026-11-16T10:00:02.000Z");
  assert.equal(new Set(page.messages.map((m) => m.id)).size, 8, "同页消息 id 唯一");
});

test("readCodexTranscript: developer 角色与 token_count 噪声跳过，不产出消息", () => {
  const page = readCodexTranscript(SAMPLE, "0");
  assert.ok(!page.messages.some((m) => m.text === "system prompt"));
  assert.ok(!page.messages.some((m) => m.text.includes("token")));
});

test("readCodexTranscript: reasoning 取 summary[].summary_text 映射为 thinking", () => {
  const page = readCodexTranscript(SAMPLE, "0");
  const thinking = page.messages.find((m) => m.kind === "thinking");
  assert.ok(thinking);
  assert.equal(thinking.role, "assistant");
  assert.equal(thinking.text, "先列目录");
});

test("readCodexTranscript: function_call/custom_tool_call → tool_call，output → tool_result", () => {
  const page = readCodexTranscript(SAMPLE, "0");
  const calls = page.messages.filter((m) => m.kind === "tool_call");
  const results = page.messages.filter((m) => m.kind === "tool_result");
  assert.deepEqual(calls.map((m) => m.toolName), ["shell", "exec"]);
  assert.deepEqual(results.map((m) => m.text), ["file.txt", "done"]);
  assert.equal(results[0]!.role, "user");
});

test("readCodexTranscript: 未知 type/payload.type 只跳过计数，不抛异常", (t) => {
  const file = tempFile(t);
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "response_item", payload: { type: "totally_new", id: "x" } }),
      JSON.stringify({ type: "mystery_record", payload: { type: "mystery" } }),
      "",
    ].join("\n"),
    "utf8",
  );

  const page = readCodexTranscript(file, "0");
  assert.deepEqual(page.messages, []);
  assert.equal(page.skipped, 2);
  assert.equal(page.pending, true);
  assert.equal(page.nextCursor, String(statSync(file).size));
});

test("readCodexTranscript: 字节偏移游标增量读，不重复不丢行", (t) => {
  const file = tempFile(t);
  const line1 = JSON.stringify({ type: "session_meta", payload: { id: "t1" } });
  const line2 = userLine("第一行");
  writeFileSync(file, `${line1}\n${line2}\n`, "utf8");

  const page1 = readCodexTranscript(file, "0");
  assert.deepEqual(page1.messages.map((m) => m.text), ["第一行"]);
  assert.equal(page1.nextCursor, String(bytes(line1) + bytes(line2) + 2));

  const line3 = assistantLine("第二行");
  appendFileSync(file, `${line3}\n`, "utf8");

  const page2 = readCodexTranscript(file, page1.nextCursor);
  assert.deepEqual(page2.messages.map((m) => m.text), ["第二行"]);
  assert.equal(page2.nextCursor, String(bytes(line1) + bytes(line2) + bytes(line3) + 3));

  const page3 = readCodexTranscript(file, page2.nextCursor);
  assert.equal(page3.messages.length, 0);
  assert.equal(page3.pending, true);
  assert.equal(page3.nextCursor, page2.nextCursor);
});

test("readCodexTranscript: 多字节字符按 UTF-8 字节计数", (t) => {
  const file = tempFile(t);
  const line = userLine("回复 A00_MWGJ5OP0");
  writeFileSync(file, `${line}\n`, "utf8");

  const page = readCodexTranscript(file, "0");
  assert.equal(page.nextCursor, String(bytes(line) + 1));
  assert.notEqual(page.nextCursor, String(line.length + 1));
});

test("readCodexTranscript: limit 截断，下一页从剩余行继续", (t) => {
  const file = tempFile(t);
  const lines = [userLine("一", "u1"), assistantLine("二", "a1"), userLine("三", "u2")];
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""), "utf8");

  const page1 = readCodexTranscript(file, "0", 1);
  assert.deepEqual(page1.messages.map((m) => m.text), ["一"]);
  assert.equal(page1.nextCursor, String(bytes(lines[0]!) + 1));

  const page2 = readCodexTranscript(file, page1.nextCursor, 10);
  assert.deepEqual(page2.messages.map((m) => m.text), ["二", "三"]);
});

test("readCodexTranscript: 文件不存在 / 空文件返回 pending 空页", (t) => {
  const missing = tempFile(t, "not-created.jsonl");
  assert.deepEqual(readCodexTranscript(missing, "0"), {
    messages: [],
    nextCursor: "0",
    pending: true,
    skipped: 0,
  });

  const empty = tempFile(t, "empty.jsonl");
  writeFileSync(empty, "", "utf8");
  assert.deepEqual(readCodexTranscript(empty, "0"), {
    messages: [],
    nextCursor: "0",
    pending: true,
    skipped: 0,
  });
});

test("readCodexTranscript: 坏 JSON 行跳过并推进游标", (t) => {
  const file = tempFile(t);
  const line1 = userLine("完整一行");
  const bad = "{ this is not json";
  const line3 = assistantLine("再来一行");
  writeFileSync(file, `${line1}\n${bad}\n${line3}\n`, "utf8");

  const page = readCodexTranscript(file, "0");
  assert.deepEqual(page.messages.map((m) => m.text), ["完整一行", "再来一行"]);
  assert.equal(page.skipped, 1);
  assert.equal(page.nextCursor, String(bytes(line1) + bytes(bad) + bytes(line3) + 3));
});

test("readCodexTranscript: 末尾半行不消费，补全后才读到", (t) => {
  const file = tempFile(t);
  const line1 = userLine("先到的");
  const line2 = assistantLine("后到的");
  const head = line2.slice(0, 20);
  const tail = line2.slice(20);
  writeFileSync(file, `${line1}\n${head}`, "utf8");

  const page1 = readCodexTranscript(file, "0");
  assert.deepEqual(page1.messages.map((m) => m.text), ["先到的"]);
  assert.equal(page1.nextCursor, String(bytes(line1) + 1));

  appendFileSync(file, `${tail}\n`, "utf8");
  const page2 = readCodexTranscript(file, page1.nextCursor);
  assert.deepEqual(page2.messages.map((m) => m.text), ["后到的"]);
});

test("readTranscript: 统一入口按 agent 分派，支持对象与位置参数两种调用", () => {
  const objectForm = readTranscript({ agent: "codex", path: SAMPLE, cursor: "0" });
  const positionalForm = readTranscript("codex", SAMPLE, "0");
  assert.deepEqual(objectForm, positionalForm);
  assert.equal(objectForm.messages.length, 8);
  assert.equal(objectForm.skipped, 6);

  const claudeFile = tempFile({ after: () => {} }, "claude.jsonl");
  const claudeLine = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "claude 消息" }] },
    uuid: "c1",
    timestamp: "2026-11-16T10:00:00.000Z",
  });
  writeFileSync(claudeFile, `${claudeLine}\n`, "utf8");

  const claudePage = readTranscript({ agent: "claude", path: claudeFile, cursor: "0" });
  assert.deepEqual(claudePage.messages, readClaudeTranscript(claudeFile, "0").messages);
  assert.equal(claudePage.skipped, 0, "Claude 解析器无 skipped 口径，统一入口补 0");
});

test("readTranscript: 未注册 agent 抛 E_BAD_REQUEST", () => {
  assert.throws(
    () => readTranscript({ agent: "dsh", path: SAMPLE, cursor: "0" }),
    (err: unknown) => err instanceof WorkbenchError && err.code === "E_BAD_REQUEST",
  );
});
