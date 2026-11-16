import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { capsOf } from "../src/capabilities.ts";
import { discoverPiSessions, scanPiSessions } from "../src/discover/pi.ts";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-wb-pi-discovery-"));
}

function writeSession(root: string, dir: string, file: string, header: unknown): string {
  const target = join(root, dir);
  mkdirSync(target, { recursive: true });
  const path = join(target, file);
  writeFileSync(path, JSON.stringify(header) + "\n", "utf8");
  return path;
}

function sessionHeader(id: string, cwd: string, version = 3): Record<string, unknown> {
  return { type: "session", version, id, timestamp: "2026-11-15T16:24:08.473Z", cwd };
}

test("discoverPiSessions: 只认首行 cwd，不猜目录名 mangle", async () => {
  const root = freshRoot();
  try {
    const hit = writeSession(root, "--E--wrong-dir-name--", "a.jsonl", sessionHeader("session-a", "E:\\proj"));
    writeSession(root, "--E--proj--", "b.jsonl", sessionHeader("session-b", "E:\\other"));
    writeSession(root, "--C--Users-huang--", "c.jsonl", sessionHeader("session-c", "E:\\proj\\"));

    const refs = await discoverPiSessions({ sessionsRoot: root, cwd: "e:\\proj\\" });

    assert.equal(refs.length, 2);
    assert.deepEqual(refs.map((ref) => ref.nativeId).sort(), ["session-a", "session-c"]);
    const first = refs.find((ref) => ref.nativeId === "session-a");
    assert.ok(first !== undefined);
    assert.equal(first.key, "pi:session-a");
    assert.equal(first.agent, "pi");
    assert.equal(first.cwd, "E:\\proj");
    assert.equal(first.transcriptPath, resolve(hit));
    assert.equal(first.status, "unknown");
    assert.equal(first.driver, "none");
    assert.equal(first.kind, "interactive");
    assert.deepEqual(first.capabilities, capsOf("pi"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanPiSessions: version!==3 计入 unsupported，坏首行/非 session 计入 skipped", async () => {
  const root = freshRoot();
  try {
    writeSession(root, "a", "v3.jsonl", sessionHeader("v3", "E:\\proj"));
    writeSession(root, "a", "v2.jsonl", sessionHeader("v2", "E:\\proj", 2));

    const bad = join(root, "a", "bad.jsonl");
    writeFileSync(bad, "{not json}\n", "utf8");
    const notSession = join(root, "a", "not-session.jsonl");
    writeFileSync(notSession, JSON.stringify({ type: "message", id: "x" }) + "\n", "utf8");
    const missingCwd = join(root, "missing.jsonl");
    writeFileSync(missingCwd, JSON.stringify({ type: "session", version: 3, id: "no-cwd" }) + "\n", "utf8");

    const result = await scanPiSessions({ sessionsRoot: root });

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]?.nativeId, "v3");
    assert.equal(result.unsupported, 1);
    assert.equal(result.skipped, 3);
    assert.equal(result.scanned, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverPiSessions: limit 生效并优先列出较新的 session", async () => {
  const root = freshRoot();
  try {
    writeSession(root, "a", "old.jsonl", {
      type: "session",
      version: 3,
      id: "old",
      timestamp: "2026-11-01T00:00:00.000Z",
      cwd: "E:\\proj",
    });
    writeSession(root, "a", "new.jsonl", {
      type: "session",
      version: 3,
      id: "new",
      timestamp: "2026-11-15T00:00:00.000Z",
      cwd: "E:\\proj",
    });

    const refs = await discoverPiSessions({ sessionsRoot: root, cwd: "E:\\proj", limit: 1 });

    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.nativeId, "new");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverPiSessions: sessionsRoot 不存在时返回空数组，不抛", async () => {
  const missing = join(freshRoot(), "does-not-exist");
  const refs = await discoverPiSessions({ sessionsRoot: missing });
  assert.deepEqual(refs, []);
});
