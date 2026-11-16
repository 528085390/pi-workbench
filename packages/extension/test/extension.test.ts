import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkbenchClient,
  formatToolError,
  registerWorkbenchTools,
  wrapToolExecute,
  WORKBENCH_TOOL_NAMES,
  WorkbenchHttpError,
  type PiToolApi,
  type PiToolDefinition,
} from "../src/index.ts";

/** 记录一次被拦下的请求（断言用） */
type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

/** raw 用来伪造非 JSON 响应体（网关 HTML 错误页） */
type Reply = { status?: number; body: unknown; raw?: string };

/**
 * 假 fetch：记录每次调用，按 handler 返回固定响应。
 * 单测要求离线，因此绝不碰真实网络。
 */
function recorder(handler?: (call: Call) => Reply): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headerRecord: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headerRecord[key.toLowerCase()] = value;
    });
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: headerRecord,
      body: rawBody === undefined ? undefined : (JSON.parse(rawBody) as unknown),
    };
    calls.push(call);

    const reply: Reply = handler === undefined ? { body: {} } : handler(call);
    const text = reply.raw ?? JSON.stringify(reply.body);
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { "content-type": reply.raw === undefined ? "application/json" : "text/html" },
    });
  };
  return { calls, fetchImpl };
}

function fieldOf(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null ? (source as Record<string, unknown>)[key] : undefined;
}

test("clientId 缺省是 pi:<pid>，可覆盖", () => {
  const { fetchImpl } = recorder();
  assert.equal(createWorkbenchClient({ fetch: fetchImpl }).clientId, "pi:" + process.pid);
  assert.equal(createWorkbenchClient({ fetch: fetchImpl, clientId: "pi:42" }).clientId, "pi:42");
});

test("URL 拼接与鉴权头：baseUrl 末尾斜杠不产生双斜杠，token 走 Bearer", async () => {
  const { calls, fetchImpl } = recorder(() => ({ body: { ok: true } }));
  const client = createWorkbenchClient({ baseUrl: "http://127.0.0.1:7331/", authToken: "secret", fetch: fetchImpl });

  await client.health();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:7331/health");
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.headers["authorization"], "Bearer secret");
});

test("没有 token 时不发 authorization 头", async () => {
  const { calls, fetchImpl } = recorder(() => ({ body: [] }));
  const client = createWorkbenchClient({ baseUrl: "http://127.0.0.1:7331", fetch: fetchImpl });

  await client.agents();

  assert.equal(calls[0]?.headers["authorization"], undefined);
});

test("sessions 过滤器拼进查询串；agents 打到 /api/cp/agents", async () => {
  const { calls, fetchImpl } = recorder(() => ({ body: [] }));
  const client = createWorkbenchClient({ baseUrl: "http://127.0.0.1:7331", clientId: "pi:7", fetch: fetchImpl });

  await client.agents();
  await client.sessions();
  await client.sessions({ agent: "claude", status: "idle" });
  await client.sessions({ clientId: "human:1" });

  assert.equal(calls[0]?.url, "http://127.0.0.1:7331/api/cp/agents");
  // 列表默认带本 client 的 clientId，服务端才会算未读（spec §6.5）
  assert.equal(calls[1]?.url, "http://127.0.0.1:7331/api/cp/sessions?clientId=pi%3A7");
  assert.equal(
    calls[2]?.url,
    "http://127.0.0.1:7331/api/cp/sessions?agent=claude&status=idle&clientId=pi%3A7",
  );
  assert.equal(
    calls[3]?.url,
    "http://127.0.0.1:7331/api/cp/sessions?clientId=human%3A1",
    "可显式指定别的读者身份",
  );
});

