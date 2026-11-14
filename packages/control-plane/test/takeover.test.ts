import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { SessionRef } from "@pi-workbench/shared";

import type { AdapterUpdate, AgentAdapter } from "../src/adapters/types.ts";
import { CheckpointStore } from "../src/checkpoints.ts";
import { migrate, openDb } from "../src/db.ts";
import { DispatchStore } from "../src/dispatch-store.ts";
import { isWorkbenchError } from "../src/errors.ts";
import type { WorkbenchErrorCode } from "../src/errors.ts";
import { EventStore } from "../src/events.ts";
import { LeaseManager } from "../src/lease.ts";
import { SessionRegistry } from "../src/registry.ts";
import { claudeProjectDir } from "../src/transcript/claude.ts";
import type { UnifiedMessage } from "../src/transcript/claude.ts";
import { CLAUDE_CAPABILITIES } from "../src/capabilities.ts";
import { TakeoverEngine } from "../src/takeover.ts";
import type { TranscriptReader } from "../src/takeover.ts";

const START = Date.parse("2026-11-15T00:00:00.000Z");
const KEY = "claude:sess-1";
const CWD = "E:\\pi-workbench\\spike\\a00-workspace";
const TRANSCRIPT = join(claudeProjectDir(CWD), "sess-1.jsonl");
const HUMAN_WINDOW_MS = 30 * 60 * 1000;

type Clock = {
  now: () => number;
  advance: (ms: number) => void;
};

function makeClock(): Clock {
  let current = START;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

type Call = { method: string; args: unknown[] };

type Fake = {
  adapter: AgentAdapter;
  calls: Call[];
  count: (method: string) => number;
  argsOf: (method: string) => unknown[][];
};

/** 假 adapter：只记录调用，不跑任何子进程 */
function makeFake(
  opts: { resumeError?: Error; closeError?: Error; cancelError?: Error; newSessionError?: Error } = {},
): Fake {
  const calls: Call[] = [];
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };

  const adapter: AgentAdapter = {
    newSession: async (cwd: string) => {
      record("newSession", [cwd]);
      if (opts.newSessionError !== undefined) {
        throw opts.newSessionError;
      }
      return { sessionId: "sess-new" };
    },
    resume: async (sessionId: string, cwd: string) => {
      record("resume", [sessionId, cwd]);
      if (opts.resumeError !== undefined) {
        throw opts.resumeError;
      }
    },
    prompt: async (sessionId: string, text: string) => {
      record("prompt", [sessionId, text]);
      return { messageId: "msg-" + String(calls.length) };
    },
    cancel: async (sessionId: string) => {
      record("cancel", [sessionId]);
      if (opts.cancelError !== undefined) {
        throw opts.cancelError;
      }
      return { stopReason: "cancelled" };
    },
    close: async (sessionId: string) => {
      record("close", [sessionId]);
      if (opts.closeError !== undefined) {
        throw opts.closeError;
      }
    },
    waitForTurn: async (sessionId: string) => {
      record("waitForTurn", [sessionId]);
      return { stopReason: "end_turn" };
    },
    onUpdate: (_cb: (update: AdapterUpdate) => void) => {
      record("onUpdate", []);
      return () => {};
    },
    dispose: async () => {
      record("dispose", []);
    },
  };

  return {
    adapter,
    calls,
    count: (method: string) => calls.filter((call) => call.method === method).length,
    argsOf: (method: string) => calls.filter((call) => call.method === method).map((call) => call.args),
  };
}

type Harness = {
  db: DatabaseSync;
  store: EventStore;
  leases: LeaseManager;
  registry: SessionRegistry;
  checkpoints: CheckpointStore;
  dispatches: DispatchStore;
  fake: Fake;
  engine: TakeoverEngine;
  handoffDir: string;
  clock: Clock;
  close: () => void;
};

type FakeOpts = {
  readTranscript?: TranscriptReader;
  resumeError?: Error;
  closeError?: Error;
  cancelError?: Error;
  newSessionError?: Error;
};

const emptyReader: TranscriptReader = (_path, cursor) => ({
  messages: [],
  nextCursor: cursor ?? "0",
  pending: true,
});

function fresh(opts: FakeOpts = {}): Harness {
  const db = openDb(":memory:");
  migrate(db);
  const store = new EventStore(db);
  const clock = makeClock();
  const leases = new LeaseManager(db, { now: clock.now });
  const registry = new SessionRegistry(db);
  const checkpoints = new CheckpointStore(db);
  const dispatches = new DispatchStore(db);
  const fake = makeFake(opts);
  const handoffDir = mkdtempSync(join(tmpdir(), "pi-handoffs-"));
  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter: fake.adapter,
    checkpoints,
    dispatches,
    handoffDir,
    now: clock.now,
    readTranscript: opts.readTranscript ?? emptyReader,
  });
  return {
    db,
    store,
    leases,
    registry,
    checkpoints,
    dispatches,
    fake,
    engine,
    handoffDir,
    clock,
    close: () => {
      db.close();
      rmSync(handoffDir, { recursive: true, force: true });
    },
  };
}

