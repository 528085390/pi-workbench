import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";

import { migrate, openDb } from "../src/db.ts";
import { isWorkbenchError } from "../src/errors.ts";
import { LeaseManager } from "../src/lease.ts";
import type { WorkbenchErrorCode } from "../src/errors.ts";

const START = Date.parse("2026-11-15T00:00:00.000Z");
const TTL = 60_000;
const KEY = "claude:sess-1";

type Clock = {
  now: () => number;
  advance: (ms: number) => void;
};

function makeClock(): Clock {
  let current = START;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

type Harness = {
  db: DatabaseSync;
  lm: LeaseManager;
  clock: Clock;
};

function fresh(opts: { ttlMs?: number } = {}): Harness {
  const db = openDb(":memory:");
  migrate(db);
  const clock = makeClock();
  const lm = new LeaseManager(db, { ttlMs: opts.ttlMs ?? TTL, now: clock.now });
  return { db, lm, clock };
}

type RawRow = {
  driver: string;
  client_id: string;
  expires_at: string;
  heartbeat_at: string;
};

function rawRow(db: DatabaseSync, sessionKey: string): RawRow | undefined {
  // node:sqlite 返回 null 原型对象，deepEqual 要求普通对象，这里显式复制一份。
  const row = db
    .prepare("SELECT driver, client_id, expires_at, heartbeat_at FROM leases WHERE session_key = ?")
    .get(sessionKey) as RawRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    driver: row.driver,
    client_id: row.client_id,
    expires_at: row.expires_at,
    heartbeat_at: row.heartbeat_at,
  };
}

function captureError(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("预期抛错，但没有抛");
}

/** 断言 fn 抛 WorkbenchError 且 code 匹配。 */
function expectCode(fn: () => void, code: WorkbenchErrorCode): void {
  const err = captureError(fn);
  assert.ok(isWorkbenchError(err), `预期 WorkbenchError，实际：${String(err)}`);
  assert.equal(err.code, code, `预期错误码 ${code}，实际 ${err.code}：${err.message}`);
}

test("acquire: 首次获取成功并返回完整 Lease", () => {
  const { db, lm, clock } = fresh();
  try {
    const lease = lm.acquire(KEY, "pi", "client-a", TTL);

    assert.deepEqual(lease, {
      sessionKey: KEY,
      driver: "pi",
      clientId: "client-a",
      expiresAt: iso(clock.now() + TTL),
      heartbeatAt: iso(clock.now()),
    });
    assert.deepEqual(lm.current(KEY), lease);
    assert.deepEqual(rawRow(db, KEY), {
      driver: "pi",
      client_id: "client-a",
      expires_at: iso(START + TTL),
      heartbeat_at: iso(START),
    });
  } finally {
    db.close();
  }
});

test("acquire: 无租约时 current() 返回 null", () => {
  const { db, lm } = fresh();
  try {
    assert.equal(lm.current(KEY), null);
  } finally {
    db.close();
  }
});

test("acquire: 他人持有时抛 E_LEASE_CONFLICT，且不覆盖原租约", () => {
  const { db, lm, clock } = fresh();
  try {
    const first = lm.acquire(KEY, "pi", "client-a", TTL);
    clock.advance(1_000);

    expectCode(() => lm.acquire(KEY, "human", "client-b", TTL), "E_LEASE_CONFLICT");

    assert.deepEqual(lm.current(KEY), first);
    assert.equal(rawRow(db, KEY)?.client_id, "client-a");
    assert.equal(rawRow(db, KEY)?.driver, "pi");
  } finally {
    db.close();
  }
});

test("acquire: 同一 clientId 再取等价续期（expiresAt / heartbeatAt 前移）", () => {
  const { db, lm, clock } = fresh();
  try {
    const first = lm.acquire(KEY, "pi", "client-a", TTL);
    clock.advance(10_000);
    const renewed = lm.acquire(KEY, "pi", "client-a", TTL);

    assert.equal(renewed.clientId, "client-a");
    assert.equal(renewed.heartbeatAt, iso(START + 10_000));
    assert.equal(renewed.expiresAt, iso(START + 10_000 + TTL));
    assert.ok(renewed.expiresAt > first.expiresAt);
    assert.deepEqual(lm.current(KEY), renewed);
  } finally {
    db.close();
  }
});

test("acquire: 显式 ttlMs 生效，缺省用管理器 TTL", () => {
  const { db, lm, clock } = fresh({ ttlMs: 5_000 });
  try {
    const short = lm.acquire(KEY, "pi", "client-a", 1_000);
    assert.equal(short.expiresAt, iso(START + 1_000));

    lm.release(KEY, "client-a");
    const byDefault = lm.acquire(KEY, "pi", "client-a");
    assert.equal(byDefault.expiresAt, iso(clock.now() + 5_000));
  } finally {
    db.close();
  }
});

test("TTL 过期：到期前有效，到点即视为无租约（current() 返回 null）", () => {
  const { db, lm, clock } = fresh();
  try {
    lm.acquire(KEY, "pi", "client-a", TTL);

    clock.advance(TTL - 1);
    assert.notEqual(lm.current(KEY), null);

    clock.advance(1); // expires_at <= now
    assert.equal(lm.current(KEY), null);
  } finally {
    db.close();
  }
});

