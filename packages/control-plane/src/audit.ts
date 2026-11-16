/**
 * 审计日志（C03）：append-only 的 \`audit_log\` 读写。
 * 规格：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §7.4（30 天保留）/ §6.2（GET /api/cp/audit）。
 *
 * 约束：
 * - 只追加，不更新、不删除单行；唯一的清理入口是 \`prune\`（按保留期整批删除）。
 * - \`record\` 内部吞掉所有异常（含 JSON 序列化 / 库已关闭），只写 console.error：
 *   审计失败绝不能把业务请求打挂。
 * - \`list\` 按 id 升序；默认 100 条，上限 1000 条（spec §6.2）。
 */
import type { DatabaseSync } from "node:sqlite";

/** 一条审计记录（对外形状；detail 为原始 JSON 值）。 */
export type AuditEntry = {
  id: number;
  ts: string;
  instanceId: string;
  actor: string;
  action: string;
  sessionKey: string | null;
  outcome: "ok" | "error";
  errorCode: string | null;
  detail: unknown;
};

/** 默认保留期（天）：spec §7.4。 */
export const AUDIT_RETENTION_DAYS = 30;
/** 查询默认条数（spec §6.2）。 */
export const AUDIT_DEFAULT_LIMIT = 100;
/** 查询上限（spec §6.2）。 */
export const AUDIT_MAX_LIMIT = 1000;

const DAY_MS = 24 * 3600_000;
const COLUMNS = "id, ts, instance_id, actor, action, session_key, outcome, error_code, detail_json";

export type AuditStoreOptions = {
  /** 本进程实例 id；通常来自 InstanceStore.id */
  instanceId?: string;
  /** 注入时钟（epoch ms），默认 Date.now；测试可快进以覆盖 prune */
  now?: () => number;
};

export type AuditListFilter = {
  sessionKey?: string;
  /** ISO8601；按 ts >= since 过滤 */
  since?: string;
  /** 默认 100，超过 1000 按 1000 截断 */
  limit?: number;
};

type AuditRow = {
  id: number;
  ts: string;
  instance_id: string;
  actor: string;
  action: string;
  session_key: string | null;
  outcome: string;
  error_code: string | null;
  detail_json: string;
};

/** 把外部 limit 归一到 [1, 1000]；未给或非法时回默认 100。 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return AUDIT_DEFAULT_LIMIT;
  }
  const truncated = Math.trunc(limit);
  if (truncated <= 0) {
    return AUDIT_DEFAULT_LIMIT;
  }
  return Math.min(truncated, AUDIT_MAX_LIMIT);
}

/** detail_json 解析失败（历史脏数据）时返回 null，而不是让整条查询 500。 */
function parseDetail(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    ts: row.ts,
    instanceId: row.instance_id,
    actor: row.actor,
    action: row.action,
    sessionKey: row.session_key,
    outcome: row.outcome === "error" ? "error" : "ok",
    errorCode: row.error_code,
    detail: parseDetail(row.detail_json),
  };
}

export class AuditStore {
  readonly #db: DatabaseSync;
  readonly #instanceId: string;
  readonly #now: () => number;

  constructor(db: DatabaseSync, opts: AuditStoreOptions = {}) {
    this.#db = db;
    this.#instanceId = opts.instanceId ?? "unknown";
    this.#now = opts.now ?? Date.now;
  }

  /** 追加一条审计。任何失败都只 console.error，绝不抛出（spec §7.4 的可观测性底线）。 */
  record(entry: Omit<AuditEntry, "id" | "ts" | "instanceId">): void {
    try {
      this.#db
        .prepare(
          "INSERT INTO audit_log (ts, instance_id, actor, action, session_key, outcome, error_code, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          new Date(this.#now()).toISOString(),
          this.#instanceId,
          entry.actor,
          entry.action,
          entry.sessionKey,
          entry.outcome,
          entry.errorCode,
          JSON.stringify(entry.detail ?? null),
        );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[pi-workbenchd] 审计写入失败（已忽略，不影响业务）：" + reason);
    }
  }

  /** 按 id 升序查询；sessionKey / since 为等值 / 下界过滤。 */
  list(filter: AuditListFilter = {}): AuditEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.sessionKey !== undefined && filter.sessionKey.length > 0) {
      where.push("session_key = ?");
      params.push(filter.sessionKey);
    }
    if (filter.since !== undefined && filter.since.length > 0) {
      where.push("ts >= ?");
      params.push(filter.since);
    }
    const sql =
      "SELECT " +
      COLUMNS +
      " FROM audit_log" +
      (where.length === 0 ? "" : " WHERE " + where.join(" AND ")) +
      " ORDER BY id ASC LIMIT ?";
    params.push(normalizeLimit(filter.limit));
    const rows = this.#db.prepare(sql).all(...params) as AuditRow[];
    return rows.map(toEntry);
  }

  /** 删除 ts 早于 now - retentionDays 的行；返回删除条数。 */
  prune(retentionDays: number): number {
    const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : AUDIT_RETENTION_DAYS;
    const cutoff = new Date(this.#now() - days * DAY_MS).toISOString();
    const result = this.#db.prepare("DELETE FROM audit_log WHERE ts < ?").run(cutoff);
    return Number(result.changes);
  }
}