test("每个方法打到正确的 path + method", async () => {
  const { calls, fetchImpl } = recorder((call) => ({ body: { ok: true, path: call.url } }));
  const client = createWorkbenchClient({ baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });

  await client.dispatch({ task: "干活", cwd: "/tmp/w", idempotencyKey: "k1" });
  await client.see("claude:abc", "12", 5);
  await client.inject("claude:abc", "你好");
  await client.interrupt("claude:abc");
  await client.checkpoint("claude:abc", { summary: "做了一半", touchedFiles: ["a.ts"], nextStep: "继续" });
  await client.handoff("claude:abc", "human", { summary: "交给人类" });
  await client.handback("claude:abc");
  await client.health();

  const seen = calls.map((call) => call.method + " " + call.url.replace("http://h:1", ""));
  assert.deepEqual(seen, [
    "POST /api/cp/dispatch",
    "GET /api/cp/sessions/claude%3Aabc/transcript?after=12&limit=5",
    "POST /api/cp/sessions/claude%3Aabc/inject",
    "POST /api/cp/sessions/claude%3Aabc/interrupt",
    "POST /api/cp/sessions/claude%3Aabc/checkpoint",
    "POST /api/cp/sessions/claude%3Aabc/handoff",
    "POST /api/cp/sessions/claude%3Aabc/handback",
    "GET /health",
  ]);
});

test("写操作 body 带上 clientId 与各自的字段", async () => {
  const { calls, fetchImpl } = recorder(() => ({ body: {} }));
  const client = createWorkbenchClient({ baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });

  await client.dispatch({ task: "干活", cwd: "/tmp/w", idempotencyKey: "k1" });
  await client.inject("claude:abc", "你好");
  await client.checkpoint("claude:abc", { summary: "s" });
  await client.handoff("claude:abc", "human");
  await client.interrupt("claude:abc");
  await client.handback("claude:abc");

  assert.deepEqual(calls[0]?.body, { agent: "claude", task: "干活", idempotencyKey: "k1", cwd: "/tmp/w" });
  assert.deepEqual(calls[1]?.body, { text: "你好", clientId: "pi:7" });
  assert.deepEqual(calls[2]?.body, { clientId: "pi:7", summary: "s", touchedFiles: [], nextStep: "" });
  assert.deepEqual(calls[3]?.body, { to: "human", clientId: "pi:7" });
  // interrupt / handback 的 body 只有 clientId（I1 评审点：以前没断言）
  assert.deepEqual(calls[4]?.body, { clientId: "pi:7" });
  assert.deepEqual(calls[4]?.url, "http://h:1/api/cp/sessions/claude%3Aabc/interrupt");
  assert.deepEqual(calls[5]?.body, { clientId: "pi:7" });
  assert.deepEqual(calls[5]?.url, "http://h:1/api/cp/sessions/claude%3Aabc/handback");
});

test("404 抛 WorkbenchHttpError，字段 status/code/message 齐全", async () => {
  const { fetchImpl } = recorder(() => ({
    status: 404,
    body: { error: { code: "E_SESSION_NOT_FOUND", message: "会话不存在：claude:x" } },
  }));
  const client = createWorkbenchClient({ baseUrl: "http://h:1", fetch: fetchImpl });

  await assert.rejects(client.see("claude:x"), (error: unknown) => {
    assert.ok(error instanceof WorkbenchHttpError, "必须是 WorkbenchHttpError");
    assert.equal(error.status, 404);
    assert.equal(error.code, "E_SESSION_NOT_FOUND");
    assert.equal(error.message, "会话不存在：claude:x");
    return true;
  });
});

test("409 租约冲突同样透出 code/message", async () => {
  const { fetchImpl } = recorder(() => ({
    status: 409,
    body: { error: { code: "E_NO_LEASE", message: "无有效租约：claude:x" } },
  }));
  const client = createWorkbenchClient({ baseUrl: "http://h:1", fetch: fetchImpl });

  await assert.rejects(client.inject("claude:x", "hi"), (error: unknown) => {
    assert.ok(error instanceof WorkbenchHttpError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "E_NO_LEASE");
    assert.equal(error.message, "无有效租约：claude:x");
    return true;
  });
});

test("错误体不是标准结构时回落 E_HTTP_<status>", async () => {
  const { fetchImpl } = recorder(() => ({ status: 500, body: { oops: true } }));
  const client = createWorkbenchClient({ baseUrl: "http://h:1", fetch: fetchImpl });

  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof WorkbenchHttpError);
    assert.equal(error.status, 500);
    assert.equal(error.code, "E_HTTP_500");
    return true;
  });
});

