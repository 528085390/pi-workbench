import test from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_BACKGROUND_CAPABILITIES,
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  PI_CAPABILITIES,
  capsOf,
} from "../src/capabilities.ts";

test("capsOf: claude 交互式返回 CLAUDE_CAPABILITIES，后台返回 CLAUDE_BACKGROUND_CAPABILITIES", () => {
  assert.deepEqual(capsOf("claude"), CLAUDE_CAPABILITIES);
  assert.deepEqual(capsOf("claude", "unknown"), CLAUDE_CAPABILITIES);
  assert.deepEqual(capsOf("claude", "interactive"), CLAUDE_CAPABILITIES);
  assert.deepEqual(capsOf("claude", "background"), CLAUDE_BACKGROUND_CAPABILITIES);
  assert.equal(capsOf("claude").attach, false);
  assert.equal(capsOf("claude", "background").attach, true);
});

test("capsOf: codex 能力矩阵逐字段符合规格 §8（attach/permissions/background 均为 false）", () => {
  const expected = {
    stream: true,
    inject: true,
    interrupt: true,
    attach: false,
    resume: true,
    transcript: true,
    permissions: false,
    background: false,
  };
  assert.deepEqual(CODEX_CAPABILITIES, expected);
  assert.deepEqual(capsOf("codex"), expected);
  assert.deepEqual(capsOf("codex", "background"), expected, "codex 的会话种类不影响能力");
});

test("capsOf: pi 能力矩阵逐字段符合规格 §9（attach/permissions/background 均为 false）", () => {
  const expected = {
    stream: true,
    inject: true,
    interrupt: true,
    attach: false,
    resume: true,
    transcript: true,
    permissions: false,
    background: false,
  };
  assert.deepEqual(PI_CAPABILITIES, expected);
  assert.deepEqual(capsOf("pi"), expected);
  assert.deepEqual(capsOf("pi", "background"), expected, "pi 的会话种类不影响能力");
});

test("capsOf: 未知 agent 一律不声明任何能力（宁可不给按钮）", () => {
  const caps = capsOf("unknown-agent");
  assert.equal(caps.stream, false);
  assert.equal(caps.inject, false);
  assert.equal(caps.interrupt, false);
  assert.equal(caps.attach, false);
  assert.equal(caps.resume, false);
  assert.equal(caps.transcript, false);
  assert.equal(caps.permissions, false);
  assert.equal(caps.background, false);
});
