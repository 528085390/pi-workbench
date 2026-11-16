/**
 * HTTP/WS 服务层（A06 收尾 + A10 前置，Task 8）。
 *
 * 规格：docs/specs/2026-11-14-phase-0.5a-claude-slice.md §6（API 契约）/ §7（事件模型）。
 * 裁定：task-8-brief 的 R31–R47。要点：
 * - R31 全部路由挂 /api/cp 前缀，另留裸 GET /health 别名（T1 的 CLI probeHealth 依赖它）；
 * - R32 鉴权：非回环监听没有 authToken 直接拒绝启动；有 token 时 /api/cp/* 与 WS 要 Bearer，
 *   /health 永远免鉴权；
 * - R33 WS：先订阅（缓冲）→ 回放 after 之后存量 → 再补发缓冲里更新的事件，去重靠 seq 单调；
 * - R35 统一 errorHandler：WorkbenchError.code → HTTP 状态码，未知异常兜底 500 E_INTERNAL。
 *
 * 业务真相（租约 / 幂等 / handoff 顺序）都在 TakeoverEngine 与各 store 里；
 * 本层只做装配：鉴权、请求体校验、错误映射、事件广播。不 import node:http，也不自己 listen。
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { Checkpoint, Driver, SessionCaps, SessionEvent, SessionRef, UnifiedMessage } from "@pi-workbench/shared";
import { WORKBENCH_VERSION } from "@pi-workbench/shared";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";

import type { AdapterUpdate, AgentAdapter } from "./adapters/types.ts";
import type { AgentRouter } from "./agents/router.ts";
import type { AgentStatus } from "./agents/types.ts";
import { capsOf, CLAUDE_CAPABILITIES } from "./capabilities.ts";
import type { CheckpointStore } from "./checkpoints.ts";
import type { Config } from "./config.ts";
import { SCHEMA_VERSION } from "./db.ts";
import type { ReadCursorStore } from "./cursors.ts";
import { isWorkbenchError, WorkbenchError } from "./errors.ts";
import type { WorkbenchErrorCode } from "./errors.ts";
import type { EventStore } from "./events.ts";
import type { LeaseManager } from "./lease.ts";
import type { SessionFilter, SessionRegistry } from "./registry.ts";
import { readTranscript } from "./transcript/index.ts";
import type { TakeoverEngine } from "./takeover.ts";

/** 路由前缀（spec §6：统一 /api/cp；T1 的裸 /health 保留为别名） */
export const API_PREFIX = "/api/cp";
const HEALTH_PATH = "/health";
const API_HEALTH_PATH = API_PREFIX + HEALTH_PATH;

/** ws 的 readyState 常量（不引 ws 的类型，避免把 @fastify/websocket 的内部依赖带进公开签名） */
const WS_OPEN = 1;

/**
 * transcript 读取器：默认 readClaudeTranscript，测试可注入。
 * 比 TakeoverEngine 的 reader 多一个 limit（R46：transcript 路由自己调 reader，不经 engine）。
 */
export type ServerTranscriptReader = (
  path: string,
  cursor?: string,
  limit?: number,
) => { messages: UnifiedMessage[]; nextCursor: string; pending: boolean };

/**
 * 事件管线的结构依赖：只要求 attach，不 import pipeline 模块（避免 server 与 pipeline 双向耦合）。
 * EventPipeline.attach(source, sessionKey) 对 AgentAdapter 与 AgentDriver 都成立（B08 M2）。
 */
export type PipelineLike = {
  attach(source: { onUpdate(cb: (update: AdapterUpdate) => void): () => void }, sessionKey: string): () => void;
};

/** createServer 的依赖（R38 / R46：比 brief 多 adapter 与 checkpoints） */
export type ServerDeps = {
  config: Config;
  store: EventStore;
  leases: LeaseManager;
  registry: SessionRegistry;
  engine: TakeoverEngine;
  /** /agents 的可用性判定 + 上层优雅关闭（本层不 dispose 它） */
  adapter: AgentAdapter;
  /** Agent 注册表（0.5-B B01-b）：传入时 /agents 与 dispatch 走注册表；缺省保持 0.5-A 行为 */
  router?: AgentRouter;
  /** GET /sessions/:key/checkpoint 直接读它（R46，不经 engine） */
  checkpoints: CheckpointStore;
  /** 每读者未读游标（spec §6.5） */
  cursors: ReadCursorStore;
  readTranscript?: ServerTranscriptReader;
  /**
   * GET /agents 的动态数据源（启动探测 / 周期刷新）。
   * 传入时按 30s 缓存；缺省直接用 router.list()（或 0.5-A 的单行描述）。
   */
  agentStatuses?: () => Promise<AgentStatus[]>;
  /** 注入时钟（测试缓存过期），默认 Date.now */
  now?: () => number;
  pipeline?: PipelineLike;
  /**
   * 内部错误（500）的落点。Fastify 以 logger:false 建实例，`app.log.error` 是 no-op，
   * 所以必须显式注入；默认写 stderr，测试可传入收集器断言。
   */
  logError?: (error: unknown) => void;
};