test("错误体不是 JSON（网关 HTML 页）⇒ 回落 E_HTTP_<status>，handler 给可读文本", async () => {
  const { fetchImpl } = recorder(() => ({
    status: 502,
    body: undefined,
    raw: "<html><body><h1>502 Bad Gateway</h1></body></html>",
  }));
  const client = createWorkbenchClient({ baseUrl: "http://h:1", fetch: fetchImpl });

  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof WorkbenchHttpError, "必须是 WorkbenchHttpError");
    assert.equal(error.status, 502);
    assert.equal(error.code, "E_HTTP_502");
    assert.equal(error.message, "HTTP 502");
    return true;
  });

  const { api, tools } = fakeApi();
  registerWorkbenchTools(api, { baseUrl: "http://h:1", fetch: fetchImpl });
  const see = tools.find((tool) => tool.name === "cp_see");
  assert.ok(see !== undefined);
  assert.equal(await see.def.handler({ key: "claude:abc" }), "E_HTTP_502: HTTP 502");
});

function fakeApi(): { api: PiToolApi; tools: Array<{ name: string; def: PiToolDefinition }> } {
  const tools: Array<{ name: string; def: PiToolDefinition }> = [];
  return {
    api: { registerTool: (name, def) => void tools.push({ name, def }) },
    tools,
  };
}

test("registerWorkbenchTools 只注册 9 个 cp_* 工具，各带 description/inputSchema/handler", () => {
  const { api, tools } = fakeApi();
  const { fetchImpl } = recorder();
  registerWorkbenchTools(api, { baseUrl: "http://h:1", fetch: fetchImpl });

  assert.equal(tools.length, 9);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...WORKBENCH_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.ok(tool.name.startsWith("cp_"), tool.name + " 必须以 cp_ 开头");
    assert.equal(typeof tool.def.description, "string");
    assert.ok(tool.def.description.length > 0, tool.name + " 需要描述");
    assert.equal(typeof tool.def.inputSchema, "object");
    assert.equal(typeof tool.def.handler, "function");
  }
});

test("cp_handback 以本 client 身份打到 /handback 并回显增量摘要（I4）", async () => {
  const { api, tools } = fakeApi();
  const { calls, fetchImpl } = recorder(() => ({
    body: { resumed: true, deltaSummary: "user: 我改好了\nassistant: 收到" },
  }));
  registerWorkbenchTools(api, { baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });

  const handback = tools.find((tool) => tool.name === "cp_handback");
  assert.ok(handback !== undefined);
  const out = String(await handback.def.handler({ key: "claude:abc" }));
  assert.match(out, /handback claude:abc \(resumed=true\)/);
  assert.match(out, /receiving|收到/);
  assert.equal(calls[0]?.url, "http://h:1/api/cp/sessions/claude%3Aabc/handback");
  assert.deepEqual(calls[0]?.body, { clientId: "pi:7" });

  // R4：Pi 重启换 pid 后，用 handoff 前那个身份交回
  await handback.def.handler({ key: "claude:abc", clientId: "pi:old" });
  assert.deepEqual(calls[1]?.body, { clientId: "pi:old" });
});

test("R3：两个 token 环境变量同时存在时，客户端与 daemon 一样优先用 AUTH_TOKEN", async () => {
  const { calls, fetchImpl } = recorder(() => ({ body: {} }));
  const savedAuth = process.env["PI_WORKBENCH_AUTH_TOKEN"];
  const savedToken = process.env["PI_WORKBENCH_TOKEN"];
  process.env["PI_WORKBENCH_AUTH_TOKEN"] = "auth-wins";
  process.env["PI_WORKBENCH_TOKEN"] = "token-loses";
  try {
    const client = createWorkbenchClient({ baseUrl: "http://h:1", fetch: fetchImpl });
    await client.agents();
    assert.equal(calls[0]?.headers["authorization"], "Bearer auth-wins", "优先级必须与 config.ts 一致，否则双名不同值 → 401");
  } finally {
    if (savedAuth === undefined) delete process.env["PI_WORKBENCH_AUTH_TOKEN"];
    else process.env["PI_WORKBENCH_AUTH_TOKEN"] = savedAuth;
    if (savedToken === undefined) delete process.env["PI_WORKBENCH_TOKEN"];
    else process.env["PI_WORKBENCH_TOKEN"] = savedToken;
  }
});

test("wrapToolExecute：工具执行前清连击；不执行就不清（B2：beforeCall 不再清账）", async () => {
  let notes = 0;
  const activity = { noteToolActivity: () => void (notes += 1) };
  const out = await wrapToolExecute(activity, async () => "ok");
  assert.equal(out, "ok");
  assert.equal(notes, 1);

  // 没有 activity（插件未建通知器）也不该炸
  assert.equal(await wrapToolExecute(undefined, async () => 1), 1);
});

