/**
 * 租约管理器（A07 前半）：单 driver 硬约束的数据库单元。
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §4.4 / §7；
 * 计划：docs/superpowers/plans/2026-11-14-phase-0.5a-claude-slice.md Task 4。
 *
 * 约定：
 * - 纯 DB 单元，**不发事件**（Task 6/7 的管线负责把租约变化写进事件库）。
 * - 时间只来自 `opts.now`（默认 `Date.now`），库里存 ISO 字符串，测试可注入时钟快进。
 * - 过期判定统一用 `Date.parse(expiresAt) <= now()`：到期即视为无租约，**不得静默续期**。
 * - 默认 TTL 30 秒（来自 `config.ts`）；长 TTL 租约（如 30 分钟 handoff）由调用方逐次显式传参，
 *   `heartbeat` 也接受同一个可选 TTL 参数，避免把长租约压回默认值。
 */
import type { DatabaseSync } from "node:sqlite";

import type { Driver, Lease } from "@pi-workbench/shared";

import { DEFAULT_LEASE_TTL_MS } from "./config.ts";
import { WorkbenchError } from "./errors.ts";

export type { Lease };

/**
 * 默认租约 TTL：**30 秒**，唯一来源是 `config.ts`（binding ruling）。
 * 30 分钟的 handoff 租约由 T7 在 acquire / heartbeat 上显式传参，绝不靠抬高默认值；
 * 此处只重新导出同一个常量，保证同包内不存在两个同名不同值。
 */
export { DEFAULT_LEASE_TTL_MS };

export type LeaseManagerOptions = {
  /** 默认 TTL（毫秒，必须为正数）；`acquire` / `heartbeat` 可用各自的 TTL 参数单次覆盖。 */
  ttlMs?: number;
  /** 时间源，默认 `Date.now`；测试注入以便快进。 */
  now?: () => number;
  /**
   * 本进程的实例 id（`instances.instance_id`，schema v4）。
   * 空串 = 未归属：测试 / CLI 等单次用法不写归属；启动清扫会把它当历史租约清理。
   */
  instanceId?: string;
};

type LeaseRow = {
  session_key: string;
  driver: string;
  client_id: string;
  instance_id: string;
  expires_at: string;
  heartbeat_at: string;
};

const LEASE_COLUMNS = "session_key, driver, client_id, instance_id, expires_at, heartbeat_at";

/**
 * 单 driver 租约：同一 sessionKey 同时最多一个 writer。
 * - 他人持有时 `acquire` → `E_LEASE_CONFLICT`；
 * - 同一 clientId 再 `acquire` 等价续期；
 * - 无租约 / 非持有者写入 → `E_NO_LEASE`；非持有者释放同样 `E_NO_LEASE`（不删别人的租约）。
 */
export class LeaseManager {
  readonly #db: DatabaseSync;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #instanceId: string;

  constructor(db: DatabaseSync, opts: LeaseManagerOptions = {}) {
    this.#db = db;
    // 与 acquire / heartbeat 用同一套校验：非法 TTL 在这里就炸，避免写出「出生即过期」的租约。
    this.#ttlMs = opts.ttlMs === undefined ? DEFAULT_LEASE_TTL_MS : positiveTtl(opts.ttlMs);
    this.#now = opts.now ?? Date.now;
    this.#instanceId = opts.instanceId ?? "";
  }

