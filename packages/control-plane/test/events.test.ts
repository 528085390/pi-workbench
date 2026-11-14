import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { SessionEvent } from "@pi-workbench/shared";

import { migrate, openDb } from "../src/db.ts";
import { EventStore } from "../src/events.ts";
import type { NewEvent } from "../src/events.ts";

function freshStore(): { db: DatabaseSync; store: EventStore } {
  const db = openDb(":memory:");
  migrate(db);
  return { db, store: new EventStore(db) };
}

function eventCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  return Number(row.n);
}

function makeEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    sessionKey: "claude:sess-1",
    type: "notice",
    payload: { text: "hello" },
    source: "acp",
    idempotencyKey: "claude:sess-1:k1",
    ...overrides,
  };
}

test("append: seq 从 1 开始递增，返回完整 SessionEvent", () => {
  const { db, store } = freshStore();
  try {
    const first = store.append(makeEvent({ idempotencyKey: "k1" }));
    const second = store.append(makeEvent({ idempotencyKey: "k2", type: "token" }));

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(first.sessionKey, "claude:sess-1");
    assert.equal(first.type, "notice");
    assert.equal(first.source, "acp");
    assert.equal(first.idempotencyKey, "k1");
    assert.deepEqual(first.payload, { text: "hello" });
    assert.equal(typeof first.ts, "string");
    assert.ok(!Number.isNaN(Date.parse(first.ts)), "ts 应为可解析的 ISO 时间");
    assert.equal(eventCount(db), 2);
  } finally {
    db.close();
  }
});

test("append: 同一 idempotencyKey 二次调用返回原事件且不新增行", () => {
  const { db, store } = freshStore();
  try {
    const first = store.append(makeEvent({ idempotencyKey: "dup" }));
    const again = store.append(makeEvent({ idempotencyKey: "dup", payload: { text: "changed" }, type: "error" }));

    assert.deepEqual(again, first);
    assert.equal(again.seq, first.seq);
    assert.equal(eventCount(db), 1);
    assert.deepEqual(again.payload, { text: "hello" }, "保留首次写入的 payload");
    assert.equal(again.type, "notice", "保留首次写入的 type");
  } finally {
    db.close();
  }
});

test("append: 幂等命中会消耗自增 rowid —— seq 允许跳号但保持单调（补拉只依赖单调性）", () => {
  const { db, store } = freshStore();
  try {
    const first = store.append(makeEvent({ idempotencyKey: "gap-1" }));
    const dup = store.append(makeEvent({ idempotencyKey: "gap-1" }));
    const next = store.append(makeEvent({ idempotencyKey: "gap-2" }));

    assert.equal(first.seq, 1);
    assert.equal(dup.seq, 1, "幂等命中返回首次写入的 seq");
    assert.ok(next.seq > first.seq, "新事件的 seq 必须大于已有 seq");
    assert.equal(eventCount(db), 2);
    assert.deepEqual(store.list("claude:sess-1").map((e) => e.seq), [first.seq, next.seq]);
    assert.deepEqual(
      store.list("claude:sess-1", first.seq).map((e) => e.seq),
      [next.seq],
      "afterSeq 补拉不受跳号影响",
    );
  } finally {
    db.close();
  }
});

test("append: 重复投递不触发重复的 subscribe 通知", () => {
  const { db, store } = freshStore();
  try {
    const seen: SessionEvent[] = [];
    const off = store.subscribe((e) => seen.push(e));
    store.append(makeEvent({ idempotencyKey: "once" }));
    store.append(makeEvent({ idempotencyKey: "once" }));
    off();
    assert.equal(seen.length, 1);
  } finally {
    db.close();
  }
});

