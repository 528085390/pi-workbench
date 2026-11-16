import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readClaudeTranscript } from "../src/transcript/claude.ts";
import { readCodexTranscript } from "../src/transcript/codex.ts";
import { readPiTranscript } from "../src/transcript/pi.ts";

type Page = {
  messages: Array<{ role: string; kind: string; text: string }>;
  nextCursor: string;
  pending: boolean;
  skipped?: number;
};

type AgentCase = {
  name: "claude" | "codex" | "pi";
  read: (path: string, cursor: string, limit?: number) => Page;
  userLine: (text: string) => string;
  assistantLine: (text: string) => string;
};

const TS = "2026-11-17T00:00:00.000Z";

const AGENTS: AgentCase[] = [
  {
    name: "claude",
    read: (path, cursor, limit) => readClaudeTranscript(path, cursor, limit),
    userLine: (text) =>
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        uuid: "u1",
        timestamp: TS,
      }),
    assistantLine: (text) =>
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
        uuid: "a1",
        timestamp: TS,
      }),
  },
  {
    name: "codex",
    read: (path, cursor, limit) => readCodexTranscript(path, cursor, limit),
    userLine: (text) =>
      JSON.stringify({
        timestamp: TS,
        type: "response_item",
        payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text }] },
      }),
    assistantLine: (text) =>
      JSON.stringify({
        timestamp: TS,
        type: "response_item",
        payload: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text }] },
      }),
  },
  {
    name: "pi",
    read: (path, cursor, limit) => readPiTranscript(path, cursor, limit),
    userLine: (text) =>
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: TS,
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    assistantLine: (text) =>
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }),
  },
];

function tempFile(t: { after: (fn: () => void) => void }, name = "transcript.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-matrix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

for (const agent of AGENTS) {
  test(`matrix/${agent.name}: valid transcript parses both messages`, (t) => {
    const file = tempFile(t);
    const user = agent.userLine("用户消息");
    const assistant = agent.assistantLine("助手回复");
    writeFileSync(file, `${user}\n${assistant}\n`, "utf8");

    const page = agent.read(file, "0");
    assert.deepEqual(page.messages.map((m) => m.text), ["用户消息", "助手回复"]);
    assert.equal(page.messages[0]?.role, "user");
    assert.equal(page.messages[1]?.role, "assistant");
    assert.equal(page.pending, false);
    assert.equal(page.nextCursor, String(bytes(user) + bytes(assistant) + 2));
  });

  test(`matrix/${agent.name}: truncated last line stays pending until completed`, (t) => {
    const file = tempFile(t);
    const user = agent.userLine("先到的");
    const assistant = agent.assistantLine("后到的");
    const head = assistant.slice(0, 17);
    const tail = assistant.slice(17);
    writeFileSync(file, `${user}\n${head}`, "utf8");

    const first = agent.read(file, "0");
    assert.deepEqual(first.messages.map((m) => m.text), ["先到的"]);
    assert.equal(first.pending, false);
    assert.equal(first.nextCursor, String(bytes(user) + 1));

    appendFileSync(file, `${tail}\n`, "utf8");
    const second = agent.read(file, first.nextCursor);
    assert.deepEqual(second.messages.map((m) => m.text), ["后到的"]);
    assert.equal(second.nextCursor, String(bytes(user) + bytes(assistant) + 2));
  });

  test(`matrix/${agent.name}: missing file returns pending empty page`, (t) => {
    const file = tempFile(t, "missing.jsonl");
    const page = agent.read(file, "0");
    assert.deepEqual(page.messages, []);
    assert.equal(page.nextCursor, "0");
    assert.equal(page.pending, true);
    assert.equal(page.skipped ?? 0, 0);
  });

  test(`matrix/${agent.name}: unicode text uses UTF-8 byte cursor`, (t) => {
    const file = tempFile(t);
    const text = "多字节：你好，世界 🌍 café";
    const line = agent.userLine(text);
    writeFileSync(file, `${line}\n`, "utf8");

    const page = agent.read(file, "0");
    assert.deepEqual(page.messages.map((m) => m.text), [text]);
    assert.equal(page.nextCursor, String(bytes(line) + 1));
    assert.notEqual(page.nextCursor, String(line.length + 1));
    assert.equal(page.pending, false);
  });

  test(`matrix/${agent.name}: huge single line parses without truncation`, (t) => {
    const file = tempFile(t);
    const text = "x".repeat(2 * 1024 * 1024);
    const line = agent.userLine(text);
    writeFileSync(file, `${line}\n`, "utf8");

    const page = agent.read(file, "0");
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0]?.text.length, text.length);
    assert.equal(page.nextCursor, String(statSync(file).size));
    assert.equal(page.pending, false);
  });
}