type Restarted = {
  store: EventStore;
  leases: LeaseManager;
  registry: SessionRegistry;
  checkpoints: CheckpointStore;
  dispatches: DispatchStore;
  engine: TakeoverEngine;
};

/**
 * 模拟**真进程重启**（round 2）：EventStore / LeaseManager / SessionRegistry / CheckpointStore /
 * DispatchStore 全部重新构造，只共用同一个 DatabaseSync 句柄（同一个库），再按启动流程
 * `registry.loadFromDb()` 从 sessions 表把会话水合回内存。
 * 这里刻意**不复用** h.registry / h.leases：真重启后它们的进程内存并不存在，
 * 复用会掩盖「内存空 → E_SESSION_NOT_FOUND」这条真实失败路径。
 */
function restart(h: Harness, reader?: TranscriptReader): Restarted {
  const store = new EventStore(h.db);
  const leases = new LeaseManager(h.db, { now: h.clock.now });
  const registry = new SessionRegistry(h.db);
  const checkpoints = new CheckpointStore(h.db);
  const dispatches = new DispatchStore(h.db);
  // 真重启的启动步骤（R34）：内存为空 → 从 sessions 表回灌
  registry.loadFromDb();
  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter: h.fake.adapter,
    checkpoints,
    dispatches,
    handoffDir: h.handoffDir,
    now: h.clock.now,
    readTranscript: reader ?? emptyReader,
  });
  return { store, leases, registry, checkpoints, dispatches, engine };
}

function countRows(db: DatabaseSync, table: "checkpoints" | "dispatches"): number {
  const row = db.prepare("SELECT count(*) AS n FROM " + table).get() as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function makeRef(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    key: KEY,
    agent: "claude",
    nativeId: "sess-1",
    cwd: CWD,
    transcriptPath: TRANSCRIPT,
    status: "running",
    driver: "pi",
    capabilities: CLAUDE_CAPABILITIES,
    kind: "interactive",
    ...overrides,
  };
}

async function expectRejectCode(fn: () => Promise<unknown>, code: WorkbenchErrorCode): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(isWorkbenchError(err), "预期 WorkbenchError，实际：" + String(err));
    assert.equal(err.code, code, "预期错误码 " + code + "，实际 " + err.code + "：" + err.message);
    return;
  }
  assert.fail("预期抛 " + code + "，但没有抛");
}

function msg(id: string, role: UnifiedMessage["role"], text: string): UnifiedMessage {
  return { id, role, kind: "text", text, ts: "" };
}

test("inject: 无租约 → E_NO_LEASE，且 adapter.prompt 调用 0 次（R25）", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef());
    await expectRejectCode(() => h.engine.inject(KEY, "继续改 auth 校验", "pi-1"), "E_NO_LEASE");
    assert.equal(h.fake.count("prompt"), 0, "无租约时不得产生 ACP 请求");
  } finally {
    h.close();
  }
});

test("inject: 他人持租约 → E_NO_LEASE，prompt 仍为 0 次", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef());
    h.leases.acquire(KEY, "human", "human-1");
    await expectRejectCode(() => h.engine.inject(KEY, "偷写", "pi-1"), "E_NO_LEASE");
    assert.equal(h.fake.count("prompt"), 0);
  } finally {
    h.close();
  }
});

test("inject: 会话 running → prompt 投递一次，effective 退化为 next_turn", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "running" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    const result = await h.engine.inject(KEY, "把测试也一起改了", "pi-1");

    assert.equal(result.effective, "next_turn");
    assert.equal(typeof result.messageId, "string");
    assert.equal(result.messageId.length > 0, true);
    assert.deepEqual(h.fake.argsOf("prompt"), [["sess-1", "把测试也一起改了"]]);
  } finally {
    h.close();
  }
});

test("inject: 会话 idle → effective 为 now", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "idle" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    const result = await h.engine.inject(KEY, "hi", "pi-1");

    assert.equal(result.effective, "now");
    assert.equal(h.fake.count("prompt"), 1);
  } finally {
    h.close();
  }
});