test("TTL 过期：heartbeat 抛 E_LEASE_CONFLICT 且不静默续期", () => {
  const { db, lm, clock } = fresh();
  try {
    lm.acquire(KEY, "pi", "client-a", TTL);
    clock.advance(TTL + 1);

    expectCode(() => lm.heartbeat(KEY, "client-a"), "E_LEASE_CONFLICT");

    // 不得静默续期：库里还是原来的到期时间，current() 仍为 null
    assert.equal(rawRow(db, KEY)?.expires_at, iso(START + TTL));
    assert.equal(lm.current(KEY), null);
  } finally {
    db.close();
  }
});

test("TTL 过期：他人可以重新 acquire", () => {
  const { db, lm, clock } = fresh();
  try {
    lm.acquire(KEY, "pi", "client-a", TTL);
    clock.advance(TTL + 1);

    const taken = lm.acquire(KEY, "human", "client-b", TTL);
    assert.equal(taken.clientId, "client-b");
    assert.equal(taken.driver, "human");
    assert.equal(taken.heartbeatAt, iso(START + TTL + 1));
    assert.deepEqual(lm.current(KEY), taken);
  } finally {
    db.close();
  }
});

test("heartbeat: 持有者续期，driver 保持不变", () => {
  const { db, lm, clock } = fresh();
  try {
    lm.acquire(KEY, "pi", "client-a", TTL);
    clock.advance(30_000);
    const beat = lm.heartbeat(KEY, "client-a");

    assert.equal(beat.clientId, "client-a");
    assert.equal(beat.driver, "pi");
    assert.equal(beat.heartbeatAt, iso(START + 30_000));
    assert.equal(beat.expiresAt, iso(START + 30_000 + TTL));
  } finally {
    db.close();
  }
});

test("heartbeat: 无租约抛 E_LEASE_CONFLICT", () => {
  const { db, lm } = fresh();
  try {
    expectCode(() => lm.heartbeat(KEY, "client-a"), "E_LEASE_CONFLICT");
    assert.equal(lm.current(KEY), null);
  } finally {
    db.close();
  }
});

test("heartbeat: 非持有者抛 E_LEASE_CONFLICT，且不延长他人租约", () => {
  const { db, lm, clock } = fresh();
  try {
    const held = lm.acquire(KEY, "pi", "client-a", TTL);
    clock.advance(1_000);

    expectCode(() => lm.heartbeat(KEY, "client-b"), "E_LEASE_CONFLICT");
    assert.deepEqual(lm.current(KEY), held);
  } finally {
    db.close();
  }
});

test("release: 持有者释放后租约消失，他人可取", () => {
  const { db, lm } = fresh();
  try {
    lm.acquire(KEY, "pi", "client-a", TTL);
    lm.release(KEY, "client-a");

    assert.equal(lm.current(KEY), null);
    assert.equal(rawRow(db, KEY), undefined);
    assert.equal(lm.acquire(KEY, "human", "client-b", TTL).clientId, "client-b");
  } finally {
    db.close();
  }
});

test("release: 非持有者抛 E_NO_LEASE，且不删别人的租约", () => {
  const { db, lm } = fresh();
  try {
    const held = lm.acquire(KEY, "pi", "client-a", TTL);

    expectCode(() => lm.release(KEY, "client-b"), "E_NO_LEASE");
    assert.deepEqual(lm.current(KEY), held);
  } finally {
    db.close();
  }
});

test("release: 无租约时抛 E_NO_LEASE", () => {
  const { db, lm } = fresh();
  try {
    expectCode(() => lm.release(KEY, "client-a"), "E_NO_LEASE");
  } finally {
    db.close();
  }
});

test("assertWriter: 持有者通过", () => {
  const { db, lm } = fresh();
  try {
    lm.acquire(KEY, "pi", "client-a", TTL);
    assert.doesNotThrow(() => lm.assertWriter(KEY, "client-a"));
  } finally {
    db.close();
  }
});

test("assertWriter: 无租约 / 他人持有 / 已过期都抛 E_NO_LEASE", () => {
  const { db, lm, clock } = fresh();
  try {
    expectCode(() => lm.assertWriter(KEY, "client-a"), "E_NO_LEASE");

    lm.acquire(KEY, "pi", "client-a", TTL);
    expectCode(() => lm.assertWriter(KEY, "client-b"), "E_NO_LEASE");

    clock.advance(TTL + 1);
    expectCode(() => lm.assertWriter(KEY, "client-a"), "E_NO_LEASE");
  } finally {
    db.close();
  }
});

test("租约按 sessionKey 隔离：不同会话互不影响", () => {
  const { db, lm } = fresh();
  try {
    lm.acquire("claude:a", "pi", "client-a", TTL);
    const other = lm.acquire("claude:b", "human", "client-b", TTL);

    assert.equal(other.sessionKey, "claude:b");
    assert.equal(lm.current("claude:a")?.clientId, "client-a");
    assert.equal(lm.current("claude:b")?.clientId, "client-b");
  } finally {
    db.close();
  }
});