test("list: 按 seq 升序返回，afterSeq 只返回更大的 seq", () => {
  const { db, store } = freshStore();
  try {
    const a = store.append(makeEvent({ idempotencyKey: "a" }));
    const b = store.append(makeEvent({ idempotencyKey: "b" }));
    const c = store.append(makeEvent({ idempotencyKey: "c" }));

    assert.deepEqual(store.list("claude:sess-1").map((e) => e.seq), [a.seq, b.seq, c.seq]);
    assert.deepEqual(store.list("claude:sess-1", b.seq).map((e) => e.seq), [c.seq]);
    assert.deepEqual(store.list("claude:sess-1", c.seq), []);
    assert.deepEqual(store.list("claude:sess-1", 0).map((e) => e.seq), [1, 2, 3]);
  } finally {
    db.close();
  }
});

test("list: 支持 limit，且 limit 后仍按 seq 升序", () => {
  const { db, store } = freshStore();
  try {
    for (const key of ["1", "2", "3", "4"]) {
      store.append(makeEvent({ idempotencyKey: `k${key}`, payload: { index: key } }));
    }
    const limited = store.list("claude:sess-1", 0, 2);
    assert.deepEqual(limited.map((e) => e.seq), [1, 2]);
    const afterAndLimited = store.list("claude:sess-1", 1, 2);
    assert.deepEqual(afterAndLimited.map((e) => e.seq), [2, 3]);
    assert.equal(store.list("claude:sess-1", 0, 0).length, 0);
  } finally {
    db.close();
  }
});

test("list: 按 sessionKey 隔离", () => {
  const { db, store } = freshStore();
  try {
    store.append(makeEvent({ sessionKey: "claude:a", idempotencyKey: "a1" }));
    store.append(makeEvent({ sessionKey: "claude:b", idempotencyKey: "b1" }));
    store.append(makeEvent({ sessionKey: "claude:a", idempotencyKey: "a2" }));

    assert.deepEqual(store.list("claude:a").map((e) => e.idempotencyKey), ["a1", "a2"]);
    assert.deepEqual(store.list("claude:b").map((e) => e.idempotencyKey), ["b1"]);
    assert.deepEqual(store.list("claude:missing"), []);
  } finally {
    db.close();
  }
});

test("append: payload 以 JSON 文本往返（对象 / 字符串 / null / 数组）", () => {
  const { db, store } = freshStore();
  try {
    const cases: unknown[] = [{ a: 1, b: [true, null] }, "plain string", null, [1, 2, 3]];
    const events = cases.map((payload, i) =>
      store.append(makeEvent({ payload, idempotencyKey: `p${i}` })),
    );
    assert.deepEqual(events.map((e) => e.payload), cases);

    const raw = db.prepare("SELECT payload_json FROM events WHERE idempotency_key = ?").get("p0") as {
      payload_json: string;
    };
    assert.equal(typeof raw.payload_json, "string");
    assert.deepEqual(JSON.parse(raw.payload_json), cases[0]);
  } finally {
    db.close();
  }
});

test("subscribe: 收到新事件，退订后不再收到，多订阅者互不影响", () => {
  const { db, store } = freshStore();
  try {
    const seenA: SessionEvent[] = [];
    const seenB: SessionEvent[] = [];
    const offA = store.subscribe((e) => seenA.push(e));
    const offB = store.subscribe((e) => seenB.push(e));

    const first = store.append(makeEvent({ idempotencyKey: "s1" }));
    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 1);
    assert.deepEqual(seenA[0], first);
    assert.deepEqual(seenB[0], first);

    offA();
    store.append(makeEvent({ idempotencyKey: "s2" }));
    assert.equal(seenA.length, 1, "退订后 A 不再收到");
    assert.equal(seenB.length, 2, "B 仍收到");

    offB();
    store.append(makeEvent({ idempotencyKey: "s3" }));
    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 2);

    offA();
    offB();
  } finally {
    db.close();
  }
});

test("subscribe: 监听器抛错不影响 append 落库", () => {
  const { db, store } = freshStore();
  try {
    const off = store.subscribe(() => {
      throw new Error("listener boom");
    });
    const event = store.append(makeEvent({ idempotencyKey: "boom" }));
    off();
    assert.equal(event.seq, 1);
    assert.equal(eventCount(db), 1);
  } finally {
    db.close();
  }
});
