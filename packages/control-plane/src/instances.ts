/**
 * 实例记录（`instances` 表，schema v4）。
 * 规格：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §7.1（C01 启动顺序第 3 步）；
 * 计划：docs/superpowers/plans/2026-11-17-phase-0.5c-control-plane-hardening.md Task 2。
 *
 * 单实例锁（`workbench.pid`）保证同一时刻只有一个活着的 daemon，所以这张表只做两件事：
 * 1. 记录「本次启动是谁、什么时候起的、心跳到哪」——`/api/cp/version` 的 `instanceId`、
 *    审计行的 `instance_id`、租约行的 `instance_id` 都取自这里；
 * 2. 留下「上一次没正常收尾」的行（`ended_at IS NULL`），交重启对账补齐 `ended_at`。
 *
 * 约定：
 * - 纯 DB 单元，**不发事件、不起定时器**：15s 心跳由 `index.ts` 装配（`setInterval(...).unref()`）。
 * - 时间只来自 `opts.now`（默认 `Date.now`），库里存 ISO 字符串，测试可注入时钟快进。
 * - `touch()` / `finish()` 只作用于本次 `begin()` 写下的那一行；没 `begin()` 时是 no-op，
 *   这样启动失败路径上的兜底 `finish()` 不会误伤更早实例的行。
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import { WORKBENCH_VERSION } from "@pi-workbench/shared";

/** 一行实例记录（对外字段；`endedAt` 为 null 表示还没正常收尾）。 */
export type InstanceInfo = {
  id: string;
  pid: number;
  host: string;
  version: string;
  startedAt: string;
  heartbeatAt: string;
  endedAt: string | null;
};

export type InstanceStoreOptions = {
  /** 进程号，默认 `process.pid`。 */
  pid?: number;
  /** 主机名，默认 `os.hostname()`。 */
  host?: string;
  /** daemon 版本，默认 `WORKBENCH_VERSION`。 */
  version?: string;
  /** 时间源（epoch ms），默认 `Date.now`；测试注入以便快进。 */
  now?: () => number;
};

type InstanceRow = {
  instance_id: string;
  pid: number;
  host: string;
  version: string;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
};

const COLUMNS = "instance_id, pid, host, version, started_at, heartbeat_at, ended_at";

function toInfo(row: InstanceRow): InstanceInfo {
  return {
    id: row.instance_id,
    pid: Number(row.pid),
    host: row.host,
    version: row.version,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    endedAt: row.ended_at,
  };
}

/** `instances` 表读写：每次 daemon 启动写一行，15s 心跳，退出时写 `ended_at`。 */
export class InstanceStore {
  readonly #db: DatabaseSync;
  readonly #pid: number;
  readonly #host: string;
  readonly #version: string;
  readonly #now: () => number;
  /** 本次 `begin()` 写下的行 id；null = 本进程还没登记过。 */
  #id: string | null = null;

  constructor(db: DatabaseSync, opts: InstanceStoreOptions = {}) {
    this.#db = db;
    this.#pid = opts.pid ?? process.pid;
    this.#host = opts.host ?? hostname();
    this.#version = opts.version ?? WORKBENCH_VERSION;
    this.#now = opts.now ?? Date.now;
  }

  /** 本次登记的实例 id；未 `begin()` 时为 null（`/api/cp/version` 用）。 */
  get id(): string | null {
    return this.#id;
  }

  /**
   * 写本实例一行（`started_at` = `heartbeat_at` = 当前时间）并返回它。
   * 每进程只应在启动时调一次：重复调用会再写一行，并以最后一行为「本实例」。
   */
  begin(): InstanceInfo {
    const id = randomUUID();
    const ts = this.#iso();
    this.#db
      .prepare(`INSERT INTO instances (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(id, this.#pid, this.#host, this.#version, ts, ts);
    this.#id = id;
    const info = this.get(id);
    if (info === null) {
      throw new Error("instances 写入后读不到记录：" + id);
    }
    return info;
  }

  /** 心跳：刷新本实例行的 `heartbeat_at`。未 `begin()` → no-op。 */
  touch(): void {
    if (this.#id === null) {
      return;
    }
    this.#db
      .prepare("UPDATE instances SET heartbeat_at = ? WHERE instance_id = ?")
      .run(this.#iso(), this.#id);
  }

  /** 收尾：只给本实例行写 `ended_at`（不碰别的实例行，也不清 `begin()` 状态）。未 `begin()` → no-op。 */
  finish(): void {
    if (this.#id === null) {
      return;
    }
    this.#db
      .prepare("UPDATE instances SET ended_at = ? WHERE instance_id = ?")
      .run(this.#iso(), this.#id);
  }

  get(id: string): InstanceInfo | null {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM instances WHERE instance_id = ?`)
      .get(id) as InstanceRow | undefined;
    return row === undefined ? null : toInfo(row);
  }

  /**
   * 启动收尾：把本实例之前所有未写 `ended_at` 的历史实例补上当前时间（spec §7.1 第 8 步）。
   * 只处理 `instance_id != 本实例` 的行；未 `begin()` 时 no-op。返回收尾行数。
   */
  closeStale(): number {
    if (this.#id === null) {
      return 0;
    }
    const result = this.#db
      .prepare("UPDATE instances SET ended_at = ? WHERE ended_at IS NULL AND instance_id != ?")
      .run(this.#iso(), this.#id);
    return Number(result.changes);
  }

  /** 未正常收尾（`ended_at` 为空）的实例，按启动时间升序；重启对账用。 */
  unfinished(): InstanceInfo[] {
    const rows = this.#db
      .prepare(`SELECT ${COLUMNS} FROM instances WHERE ended_at IS NULL ORDER BY started_at, instance_id`)
      .all() as InstanceRow[];
    return rows.map(toInfo);
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}