test("formatToolError：带 E_* code 的领域错误原样透出（I3 的 E_DAEMON_DOWN）", () => {
  class Fake extends Error {
    readonly code = "E_DAEMON_DOWN";
  }
  assert.equal(formatToolError(new Fake("E_DAEMON_DOWN: 找不到控制面入口 x")), "E_DAEMON_DOWN: 找不到控制面入口 x");
});

test("cp_lease 三种 action 打到 /lease 并带 clientId/driver/ttlMs", async () => {
  const { api, tools } = fakeApi();
  const { calls, fetchImpl } = recorder((call) => {
    if (call.body !== null && typeof call.body === "object" && (call.body as Record<string, unknown>)["action"] === "release") {
      return { body: { released: true, sessionKey: "claude:abc", clientId: "pi:7" } };
    }
    return {
      body: {
        sessionKey: "claude:abc",
        driver: "pi",
        clientId: "pi:7",
        expiresAt: "2026-11-15T00:00:00.000Z",
        heartbeatAt: "2026-11-14T23:30:00.000Z",
      },
    };
  });
  registerWorkbenchTools(api, { baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });

  const lease = tools.find((tool) => tool.name === "cp_lease");
  assert.ok(lease !== undefined, "必须注册 cp_lease —— 否则 Pi 侧写操作全 E_NO_LEASE");
  const handback = tools.find((tool) => tool.name === "cp_handback");
  assert.ok(handback !== undefined, "必须注册 cp_handback —— 否则人类接管后 Pi 交不回来");

  const acquired = await lease.def.handler({ key: "claude:abc", action: "acquire", ttlMs: 60000 });
  assert.equal(typeof acquired, "string");
  assert.match(acquired as string, /lease acquire ok/);

  const released = await lease.def.handler({ key: "claude:abc", action: "release" });
  assert.equal(released, "lease released for claude:abc");

  const acquireCall = calls.find(
    (call) => call.body !== null && typeof call.body === "object" && (call.body as Record<string, unknown>)["action"] === "acquire",
  );
  assert.ok(acquireCall !== undefined);
  assert.equal(acquireCall.method, "POST");
  assert.ok(acquireCall.url.endsWith("/api/cp/sessions/claude%3Aabc/lease"), acquireCall.url);
  assert.equal((acquireCall.body as Record<string, unknown>)["clientId"], "pi:7");
  assert.equal((acquireCall.body as Record<string, unknown>)["ttlMs"], 60000);

  const bad = await lease.def.handler({ key: "claude:abc", action: "take" });
  assert.equal(bad, "E_BAD_REQUEST: action 必须是 acquire / release / heartbeat");
});

test("cp_dispatch / cp_inject handler 委托给 client，返回人读摘要", async () => {
  const { api, tools } = fakeApi();
  const { calls, fetchImpl } = recorder((call) => {
    if (call.url.endsWith("/api/cp/dispatch")) {
      return { body: { key: "claude:abc", status: "running", cwd: "/w", driver: "pi" } };
    }
    return { body: { messageId: "m-1", effective: "next_turn" } };
  });
  registerWorkbenchTools(api, { baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });

  const dispatch = tools.find((tool) => tool.name === "cp_dispatch");
  const inject = tools.find((tool) => tool.name === "cp_inject");
  assert.ok(dispatch !== undefined && inject !== undefined);

  const dispatched = await dispatch.def.handler({ task: "跑测试", cwd: "/w" });
  assert.equal(dispatched, "dispatched claude:abc (running) cwd=/w");

  const injected = await inject.def.handler({ key: "claude:abc", text: "回答 E2E" });
  assert.equal(injected, "injected claude:abc (effective=next_turn, messageId=m-1)");

  assert.equal(fieldOf(calls[1]?.body, "clientId"), "pi:7");
});

test("handler 把 HTTP 错误转成 E_XXX: message 文本，不抛错", async () => {
  const { api, tools } = fakeApi();
  const { fetchImpl } = recorder(() => ({
    status: 409,
    body: { error: { code: "E_NO_LEASE", message: "无有效租约：claude:x" } },
  }));
  registerWorkbenchTools(api, { baseUrl: "http://h:1", fetch: fetchImpl });

  const interrupt = tools.find((tool) => tool.name === "cp_interrupt");
  assert.ok(interrupt !== undefined);
  assert.equal(await interrupt.def.handler({ key: "claude:x" }), "E_NO_LEASE: 无有效租约：claude:x");
});

