/**
 * 每读者未读游标（spec §6.5，schema v3）。
 *
 * 模型：会话 = 消息流，每个 clientId 各自记一个"读到哪"的 transcript 游标（字节偏移字符串，
 * 与 `GET /transcript` 的 nextCursor 同一域）。`unread` = 游标之后还有几条消息。
 * 读不读、何时读、读多少全由调用方决定；服务端只存事实。
 */
import type { DatabaseSync } from "node:sqlite";

export type ReadCursor = {
  sessionKey: string;
  clientId: string;
  lastReadCursor: string;
  updatedAt: string;
};

type CursorRow = {
  session_key: string;
  client_id: string;
  last_read_cursor: string;
  updated_at: string;
};

function toCursor(row: CursorRow): ReadCursor {
  return {
    sessionKey: row.session_key,
    clientId: row.client_id,
    lastReadCursor: String(row.last_read_cursor),
    updatedAt: row.updated_at,
  };
}

export class ReadCursorStore {
  readonly #db: DatabaseSync;
  readonly #now: () => string;

  constructor(db: DatabaseSync, now: () => string = () => new Date().toISOString()) {
    this.#db = db;
    this.#now = now;
  }

  get(sessionKey: string, clientId: string): ReadCursor | null {
    const row = this.#db
      .prepare("SELECT * FROM read_cursors WHERE session_key = ? AND client_id = ?")
      .get(sessionKey, clientId) as CursorRow | undefined;
    return row === undefined ? null : toCursor(row);
  }

  /** 已读到的游标；没读过按 "0" 算（= 全部未读）。 */
  cursorOf(sessionKey: string, clientId: string): string {
    return this.get(sessionKey, clientId)?.lastReadCursor ?? "0";
  }

  /**
   * 推进游标。**只进不退**：新游标解析成数字后不大于旧值时保持原值（避免调用方回退导致重复未读）。
   */
  set(sessionKey: string, clientId: string, cursor: string): ReadCursor {
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO read_cursors (session_key, client_id, last_read_cursor, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_key, client_id) DO UPDATE SET
           last_read_cursor = CASE
             WHEN CAST(excluded.last_read_cursor AS INTEGER) >= CAST(read_cursors.last_read_cursor AS INTEGER)
             THEN excluded.last_read_cursor ELSE read_cursors.last_read_cursor END,
           updated_at = excluded.updated_at`,
      )
      .run(sessionKey, clientId, cursor, now);
    return this.get(sessionKey, clientId) ?? { sessionKey, clientId, lastReadCursor: cursor, updatedAt: now };
  }

  listForClient(clientId: string): ReadCursor[] {
    const rows = this.#db
      .prepare("SELECT * FROM read_cursors WHERE client_id = ? ORDER BY session_key")
      .all(clientId) as CursorRow[];
    return rows.map(toCursor);
  }
}