test("inject: 未知 key → E_SESSION_NOT_FOUND，prompt 0 次", async () => {
  const h = fresh();
  try {
    h.leases.acquire("claude:ghost", "pi", "pi-1");
    await expectRejectCode(() => h.engine.inject("claude:ghost", "hi", "pi-1"), "E_SESSION_NOT_FOUND");
    assert.equal(h.fake.count("prompt"), 0);
  } finally {
    h.close();
  }
});

test("interrupt: 无租约 → E_NO_LEASE，cancel 0 次", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef());
    await expectRejectCode(() => h.engine.interrupt(KEY, "pi-1"), "E_NO_LEASE");
    assert.equal(h.fake.count("cancel"), 0, "无租约时不得打断别人的回合");
  } finally {
    h.close();
  }
});

test("interrupt: 持租约 → cancel 一次并追加 state_update（idle + stopReason）", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "running" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    const result = await h.engine.interrupt(KEY, "pi-1");

    assert.equal(result.stopReason, "cancelled");
    assert.deepEqual(h.fake.argsOf("cancel"), [["sess-1"]]);
    assert.equal(h.registry.get(KEY)?.status, "idle", "状态投影回 idle");

    const stateUpdates = h.store.list(KEY).filter((event) => event.type === "state_update");
    assert.equal(stateUpdates.length, 1, "必须恰好追加一条 state_update");
    const payload = stateUpdates[0]?.payload;
    assert.ok(typeof payload === "object" && payload !== null, "state_update 必须有 payload");
    const record = payload as Record<string, unknown>;
    assert.equal(record["state"], "idle");
    assert.equal(record["stopReason"], "cancelled");
  } finally {
    h.close();
  }
});

test("checkpoint: 无租约 → E_NO_LEASE，且不落盘任何文件", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef());
    await expectRejectCode(
      () => Promise.resolve().then(() => h.engine.checkpoint(KEY, { summary: "s", touchedFiles: [], nextStep: "n" }, "pi-1")),
      "E_NO_LEASE",
    );
    assert.deepEqual(readdirSync(h.handoffDir), [], "无租约不得写 checkpoint 文件");
  } finally {
    h.close();
  }
});

test("checkpoint: 文件名带 sanitize 后的 key + ISO 时间戳，内容含四个段落", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "idle" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    const checkpoint = h.engine.checkpoint(
      KEY,
      { summary: "把 auth 校验抽成函数", touchedFiles: ["src/auth.ts", "src/login.ts"], nextStep: "补单测" },
      "pi-1",
    );

    assert.equal(checkpoint.sessionKey, KEY);
    assert.equal(checkpoint.summary, "把 auth 校验抽成函数");
    assert.deepEqual(checkpoint.touchedFiles, ["src/auth.ts", "src/login.ts"]);
    assert.equal(checkpoint.nextStep, "补单测");
    assert.equal(checkpoint.transcriptCursor, "0", "无 transcript 时游标为 0");
    assert.equal(checkpoint.createdAt, new Date(START).toISOString());

    const files = readdirSync(h.handoffDir);
    assert.equal(files.length, 1);
    const name = files[0] ?? "";
    assert.match(name, /^claude-sess-1-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.md$/, "文件名口径：key-ISO.md");

    const text = readFileSync(join(h.handoffDir, name), "utf8");
    assert.ok(text.includes("## 摘要"), "缺 摘要 段");
    assert.ok(text.includes("把 auth 校验抽成函数"));
    assert.ok(text.includes("## 触碰文件"), "缺 触碰文件 段");
    assert.ok(text.includes("- src/auth.ts"));
    assert.ok(text.includes("- src/login.ts"));
    assert.ok(text.includes("## 下一步"), "缺 下一步 段");
    assert.ok(text.includes("补单测"));
    assert.ok(text.includes("## 游标"), "缺 游标 段");
  } finally {
    h.close();
  }
});

test("checkpoint: touchedFiles 为空写「（无）」，游标取 transcript 末尾", async () => {
  const h = fresh({
    readTranscript: (_path, cursor) => {
      if ((cursor ?? "0") === "0") {
        return { messages: [msg("m1", "assistant", "读到两句")], nextCursor: "120", pending: false };
      }
      return { messages: [], nextCursor: cursor ?? "120", pending: true };
    },
  });
  try {
    h.registry.upsert(makeRef({ status: "idle" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    const checkpoint = h.engine.checkpoint(KEY, { summary: "s", touchedFiles: [], nextStep: "n" }, "pi-1");

    assert.equal(checkpoint.transcriptCursor, "120");
    const files = readdirSync(h.handoffDir);
    const text = readFileSync(join(h.handoffDir, files[0] ?? ""), "utf8");
    assert.ok(text.includes("（无）"), "空触碰文件必须写（无）");
  } finally {
    h.close();
  }
});

test("handoff: 无租约 → E_NO_LEASE，cancel / close 均 0 次", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef());
    await expectRejectCode(() => h.engine.handoff(KEY, "human", "pi-1"), "E_NO_LEASE");
    assert.equal(h.fake.count("cancel"), 0);
    assert.equal(h.fake.count("close"), 0);
  } finally {
    h.close();
  }
});

