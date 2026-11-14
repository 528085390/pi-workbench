/**
 * 事件库（A03）：append-only 事件流，seq 由 SQLite AUTOINCREMENT 全局单调。
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §7。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { SessionEvent, SessionEventType } from "@pi-workbench/shared";

/** 待写入的新事件（seq / ts 由 store 分配）。 */
export type NewEvent = {
  sessionKey: string;
  type: SessionEventType;
  payload: unknown;
  source: "acp" | "transcript" | "system";
  idempotencyKey: string;
};

export type EventListener = (event: SessionEvent) => void;

type EventRow = {
  seq: number;
  session_key: string;
  type: string;
  payload_json: string;
  source: string;
  ts: string;
  idempotency_key: string;
};

const EVENT_COLUMNS = "seq, session_key, type, payload_json, source, ts, idempotency_key";

/**
 * 事件读写。
 * - `append` 同步落库：同 `idempotencyKey` 重复投递返回首次写入的事件，不新增行、不重复通知。
 * - `list` 按 seq 升序返回某会话的事件，可增量补拉（`afterSeq`）与限量（`limit`）。
 * - `subscribe` 注册监听器；返回的退订函数只移除该监听器。
 */
export class EventStore {
  readonly #db: DatabaseSync;
  readonly #listeners = new Set<EventListener>();
  #insertStmt: StatementSync | null = null;
  #byKeyStmt: StatementSync | null = null;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 追加事件；返回写入（或幂等命中）的事件。 */
  append(event: NewEvent): SessionEvent {
    const payloadJson = event.payload === undefined ? "null" : JSON.stringify(event.payload);
    const ts = new Date().toISOString();

    // INSERT OR IGNORE + RETURNING：唯一键冲突时不返回任何行。
    const inserted = this.#insert().get(
      event.sessionKey,
      event.type,
      payloadJson,
      event.source,
      ts,
      event.idempotencyKey,
    ) as EventRow | undefined;

    if (inserted === undefined) {
      const existing = this.#byIdempotencyKey().get(event.idempotencyKey) as EventRow | undefined;
      if (existing === undefined) {
        throw new Error(`事件插入被忽略但未找到原行：${event.idempotencyKey}`);
      }
      return toEvent(existing);
    }

    const stored = toEvent(inserted);
    this.#notify(stored);
    return stored;
  }

  /** 某会话的事件，按 seq 升序；`afterSeq` 为增量补拉游标。 */
  list(sessionKey: string, afterSeq = 0, limit?: number): SessionEvent[] {
    if (limit !== undefined) {
      const rows = this.#db
        .prepare(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE session_key = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        )
        .all(sessionKey, normalizeSeq(afterSeq), normalizeLimit(limit)) as EventRow[];
      return rows.map(toEvent);
    }

    const rows = this.#db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE session_key = ? AND seq > ? ORDER BY seq ASC`)
      .all(sessionKey, normalizeSeq(afterSeq)) as EventRow[];
    return rows.map(toEvent);
  }

  /** 注册监听器，返回只移除该监听器的退订函数（可重复调用）。 */
  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #insert(): StatementSync {
    this.#insertStmt ??= this.#db.prepare(
      `INSERT OR IGNORE INTO events (session_key, type, payload_json, source, ts, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${EVENT_COLUMNS}`,
    );
    return this.#insertStmt;
  }

  #byIdempotencyKey(): StatementSync {
    this.#byKeyStmt ??= this.#db.prepare(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE idempotency_key = ?`,
    );
    return this.#byKeyStmt;
  }

  /**
   * 通知监听器。事件已提交，监听器抛错不得影响 append 结果或数据库状态，
   * 因此逐个隔离并记录到 stderr（便于发现下游 bug，又不阻断写入）。
   */
  #notify(event: SessionEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        process.stderr.write(`[pi-workbench] 事件监听器抛错（已忽略）：${String(err)}\n`);
      }
    }
  }
}

function normalizeSeq(afterSeq: number): number {
  return Number.isFinite(afterSeq) ? Math.trunc(afterSeq) : 0;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  return Math.max(0, Math.trunc(limit));
}

function toEvent(row: EventRow): SessionEvent {
  return {
    seq: Number(row.seq),
    sessionKey: row.session_key,
    type: row.type as SessionEventType,
    payload: JSON.parse(row.payload_json) as unknown,
    source: row.source,
    ts: row.ts,
    idempotencyKey: row.idempotency_key,
  };
}