  /**
   * 取租约。单条 upsert 完成「过期抢占 / 同 clientId 续期 / 他人冲突」判定：
   * `ON CONFLICT ... WHERE leases.expires_at <= now OR leases.client_id = clientId`，
   * changes = 0 即说明租约被另一个仍有效的 client 持有。
   */
  acquire(sessionKey: string, driver: Driver, clientId: string, ttlMs?: number): Lease {
    const nowMs = this.#now();
    const heartbeatAt = toIso(nowMs);
    const expiresAt = toIso(nowMs + positiveTtl(ttlMs ?? this.#ttlMs));

    const result = this.#db
      .prepare(
        `INSERT INTO leases (session_key, driver, client_id, instance_id, expires_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           driver = excluded.driver,
           client_id = excluded.client_id,
           expires_at = excluded.expires_at,
           heartbeat_at = excluded.heartbeat_at,
           instance_id = excluded.instance_id
         WHERE leases.expires_at <= ? OR leases.client_id = ?`,
      )
      .run(sessionKey, driver, clientId, this.#instanceId, expiresAt, heartbeatAt, heartbeatAt, clientId);

    if (Number(result.changes) === 0) {
      const held = this.#read(sessionKey);
      throw new WorkbenchError("E_LEASE_CONFLICT", `租约被其他客户端持有：${sessionKey}`, {
        sessionKey,
        clientId,
        heldBy: held === null ? null : held.clientId,
        expiresAt: held === null ? null : held.expiresAt,
      });
    }

    return this.#require(sessionKey);
  }

  /**
   * 续期。只有「持有者 + 未过期」才成功（带 WHERE 的单条 UPDATE，避免读改写竞态）；
   * 租约缺失 / 已被他人持有 / 已过期一律 `E_LEASE_CONFLICT`——过期不静默续期。
   *
   * 到期时间 = now + (ttlMs ?? 管理器默认 TTL)：长 TTL 租约（30 分钟 handoff）的心跳
   * 必须显式传同样的 TTL，否则会被压回默认值。
   */
  heartbeat(sessionKey: string, clientId: string, ttlMs?: number): Lease {
    const nowMs = this.#now();
    const heartbeatAt = toIso(nowMs);
    const expiresAt = toIso(nowMs + positiveTtl(ttlMs ?? this.#ttlMs));

    const result = this.#db
      .prepare(
        `UPDATE leases SET expires_at = ?, heartbeat_at = ?, instance_id = ?
         WHERE session_key = ? AND client_id = ? AND expires_at > ?`,
      )
      .run(expiresAt, heartbeatAt, this.#instanceId, sessionKey, clientId, heartbeatAt);

    if (Number(result.changes) === 0) {
      throw this.#conflict(sessionKey, clientId, "heartbeat");
    }

    return this.#require(sessionKey);
  }

  /**
   * 释放。只删自己的租约（DELETE 带 client_id 条件）：
   * 无租约或非持有者 → `E_NO_LEASE`，绝不删别人的租约。
   */
  release(sessionKey: string, clientId: string): void {
    const result = this.#db
      .prepare("DELETE FROM leases WHERE session_key = ? AND client_id = ?")
      .run(sessionKey, clientId);

    if (Number(result.changes) === 0) {
      const held = this.#read(sessionKey);
      throw new WorkbenchError("E_NO_LEASE", `释放租约失败：无租约或非持有者 ${sessionKey}`, {
        sessionKey,
        clientId,
        heldBy: held === null ? null : held.clientId,
      });
    }
  }

  /** 当前有效租约；无租约或已过期返回 null（过期行仍留在库里，等下一次 acquire 覆盖）。 */
  current(sessionKey: string): Lease | null {
    const lease = this.#read(sessionKey);
    if (lease === null) {
      return null;
    }
    return Date.parse(lease.expiresAt) <= this.#now() ? null : lease;
  }

  /**
   * 周期清扫：删除全部已过期租约（`expires_at <= now`），返回删除行数。
   * 与 `current()` 共用注入时钟；不碰未过期租约（归属清理由启动清扫负责）。
   */
  sweepExpired(): number {
    const result = this.#db
      .prepare("DELETE FROM leases WHERE expires_at <= ?")
      .run(toIso(this.#now()));
    return Number(result.changes);
  }

  /**
   * 启动清扫（spec §7.1 第 4 步）：单实例锁保证其他实例已死。
   * 1. 未过期的 human handoff 租约跨重启保留（spec §7.1 对账表），先改归属到当前实例；
   * 2. 删除其余 `instance_id != 当前` 的租约（含 v4 之前的空串历史行，spec §5 约束 2）。
   * 返回删除行数；被接管的 human 租约不计入（它们没有被删除）。
   */
  sweepForBoot(): number {
    const now = toIso(this.#now());
    this.#db
      .prepare(
        `UPDATE leases SET instance_id = ?
         WHERE instance_id != ? AND driver = 'human' AND expires_at > ?`,
      )
      .run(this.#instanceId, this.#instanceId, now);
    const deleted = this.#db
      .prepare("DELETE FROM leases WHERE instance_id != ?")
      .run(this.#instanceId);
    return Number(deleted.changes);
  }

  /** 写保护断言：无有效租约或租约属于他人 → `E_NO_LEASE`。 */
  assertWriter(sessionKey: string, clientId: string): void {
    this.#assertWriter(sessionKey, clientId);
  }

  #assertWriter(sessionKey: string, clientId: string): Lease {
    const lease = this.current(sessionKey);
    if (lease === null) {
      throw new WorkbenchError("E_NO_LEASE", `无有效租约：${sessionKey}`, { sessionKey, clientId });
    }
    if (lease.clientId !== clientId) {
      throw new WorkbenchError("E_NO_LEASE", `租约由其他客户端持有：${sessionKey}`, {
        sessionKey,
        clientId,
        heldBy: lease.clientId,
      });
    }
    return lease;
  }

  #conflict(sessionKey: string, clientId: string, action: string): WorkbenchError {
    const held = this.#read(sessionKey);
    return new WorkbenchError("E_LEASE_CONFLICT", `${action} 失败：无租约、已过期或非持有者 ${sessionKey}`, {
      sessionKey,
      clientId,
      action,
      heldBy: held === null ? null : held.clientId,
      expiresAt: held === null ? null : held.expiresAt,
    });
  }

  #read(sessionKey: string): Lease | null {
    const row = this.#db
      .prepare(`SELECT ${LEASE_COLUMNS} FROM leases WHERE session_key = ?`)
      .get(sessionKey) as LeaseRow | undefined;
    return row === undefined ? null : toLease(row);
  }

  #require(sessionKey: string): Lease {
    const lease = this.#read(sessionKey);
    if (lease === null) {
      throw new WorkbenchError("E_NO_LEASE", `租约写入后读取不到：${sessionKey}`, { sessionKey });
    }
    return lease;
  }
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function positiveTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new WorkbenchError("E_BAD_REQUEST", `TTL 必须是正数：${String(ttlMs)}`, { ttlMs });
  }
  return ttlMs;
}

function toLease(row: LeaseRow): Lease {
  return {
    sessionKey: row.session_key,
    driver: asDriver(row.driver),
    clientId: row.client_id,
    instanceId: row.instance_id,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
  };
}

function asDriver(value: string): Driver {
  if (value === "pi" || value === "human" || value === "none") {
    return value;
  }
  throw new WorkbenchError("E_BAD_REQUEST", `租约记录里的 driver 不合法：${value}`, { driver: value });
}