test("handler 缺必填参数时返回 E_BAD_REQUEST 文本，且不发请求", async () => {
  const { api, tools } = fakeApi();
  const { calls, fetchImpl } = recorder();
  registerWorkbenchTools(api, { baseUrl: "http://h:1", fetch: fetchImpl });

  const inject = tools.find((tool) => tool.name === "cp_inject");
  assert.ok(inject !== undefined);

  assert.equal(await inject.def.handler({ key: "claude:x" }), "E_BAD_REQUEST: 缺少必填参数 text");
  assert.equal(calls.length, 0, "参数不合法时不应发请求");
});

test("registerWorkbenchTools 接受已建好的 client（复用，不重建）", async () => {
  const { api, tools } = fakeApi();
  const { calls, fetchImpl } = recorder(() => ({ body: [] }));
  const client = createWorkbenchClient({ baseUrl: "http://h:1", authToken: "t", clientId: "pi:7", fetch: fetchImpl });

  const returned = registerWorkbenchTools(api, client);
  assert.equal(returned, client);

  const sessions = tools.find((tool) => tool.name === "cp_sessions");
  assert.ok(sessions !== undefined);
  assert.equal(await sessions.def.handler({}), "no sessions");
  assert.equal(calls[0]?.url, "http://h:1/api/cp/sessions?clientId=pi%3A7");
  assert.equal(calls[0]?.headers["authorization"], "Bearer t");
});
// ---------------------------------------------------------------- 读语义 v2（spec §6.5）

test("unread：默认 ack=1 读未读，ack:false 是 peek；markRead 打到 /read", async () => {
  const { calls, fetchImpl } = recorder(() => ({
    body: { messages: [], nextCursor: "7", lastReadCursor: "7", unread: 0, awaiting: false, acked: true },
  }));
  const client = createWorkbenchClient({ baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });

  await client.unread("claude:abc");
  await client.unread("claude:abc", { limit: 3, ack: false });
  await client.markRead("claude:abc");
  await client.markRead("claude:abc", "9");

  assert.equal(calls[0]?.url, "http://h:1/api/cp/sessions/claude%3Aabc/unread?clientId=pi%3A7&ack=1");
  assert.equal(
    calls[1]?.url,
    "http://h:1/api/cp/sessions/claude%3Aabc/unread?clientId=pi%3A7&limit=3&ack=0",
    "peek 传 ack=0",
  );
  assert.equal(calls[2]?.url, "http://h:1/api/cp/sessions/claude%3Aabc/read");
  assert.deepEqual(calls[2]?.body, { clientId: "pi:7" });
  assert.deepEqual(calls[3]?.body, { clientId: "pi:7", cursor: "9" });
});

test("cp_see 默认走未读并标记已读；peek=true 只读；after 走 transcript", async () => {
  const { api, tools } = (() => {
    const registered: { name: string; def: PiToolDefinition }[] = [];
    const toolApi: PiToolApi = {
      registerTool(name, def) {
        registered.push({ name, def });
      },
    };
    return { api: { api: toolApi, tools: registered }, tools: registered };
  })();
  const { calls, fetchImpl } = recorder((call) =>
    call.url.includes("/transcript")
      ? { body: { messages: [{ id: "m1", role: "user", kind: "text", text: "历史" }], nextCursor: "42" } }
      : {
          body: {
            messages: [{ id: "m2", role: "assistant", kind: "text", text: "新消息" }],
            nextCursor: "50",
            lastReadCursor: "50",
            unread: 1,
            awaiting: false,
            acked: true,
          },
        },
  );
  const client = createWorkbenchClient({ baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });
  registerWorkbenchTools(api.api, client);

  const see = tools.find((tool) => tool.name === "cp_see");
  assert.ok(see !== undefined);
  const plain = String(await see.def.handler({ key: "claude:abc" }));
  assert.match(plain, /1 unread message\(s\)/);
  assert.match(plain, /新消息/);
  assert.match(calls[0]?.url ?? "", /\/unread\?clientId=pi%3A7&ack=1$/);

  const peeked = String(await see.def.handler({ key: "claude:abc", peek: true }));
  assert.match(peeked, /新消息/);
  assert.match(calls[1]?.url ?? "", /ack=0$/);

  const byCursor = String(await see.def.handler({ key: "claude:abc", after: "12" }));
  assert.match(byCursor, /历史/);
  assert.match(calls[2]?.url ?? "", /\/transcript\?after=12$/);
  assert.equal(calls.length, 3);
});