test("handoff(interactive): 严格按序 cancel→checkpoint→close→租约转 human(30min)，命令为 --resume / resume-tui", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "running", kind: "interactive" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    const result = await h.engine.handoff(KEY, "human", "pi-1", {
      summary: "改到一半",
      touchedFiles: ["src/auth.ts"],
      nextStep: "接上继续写校验",
    });

    assert.deepEqual(result.command, ["claude", "--resume", "sess-1"]);
    assert.equal(result.mode, "resume-tui");
    assert.equal(result.checkpoint.summary, "改到一半");
    assert.deepEqual(h.fake.argsOf("cancel"), [["sess-1"]]);
    assert.deepEqual(h.fake.argsOf("waitForTurn"), [["sess-1"]]);
    assert.deepEqual(h.fake.argsOf("close"), [["sess-1"]]);

    const order = h.fake.calls.map((call) => call.method);
    assert.ok(order.indexOf("cancel") < order.indexOf("close"), "cancel 必须在 close 之前");

    const lease = h.leases.current(KEY);
    assert.ok(lease !== null, "handoff 后必须有租约");
    assert.equal(lease.driver, "human");
    assert.equal(lease.clientId, "handoff-pi-1");
    assert.equal(Date.parse(lease.expiresAt) - h.clock.now(), HUMAN_WINDOW_MS, "人类接管窗口 30 分钟");

    const ref = h.registry.get(KEY);
    assert.equal(ref?.driver, "human");
    assert.equal(ref?.status, "handoff");

    const stateUpdates = h.store.list(KEY).filter((event) => event.type === "state_update");
    assert.equal(stateUpdates.length, 1);
    const payload = stateUpdates[0]?.payload as Record<string, unknown> | undefined;
    assert.equal(payload?.["state"], "handoff");
    assert.equal(payload?.["driver"], "human");

    assert.equal(readdirSync(h.handoffDir).length, 1, "handoff 必须落一个 checkpoint 文件");
  } finally {
    h.close();
  }
});

test("handoff(background): 命令为 attach / attach 模式，idle 会话不 cancel", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "idle", kind: "background" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    const result = await h.engine.handoff(KEY, "human", "pi-1");

    assert.deepEqual(result.command, ["claude", "attach", "sess-1"]);
    assert.equal(result.mode, "attach");
    assert.equal(h.fake.count("cancel"), 0, "idle 会话无需 cancel");
    assert.equal(h.fake.count("close"), 1);
    const lease = h.leases.current(KEY);
    assert.equal(lease?.driver, "human");
    assert.equal(Date.parse(lease?.expiresAt ?? "") - h.clock.now(), HUMAN_WINDOW_MS);
  } finally {
    h.close();
  }
});

test("handback: resume 同一 nativeId + 从 checkpoint 游标起读 transcript 生成 deltaSummary", async () => {
  const seen: Array<string | undefined> = [];
  // 人类接管前 transcript 只到游标 120；接管后才多出人类的几条消息
  let humanPhase = false;
  const h = fresh({
    readTranscript: (_path, cursor) => {
      seen.push(cursor);
      if ((cursor ?? "0") === "0") {
        return { messages: [msg("m1", "assistant", "交人前的一轮")], nextCursor: "120", pending: false };
      }
      if (cursor === "120" && humanPhase) {
        return {
          messages: [msg("m9", "user", "我把 auth 改成抛错了"), msg("m10", "assistant", "收到，我来补 try/catch")],
          nextCursor: "400",
          pending: false,
        };
      }
      return { messages: [], nextCursor: cursor ?? "0", pending: true };
    },
  });
  try {
    h.registry.upsert(makeRef({ status: "running" }));
    h.leases.acquire(KEY, "pi", "pi-1");
    // 先把会话交给人：checkpoint 记录游标（第一页推进到 120）
    const handoff = await h.engine.handoff(KEY, "human", "pi-1", {
      summary: "交人",
      touchedFiles: [],
      nextStep: "人工改完交回",
    });
    assert.equal(handoff.checkpoint.transcriptCursor, "120");
    humanPhase = true;
    seen.length = 0;

    const result = await h.engine.handback(KEY, "handoff-pi-1");

    assert.equal(result.resumed, true);
    assert.deepEqual(h.fake.argsOf("resume"), [["sess-1", CWD]]);
    assert.deepEqual(seen, ["120"], "必须从 checkpoint 的游标继续读");
    assert.equal(result.deltaSummary, "user: 我把 auth 改成抛错了\nassistant: 收到，我来补 try/catch");

    const ref = h.registry.get(KEY);
    assert.equal(ref?.driver, "pi");
    assert.equal(ref?.status, "idle");
    const lease = h.leases.current(KEY);
    assert.equal(lease?.driver, "pi");
    assert.equal(lease?.clientId, "handback-handoff-pi-1");
  } finally {
    h.close();
  }
});