/** startServer 返回的可关闭句柄（index.ts 的 SIGINT/SIGTERM 用） */
export type ServerHandle = {
  app: FastifyInstance;
  url: string;
  port: number;
  close(): Promise<void>;
};

type HealthBody = {
  ok: true;
  name: string;
  version: string;
  pid: number;
  uptimeMs: number;
  /** C1：客户端（Pi 插件）据此拒绝连旧 daemon，别让插件跑在缺路由的版本上 */
  schemaVersion: number;
};

type AgentDescriptor = {
  agent: string;
  available: boolean;
  version: string;
  caps: SessionCaps;
};

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

/**
 * 会话视图（spec §6.5）：`SessionRef` + 某读者的读状态。
 * `unread` 是游标之后还有几条 transcript 消息；`awaiting` 表示会话在等人回话。
 */
export type SessionView = SessionRef & {
  lastReadCursor: string;
  unread: number;
  awaiting: boolean;
};

type JsonRecord = Record<string, unknown>;

/**
 * R35 错误码 → HTTP 状态码。表里没有的码（E_INTERNAL）走兜底 500：
 * spec §6 未列该码，它只用于「非 WorkbenchError 的未知异常」，见 createServer 的 errorHandler。
 */
export const STATUS_BY_CODE: Readonly<Record<WorkbenchErrorCode, number>> = {
  E_BAD_REQUEST: 400,
  E_UNAUTHORIZED: 401,
  E_SESSION_NOT_FOUND: 404,
  E_LEASE_CONFLICT: 409,
  E_NO_LEASE: 409,
  E_IDEMPOTENCY_CONFLICT: 409,
  E_CAP_UNSUPPORTED: 422,
  E_AGENT_UNAVAILABLE: 422,
  E_ADAPTER_DOWN: 503,
  E_RESUME_REJECTED: 503,
};

/** 兜底错误码（spec §6 之外，仅「未知异常 → 500」使用） */
export const INTERNAL_ERROR_CODE = "E_INTERNAL";
/**
 * 500 的对外固定文案（评审 Minor 2）：真实 message 可能带 SQL 片段 / 绝对路径 / 内部标识，
 * 只写进日志，绝不回传给客户端。
 */
export const INTERNAL_ERROR_MESSAGE = "internal error";

const ROUTE_LIST = "GET /sessions";
const ROUTE_DISCOVER = "GET /sessions/discover";
/** 发现路由默认上限：避免上千 rollout 一次性登记/挂管线；显式 limit 可覆盖。 */
const DEFAULT_DISCOVER_LIMIT = 100;
const ROUTE_DETAIL = "GET /sessions/:key";
const ROUTE_TRANSCRIPT = "GET /sessions/:key/transcript";
const ROUTE_LEASE = "POST /sessions/:key/lease";
const ROUTE_INJECT = "POST /sessions/:key/inject";
const ROUTE_INTERRUPT = "POST /sessions/:key/interrupt";
const ROUTE_ATTACH = "POST /sessions/:key/attach";
const ROUTE_CHECKPOINT = "POST /sessions/:key/checkpoint";
const ROUTE_HANDOFF = "POST /sessions/:key/handoff";
const ROUTE_HANDBACK = "POST /sessions/:key/handback";
const ROUTE_DISPATCH = "POST /dispatch";
const ROUTE_UNREAD = "GET /sessions/:key/unread";
const ROUTE_READ = "POST /sessions/:key/read";

/** GET /agents 的缓存窗口（spec §11.1：30s 内不重复探测） */
export const AGENT_STATUS_CACHE_MS = 30_000;

/** 默认读取器：按会话 agent 走统一的 transcript 路由器，缺省参数保持 0.5-A 的 Claude 语义 */
const defaultReader: ServerTranscriptReader = (path, cursor, limit) =>
  readTranscript("claude", path, cursor ?? "0", limit);

/**
 * 装配 Fastify 实例：不 listen（R38）。
 * 所有依赖由调用方注入，便于 app.inject 直接测 HTTP 全路由。
 */
