import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { capsOf } from "../src/capabilities.ts";
import { discoverCodexSessions } from "../src/discover/codex.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/codex", import.meta.url));
const SESSIONS = join(FIXTURES, "sessions");
const CWD = "E:\\pi-workbench\\fixture-cwd";
const NOW = (): number => Date.parse("2026-11-16T12:00:00.000Z");

function ids(refs: Array<{ nativeId: string }>): string[] {
  return refs.map((ref) => ref.nativeId);
}

test("discoverCodexSessions: 扫 YYYY/MM/DD rollout，读首行 session_meta，默认只列 thread_source=user，缺失保留", async () => {
  const refs = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: CWD, now: NOW });

  assert.deepEqual(ids(refs), ["thread-user-1", "thread-missing-1"]);

  const first = refs[0]!;
  assert.equal(first.key, "codex:thread-user-1");
  assert.equal(first.agent, "codex");
  assert.equal(first.nativeId, "thread-user-1");
  assert.equal(first.cwd, CWD);
  assert.equal(first.status, "unknown");
  assert.equal(first.driver, "none");
  assert.equal(first.kind, "interactive");
  assert.deepEqual(first.capabilities, capsOf("codex"));
  assert.ok(first.transcriptPath?.endsWith("rollout-2026-11-15T10-00-00-user.jsonl"));
  assert.ok(first.transcriptPath?.includes("2026"), "transcriptPath 指向 rollout 文件");
});

test("discoverCodexSessions: cwd 从首行 payload.cwd 取，精确过滤且忽略尾部斜杠", async () => {
  const refs = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: "E:\\elsewhere", now: NOW });
  assert.deepEqual(ids(refs), ["thread-other-cwd-1"]);

  const trailing = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: CWD + "\\", now: NOW });
  assert.deepEqual(ids(trailing), ["thread-user-1", "thread-missing-1"]);
});

test("discoverCodexSessions: limit 保留最新 N 条", async () => {
  const refs = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: CWD, limit: 2, now: NOW });
  assert.deepEqual(ids(refs), ["thread-user-1", "thread-missing-1"]);

  const none = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: CWD, limit: 0, now: NOW });
  assert.deepEqual(none, []);
});

test("discoverCodexSessions: 坏首行/半行/非 rollout 文件跳过而不抛", async () => {
  const refs = await discoverCodexSessions({ sessionsRoot: SESSIONS, now: NOW });
  const found = ids(refs);
  assert.ok(!found.includes("thread-bad-1"));
  assert.ok(!found.includes("thread-half-1"));
  assert.ok(!found.includes("thread-not-rollout-1"));
  assert.deepEqual([...found].sort(), [
    "thread-missing-1",
    "thread-other-cwd-1",
    "thread-user-1",
  ]);
});

test("discoverCodexSessions: sinceDays 窗口默认 30 天，可按需放宽", async () => {
  const recent = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: CWD, now: NOW });
  assert.ok(!ids(recent).includes("thread-old-1"));

  const wide = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: CWD, sinceDays: 365, now: NOW });
  assert.deepEqual(ids(wide), ["thread-user-1", "thread-missing-1", "thread-old-1"]);
});

test("discoverCodexSessions: archived_sessions 默认不列，includeArchived 才列", async () => {
  const active = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: CWD, now: NOW });
  assert.ok(!ids(active).includes("thread-archived-1"));

  const all = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: CWD, includeArchived: true, now: NOW });
  assert.deepEqual(ids(all), ["thread-archived-1", "thread-user-1", "thread-missing-1"]);
});

test("discoverCodexSessions: includeSubagents 才列出子代理线程", async () => {
  const all = await discoverCodexSessions({ sessionsRoot: SESSIONS, cwd: CWD, includeSubagents: true, now: NOW });
  assert.deepEqual(ids(all), ["thread-subagent-1", "thread-user-1", "thread-missing-1"]);
});

test("discoverCodexSessions: sessionsRoot 不存在时返回空数组", async () => {
  const refs = await discoverCodexSessions({ sessionsRoot: join(FIXTURES, "does-not-exist"), now: NOW });
  assert.deepEqual(refs, []);
});
