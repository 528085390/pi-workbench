/**
 * API v1 公共契约（C06 / Task 11）。
 *
 * 口径：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §6。
 * - `API_ROUTES` 是 spec §6.1 的冻结路由清单（22 条，含裸 GET /health），
 *   运行时路由必须与之完全相等；`/api/cp/health` 只是 /health 的兼容别名，不进清单。
 * - v1 内只做 additive：新增可选字段 / 新端点；删字段、改语义一律走 /api/cp/v2。
 * - `SCHEMA_VERSION_EXPECTED` 是 API 契约承诺的库 schema 版本；
 *   运行时 db.ts 的 SCHEMA_VERSION 必须与它一致（契约测试覆盖）。
 */

/** API 主版本（路径 /api/cp 背后的语义版本）。 */
export const API_VERSION = "1";

/** API v1 承诺的 SQLite schema 版本。 */
export const SCHEMA_VERSION_EXPECTED = 4;

export type ApiRouteMethod = "GET" | "POST";

export type ApiRoute = {
  readonly method: ApiRouteMethod;
  readonly path: string;
};

/**
 * spec §6.1 冻结路由清单，顺序与规格表一致。
 * 只列对外承诺的路径：裸 /health 在列，/api/cp/health 兼容别名不在列。
 */
export const API_ROUTES: ReadonlyArray<ApiRoute> = Object.freeze([
  { method: "GET", path: "/health" },
  { method: "GET", path: "/api/cp/version" },
  { method: "GET", path: "/api/cp/agents" },
  { method: "GET", path: "/api/cp/sessions" },
  { method: "GET", path: "/api/cp/sessions/discover" },
  { method: "POST", path: "/api/cp/sessions" },
  { method: "GET", path: "/api/cp/sessions/:key" },
  { method: "GET", path: "/api/cp/sessions/:key/transcript" },
  { method: "GET", path: "/api/cp/sessions/:key/unread" },
  { method: "POST", path: "/api/cp/sessions/:key/read" },
  { method: "POST", path: "/api/cp/sessions/:key/lease" },
  { method: "POST", path: "/api/cp/sessions/:key/inject" },
  { method: "POST", path: "/api/cp/sessions/:key/interrupt" },
  { method: "POST", path: "/api/cp/sessions/:key/attach" },
  { method: "POST", path: "/api/cp/sessions/:key/checkpoint" },
  { method: "GET", path: "/api/cp/sessions/:key/checkpoint" },
  { method: "POST", path: "/api/cp/sessions/:key/handoff" },
  { method: "POST", path: "/api/cp/sessions/:key/handback" },
  { method: "POST", path: "/api/cp/dispatch" },
  { method: "GET", path: "/api/cp/ws" },
  { method: "GET", path: "/api/cp/audit" },
  { method: "GET", path: "/api/cp/assets" },
]);

/** 统一错误响应体（spec §6.3 不变式 2）。 */
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

/** GET /api/cp/version 的 200 响应（spec §6.2）。 */
export type VersionResponse = {
  api: typeof API_VERSION;
  schemaVersion: number;
  daemon: string;
  instanceId: string;
};