export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  // R32：非回环监听必须有 token，否则连实例都不许建（启动阶段就炸，别等到第一个请求）
  assertAuthConfig(deps.config);

  const { config } = deps;
  /**
   * 统一读路径（0.5-B B06）：按会话 agent 选择 transcript parser。
   * 0.5-A 注入的 ServerTranscriptReader 仍是 path-only 旧签名，优先调用它，
   * 保证既有 Claude 测试与字节游标语义逐字不变。
   */
  const readPage = (
    agent: SessionRef["agent"],
    path: string,
    cursor: string,
    limit?: number,
  ): { messages: UnifiedMessage[]; nextCursor: string; pending: boolean } => {
    if (deps.readTranscript !== undefined) {
      return deps.readTranscript(path, cursor, limit);
    }
    return readTranscript(agent, path, cursor, limit);
  };
  /**
   * "还剩几条"专用读取（B1）：limit=Infinity，读到 EOF。
   * viewOf / POST /read 过去漏传 limit，被生产默认 200 截断 → unread 封顶、/read 读不完。
   * 走注入的 reader，测试里的假 reader 也要按"读到底"返回。
   */
  const readToEnd = (
    agent: SessionRef["agent"],
    path: string,
    cursor: string,
  ): { messages: UnifiedMessage[]; nextCursor: string } =>
    readPage(agent, path, cursor, Number.POSITIVE_INFINITY);
  const startedAt = Date.now();
  const now = deps.now ?? Date.now;
  /** GET /agents 的 30s 缓存（spec §11.1）：探测器可能跑子进程，不能每个请求都打一遍 */
  let agentCache: { at: number; statuses: AgentStatus[] } | null = null;
  const currentAgents = async (): Promise<AgentStatus[] | AgentDescriptor[]> => {
    if (deps.agentStatuses === undefined) {
      return deps.router === undefined ? [describeAgent(config, deps.adapter)] : deps.router.list();
    }
    const at = now();
    if (agentCache !== null && at - agentCache.at < AGENT_STATUS_CACHE_MS) {
      return agentCache.statuses;
    }
    try {
      const statuses = await deps.agentStatuses();
      agentCache = { at, statuses };
      return statuses;
    } catch {
      // 探测层异常不能把 /agents 拖成 500：回退到注册表最后一次快照
      return deps.router?.list() ?? [describeAgent(config, deps.adapter)];
    }
  };

  /** 任意已登记会话接入事件流（B08 M2/P2-3）：dispatch、发现、登记、handback 共用。 */
  const attachPipeline = (session: SessionRef): void => {
    try {
      const driver = deps.router?.get(session.agent) ?? null;
      if (driver !== null) {
        deps.pipeline?.attach(driver, session.key);
      } else if (session.agent === "claude") {
        deps.pipeline?.attach(deps.adapter, session.key);
      }
    } catch (err) {
      process.stderr.write("[pi-workbench] 挂事件管线失败（不影响请求返回）：" + String(err) + "\n");
    }
  };

  const app = Fastify({ logger: false });
  const logError = deps.logError ?? ((error: unknown): void => { console.error("[pi-workbenchd] 未处理异常", error); });

  /**
   * spec §6.5：SessionRef + 该读者的读状态。
   * unread 直接数「游标之后还剩几条消息」——与 cp_see 读的是同一条 transcript 流，
   * 不会出现「事件数对了但没消息」那种错位。transcript 未落盘/读不到时按 0 算，不把列表接口拖成 500。
   */
  const viewOf = (session: SessionRef, clientId: string): SessionView => {
    const lastReadCursor = deps.cursors.cursorOf(session.key, clientId);
    const path = session.transcriptPath;
    let unread = 0;
    if (path !== undefined && path.length > 0) {
      try {
        // B1：必须是"读到 EOF 的消息数"，不能受分页默认上限影响
        unread = readToEnd(session.agent, path, lastReadCursor).messages.length;
      } catch {
        unread = 0;
      }
    }
    return { ...session, lastReadCursor, unread, awaiting: session.status === "needs-input" };
  };
  await app.register(fastifyWebsocket);

  const health = async (): Promise<HealthBody> => ({
    ok: true,
    name: "pi-workbenchd",
    version: WORKBENCH_VERSION,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    schemaVersion: SCHEMA_VERSION,
  });

  // T1 兼容：裸 /health（CLI probeHealth 依赖 {ok,pid,version}）
  app.get(HEALTH_PATH, health);

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (isWorkbenchError(error)) {
      const status = STATUS_BY_CODE[error.code];
      void reply.status(status).send(errorBody(error.code, error.message, error.details));
      return;
    }
    // Fastify 自己的客户端错误（JSON 解析失败 / body 过大 413 / 不支持媒体类型 415 等）：
    // 保留原 4xx 状态码，只把 code 归一到 E_BAD_REQUEST（评审 Minor 1：别把 413/415 一律压成 400）
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      void reply.status(error.statusCode).send(errorBody("E_BAD_REQUEST", error.message));
      return;
    }
    // 未知异常：对外固定文案，真实错误只进日志（评审 Minor 2：不回传内部 message）
    logError(error);
    void reply.status(500).send(errorBody(INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE));
  });

  app.setNotFoundHandler((request, reply) => {
    // R31：路由不存在仍是 404，但 body 统一成 {error:{code,message}}，code 用 E_BAD_REQUEST
    const path = pathOf(request.url);
    // R32 + 评审 Minor 3：未匹配的 /api/cp/* 仍在受保护命名空间里，未认证必须先 401，
    // 否则未认证调用方靠 404/401 的差异就能枚举路由是否存在。非 /api 路径保持 404。
    if (isApiPath(path) && !isAuthorized(config, request.headers.authorization)) {
      void reply
        .status(401)
        .send(errorBody("E_UNAUTHORIZED", "缺少或错误的 Authorization: Bearer <token>", { header: "authorization" }));
      return;
    }
    void reply.status(404).send(errorBody("E_BAD_REQUEST", "未知路由：" + request.method + " " + path, { path }));
  });

  await app.register(
    async (api) => {
      // R32：整个 /api/cp 命名空间都要 token（/health 例外）
      api.addHook("onRequest", async (request) => {
        if (pathOf(request.url) === API_HEALTH_PATH) {
          return;
        }
        if (!isAuthorized(config, request.headers.authorization)) {
          throw new WorkbenchError("E_UNAUTHORIZED", "缺少或错误的 Authorization: Bearer <token>", {
            header: "authorization",
          });
        }
      });

      api.get(HEALTH_PATH, health);

      // 0.5-B B01-b：有注册表时由 router.list() 动态生成；缺省保留 0.5-A 的 claude-only 描述
      api.get("/agents", async () => await currentAgents());

      // 0.5-B B08（评审 M4）：发现层必须有产品出口，否则用户无法让 daemon 认识既有原生会话。
      // GET /sessions/discover?agent=codex&cwd=...&limit=... → 发现并登记（幂等 upsert），返回登记后的 SessionRef。
      api.get("/sessions/discover", async (request) => {
        const query = queryOf(request);
        const agent = optionalString(query, "agent", ROUTE_DISCOVER);
        if (agent === undefined || agent.trim().length === 0) {
          throw new WorkbenchError("E_BAD_REQUEST", ROUTE_DISCOVER + " 必须带 agent", { route: ROUTE_DISCOVER });
        }
        const driver = deps.router?.get(agent) ?? null;
        if (driver === null) {
          throw new WorkbenchError("E_AGENT_UNAVAILABLE", "Agent 未注册或不可用：" + agent, { agent });
        }
        const cwd = optionalString(query, "cwd", ROUTE_DISCOVER);
        const rawLimit = query["limit"];
        let limit = DEFAULT_DISCOVER_LIMIT;
        if (typeof rawLimit === "string" && rawLimit.trim().length > 0) {
          limit = Number(rawLimit);
          if (!Number.isInteger(limit) || limit <= 0) {
            throw new WorkbenchError("E_BAD_REQUEST", ROUTE_DISCOVER + " 的 limit 必须是正整数", { limit: rawLimit });
          }
        }
        const refs = await driver.discover({
          ...(cwd === undefined || cwd.length === 0 ? {} : { cwd }),
          limit,
        });
        // P1-1：发现结果只做「缺失时插入 / 补 transcriptPath」，绝不把活跃会话打回 idle。
        const registered = refs.map((ref) => deps.registry.registerDiscovered(ref).session);
        for (const session of registered) {
          attachPipeline(session);
        }
        return { sessions: registered, count: registered.length };
      });

      api.get("/sessions", async (request) => {
        const query = queryOf(request);
        const filter: SessionFilter = {};
        const agent = optionalString(query, "agent", ROUTE_LIST);
        if (agent !== undefined) {
          filter.agent = agent;
        }
        const status = optionalString(query, "status", ROUTE_LIST);
        if (status !== undefined) {
          filter.status = status;
        }
        const sessions = deps.registry.list(filter);
        // 不带 clientId 时保持 v1 的形状（纯 SessionRef 数组），带则每项附读状态（spec §6.5）
        const clientId = optionalString(query, "clientId", ROUTE_LIST);
        return clientId === undefined ? sessions : sessions.map((session) => viewOf(session, clientId));
      });

      // B08 M4：登记一个已存在的原生会话（发现结果 / 外部扫描器都走这里，不再直接写库）。
      api.post("/sessions", async (request) => {
        const routeName = "POST /sessions";
        const body = bodyOf(request.body, routeName);
        const agent = requireString(body, "agent", routeName);
        const nativeId = requireString(body, "nativeId", routeName);
        const cwd = requireString(body, "cwd", routeName);
        const key = optionalString(body, "key", routeName) ?? agent + ":" + nativeId;
        const transcriptPath = optionalString(body, "transcriptPath", routeName);
        const driver = deps.router?.get(agent) ?? null;
        if (driver === null && deps.router !== undefined) {
          throw new WorkbenchError("E_AGENT_UNAVAILABLE", "Agent 未注册或不可用：" + agent, { agent });
        }
        const ref: SessionRef = {
          key,
          agent,
          nativeId,
          cwd,
          ...(transcriptPath === undefined || transcriptPath.length === 0 ? {} : { transcriptPath }),
          status: "idle",
          driver: "none",
          capabilities: driver === null ? capsOf(agent) : driver.caps,
          kind: "interactive",
        };
        const registered = deps.registry.registerDiscovered(ref);
        attachPipeline(registered.session);
        return { session: registered.session, created: registered.created };
      });

      api.get("/sessions/:key", async (request) => {
        const key = paramOf(request, "key");
        const session = requireSession(deps.registry, key);
        const clientId = optionalString(queryOf(request), "clientId", ROUTE_DETAIL);
        return {
          session: clientId === undefined ? session : viewOf(session, clientId),
          lease: deps.leases.current(key),
        };
      });

      api.get("/sessions/:key/transcript", async (request) => {
        const key = paramOf(request, "key");
        const session = requireSession(deps.registry, key);
        const query = queryOf(request);
        const after = optionalString(query, "after", ROUTE_TRANSCRIPT) ?? "0";
        const limit = optionalPositiveInt(query, "limit", ROUTE_TRANSCRIPT);
        const path = session.transcriptPath;
        if (path === undefined || path.length === 0) {
          // 0.5-B：Codex/Pi 的会话文件由各自驱动懒解析（spec §7.1）。路径未解析出来时
          // 委派 driver.see；驱动没有 see 或解析不到，才返回空页（游标停在调用方给的位置）。
          const driver = deps.router?.get(session.agent) ?? null;
          if (driver !== null && typeof driver.see === "function") {
            const page = await driver.see(session, after, limit);
            return { messages: page.messages, nextCursor: page.nextCursor, pending: page.pending };
          }
          return { messages: [] as UnifiedMessage[], nextCursor: after };
        }
        const page = readPage(session.agent, path, after, limit);
        return { messages: page.messages, nextCursor: page.nextCursor };
      });

      // spec §6.5：只返回该读者没读过的消息。ack=1 才推进游标，ack=0 是 peek（默认不推进）。
      api.get("/sessions/:key/unread", async (request) => {
        const key = paramOf(request, "key");
        const session = requireSession(deps.registry, key);
        const query = queryOf(request);
        const clientId = requireString(query, "clientId", ROUTE_UNREAD);
        const limit = optionalPositiveInt(query, "limit", ROUTE_UNREAD);
        const ack = optionalBoolean(query, "ack", ROUTE_UNREAD) ?? false;
        const lastReadCursor = deps.cursors.cursorOf(key, clientId);
        const path = session.transcriptPath;
        const page =
          path === undefined || path.length === 0
            ? { messages: [] as UnifiedMessage[], nextCursor: lastReadCursor, pending: true }
            : readPage(session.agent, path, lastReadCursor, limit);
        if (ack) {
          deps.cursors.set(key, clientId, page.nextCursor);
        }
        // I1 + R2：unread 是"从我已读位置起还剩几条"，不是"本页几条"，也不该被 limit 改变。
        // peek（ack=0）游标没动 → 必须从 lastReadCursor 数；只有真推进了才从 nextCursor 数。
        const baseCursor = ack ? page.nextCursor : lastReadCursor;
        const remaining =
          path === undefined || path.length === 0
            ? 0
            : readToEnd(session.agent, path, baseCursor).messages.length;
        return {
          messages: page.messages,
          nextCursor: page.nextCursor,
          lastReadCursor: ack ? page.nextCursor : lastReadCursor,
          unread: remaining,
          pageCount: page.messages.length,
          awaiting: session.status === "needs-input",
          acked: ack,
        };
      });

      // 显式"标记已读"：给 cursor 就推进到该游标；不给就读到 EOF（= 全部已读）。
      api.post("/sessions/:key/read", async (request) => {
        const key = paramOf(request, "key");
        const session = requireSession(deps.registry, key);
        const body = bodyOf(request.body, ROUTE_READ);
        const clientId = requireString(body, "clientId", ROUTE_READ);
        const explicit = optionalCursor(body, "cursor", ROUTE_READ);
        let target = explicit;
        if (target === undefined) {
          const path = session.transcriptPath;
          // B1：不给游标 = 读到 EOF（全部已读），不能用分页默认上限
          target =
            path === undefined || path.length === 0
              ? deps.cursors.cursorOf(key, clientId)
              : readToEnd(session.agent, path, deps.cursors.cursorOf(key, clientId)).nextCursor;
        }
        const cursor = deps.cursors.set(key, clientId, target);
        return { sessionKey: key, clientId: cursor.clientId, lastReadCursor: cursor.lastReadCursor, updatedAt: cursor.updatedAt };
      });

      api.post("/sessions/:key/lease", async (request) => {
        const key = paramOf(request, "key");
        requireSession(deps.registry, key);
        const body = bodyOf(request.body, ROUTE_LEASE);
        const clientId = requireString(body, "clientId", ROUTE_LEASE);
        const action = requireString(body, "action", ROUTE_LEASE);
        if (action !== "acquire" && action !== "release" && action !== "heartbeat") {
          throw new WorkbenchError("E_BAD_REQUEST", ROUTE_LEASE + " 的 action 必须是 acquire / release / heartbeat", {
            action,
          });
        }
        const ttlMs = optionalPositiveInt(body, "ttlMs", ROUTE_LEASE);
        if (action === "acquire") {
          return deps.leases.acquire(key, driverOf(body, ROUTE_LEASE), clientId, ttlMs);
        }
        if (action === "heartbeat") {
          return deps.leases.heartbeat(key, clientId, ttlMs);
        }
        deps.leases.release(key, clientId);
        // spec §6 该行标的是 Lease，但 release 之后已无租约可返回：回 {released:true} 供调用方断言
        return { released: true, sessionKey: key, clientId };
      });

      /**
       * 建立控制通道（规格 §6.1 attach / §14 Gate #4）。
       * 能力裁决用**会话声明的 caps**：Claude 的 attach 随 kind 变化（交互式 false / 后台 true），
       * driver.caps 只是交互式快照；Codex/Pi 两者都是 false。缺能力时在调用 driver 之前 422，
       * 不产生任何 ACP / RPC 子进程调用。
       */
      api.post("/sessions/:key/attach", async (request) => {
        const key = paramOf(request, "key");
        const session = requireSession(deps.registry, key);
        if (deps.router === undefined) {
          throw new WorkbenchError("E_AGENT_UNAVAILABLE", "Agent 注册表未启用，无法 attach：" + session.agent, {
            agent: session.agent,
            cap: "attach",
          });
        }
        const driver = deps.router.get(session.agent);
        if (driver === null) {
          throw new WorkbenchError("E_AGENT_UNAVAILABLE", "Agent 未注册或不可用：" + session.agent, {
            agent: session.agent,
            cap: "attach",
          });
        }
        const declared = session.capabilities;
        if (declared.attach !== true) {
          throw new WorkbenchError("E_CAP_UNSUPPORTED", "Agent " + session.agent + " 不支持能力 attach", {
            agent: session.agent,
            cap: "attach",
          });
        }
        await driver.attach(session);
        return { attached: true, sessionKey: key, agent: session.agent };
      });

      api.post("/sessions/:key/inject", async (request) => {
        const key = paramOf(request, "key");
        requireSession(deps.registry, key);
        const body = bodyOf(request.body, ROUTE_INJECT);
        const clientId = requireString(body, "clientId", ROUTE_INJECT);
        const text = requireString(body, "text", ROUTE_INJECT);
        return await deps.engine.inject(key, text, clientId);
      });

      api.post("/sessions/:key/interrupt", async (request) => {
        const key = paramOf(request, "key");
        requireSession(deps.registry, key);
        const body = bodyOf(request.body, ROUTE_INTERRUPT);
        const clientId = requireString(body, "clientId", ROUTE_INTERRUPT);
        return await deps.engine.interrupt(key, clientId);
      });

      api.post("/sessions/:key/checkpoint", async (request) => {
        const key = paramOf(request, "key");
        requireSession(deps.registry, key);
        const body = bodyOf(request.body, ROUTE_CHECKPOINT);
        // R36：checkpoint 的 body 在 spec 之外额外要求 clientId（R25 的写保护口径）
        const clientId = requireString(body, "clientId", ROUTE_CHECKPOINT);
        const summary = requireString(body, "summary", ROUTE_CHECKPOINT);
        const nextStep = optionalString(body, "nextStep", ROUTE_CHECKPOINT) ?? "";
        const touchedFiles = optionalStringArray(body, "touchedFiles", ROUTE_CHECKPOINT) ?? [];
        return deps.engine.checkpoint(key, { summary, touchedFiles, nextStep }, clientId);
      });

      api.get("/sessions/:key/checkpoint", async (request) => {
        const key = paramOf(request, "key");
        requireSession(deps.registry, key);
        // R46：直接读 checkpoints 表，不经 engine；没有则 null（仍是 200）
        return deps.checkpoints.latest(key);
      });

      api.post("/sessions/:key/handoff", async (request) => {
        const key = paramOf(request, "key");
        requireSession(deps.registry, key);
        const body = bodyOf(request.body, ROUTE_HANDOFF);
        const to = requireString(body, "to", ROUTE_HANDOFF);
        if (to !== "human" && to !== "pi") {
          throw new WorkbenchError("E_BAD_REQUEST", ROUTE_HANDOFF + " 的 to 必须是 human 或 pi", { to });
        }
        // R36：handoff 同样额外要求 clientId
        const clientId = requireString(body, "clientId", ROUTE_HANDOFF);
        const summary = optionalString(body, "summary", ROUTE_HANDOFF);
        const nextStep = optionalString(body, "nextStep", ROUTE_HANDOFF);
        const touchedFiles = optionalStringArray(body, "touchedFiles", ROUTE_HANDOFF);
        const input =
          summary === undefined && nextStep === undefined && touchedFiles === undefined
            ? undefined
            : { summary: summary ?? "", touchedFiles: touchedFiles ?? [], nextStep: nextStep ?? "" };
        return await deps.engine.handoff(key, to, clientId, input);
      });

      api.post("/sessions/:key/handback", async (request) => {
        const key = paramOf(request, "key");
        requireSession(deps.registry, key);
        const body = bodyOf(request.body, ROUTE_HANDBACK);
        const clientId = requireString(body, "clientId", ROUTE_HANDBACK);
        const result = await deps.engine.handback(key, clientId);
        const session = deps.registry.get(key);
        if (session !== null) {
          attachPipeline(session);
        }
        return result;
      });

      api.post("/dispatch", async (request) => {
        // 0.5-B：启动探测是后台跑的，探测未完成时 codex/pi 会以 available=false + reason 注册；
        // 首次 dispatch 前先等这一次探测（3s 上限、in-flight 复用），避免刚启动就误报 E_AGENT_UNAVAILABLE。
        try {
          // 复用 /agents 的 30s 缓存；deps.agentStatuses 缺省时 currentAgents() 直接读注册表
          await currentAgents();
        } catch {
          // 探测失败照常走注册表快照，由下面的可用性判定给出结构化错误
        }
        const body = bodyOf(request.body, ROUTE_DISPATCH);
        // 0.5-B B01-b：agent 缺省 claude（保持 0.5-A 调用方兼容），透传给引擎按注册表判可用
        const agent = optionalString(body, "agent", ROUTE_DISPATCH) ?? "claude";
        const task = requireString(body, "task", ROUTE_DISPATCH);
        const idempotencyKey = requireString(body, "idempotencyKey", ROUTE_DISPATCH);
        const cwd = optionalString(body, "cwd", ROUTE_DISPATCH);
        const ref = await deps.engine.dispatch({ agent, task, cwd, idempotencyKey });
        // 新会话挂事件管线，后续 ACP update 才会被归一化成事件（R39 的 pipeline 接线落点）
        attachPipeline(ref);
        return ref;
      });

      // R33 WebSocket：先订阅缓冲 → 回放 after 之后的存量 → 再补发缓冲里 seq 更大的
      api.get("/ws", { websocket: true }, (socket, request) => {
        const after = parseAfterSeq(queryOf(request)["after"]);
        const buffered: SessionEvent[] = [];
        let replaying = true;
        let lastSeq = after;

        const deliver = (event: SessionEvent): void => {
          if (event.seq <= lastSeq) {
            return; // seq 单调，重复的一律丢掉
          }
          lastSeq = event.seq;
          if (socket.readyState === WS_OPEN) {
            socket.send(wireOf(event));
          }
        };

        const unsubscribe = deps.store.subscribe((event) => {
          if (replaying) {
            buffered.push(event);
            return;
          }
          deliver(event);
        });

        try {
          for (const event of deps.store.listAll(after)) {
            deliver(event);
          }
        } finally {
          replaying = false;
          for (const event of buffered) {
            deliver(event);
          }
          buffered.length = 0;
        }

        socket.on("close", () => {
          unsubscribe();
        });
        socket.on("error", () => {
          unsubscribe();
        });
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}

/**
 * createServer + listen，返回可关闭句柄（R39：index.ts 用它 + 自己管信号）。
 * 监听失败（最常见 EADDRINUSE）先把实例关掉再抛，避免泄漏 socket。
 */
export async function startServer(deps: ServerDeps): Promise<ServerHandle> {
  const app = await createServer(deps);
  try {
    await app.listen({ host: deps.config.host, port: deps.config.port });
  } catch (err) {
    await app.close();
    throw err;
  }
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : deps.config.port;
  return {
    app,
    port,
    url: "http://" + deps.config.host + ":" + String(port),
    close: async () => {
      await app.close();
    },
  };
}

/** 回环判定：127.0.0.0/8、::1、localhost（R32 的口径，含常见 IPv6 展开写法） */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * R32 启动前守卫：监听非回环地址却没有 authToken → 抛错拒绝启动（绝不静默裸奔）。
 * createServer / startServer 都会调，因此「构造即校验」。
 */
export function assertAuthConfig(config: Config): void {
  const token = config.authToken;
  if (token !== null && token.length > 0) {
    return;
  }
  if (isLoopbackHost(config.host)) {
    return;
  }
  throw new WorkbenchError("E_UNAUTHORIZED", "拒绝启动：监听 " + config.host + " 不是回环地址，必须配置 authToken", {
    host: config.host,
  });
}

function isAuthorized(config: Config, header: string | undefined): boolean {
  const token = config.authToken;
  if (token === null || token.length === 0) {
    return true; // 回环 + 无 token：全部放行
  }
  if (header === undefined) {
    return false;
  }
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  const presented = Buffer.from(header.slice(prefix.length).trim(), "utf8");
  const expected = Buffer.from(token, "utf8");
  if (presented.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(presented, expected);
}

function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

function pathOf(url: string): string {
  const mark = url.indexOf("?");
  return mark === -1 ? url : url.slice(0, mark);
}

/** 是否落在 /api/cp 受保护命名空间内（含裸前缀本身） */
function isApiPath(path: string): boolean {
  return path === API_PREFIX || path.startsWith(API_PREFIX + "/");
}

function requireSession(registry: SessionRegistry, key: string): SessionRef {
  const session = registry.get(key);
  if (session === null) {
    throw new WorkbenchError("E_SESSION_NOT_FOUND", "会话不存在：" + key, { sessionKey: key });
  }
  return session;
}

function queryOf(request: FastifyRequest): JsonRecord {
  const query: unknown = request.query;
  return typeof query === "object" && query !== null ? (query as JsonRecord) : {};
}

function paramOf(request: FastifyRequest, name: string): string {
  const params: unknown = request.params;
  const record = typeof params === "object" && params !== null ? (params as JsonRecord) : {};
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkbenchError("E_BAD_REQUEST", "缺少路径参数 " + name, { param: name });
  }
  return value;
}

function bodyOf(body: unknown, route: string): JsonRecord {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WorkbenchError("E_BAD_REQUEST", route + " 的请求体必须是 JSON 对象", { route });
  }
  return body as JsonRecord;
}

/**
 * 必填字符串：trim 只用于「是否为空」判定，值原样返回（评审 Minor 4）。
 * inject.text / checkpoint.summary 的首尾空白有语义（代码块、patch、尾随换行），裁掉会破坏内容。
 */
function requireString(source: JsonRecord, field: string, route: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkbenchError("E_BAD_REQUEST", route + " 缺少必填字段 " + field, { route, field });
  }
  return value;
}

/** transcript 游标 = 非负整数字符串（字节偏移）；别的形状直接 400，别让脏游标落库 */
function optionalCursor(source: JsonRecord, field: string, route: string): string | undefined {
  const raw = optionalString(source, field, route);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new WorkbenchError("E_BAD_REQUEST", route + " 的 " + field + " 必须是非负整数字符串", { [field]: raw });
  }
  return raw;
}