test("handback: resume 被拒 → E_RESUME_REJECTED，不改 driver/状态", async () => {
  const h = fresh({ resumeError: new Error("session busy") });
  try {
    h.registry.upsert(makeRef({ status: "handoff", driver: "human" }));
    h.leases.acquire(KEY, "human", "human-1");

    await expectRejectCode(() => h.engine.handback(KEY, "human-1"), "E_RESUME_REJECTED");
    assert.equal(h.registry.get(KEY)?.driver, "human");
    assert.equal(h.registry.get(KEY)?.status, "handoff");
  } finally {
    h.close();
  }
});

test("handback: 无租约 → E_NO_LEASE，resume 0 次", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "handoff", driver: "human" }));
    await expectRejectCode(() => h.engine.handback(KEY, "pi-1"), "E_NO_LEASE");
    assert.equal(h.fake.count("resume"), 0);
  } finally {
    h.close();
  }
});

test("see: 未知 key → E_SESSION_NOT_FOUND", () => {
  const h = fresh();
  try {
    let caught: unknown = null;
    try {
      h.engine.see("claude:ghost");
    } catch (err) {
      caught = err;
    }
    assert.ok(isWorkbenchError(caught), "预期 WorkbenchError");
    assert.equal(caught.code, "E_SESSION_NOT_FOUND");
  } finally {
    h.close();
  }
});

test("see: 没有 transcript 文件 → 空消息 + pending，游标回退到 after", () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef());
    const page = h.engine.see(KEY, "42");
    assert.deepEqual(page.messages, []);
    assert.equal(page.cursor, "42");
    assert.equal(page.pending, true);
  } finally {
    h.close();
  }
});

test("see: 透传 transcript 增量（messages / cursor / pending）", () => {
  const calls: Array<string | undefined> = [];
  const h = fresh({
    readTranscript: (_path, cursor) => {
      calls.push(cursor);
      return { messages: [msg("m1", "user", "hi")], nextCursor: "8", pending: false };
    },
  });
  try {
    h.registry.upsert(makeRef());
    const page = h.engine.see(KEY, "0");
    assert.deepEqual(calls, ["0"]);
    assert.equal(page.cursor, "8");
    assert.equal(page.pending, false);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0]?.text, "hi");
  } finally {
    h.close();
  }
});

test("dispatch: 首次创建会话（newSession + upsert + prompt，prompt 不阻塞回合）", async () => {
  const h = fresh();
  try {
    const ref = await h.engine.dispatch({
      agent: "claude",
      task: "把 auth 校验抽成函数",
      cwd: CWD,
      idempotencyKey: "idem-1",
    });

    assert.equal(ref.key, "claude:sess-new");
    assert.equal(ref.agent, "claude");
    assert.equal(ref.nativeId, "sess-new");
    assert.equal(ref.acpSessionId, "sess-new");
    assert.equal(ref.cwd, CWD);
    assert.equal(ref.status, "running");
    assert.equal(ref.driver, "pi");
    assert.equal(ref.kind, "interactive");
    assert.deepEqual(ref.capabilities, CLAUDE_CAPABILITIES);
    assert.equal(ref.transcriptPath, join(claudeProjectDir(CWD), "sess-new.jsonl"));

    assert.deepEqual(h.fake.argsOf("newSession"), [[CWD]]);
    assert.deepEqual(h.fake.argsOf("prompt"), [["sess-new", "把 auth 校验抽成函数"]]);
    assert.deepEqual(h.registry.get("claude:sess-new"), ref);
  } finally {
    h.close();
  }
});

test("dispatch: 同 idempotencyKey 两次 → 同一 ref，newSession 只调 1 次", async () => {
  const h = fresh();
  try {
    const input = { agent: "claude" as const, task: "查一下测试", cwd: CWD, idempotencyKey: "idem-2" };
    const first = await h.engine.dispatch(input);
    const second = await h.engine.dispatch(input);

    assert.deepEqual(second, first);
    assert.equal(h.fake.count("newSession"), 1, "幂等命中不得再起会话");
    assert.equal(h.fake.count("prompt"), 1, "幂等命中不得重复投递");
  } finally {
    h.close();
  }
});