test("cp_sessions 输出未读数与 awaiting 标记", async () => {
  const registered: { name: string; def: PiToolDefinition }[] = [];
  const toolApi: PiToolApi = {
    registerTool(name, def) {
      registered.push({ name, def });
    },
  };
  const { fetchImpl } = recorder(() => ({
    body: [
      {
        key: "claude:abc",
        agent: "claude",
        nativeId: "abc",
        cwd: "E:\\w",
        status: "needs-input",
        driver: "pi",
        capabilities: { stream: true },
        lastReadCursor: "3",
        unread: 2,
        awaiting: true,
      },
    ],
  }));
  const client = createWorkbenchClient({ baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });
  registerWorkbenchTools(toolApi, client);

  const sessions = registered.find((tool) => tool.name === "cp_sessions");
  assert.ok(sessions !== undefined);
  const out = String(await sessions.def.handler({}));
  assert.match(out, /claude:abc needs-input driver=pi unread=2 awaiting/);
});
test("beforeCall：每次请求前先 await 钩子（插件用它等 daemon 自动拉起）", async () => {
  const order: string[] = [];
  const { fetchImpl } = recorder(() => ({ body: { ok: true } }));
  const wrapped: typeof fetch = async (input, init) => {
    order.push("fetch");
    return fetchImpl(input, init);
  };
  const client = createWorkbenchClient({
    baseUrl: "http://h:1",
    fetch: wrapped,
    beforeCall: async () => {
      order.push("hook");
    },
  });

  await client.agents();
  await client.agents();

  assert.deepEqual(order, ["hook", "fetch", "hook", "fetch"]);
});

test("beforeCall 抛错 → 不发请求", async () => {
  const { calls, fetchImpl } = recorder(() => ({ body: {} }));
  const client = createWorkbenchClient({
    baseUrl: "http://h:1",
    fetch: fetchImpl,
    beforeCall: () => {
      throw new Error("E_DAEMON_DOWN: 起不来");
    },
  });

  await assert.rejects(() => client.agents(), /E_DAEMON_DOWN/);
  assert.equal(calls.length, 0);
});

test("cp_dispatch 显式 agent：先按 /agents 预检 caps，再透传 agent", async () => {
  const { api, tools } = fakeApi();
  const { calls, fetchImpl } = recorder((call) => {
    if (call.url.endsWith("/api/cp/agents")) {
      return {
        body: [
          {
            agent: "codex",
            available: true,
            version: "0.167.0",
            caps: {
              stream: true,
              inject: true,
              interrupt: true,
              attach: false,
              resume: true,
              transcript: true,
              permissions: false,
              background: false,
            },
          },
        ],
      };
    }
    return { body: { key: "codex:abc", status: "running", cwd: "/w", driver: "pi" } };
  });
  registerWorkbenchTools(api, { baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });
  const dispatch = tools.find((tool) => tool.name === "cp_dispatch");
  assert.ok(dispatch !== undefined);

  const out = await dispatch.def.handler({ task: "跑测试", cwd: "/w", agent: "codex" });
  assert.equal(out, "dispatched codex:abc (running) cwd=/w");
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.url.endsWith("/api/cp/agents"), calls[0]?.url);
  assert.equal(calls[1]?.url.endsWith("/api/cp/dispatch"), true);
  assert.equal(fieldOf(calls[1]?.body, "agent"), "codex");
});

