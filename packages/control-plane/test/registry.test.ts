import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { SessionRef } from "@pi-workbench/shared";

import { migrate, openDb } from "../src/db.ts";
import { SessionRegistry } from "../src/registry.ts";

const CAPS: SessionRef["capabilities"] = {
  stream: true,
  inject: true,
  interrupt: true,
  attach: false,
  resume: true,
  transcript: true,
  permissions: true,
  background: false,
};

function fresh(): { db: DatabaseSync; registry: SessionRegistry } {
  const db = openDb(":memory:");
  migrate(db);
  return { db, registry: new SessionRegistry(db) };
}

function makeRef(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    key: "claude:sess-1",
    agent: "claude",
    nativeId: "sess-1",
    cwd: "E:\\pi-workbench\\spike\\a00-workspace",
    transcriptPath: "C:\\Users\\huang\\.claude\\projects\\E--pi-workbench-spike-a00-workspace\\sess-1.jsonl",
    status: "running",
    driver: "none",
    capabilities: CAPS,
    kind: "interactive",
    ...overrides,
  };
}

function rowCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
  return Number(row.n);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("upsert: 双写 —— 内存可 get，sessions 表落行", () => {
  const { db, registry } = fresh();
  try {
    const ref = makeRef();
    registry.upsert(ref);

    assert.deepEqual(registry.get("claude:sess-1"), ref);
    assert.equal(registry.get("claude:missing"), null);

    const row = db.prepare("SELECT * FROM sessions WHERE key = ?").get("claude:sess-1") as
      | Record<string, unknown>
      | undefined;
    assert.ok(row !== undefined, "sessions 表必须有这一行");
    assert.equal(row.agent, "claude");
    assert.equal(row.native_id, "sess-1");
    assert.equal(row.cwd, ref.cwd);
    assert.equal(row.kind, "interactive");
    assert.equal(row.status, "running");
    assert.equal(row.driver, "none");
    assert.equal(row.transcript_path, ref.transcriptPath);
    assert.equal(row.acp_session_id, null);
    assert.deepEqual(JSON.parse(String(row.caps_json)), CAPS);
    assert.equal(typeof row.created_at, "string");
    assert.equal(row.created_at, row.updated_at, "首次写入 created_at = updated_at");
  } finally {
    db.close();
  }
});

test("upsert: 同 key 二次写入是更新，不新增行且保留 created_at", async () => {
  const { db, registry } = fresh();
  try {
    registry.upsert(makeRef());
    const before = db.prepare("SELECT created_at, updated_at FROM sessions WHERE key = ?").get("claude:sess-1") as {
      created_at: string;
      updated_at: string;
    };

    await waitMs(5);
    const updated = makeRef({
      status: "idle",
      kind: "background",
      capabilities: { ...CAPS, attach: true, background: true },
    });
    registry.upsert(updated);

    assert.equal(rowCount(db), 1, "主键冲突必须走 UPDATE");
    const after = db.prepare("SELECT status, kind, created_at, updated_at, caps_json FROM sessions WHERE key = ?").get(
      "claude:sess-1",
    ) as { status: string; kind: string; created_at: string; updated_at: string; caps_json: string };
    assert.equal(after.status, "idle");
    assert.equal(after.kind, "background");
    assert.deepEqual(JSON.parse(after.caps_json), updated.capabilities);
    assert.equal(after.created_at, before.created_at, "created_at 不允许被覆盖");
    assert.ok(after.updated_at > before.updated_at, "updated_at 必须前进");
    assert.equal(registry.get("claude:sess-1")?.status, "idle", "内存同步更新");
  } finally {
    db.close();
  }
});

