/**
 * dispatch 幂等预留表（A08 支撑件，schema v2）。
 *
 * 语义：`reserve` 用 INSERT OR IGNORE 做**原子占位**，同 key 并发只有一个赢家；
 * 赢家继续 newSession，输家读到已有记录按 payload hash 判定冲突或复用。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

export type DispatchStatus = "reserved" | "done" | "failed";

export type DispatchRecord = {
  idempotencyKey: string;
  payloadHash: string;
  sessionKey: string | null;
  status: DispatchStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type DispatchRow = {
  idempotency_key: string;
  payload_hash: string;
  session_key: string | null;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = "idempotency_key, payload_hash, session_key, status, error, created_at, updated_at";

function toRecord(row: DispatchRow): DispatchRecord {
  const status: DispatchStatus =
    row.status === "done" || row.status === "failed" ? row.status : "reserved";
  return {
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    sessionKey: row.session_key,
    status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** dispatches 表读写。 */
export class DispatchStore {
  readonly #db: DatabaseSync;
  #insertStmt: StatementSync | null = null;
  #getStmt: StatementSync | null = null;
  #completesStmt: StatementSync | null = null;
  #reclaimStmt: StatementSync | null = null;
  #touchStmt: StatementSync | null = null;
  #pruneStmt: StatementSync | null = null;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * 原子占位。返回 `{ record, created }`：
   * created=true 表示本次调用赢下 key，调用方负责后续 newSession 并 `complete`/`fail`。
   */
  reserve(idempotencyKey: string, payloadHash: string, now = new Date()): { record: DispatchRecord; created: boolean } {
    const ts = now.toISOString();
    const result = this.#insert().run(idempotencyKey, payloadHash, ts, ts);
    const record = this.get(idempotencyKey);
    if (record === null) {
      throw new Error("dispatches 占位后读不到记录：" + idempotencyKey);
    }
    return { record, created: Number(result.changes) > 0 };
  }

  get(idempotencyKey: string): DispatchRecord | null {
    const row = this.#get().get(idempotencyKey) as DispatchRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  complete(idempotencyKey: string, sessionKey: string, now = new Date()): void {
    this.#completes().run("done", sessionKey, null, now.toISOString(), idempotencyKey);
  }

  fail(idempotencyKey: string, reason: string, now = new Date()): void {
    this.#completes().run("failed", null, reason, now.toISOString(), idempotencyKey);
  }

  /**
   * 回收超 TTL 的 reserved：只有一条原子 UPDATE 抢到才算赢家（changes === 1）。
   * 赢家负责重新 newSession；输家继续轮询。
   */
  reclaim(idempotencyKey: string, ttlMs: number, now = new Date()): boolean {
    const cutoff = new Date(now.getTime() - ttlMs).toISOString();
    const result = this.#reclaim().run(now.toISOString(), idempotencyKey, cutoff);
    return Number(result.changes) === 1;
  }

  /** 续约 reserved 预留窗口（长 newSession 心跳）。 */
  touch(idempotencyKey: string, now = new Date()): void {
    this.#touch().run(now.toISOString(), idempotencyKey);
  }

  /** 删除超过保留期的 done/failed 记录，返回删除行数。 */
  pruneRetained(retentionMs: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    const result = this.#prune().run(cutoff);
    return Number(result.changes);
  }

  #insert(): StatementSync {
    this.#insertStmt ??= this.#db.prepare(
      `INSERT OR IGNORE INTO dispatches (idempotency_key, payload_hash, status, created_at, updated_at)
       VALUES (?, ?, 'reserved', ?, ?)`,
    );
    return this.#insertStmt;
  }

  #get(): StatementSync {
    this.#getStmt ??= this.#db.prepare(`SELECT ${COLUMNS} FROM dispatches WHERE idempotency_key = ?`);
    return this.#getStmt;
  }

  #completes(): StatementSync {
    this.#completesStmt ??= this.#db.prepare(
      "UPDATE dispatches SET status = ?, session_key = ?, error = ?, updated_at = ? WHERE idempotency_key = ?",
    );
    return this.#completesStmt;
  }

  #reclaim(): StatementSync {
    this.#reclaimStmt ??= this.#db.prepare(
      "UPDATE dispatches SET updated_at = ? WHERE idempotency_key = ? AND status = 'reserved' AND updated_at <= ?",
    );
    return this.#reclaimStmt;
  }

  #touch(): StatementSync {
    this.#touchStmt ??= this.#db.prepare(
      "UPDATE dispatches SET updated_at = ? WHERE idempotency_key = ? AND status = 'reserved'",
    );
    return this.#touchStmt;
  }

  #prune(): StatementSync {
    this.#pruneStmt ??= this.#db.prepare(
      "DELETE FROM dispatches WHERE status IN ('done','failed') AND updated_at < ?",
    );
    return this.#pruneStmt;
  }
}