test("dispatch: 同 key 不同 task → E_IDEMPOTENCY_CONFLICT，不再建会话", async () => {
  const h = fresh();
  try {
    await h.engine.dispatch({ agent: "claude", task: "任务 A", cwd: CWD, idempotencyKey: "idem-3" });
    await expectRejectCode(
      () => h.engine.dispatch({ agent: "claude", task: "任务 B", cwd: CWD, idempotencyKey: "idem-3" }),
      "E_IDEMPOTENCY_CONFLICT",
    );
    assert.equal(h.fake.count("newSession"), 1);
  } finally {
    h.close();
  }
});

test("dispatch: agent !== claude → E_BAD_REQUEST，newSession 0 次", async () => {
  const h = fresh();
  try {
    await expectRejectCode(
      () => h.engine.dispatch({ agent: "codex", task: "x", cwd: CWD, idempotencyKey: "idem-4" }),
      "E_BAD_REQUEST",
    );
    assert.equal(h.fake.count("newSession"), 0);
  } finally {
    h.close();
  }
});

test("dispatch: task / idempotencyKey 为空 → E_BAD_REQUEST", async () => {
  const h = fresh();
  try {
    await expectRejectCode(
      () => h.engine.dispatch({ agent: "claude", task: "  ", cwd: CWD, idempotencyKey: "idem-5" }),
      "E_BAD_REQUEST",
    );
    await expectRejectCode(
      () => h.engine.dispatch({ agent: "claude", task: "x", cwd: CWD, idempotencyKey: "" }),
      "E_BAD_REQUEST",
    );
    assert.equal(h.fake.count("newSession"), 0);
  } finally {
    h.close();
  }
});

// ---------- 评审修复 round 1：C1 / C2 / C3 / I4 / M5 / M6 ----------

test("dispatch: 并发两次同 key → 同一 key，newSession 只 1 次，dispatches 只 1 行（C2）", async () => {
  const h = fresh();
  try {
    const input = { agent: "claude" as const, task: "并发派发一次", cwd: CWD, idempotencyKey: "idem-race" };
    const [a, b] = await Promise.all([h.engine.dispatch(input), h.engine.dispatch(input)]);

    assert.equal(a.key, "claude:sess-new");
    assert.equal(b.key, a.key, "并发两次必须落到同一个会话");
    assert.deepEqual(b, a);
    assert.equal(h.fake.count("newSession"), 1, "原子占位保证只起一个会话");
    assert.equal(h.fake.count("prompt"), 1, "任务只投递一次");
    assert.equal(countRows(h.db, "dispatches"), 1);
  } finally {
    h.close();
  }
});

test("dispatch: 真重启（全新 store/registry/leases + loadFromDb）同 key 同 payload → 同一会话，newSession 仍为 1（C2 / round 2）", async () => {
  const h = fresh();
  try {
    const input = { agent: "claude" as const, task: "重启后幂等", cwd: CWD, idempotencyKey: "idem-restart" };
    const first = await h.engine.dispatch(input);

    // 真重启：内存全空，只有 sessions 表 + loadFromDb 能把会话带回来
    const after = restart(h);
    assert.notEqual(
      after.registry.get(first.key),
      null,
      "loadFromDb 必须把会话水合回内存，否则幂等命中会报 E_SESSION_NOT_FOUND",
    );

    const second = await after.engine.dispatch(input);

    assert.deepEqual(second, first, "重启后必须返回同一个 SessionRef");
    assert.equal(h.fake.count("newSession"), 1, "库里已 done 的幂等键不得再起会话");
    assert.equal(h.fake.count("prompt"), 1, "重启后的幂等命中不得重复投递任务");
    assert.equal(countRows(h.db, "dispatches"), 1);
  } finally {
    h.close();
  }
});

test("dispatch: newSession 失败 → 落 failed 记录 + E_ADAPTER_DOWN，重试同键仍报 E_ADAPTER_DOWN（C1）", async () => {
  const h = fresh({ newSessionError: new Error("spawn claude ENOENT") });
  try {
    const input = { agent: "claude" as const, task: "必然失败", cwd: CWD, idempotencyKey: "idem-fail" };
    await expectRejectCode(() => h.engine.dispatch(input), "E_ADAPTER_DOWN");

    const record = h.dispatches.get("idem-fail");
    assert.equal(record?.status, "failed", "失败必须落库，不能停在 reserved");
    assert.ok((record?.error ?? "").includes("ENOENT"), "失败原因要落库：" + String(record?.error));

    await expectRejectCode(() => h.engine.dispatch(input), "E_ADAPTER_DOWN");
    assert.equal(h.fake.count("newSession"), 1, "failed 记录不能让重试又起一个会话");
  } finally {
    h.close();
  }
});

