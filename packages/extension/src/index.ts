import type { AgentName, Checkpoint, SessionCaps, SessionRef } from "@pi-workbench/shared";

/**
 * Pi 扩展入口（A09）：把 Pi LLM 的 `cp_*` 工具调用转发到 daemon 的 `/api/cp/*`。
 *
 * 分层（裁定 R42）：
 * - `createWorkbenchClient` 只做 HTTP：返回解析后的 JSON，非 2xx 抛 `WorkbenchHttpError`；
 * - `registerWorkbenchTools` 属于工具层：注册 8 个 `WORKBENCH_TOOL_NAMES`，把 JSON 响应压成
 *   一句人读文本，把错误压成 `E_XXX: message`（LLM 看得到错误码，不需要解析 JSON）。
 *
 * 不 import Pi SDK：`PiToolApi` 是最小结构化契约（`registerTool(name, def)`），
 * 宿主传什么实现都行（Pi runtime / 测试里的假 api）。
 */

/** A09 注册给 Pi LLM 的工具名（8 个，顺序即注册顺序）。 */
export const WORKBENCH_TOOL_NAMES = [
  "cp_dispatch",
  "cp_sessions",
  "cp_see",
  "cp_inject",
  "cp_interrupt",
  "cp_handoff",
  "cp_checkpoint",
  "cp_lease",
] as const;

export type WorkbenchToolName = (typeof WORKBENCH_TOOL_NAMES)[number];

/** 控制面默认地址（PRD FR-5.3：loopback 7331） */
export const DEFAULT_BASE_URL = "http://127.0.0.1:7331";

/**
 * Pi 工具定义（只用到的三个字段）。
 * `inputSchema` 故意是 `unknown`：Pi 侧接受 JSON-ish 字面量，这里不绑死某个 schema 库。
 */
export type PiToolDefinition = {
  description: string;
  inputSchema: unknown;
  handler: (input: unknown) => Promise<unknown> | unknown;
};

/** Pi 注册工具的最小结构化接口（不 import Pi SDK，R42） */
export type PiToolApi = {
  registerTool(name: string, def: PiToolDefinition): void;
};

export type WorkbenchClientOptions = {
  baseUrl?: string;
  /** 写操作身份；缺省 `pi:<pid>`（R42） */
  clientId?: string;
  /** 注入假 fetch（测试用）；缺省全局 fetch */
  fetch?: typeof fetch;
  /** Bearer token；缺省读 `PI_WORKBENCH_TOKEN` */
  authToken?: string;
  /** T1 旧字段名，等价 `authToken`（R43 兼容，勿在新代码里用） */
  token?: string;
};

/**
 * 非 2xx 的统一异常。`code` 取 daemon 错误体里的 `error.code`，
 * 拿不到（非 JSON / 结构不符）时回落 `E_HTTP_<status>`。
 */
export class WorkbenchHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "WorkbenchHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type HealthBody = {
  ok: boolean;
  name?: string;
  version?: string;
  pid?: number;
  uptimeMs?: number;
};

/**
 * `GET /api/cp/agents` 的一条。能力字段名以服务端为准：服务端返回 `caps`
 * （server.ts 的 agent list），T9 评审 M1 指出这里曾误写成 `capabilities`，
 * 导致类型与真实响应不符 —— 只保留 `caps` 这一个名字，别再加别名。
 */
export type AgentDescriptor = {
  agent: AgentName;
  available?: boolean;
  version?: string;
  caps: SessionCaps;
};

/** transcript 归一化后的一条消息（与控制面 UnifiedMessage 同构的最小形状） */
export type TranscriptMessage = {
  id?: string;
  role: string;
  kind: string;
  text: string;
  ts?: string;
};

export type TranscriptPage = {
  messages: TranscriptMessage[];
  nextCursor: string;
};

/** spec §6.5：SessionRef + 该读者的读状态（列表/详情带 clientId 时服务端才附） */
export type SessionView = SessionRef & {
  lastReadCursor: string;
  unread: number;
  awaiting: boolean;
};