test("cp_dispatch 缺能力时结构化报错且不发 HTTP dispatch（假 client 计数）", async () => {
  const { api, tools } = fakeApi();
  const { calls, fetchImpl } = recorder((call) => {
    if (call.url.endsWith("/api/cp/agents")) {
      return {
        body: [
          {
            agent: "pi",
            available: true,
            caps: {
              stream: true,
              inject: false,
              interrupt: true,
              attach: false,
              resume: true,
              transcript: true,
              permissions: false,
              background: false,
            },
          },
        ],
      };
    }
    return { body: { key: "pi:abc", status: "running", cwd: "/w", driver: "pi" } };
  });
  registerWorkbenchTools(api, { baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });
  const dispatch = tools.find((tool) => tool.name === "cp_dispatch");
  assert.ok(dispatch !== undefined);

  const out = await dispatch.def.handler({ task: "跑测试", agent: "pi" });
  assert.match(String(out), /^E_CAP_UNSUPPORTED: /);
  assert.equal(calls.length, 1, "预检失败不得再发 /dispatch");
  assert.ok(calls[0]?.url.endsWith("/api/cp/agents"));
});

test("cp_dispatch 显式 agent 未注册 / 不可用时结构化报错且不发 dispatch", async () => {
  const { api, tools } = fakeApi();
  const { calls, fetchImpl } = recorder((call) => {
    if (call.url.endsWith("/api/cp/agents")) {
      return {
        body: [
          {
            agent: "codex",
            available: false,
            reason: "E_AGENT_UNAVAILABLE: codex 未登录",
            caps: {
              stream: true,
              inject: true,
              interrupt: true,
              attach: false,
              resume: true,
              transcript: true,
              permissions: false,
              background: false,
            },
          },
        ],
      };
    }
    return { body: { key: "codex:abc", status: "running", cwd: "/w", driver: "pi" } };
  });
  registerWorkbenchTools(api, { baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });
  const dispatch = tools.find((tool) => tool.name === "cp_dispatch");
  assert.ok(dispatch !== undefined);

  const out = await dispatch.def.handler({ task: "跑测试", agent: "codex" });
  assert.match(String(out), /^E_AGENT_UNAVAILABLE: /);
  assert.equal(calls.length, 1, "不可用预检失败不得再发 /dispatch");
});

test("cp_dispatch 的 /agents 预检有 30s 缓存：连续两次只探测一次", async () => {
  const { api, tools } = fakeApi();
  const { calls, fetchImpl } = recorder((call) => {
    if (call.url.endsWith("/api/cp/agents")) {
      return {
        body: [
          {
            agent: "codex",
            available: true,
            caps: {
              stream: true,
              inject: true,
              interrupt: true,
              attach: false,
              resume: true,
              transcript: true,
              permissions: false,
              background: false,
            },
          },
        ],
      };
    }
    return { body: { key: "codex:abc", status: "running", cwd: "/w", driver: "pi" } };
  });
  registerWorkbenchTools(api, { baseUrl: "http://h:1", clientId: "pi:7", fetch: fetchImpl });
  const dispatch = tools.find((tool) => tool.name === "cp_dispatch");
  assert.ok(dispatch !== undefined);

  await dispatch.def.handler({ task: "第一次", agent: "codex" });
  await dispatch.def.handler({ task: "第二次", agent: "codex" });
  assert.equal(calls.filter((call) => call.url.endsWith("/api/cp/agents")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/cp/dispatch")).length, 2);
});

test("createWorkbenchClient：excludeSessionKeys 过滤自身会话（cp_sessions 与通知器共用）", async () => {
  const { fetchImpl } = recorder(() => ({
    body: [
      { key: "pi:self", agent: "pi", status: "idle", driver: "pi", cwd: "/w", unread: 0 },
      { key: "claude:a", agent: "claude", status: "idle", driver: "pi", cwd: "/w", unread: 1 },
    ],
  }));
  let self: string | undefined = "pi:self";
  const client = createWorkbenchClient({
    baseUrl: "http://h:1",
    clientId: "pi:7",
    fetch: fetchImpl,
    excludeSessionKeys: () => (self === undefined ? [] : [self]),
  });
  assert.deepEqual((await client.sessions()).map((item) => item.key), ["claude:a"]);
  self = undefined;
  assert.deepEqual((await client.sessions()).map((item) => item.key), ["pi:self", "claude:a"]);
});

test("wrapToolExecute：把工具名传给 noteToolActivity（供 cp_sessions 识别观察动作）", async () => {
  const names: Array<string | undefined> = [];
  const activity = {
    noteToolActivity(toolName?: string): void {
      names.push(toolName);
    },
  };
  await wrapToolExecute(activity, async () => "ok", "cp_sessions");
  assert.deepEqual(names, ["cp_sessions"]);
});