test("checkpoint: 落库（checkpoints 表 1 行，latest 与返回值一致）（C3）", () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "idle" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    const checkpoint = h.engine.checkpoint(
      KEY,
      { summary: "落库检查", touchedFiles: ["src/a.ts"], nextStep: "补单测" },
      "pi-1",
    );

    assert.equal(countRows(h.db, "checkpoints"), 1, "checkpoint 必须落库");
    const latest = h.checkpoints.latest(KEY);
    assert.ok(latest !== null, "latest 必须能读到");
    assert.equal(latest.sessionKey, KEY);
    assert.equal(latest.summary, "落库检查");
    assert.deepEqual(latest.touchedFiles, ["src/a.ts"]);
    assert.equal(latest.nextStep, "补单测");
    assert.equal(latest.transcriptCursor, checkpoint.transcriptCursor);
    assert.equal(latest.createdAt, checkpoint.createdAt);
    assert.match(latest.path, /pi-handoffs-[^\\/]+[\\/]claude-sess-1-[^\\/]+\.md$/, "库里存的是 Markdown 绝对路径");
  } finally {
    h.close();
  }
});

test("handback: 真重启（全新 store/registry/leases + loadFromDb）仍用库里 checkpoint 的游标读增量，不报 E_SESSION_NOT_FOUND（C3 / round 2）", async () => {
  let humanPhase = false;
  const reader: TranscriptReader = (_path, cursor) => {
    if ((cursor ?? "0") === "0") {
      return { messages: [msg("m1", "assistant", "交人前的一轮")], nextCursor: "120", pending: false };
    }
    if (cursor === "120" && humanPhase) {
      return { messages: [msg("m9", "user", "我把 auth 改成抛错了")], nextCursor: "400", pending: false };
    }
    return { messages: [], nextCursor: cursor ?? "0", pending: true };
  };
  const h = fresh({ readTranscript: reader });
  try {
    h.registry.upsert(makeRef({ status: "running" }));
    h.leases.acquire(KEY, "pi", "pi-1");
    const handoff = await h.engine.handoff(KEY, "human", "pi-1", {
      summary: "交人",
      touchedFiles: [],
      nextStep: "人工改完交回",
    });
    assert.equal(handoff.checkpoint.transcriptCursor, "120");
    assert.equal(countRows(h.db, "checkpoints"), 1, "handoff 的 checkpoint 必须落库");

    humanPhase = true;
    // 真重启：内存里没有会话、没有 checkpoint、没有租约对象，只能靠库 + loadFromDb
    const after = restart(h, reader);
    assert.notEqual(
      after.registry.get(KEY),
      null,
      "loadFromDb 必须先水合会话，否则 handback 会在 #requireSession 报 E_SESSION_NOT_FOUND",
    );

    const result = await after.engine.handback(KEY, "handoff-pi-1");

    assert.equal(result.resumed, true, "重启后 handback 必须成功");
    assert.equal(result.deltaSummary, "user: 我把 auth 改成抛错了", "必须从库里 checkpoint 的游标起读");
    assert.equal(after.registry.get(KEY)?.driver, "pi");
    assert.equal(after.leases.current(KEY)?.clientId, "handback-handoff-pi-1", "租约转回 pi 并落库");
  } finally {
    h.close();
  }
});