function optionalString(source: JsonRecord, field: string, route: string): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new WorkbenchError("E_BAD_REQUEST", route + " 的 " + field + " 必须是字符串", { route, field });
  }
  return value;
}

function optionalBoolean(source: JsonRecord, field: string, route: string): boolean | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  // 查询参数天然是字符串：接受 1/0 与 true/false 两种写法
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  throw new WorkbenchError("E_BAD_REQUEST", route + " 的 " + field + " 必须是布尔值", { route, field });
}

function optionalPositiveInt(source: JsonRecord, field: string, route: string): number | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new WorkbenchError("E_BAD_REQUEST", route + " 的 " + field + " 必须是正整数", { route, field });
  }
  return value;
}

function optionalStringArray(source: JsonRecord, field: string, route: string): string[] | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new WorkbenchError("E_BAD_REQUEST", route + " 的 " + field + " 必须是字符串数组", { route, field });
  }
  return [...value];
}

function driverOf(source: JsonRecord, route: string): Driver {
  const value = source["driver"];
  if (value === undefined || value === null) {
    return "pi";
  }
  if (value === "pi" || value === "human" || value === "none") {
    return value;
  }
  throw new WorkbenchError("E_BAD_REQUEST", route + " 的 driver 必须是 pi / human / none", { driver: value });
}