test("upsert: kind 缺省写 unknown，acpSessionId/transcriptPath 缺省写 NULL", () => {
  const { db, registry } = fresh();
  try {
    const ref = makeRef({ kind: undefined, acpSessionId: undefined, transcriptPath: undefined });
    registry.upsert(ref);

    const row = db.prepare("SELECT kind, acp_session_id, transcript_path FROM sessions WHERE key = ?").get(
      "claude:sess-1",
    ) as { kind: string; acp_session_id: string | null; transcript_path: string | null };
    assert.equal(row.kind, "unknown");
    assert.equal(row.acp_session_id, null);
    assert.equal(row.transcript_path, null);
  } finally {
    db.close();
  }
});

test("upsert: acpSessionId 有值时落库", () => {
  const { db, registry } = fresh();
  try {
    registry.upsert(makeRef({ acpSessionId: "acp-42" }));
    const row = db.prepare("SELECT acp_session_id FROM sessions WHERE key = ?").get("claude:sess-1") as {
      acp_session_id: string | null;
    };
    assert.equal(row.acp_session_id, "acp-42");
  } finally {
    db.close();
  }
});

test("list: 按 updated_at 倒序返回全部会话", async () => {
  const { db, registry } = fresh();
  try {
    registry.upsert(makeRef({ key: "claude:old", nativeId: "old" }));
    await waitMs(5);
    registry.upsert(makeRef({ key: "claude:mid", nativeId: "mid" }));
    await waitMs(5);
    registry.upsert(makeRef({ key: "claude:new", nativeId: "new" }));

    assert.deepEqual(registry.list().map((r) => r.key), ["claude:new", "claude:mid", "claude:old"]);
  } finally {
    db.close();
  }
});

test("list: 再次 upsert 会把会话顶到最前", async () => {
  const { db, registry } = fresh();
  try {
    registry.upsert(makeRef({ key: "claude:a", nativeId: "a" }));
    await waitMs(5);
    registry.upsert(makeRef({ key: "claude:b", nativeId: "b" }));
    await waitMs(5);
    registry.upsert(makeRef({ key: "claude:a", nativeId: "a", status: "idle" }));

    assert.deepEqual(registry.list().map((r) => r.key), ["claude:a", "claude:b"]);
    assert.equal(registry.list()[0].status, "idle");
  } finally {
    db.close();
  }
});

test("list: agent / status 过滤可组合", () => {
  const { db, registry } = fresh();
  try {
    registry.upsert(makeRef({ key: "claude:1", nativeId: "1", status: "running" }));
    registry.upsert(makeRef({ key: "claude:2", nativeId: "2", status: "idle" }));
    registry.upsert(makeRef({ key: "pi:3", nativeId: "3", agent: "pi", status: "running" }));

    assert.equal(registry.list().length, 3);
    assert.deepEqual(registry.list({ agent: "claude" }).map((r) => r.key).sort(), ["claude:1", "claude:2"]);
    assert.deepEqual(registry.list({ agent: "pi" }).map((r) => r.key), ["pi:3"]);
    assert.deepEqual(registry.list({ status: "running" }).map((r) => r.key).sort(), ["claude:1", "pi:3"]);
    assert.deepEqual(registry.list({ agent: "claude", status: "running" }).map((r) => r.key), ["claude:1"]);
    assert.deepEqual(registry.list({ agent: "codex" }), []);
    assert.deepEqual(registry.list({ status: "exited" }), []);
  } finally {
    db.close();
  }
});

test("list: 空注册表返回空数组", () => {
  const { db, registry } = fresh();
  try {
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(registry.list({ agent: "claude" }), []);
    assert.equal(registry.get("claude:any"), null);
  } finally {
    db.close();
  }
});

test("内存与库分离：新建实例从库读不到内存态（内存不预热）", () => {
  const { db, registry } = fresh();
  try {
    registry.upsert(makeRef());
    const reborn = new SessionRegistry(db);
    assert.deepEqual(reborn.list(), [], "新实例内存为空");
    assert.equal(reborn.get("claude:sess-1"), null);
    assert.equal(rowCount(db), 1, "库里的行仍在（说明之前确实写了库）");
  } finally {
    db.close();
  }
});