test("handoff: close 失败 → 写 error 事件 + 状态回 idle + 抛 E_ADAPTER_DOWN（I4）", async () => {
  const h = fresh({ closeError: new Error("close 时 IPC 已断开") });
  try {
    h.registry.upsert(makeRef({ status: "running" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    await expectRejectCode(() => h.engine.handoff(KEY, "human", "pi-1"), "E_ADAPTER_DOWN");

    const errors = h.store.list(KEY).filter((event) => event.type === "error");
    assert.equal(errors.length, 1, "失败必须留一条 error 事件");
    const payload = errors[0]?.payload as Record<string, unknown> | undefined;
    assert.ok(String(payload?.["message"] ?? "").includes("IPC 已断开"), "error 事件要带原因：" + String(payload?.["message"]));

    assert.equal(h.registry.get(KEY)?.status, "idle", "失败后状态必须回到 idle，不能停在 running");
    assert.equal(h.registry.get(KEY)?.driver, "pi", "失败后 driver 不得改成 human");
    const lease = h.leases.current(KEY);
    assert.equal(lease?.driver, "pi", "租约仍在原客户端手里");
    assert.equal(lease?.clientId, "pi-1");
  } finally {
    h.close();
  }
});

test("handoff: cancel 失败 → error 事件 + idle + E_ADAPTER_DOWN，且不再调用 close（I4）", async () => {
  const h = fresh({ cancelError: new Error("cancel 失败：session 已消失") });
  try {
    h.registry.upsert(makeRef({ status: "running" }));
    h.leases.acquire(KEY, "pi", "pi-1");

    await expectRejectCode(() => h.engine.handoff(KEY, "human", "pi-1"), "E_ADAPTER_DOWN");

    const errors = h.store.list(KEY).filter((event) => event.type === "error");
    assert.equal(errors.length, 1);
    assert.equal(h.registry.get(KEY)?.status, "idle");
    assert.equal(h.fake.count("close"), 0, "cancel 失败后不应继续 close");
  } finally {
    h.close();
  }
});

test("see: reader 报 pending 且 0 条消息 → 游标保持 after，不回退成 0（M5）", () => {
  const h = fresh({
    readTranscript: (_path, _cursor) => ({ messages: [], nextCursor: "0", pending: true }),
  });
  try {
    h.registry.upsert(makeRef());
    const page = h.engine.see(KEY, "42");

    assert.deepEqual(page.messages, []);
    assert.equal(page.cursor, "42", "pending 且无消息时游标不得倒退");
    assert.equal(page.pending, true);
  } finally {
    h.close();
  }
});

test("dispatch: 会话进入 running 时除 notice 还写一条 state_update（M6）", async () => {
  const h = fresh();
  try {
    const ref = await h.engine.dispatch({
      agent: "claude",
      task: "M6 事件口径",
      cwd: CWD,
      idempotencyKey: "idem-m6",
    });

    const events = h.store.list(ref.key);
    const notices = events.filter((event) => {
      const payload = event.payload as Record<string, unknown> | null;
      return event.type === "notice" && payload?.["kind"] === "dispatch";
    });
    assert.equal(notices.length, 1, "notice + payload.kind=dispatch 保留");

    const stateUpdates = events.filter((event) => event.type === "state_update");
    assert.equal(stateUpdates.length, 1, "按状态分发的消费者需要 state_update");
    const payload = stateUpdates[0]?.payload as Record<string, unknown> | undefined;
    assert.equal(payload?.["state"], "running");
  } finally {
    h.close();
  }
});

// ---------- 评审修复 round 2：真重启覆盖 / upsert 失败回收 / cwd 口径 ----------

test("dispatch: registry.upsert 失败 → 回收 adapter 会话（close 1 次）+ dispatches 落 failed（round 2）", async () => {
  const h = fresh();
  try {
    // 模拟「会话落库失败」（sessions 表不可写），此时 newSession 已经成功
    h.registry.upsert = (_ref: SessionRef): void => {
      throw new Error("写入 sessions 表失败");
    };

    const input = { agent: "claude" as const, task: "落库必然失败", cwd: CWD, idempotencyKey: "idem-upsert-fail" };
    await expectRejectCode(() => h.engine.dispatch(input), "E_ADAPTER_DOWN");

    assert.deepEqual(h.fake.argsOf("close"), [["sess-new"]], "必须回收刚起的那一个 adapter 会话");
    assert.equal(h.fake.count("close"), 1, "回收只做一次");

    const record = h.dispatches.get("idem-upsert-fail");
    assert.equal(record?.status, "failed", "幂等键不能永远停在 reserved");
    assert.ok((record?.error ?? "").includes("写入 sessions 表失败"), "失败原因要落库：" + String(record?.error));

    await expectRejectCode(() => h.engine.dispatch(input), "E_ADAPTER_DOWN");
    assert.equal(h.fake.count("newSession"), 1, "failed 记录不能让重试又起一个会话");
  } finally {
    h.close();
  }
});

test("dispatch: 省略 cwd 与显式传同一个 cwd 等价（同 hash，不报 E_IDEMPOTENCY_CONFLICT）（round 2）", async () => {
  const h = fresh();
  try {
    const here = process.cwd();
    const first = await h.engine.dispatch({ agent: "claude", task: "cwd 口径", idempotencyKey: "idem-cwd" });
    const second = await h.engine.dispatch({
      agent: "claude",
      task: "cwd 口径",
      cwd: here,
      idempotencyKey: "idem-cwd",
    });

    assert.equal(first.cwd, here, "省略 cwd 时解析成 process.cwd()");
    assert.deepEqual(second, first, "显式传同一个 cwd 必须命中同一会话");
    assert.equal(h.fake.count("newSession"), 1);
    assert.deepEqual(h.fake.argsOf("newSession"), [[here]]);
  } finally {
    h.close();
  }
});