function parseAfterSeq(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return 0;
}

/** WS 线格式（R33）：不含 idempotencyKey 等内部字段 */
function wireOf(event: SessionEvent): string {
  return JSON.stringify({
    seq: event.seq,
    sessionKey: event.sessionKey,
    type: event.type,
    payload: event.payload,
    source: event.source,
    ts: event.ts,
  });
}

/**
 * R37：能力矩阵复用 capabilities.ts 的常量（与 T7 dispatch 生成 SessionRef 用同一份，绝不复制两份）。
 * available = adapter 命令可启动（绝对路径要真实存在，bare 命令视为可在 PATH 找到）+ adapter 具备必需方法。
 */
function describeAgent(config: Config, adapter: AgentAdapter): AgentDescriptor {
  const cmd = config.claude.adapterCmd;
  const head = cmd[0] ?? "";
  const commandOk = head.length > 0 && (isAbsolute(head) ? existsSync(head) : true);
  const adapterOk = typeof adapter.prompt === "function" && typeof adapter.newSession === "function";
  return {
    agent: "claude",
    available: commandOk && adapterOk,
    // config 里没有版本字段，按 R37 口径回落 unknown
    version: "unknown",
    caps: CLAUDE_CAPABILITIES,
  };
}

/** checkpoint 路由的返回类型：Checkpoint | null（StoredCheckpoint 是其子类型，额外带 path） */
export type CheckpointResponse = Checkpoint | null;
