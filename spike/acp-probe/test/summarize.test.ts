import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUpdate } from "../src/summarize.js";

test("agent_message_chunk is text", () => {
  const r = summarizeUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
  assert.equal(r.kind, "agent_message_chunk");
  assert.equal(r.text, "hello");
});

test("state_update exposes idle", () => {
  const r = summarizeUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  assert.equal(r.state, "idle");
  assert.equal(r.stopReason, "end_turn");
});