/** `GET /sessions/:key/unread` 的一页：游标之后还有几条 + 是否已推进游标 */
export type UnreadPage = TranscriptPage & {
  lastReadCursor: string;
  unread: number;
  awaiting: boolean;
  acked: boolean;
};

export type SessionFilter = {
  agent?: string;
  status?: string;
  /** 带上它才会算未读（服务端按读者分别记游标） */
  clientId?: string;
};

export type DispatchInput = {
  agent?: AgentName;
  task: string;
  cwd?: string;
  idempotencyKey?: string;
};

export type InjectResult = { messageId: string; effective: "now" | "next_turn" };
export type InterruptResult = { stopReason: string };

export type CheckpointInput = {
  summary: string;
  touchedFiles?: string[];
  nextStep?: string;
};

export type HandoffResult = {
  checkpoint: Checkpoint;
  command: string[];
  mode: "resume-tui" | "attach";
};

export type HandbackResult = { resumed: boolean; deltaSummary: string };

/** `POST /sessions/:key/lease` 的三种动作 */
export type LeaseAction = "acquire" | "release" | "heartbeat";

/** acquire / heartbeat 返回的租约（release 返回 ReleaseResult） */
export type LeaseRecord = {
  sessionKey: string;
  driver: "pi" | "human" | "none";
  clientId: string;
  expiresAt: string;
  heartbeatAt: string;
};

export type ReleaseResult = { released: boolean; sessionKey: string; clientId: string };

export type LeaseResult = LeaseRecord | ReleaseResult;

/** daemon HTTP 契约（A09）。全部返回解析后的 JSON；非 2xx 抛 `WorkbenchHttpError`。 */
export type WorkbenchClient = {
  /** 本 client 的写操作身份（`pi:<pid>`，可覆盖） */
  readonly clientId: string;
  health(): Promise<HealthBody>;
  agents(): Promise<AgentDescriptor[]>;
  /** 列表；默认带本 client 的 clientId，因此返回带 unread/awaiting 的视图 */
  sessions(filter?: SessionFilter): Promise<SessionView[]>;
  dispatch(input: DispatchInput): Promise<SessionRef>;
  /** see = 按游标读 transcript 增量（纯只读，不碰未读状态）；`after` 是上一次的 nextCursor */
  see(key: string, after?: string, limit?: number): Promise<TranscriptPage>;
  /**
   * 读"我还没读过的消息"（spec §6.5）。默认 ack=true：读到哪就把我的游标推进到哪；
   * ack=false 是 peek，只看不推进。没有游标参数——读多少由这里的 limit 决定。
   */
  unread(key: string, options?: { limit?: number; ack?: boolean }): Promise<UnreadPage>;
  /** 显式标记已读：给 cursor 就推进到该处，不给就读到 EOF */
  markRead(key: string, cursor?: string): Promise<{ sessionKey: string; clientId: string; lastReadCursor: string }>;
  inject(key: string, text: string): Promise<InjectResult>;
  interrupt(key: string): Promise<InterruptResult>;
  checkpoint(key: string, input: CheckpointInput): Promise<Checkpoint>;
  handoff(key: string, to: "human" | "pi", input?: CheckpointInput): Promise<HandoffResult>;
  handback(key: string): Promise<HandbackResult>;
  /**
   * 取/续/还租约（A09 补）。写操作（inject/interrupt/checkpoint/handoff）都要求
   * 同一 `clientId` 先 acquire；没有这个方法，Pi 侧工具在真实宿主里全是 E_NO_LEASE。
   */
  lease(key: string, action: LeaseAction, options?: { driver?: "pi" | "human"; ttlMs?: number }): Promise<LeaseResult>;
};

/** T1 的旧名字，等价于 `WorkbenchClient`（R43：不破坏既有导入） */
export type WorkbenchApi = WorkbenchClient;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/** 去掉末尾斜杠，避免 `new URL("x", base + "/")` 拼出双斜杠路径 */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 非 2xx 响应 → WorkbenchHttpError（`{status, code, message}`，R42） */
function httpErrorOf(status: number, payload: unknown): WorkbenchHttpError {
  if (isRecord(payload) && isRecord(payload["error"])) {
    const body = payload["error"];
    const code = readString(body, "code");
    const message = readString(body, "message");
    return new WorkbenchHttpError(
      status,
      code !== undefined && code.length > 0 ? code : "E_HTTP_" + String(status),
      message !== undefined && message.length > 0 ? message : "HTTP " + String(status),
      body["details"],
    );
  }
  return new WorkbenchHttpError(status, "E_HTTP_" + String(status), "HTTP " + String(status));
}

function queryOf(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length === 0 ? "" : "?" + query;
}

/**
 * 造一个 client。
 * `baseUrl` / `authToken` 缺省从 `PI_WORKBENCH_URL` / `PI_WORKBENCH_TOKEN` 读；`clientId` 缺省 `pi:<pid>`。
 * 所有请求都带 JSON content-type（仅 POST）与 Bearer 头（有 token 时）。
 */
export function createWorkbenchClient(options: WorkbenchClientOptions = {}): WorkbenchClient {
  const baseUrl = trimTrailingSlash(
    options.baseUrl ?? process.env["PI_WORKBENCH_URL"] ?? DEFAULT_BASE_URL,
  );
  // 身份优先级：显式入参 > PI_WORKBENCH_CLIENT_ID > pi:<pid>。
  // 想跨进程保持同一"读者/租约持有人"（例如 Pi 常驻但每次重启都换 pid）就设环境变量。
  const clientId = options.clientId ?? process.env["PI_WORKBENCH_CLIENT_ID"] ?? `pi:${process.pid}`;
  const explicitToken = options.authToken ?? options.token;
  const envToken = process.env["PI_WORKBENCH_TOKEN"];
  const authToken = explicitToken ?? envToken ?? null;
  const doFetch: typeof fetch = options.fetch ?? fetch;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, baseUrl + "/");
    const headers: Record<string, string> = {};
    if (authToken !== null && authToken.length > 0) {
      headers["authorization"] = "Bearer " + authToken;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await doFetch(url, init);
    const payload = parseJson(await response.text());
    if (!response.ok) {
      throw httpErrorOf(response.status, payload);
    }
    return payload;
  }

  function sessionPath(key: string, suffix: string): string {
    return "/api/cp/sessions/" + encodeURIComponent(key) + suffix;
  }

  return {
    clientId,
    health: async () => (await call("GET", "/health")) as HealthBody,
    agents: async () => (await call("GET", "/api/cp/agents")) as AgentDescriptor[],
    sessions: async (filter) =>
      (await call(
        "GET",
        "/api/cp/sessions" +
          queryOf({
            agent: filter?.agent,
            status: filter?.status,
            clientId: filter?.clientId ?? clientId,
          }),
      )) as SessionView[],
    unread: async (key, options) =>
      (await call(
        "GET",
        sessionPath(key, "/unread") +
          queryOf({ clientId, limit: options?.limit, ack: options?.ack === false ? 0 : 1 }),
      )) as UnreadPage,
    markRead: async (key, cursor) =>
      (await call("POST", sessionPath(key, "/read"), {
        clientId,
        ...(cursor === undefined ? {} : { cursor }),
      })) as { sessionKey: string; clientId: string; lastReadCursor: string },
    dispatch: async (input) => {
      const body: Record<string, unknown> = {
        agent: input.agent ?? "claude",
        task: input.task,
        idempotencyKey: input.idempotencyKey ?? `pi-${String(process.pid)}-${String(Date.now())}`,
      };
      if (input.cwd !== undefined) body["cwd"] = input.cwd;
      return (await call("POST", "/api/cp/dispatch", body)) as SessionRef;
    },
    see: async (key, after, limit) =>
      (await call(
        "GET",
        sessionPath(key, "/transcript") + queryOf({ after, limit }),
      )) as TranscriptPage,
    inject: async (key, text) =>
      (await call("POST", sessionPath(key, "/inject"), { text, clientId })) as InjectResult,
    interrupt: async (key) =>
      (await call("POST", sessionPath(key, "/interrupt"), { clientId })) as InterruptResult,
    checkpoint: async (key, input) =>
      (await call("POST", sessionPath(key, "/checkpoint"), {
        clientId,
        summary: input.summary,
        touchedFiles: input.touchedFiles ?? [],
        nextStep: input.nextStep ?? "",
      })) as Checkpoint,
    handoff: async (key, to, input) => {
      const body: Record<string, unknown> = { to, clientId };
      if (input !== undefined) {
        body["summary"] = input.summary;
        body["touchedFiles"] = input.touchedFiles ?? [];
        body["nextStep"] = input.nextStep ?? "";
      }
      return (await call("POST", sessionPath(key, "/handoff"), body)) as HandoffResult;
    },
    handback: async (key) =>
      (await call("POST", sessionPath(key, "/handback"), { clientId })) as HandbackResult,
    lease: async (key, action, options) => {
      const body: Record<string, unknown> = { action, clientId };
      if (options?.driver !== undefined) body["driver"] = options.driver;
      if (options?.ttlMs !== undefined) body["ttlMs"] = options.ttlMs;
      return (await call("POST", sessionPath(key, "/lease"), body)) as LeaseResult;
    },
  };
}

/** 工具层自己的入参错误（区别于 HTTP 错误码） */
class ToolInputError extends Error {
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
    this.code = "E_BAD_REQUEST";
  }
}

/**
 * 错误 → 一行文本（R42）：HTTP 错误保留 daemon 的 code，其余给 `E_INTERNAL`。
 * handler 返回文本而不是抛错：LLM 从工具结果里读到码就够了，抛错会把栈糊进上下文。
 */
export function formatToolError(error: unknown): string {
  if (error instanceof WorkbenchHttpError) {
    return error.code + ": " + error.message;
  }
  if (error instanceof ToolInputError) {
    return error.code + ": " + error.message;
  }
  if (error instanceof Error) {
    return "E_INTERNAL: " + error.message;
  }
  return "E_INTERNAL: " + String(error);
}

function fieldOf(input: unknown, field: string): string | undefined {
  return isRecord(input) ? readString(input, field) : undefined;
}

function requireField(input: unknown, field: string): string {
  const value = fieldOf(input, field);
  if (value === undefined || value.trim().length === 0) {
    throw new ToolInputError("缺少必填参数 " + field);
  }
  return value;
}

function stringListOf(input: unknown, field: string): string[] | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[field];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function excerpt(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

function messageLine(message: TranscriptMessage): string {
  const who = message.role + "/" + message.kind;
  return "[" + who + "] " + excerpt(message.text);
}

function isClient(value: unknown): value is WorkbenchClient {
  return isRecord(value) && typeof value["inject"] === "function" && typeof value["dispatch"] === "function";
}

/**
 * 注册 7 个 `cp_*` 工具（R42）。
 *
 * 第二个参数既可以是已建好的 client，也可以是 `WorkbenchClientOptions`（`{baseUrl, clientId, ...}`）；
 * 省略时用默认 client（`pi:<pid>` + `PI_WORKBENCH_URL`）。
 * 返回实际使用的 client，调用方需要的话可以复用它（例如心跳 / 直连调试）。
 */
export function registerWorkbenchTools(
  api: PiToolApi,
  clientOrOptions: WorkbenchClient | WorkbenchClientOptions = {},
): WorkbenchClient {
  const client = isClient(clientOrOptions) ? clientOrOptions : createWorkbenchClient(clientOrOptions);

  api.registerTool("cp_dispatch", {
    description:
      "在控制面新起一个 Claude 会话并立刻投递任务。返回会话 key（claude:<nativeId>）、状态与 cwd。",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "要交给 Claude 的完整任务描述（必填）" },
        cwd: { type: "string", description: "会话工作目录；缺省用 daemon 的 cwd" },
        idempotencyKey: { type: "string", description: "幂等键；同键同任务只会起一个会话" },
      },
      required: ["task"],
    },
    handler: async (input: unknown): Promise<string> => {
      try {
        const ref = await client.dispatch({
          agent: "claude",
          task: requireField(input, "task"),
          cwd: fieldOf(input, "cwd"),
          idempotencyKey: fieldOf(input, "idempotencyKey"),
        });
        return "dispatched " + ref.key + " (" + ref.status + ") cwd=" + ref.cwd;
      } catch (error) {
        return formatToolError(error);
      }
    },
  });

  api.registerTool("cp_sessions", {
    description:
      "列出控制面里的会话（可按 agent / status 过滤），每行一个 key + 状态 + driver + 未读数 + cwd。unread>0 表示有你没读过的消息。",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "按 agent 过滤，例如 claude" },
        status: { type: "string", description: "按状态过滤：starting|running|needs-input|idle|handoff|exited" },
      },
    },
    handler: async (input: unknown): Promise<string> => {
      try {
        const list = await client.sessions({ agent: fieldOf(input, "agent"), status: fieldOf(input, "status") });
        if (list.length === 0) {
          return "no sessions";
        }
        return list
          .map(
            (ref) =>
              ref.key +
              " " +
              ref.status +
              " driver=" +
              ref.driver +
              " unread=" +
              String(ref.unread) +
              (ref.awaiting ? " awaiting" : "") +
              " " +
              ref.cwd,
          )
          .join("\n");
      } catch (error) {
        return formatToolError(error);
      }
    },
  });

  api.registerTool("cp_see", {
    description:
      "读这个会话里你还没读过的消息（像聊天软件打开会话）。默认读后即标记已读；peek=true 只看不标记。" +
      "想按自己的游标重读某段历史时传 after（走 transcript，纯只读，不动未读状态）。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "会话 key，形如 claude:<nativeId>（必填）" },
        peek: { type: "boolean", description: "只看不标记已读（缺省 false）" },
        limit: { type: "number", description: "最多读多少条（可选，缺省服务端上限）" },
        after: { type: "string", description: "按游标读 transcript（可选；给了就不走未读逻辑）" },
      },
      required: ["key"],
    },
    handler: async (input: unknown): Promise<string> => {
      try {
        const key = requireField(input, "key");
        const limitRaw = isRecord(input) ? input["limit"] : undefined;
        const limit = typeof limitRaw === "number" && Number.isInteger(limitRaw) ? limitRaw : undefined;
        const after = fieldOf(input, "after");
        if (after !== undefined) {
          const page = await client.see(key, after, limit);
          const head =
            page.messages.length === 0 ? "no new messages" : page.messages.length + " message(s)";
          const lines = page.messages.slice(-10).map(messageLine);
          return [head + "; cursor=" + page.nextCursor, ...lines].join("\n");
        }
        const peek = isRecord(input) && input["peek"] === true;
        const page = await client.unread(key, { limit, ack: !peek });
        const head =
          page.messages.length === 0
            ? "no unread messages" + (page.awaiting ? " (session is waiting for your input)" : "")
            : String(page.messages.length) + " unread message(s)";
        const lines = page.messages.slice(-10).map(messageLine);
        return [head + "; cursor=" + page.nextCursor, ...lines].join("\n");
      } catch (error) {
        return formatToolError(error);
      }
    },
  });

  api.registerTool("cp_inject", {
    description:
      "向会话投递一条用户消息（需要持有租约）。运行中会在下一个 turn 边界生效，响应标 effective。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "会话 key（必填）" },
        text: { type: "string", description: "要注入的文本（必填）" },
      },
      required: ["key", "text"],
    },
    handler: async (input: unknown): Promise<string> => {
      try {
        const key = requireField(input, "key");
        const result = await client.inject(key, requireField(input, "text"));
        return "injected " + key + " (effective=" + result.effective + ", messageId=" + result.messageId + ")";
      } catch (error) {
        return formatToolError(error);
      }
    },
  });

  api.registerTool("cp_interrupt", {
    description: "打断会话当前回合（需要持有租约），返回 adapter 给的 stopReason。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "会话 key（必填）" },
      },
      required: ["key"],
    },
    handler: async (input: unknown): Promise<string> => {
      try {
        const key = requireField(input, "key");
        const result = await client.interrupt(key);
        return "interrupted " + key + " (stopReason=" + result.stopReason + ")";
      } catch (error) {
        return formatToolError(error);
      }
    },
  });

  api.registerTool("cp_handoff", {
    description:
      "把会话交给人类（或另一个 Pi 客户端）：先写 checkpoint 再关掉 adapter 侧会话，返回可执行的接管命令。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "会话 key（必填）" },
        to: { type: "string", description: "human 或 pi，缺省 human" },
        summary: { type: "string", description: "交接摘要（可选）" },
        nextStep: { type: "string", description: "下一步建议（可选）" },
        touchedFiles: { type: "array", items: { type: "string" }, description: "本轮触碰过的文件（可选）" },
      },
      required: ["key"],
    },
    handler: async (input: unknown): Promise<string> => {
      try {
        const key = requireField(input, "key");
        const to = fieldOf(input, "to") === "pi" ? "pi" : "human";
        const summary = fieldOf(input, "summary");
        const result = await client.handoff(
          key,
          to,
          summary === undefined ? undefined : { summary, touchedFiles: stringListOf(input, "touchedFiles"), nextStep: fieldOf(input, "nextStep") },
        );
        return (
          "handoff " + key + " to " + to + " (" + result.mode + "); 接管命令：" + result.command.join(" ")
        );
      } catch (error) {
        return formatToolError(error);
      }
    },
  });

  api.registerTool("cp_checkpoint", {
    description: "给会话写一份 checkpoint（摘要 / 触碰文件 / 下一步），handback 会按它的游标读增量。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "会话 key（必填）" },
        summary: { type: "string", description: "当前进展摘要（必填）" },
        touchedFiles: { type: "array", items: { type: "string" }, description: "触碰过的文件（可选）" },
        nextStep: { type: "string", description: "下一步建议（可选）" },
      },
      required: ["key", "summary"],
    },
    handler: async (input: unknown): Promise<string> => {
      try {
        const key = requireField(input, "key");
        const checkpoint = await client.checkpoint(key, {
          summary: requireField(input, "summary"),
          touchedFiles: stringListOf(input, "touchedFiles"),
          nextStep: fieldOf(input, "nextStep"),
        });
        return (
          "checkpoint saved for " + key + " @ " + checkpoint.createdAt + " (cursor=" + checkpoint.transcriptCursor + ")"
        );
      } catch (error) {
        return formatToolError(error);
      }
    },
  });

  api.registerTool("cp_lease", {
    description:
      "取 / 续 / 还会话租约。inject、interrupt、checkpoint、handoff 这些写操作都要求本客户端先 acquire（同一 clientId）。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "会话 key（必填）" },
        action: { type: "string", enum: ["acquire", "release", "heartbeat"], description: "动作（必填）" },
        driver: { type: "string", enum: ["pi", "human"], description: "acquire 时的驱动方（可选，默认 pi）" },
        ttlMs: { type: "number", description: "租约时长毫秒（可选；human 接管给大值，如 30 分钟）" },
      },
      required: ["key", "action"],
    },
    handler: async (input: unknown): Promise<string> => {
      try {
        const key = requireField(input, "key");
        const action = requireField(input, "action");
        if (action !== "acquire" && action !== "release" && action !== "heartbeat") {
          throw new ToolInputError("action 必须是 acquire / release / heartbeat");
        }
        const driverRaw = fieldOf(input, "driver");
        if (driverRaw !== undefined && driverRaw !== "pi" && driverRaw !== "human") {
          throw new ToolInputError("driver 只能是 pi / human");
        }
        const ttlRaw = isRecord(input) ? input["ttlMs"] : undefined;
        if (ttlRaw !== undefined && (typeof ttlRaw !== "number" || !Number.isFinite(ttlRaw) || ttlRaw <= 0)) {
          throw new ToolInputError("ttlMs 必须是正数");
        }
        const options: { driver?: "pi" | "human"; ttlMs?: number } = {};
        if (driverRaw !== undefined) options.driver = driverRaw;
        if (typeof ttlRaw === "number") options.ttlMs = ttlRaw;
        const result = await client.lease(key, action, options);
        if ("released" in result) {
          return "lease released for " + key;
        }
        return "lease " + action + " ok for " + key + " (driver=" + result.driver + ", expiresAt=" + result.expiresAt + ")";
      } catch (error) {
        return formatToolError(error);
      }
    },
  });

  return client;
}
