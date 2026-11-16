import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { AgentRouter } from "../src/agents/router.ts";
import type { AgentDriver } from "../src/agents/types.ts";
import { STATUS_BY_CODE } from "../src/server.ts";
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
  opts: {
    resumeError?: Error;
    closeError?: Error;
    cancelError?: Error;
    newSessionError?: Error;
    newSessionErrorTimes?: number;
    onNewSession?: () => void | Promise<void>;
    newSessionGate?: Promise<void>;
    newSessionIds?: string[];
  } = {},
): Fake {
  let newSessionFailuresLeft =
    opts.newSessionError === undefined ? 0 : (opts.newSessionErrorTimes ?? Number.POSITIVE_INFINITY);
  let newSessionSeq = 0;
  const calls: Call[] = [];
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };

  const adapter: AgentAdapter = {
    newSession: async (cwd: string) => {
      record("newSession", [cwd]);
      await opts.onNewSession?.();
      if (opts.newSessionGate !== undefined) {
        await opts.newSessionGate;
      }
      if (opts.newSessionError !== undefined && newSessionFailuresLeft > 0) {
        newSessionFailuresLeft -= 1;
        throw opts.newSessionError;
      }
      const sessionId = opts.newSessionIds?.[newSessionSeq] ?? "sess-new";
      newSessionSeq += 1;
      return { sessionId };
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
  newSessionErrorTimes?: number;
  onNewSession?: () => void | Promise<void>;
  newSessionGate?: Promise<void>;
  newSessionIds?: string[];
  dispatchReservedTtlMs?: number;
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
    dispatchReservedTtlMs: opts.dispatchReservedTtlMs ?? 120_000,
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

function dispatchHash(agent: string, task: string, cwd: string): string {
  return createHash("sha256").update(JSON.stringify({ agent, task, cwd })).digest("hex");
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
    assert.equal(lease?.clientId, "pi-1", "handback 后租约剥掉 handoff- 前缀，回到 pi 侧身份");
  } finally {
    h.close();
  }
});

test("handback: Pi 用自身 clientId（不带 handoff- 前缀）也能交回（I4）", async () => {
  // 评审 I4：handoff 建的租约是 "handoff-pi-1"，Pi 扩展 handback 发的是自己的 "pi-1"。
  // 修复前 assertWriter 直接比 clientId → E_NO_LEASE，cp_handback 永远失败。
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "running" }));
    h.leases.acquire(KEY, "pi", "pi-1");
    await h.engine.handoff(KEY, "human", "pi-1", { summary: "交人", touchedFiles: [], nextStep: "" });
    assert.equal(h.leases.current(KEY)?.clientId, "handoff-pi-1", "人类租约带派生前缀");

    const result = await h.engine.handback(KEY, "pi-1");

    assert.equal(result.resumed, true);
    const lease = h.leases.current(KEY);
    assert.equal(lease?.driver, "pi");
    assert.equal(lease?.clientId, "pi-1", "交回后租约回到 Pi 自身身份");
  } finally {
    h.close();
  }
});

test("handback: 非租约持有人（含错误的 handoff- 前缀）→ E_LEASE_CONFLICT，resume 0 次（I4 防越权）", async () => {
  const h = fresh();
  try {
    h.registry.upsert(makeRef({ status: "running" }));
    h.leases.acquire(KEY, "pi", "pi-1");
    await h.engine.handoff(KEY, "human", "pi-1", { summary: "交人", touchedFiles: [], nextStep: "" });

    // 写操作语义：不是租约持有人 → E_NO_LEASE（spec 里 E_LEASE_CONFLICT 留给"租约被别人占着"的 acquire 冲突）
    await expectRejectCode(() => h.engine.handback(KEY, "pi-999"), "E_NO_LEASE");
    assert.equal(h.fake.count("resume"), 0);
    assert.equal(h.leases.current(KEY)?.clientId, "handoff-pi-1", "租约不被错误调用劫持");
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

test("dispatch: newSession 失败 → failed；同键重试原子转 reserved 后重新执行（C02 fix）", async () => {
  const h = fresh({ newSessionError: new Error("spawn claude ENOENT"), newSessionErrorTimes: 1 });
  try {
    const input = { agent: "claude" as const, task: "首次失败，重试成功", cwd: CWD, idempotencyKey: "idem-fail" };
    await expectRejectCode(() => h.engine.dispatch(input), "E_ADAPTER_DOWN");

    const failed = h.dispatches.get("idem-fail");
    assert.equal(failed?.status, "failed", "失败必须落库，不能停在 reserved");
    assert.ok((failed?.error ?? "").includes("ENOENT"), "失败原因要落库：" + String(failed?.error));

    const retried = await h.engine.dispatch(input);
    assert.equal(retried.key, "claude:sess-new");
    assert.equal(h.fake.count("newSession"), 2, "failed + 同 payload 必须重新执行一次");
    const record = h.dispatches.get("idem-fail");
    assert.equal(record?.status, "done", "重试成功后必须落 done");
    assert.equal(record?.error, null, "重试成功必须清掉旧错误");
  } finally {
    h.close();
  }
});

test("dispatch: 同一 key 并发 3 次只有 1 个会话（C02）", async () => {
  const h = fresh();
  try {
    const input = { agent: "claude" as const, task: "并发派发三次", cwd: CWD, idempotencyKey: "idem-race-3" };
    const refs = await Promise.all([h.engine.dispatch(input), h.engine.dispatch(input), h.engine.dispatch(input)]);

    assert.equal(new Set(refs.map((ref) => ref.key)).size, 1, "3 个响应必须是同一个会话");
    assert.deepEqual(refs[1], refs[0]);
    assert.deepEqual(refs[2], refs[0]);
    assert.equal(h.fake.count("newSession"), 1, "原子占位保证只起一个会话");
    assert.equal(h.registry.list().length, 1, "注册表里只应有一条会话");
    assert.equal(countRows(h.db, "dispatches"), 1);
  } finally {
    h.close();
  }
});

test("dispatch: reserved 超 TTL 后回收并重建会话，sessions.dispatch_key = key（C02）", async () => {
  const h = fresh();
  try {
    const input = { agent: "claude" as const, task: "回收超时预留", cwd: CWD, idempotencyKey: "idem-reclaim" };
    h.dispatches.reserve(
      input.idempotencyKey,
      dispatchHash(input.agent, input.task, input.cwd),
      new Date(h.clock.now() - 120_000),
    );

    const ref = await h.engine.dispatch(input);

    assert.equal(ref.key, "claude:sess-new");
    assert.equal(h.fake.count("newSession"), 1, "回收后由本调用重新建会话");
    const row = h.db.prepare("SELECT dispatch_key FROM sessions WHERE key = ?").get(ref.key) as
      | { dispatch_key?: string | null }
      | undefined;
    assert.equal(row?.dispatch_key, input.idempotencyKey, "新会话必须写入 dispatch_key");
    assert.equal(h.dispatches.get(input.idempotencyKey)?.status, "done");
  } finally {
    h.close();
  }
});

test("dispatch: 慢 newSession 由 TTL/3 心跳续约，其他调用不会回收重建（C02 fix）", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const h = fresh({
    dispatchReservedTtlMs: 60,
    newSessionGate: gate,
    onNewSession: () => {
      entered();
    },
  });
  try {
    const input = { agent: "claude" as const, task: "慢会话", cwd: CWD, idempotencyKey: "idem-slow" };
    const first = h.engine.dispatch(input);
    await enteredPromise;

    // 固定时钟跨过 TTL，再等心跳周期；没有 touch 的话第二次调用会 reclaim 并二次 newSession
    h.clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = h.engine.dispatch(input);

    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(h.fake.count("newSession"), 1, "心跳续约后不得被回收重建");
    assert.equal(h.dispatches.get(input.idempotencyKey)?.status, "done");
  } finally {
    release();
    h.close();
  }
});

test("dispatch: reserved 未超 TTL → 轮询耗尽 E_DISPATCH_IN_PROGRESS（409，C02）", async () => {
  const h = fresh();
  try {
    const input = { agent: "claude" as const, task: "等待超时", cwd: CWD, idempotencyKey: "idem-busy" };
    h.dispatches.reserve(
      input.idempotencyKey,
      dispatchHash(input.agent, input.task, input.cwd),
      new Date(h.clock.now()),
    );

    await expectRejectCode(() => h.engine.dispatch(input), "E_DISPATCH_IN_PROGRESS");
    assert.equal(STATUS_BY_CODE.E_DISPATCH_IN_PROGRESS, 409);
    assert.equal(h.fake.count("newSession"), 0, "轮询超时不得抢跑 newSession");
  } finally {
    h.close();
  }
});

test("dispatch: 两个并发调用同时回收超时预留，只有一个 newSession（C02 fix）", async () => {
  const h = fresh();
  try {
    const input = { agent: "claude" as const, task: "并发回收", cwd: CWD, idempotencyKey: "idem-reclaim-race" };
    h.dispatches.reserve(
      input.idempotencyKey,
      dispatchHash(input.agent, input.task, input.cwd),
      new Date(h.clock.now() - 120_000),
    );

    const [a, b] = await Promise.all([h.engine.dispatch(input), h.engine.dispatch(input)]);
    assert.equal(a.key, b.key);
    assert.equal(h.fake.count("newSession"), 1, "原子 reclaim 只能有一个赢家");
    assert.equal(h.registry.list().length, 1);
    assert.equal(h.dispatches.get(input.idempotencyKey)?.status, "done");
  } finally {
    h.close();
  }
});

test("dispatch: pruneRetained 清理幂等记录时同步清 sessions.dispatch_key，24h 后可复用同 key（C02 fix）", async () => {
  const h = fresh({ newSessionIds: ["sess-prune-1", "sess-prune-2"] });
  try {
    const input = { agent: "claude" as const, task: "prune 后复用", cwd: CWD, idempotencyKey: "idem-prune" };
    const first = await h.engine.dispatch(input);
    assert.equal(first.key, "claude:sess-prune-1");
    const before = h.db.prepare("SELECT dispatch_key FROM sessions WHERE key = ?").get(first.key) as
      | { dispatch_key?: string | null }
      | undefined;
    assert.equal(before?.dispatch_key, input.idempotencyKey);

    h.clock.advance(24 * 3600_000 + 1000);
    assert.equal(h.dispatches.pruneRetained(24 * 3600_000, new Date(h.clock.now())), 1);
    const cleared = h.db.prepare("SELECT dispatch_key FROM sessions WHERE key = ?").get(first.key) as
      | { dispatch_key?: string | null }
      | undefined;
    assert.equal(cleared?.dispatch_key, null, "prune 必须在同一事务清掉 sessions.dispatch_key");

    const second = await h.engine.dispatch(input);
    assert.equal(second.key, "claude:sess-prune-2", "24h 后同 key 必须能重新建会话");
    assert.equal(h.fake.count("newSession"), 2);
    const after = h.db.prepare("SELECT dispatch_key FROM sessions WHERE key = ?").get(second.key) as
      | { dispatch_key?: string | null }
      | undefined;
    assert.equal(after?.dispatch_key, input.idempotencyKey);
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
    assert.equal(after.leases.current(KEY)?.clientId, "pi-1", "租约剥掉 handoff- 前缀后回到 pi 侧身份");
    // 回归：handback 后控制权在 pi 手里，调用方用同一个 clientId 必须能直接写（旧实现挂在
    // "handback-<id>" 上，这一句会 E_NO_LEASE）
    const injected = await after.engine.inject(KEY, "接着把测试补上", "pi-1");
    assert.equal(injected.effective, "now", "handback 后 pi 侧原 clientId 直接持有租约，可继续 inject");
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
    assert.equal(h.fake.count("newSession"), 2, "failed + 同 payload 的重试会重新 newSession 一次");
  } finally {
    h.close();
  }
});

test("dispatch: complete 抛错 → 回收 adapter 会话 + 会话行回 idle + dispatches 落 failed（round 3 / N1）", async () => {
  const h = fresh();
  try {
    // 让「标 done」这一步抛错：此时 registry.upsert 已经成功，会话行与内存都已经落库
    h.dispatches.complete = (): boolean => {
      throw new Error("写 dispatches 表失败");
    };

    const input = {
      agent: "claude" as const,
      task: "落库成功、标记失败",
      cwd: CWD,
      idempotencyKey: "idem-complete-fail",
    };
    await expectRejectCode(() => h.engine.dispatch(input), "E_ADAPTER_DOWN");

    assert.deepEqual(h.fake.argsOf("close"), [["sess-new"]], "必须回收刚起的那一个 adapter 会话");
    assert.equal(h.fake.count("close"), 1, "回收只做一次");

    // 会话不能停在 running 指向一个已经关闭的 adapter 会话（僵尸行）
    assert.equal(h.registry.get("claude:sess-new")?.status, "idle", "内存态必须回 idle");
    const row = h.db.prepare("SELECT status FROM sessions WHERE key = ?").get("claude:sess-new") as
      | { status?: string }
      | undefined;
    assert.equal(row?.status, "idle", "sessions 表也必须回 idle");

    const record = h.dispatches.get("idem-complete-fail");
    assert.equal(record?.status, "failed", "幂等键不能停在 reserved");
    assert.equal(record?.sessionKey, null, "fail 会把 session_key 置空");
    assert.ok((record?.error ?? "").includes("写 dispatches 表失败"), "失败原因要落库：" + String(record?.error));
  } finally {
    h.close();
  }
});

test("dispatch: complete 抛错后清 sessions.dispatch_key，同 key 重试可建新会话（C02 fix）", async () => {
  const h = fresh({ newSessionIds: ["sess-complete-old", "sess-complete-new"] });
  try {
    const originalComplete = h.dispatches.complete.bind(h.dispatches);
    let first = true;
    h.dispatches.complete = (idempotencyKey, sessionKey, now): boolean => {
      if (first) {
        first = false;
        throw new Error("写 dispatches 表失败");
      }
      return originalComplete(idempotencyKey, sessionKey, now);
    };

    const input = { agent: "claude" as const, task: "complete 失败后重试", cwd: CWD, idempotencyKey: "idem-complete-retry" };
    await expectRejectCode(() => h.engine.dispatch(input), "E_ADAPTER_DOWN");
    const oldKey = "claude:sess-complete-old";
    const oldRow = h.db.prepare("SELECT dispatch_key FROM sessions WHERE key = ?").get(oldKey) as
      | { dispatch_key?: string | null }
      | undefined;
    assert.equal(oldRow?.dispatch_key, null, "失败回收必须清掉旧会话的 dispatch_key");

    const retried = await h.engine.dispatch(input);
    assert.equal(retried.key, "claude:sess-complete-new", "同 key 重试不得被旧 dispatch_key 的唯一索引挡住");
    assert.equal(h.fake.count("newSession"), 2);
    assert.equal(h.dispatches.get(input.idempotencyKey)?.status, "done");
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

// ---------- r5：P2-1 transcriptPath 缓存的并发 / 时间窗语义 ----------

function makeCodexRef(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    key: "codex:sess-1",
    agent: "codex",
    nativeId: "sess-1",
    cwd: CWD,
    status: "idle",
    driver: "pi",
    capabilities: { ...CLAUDE_CAPABILITIES, permissions: false },
    kind: "interactive",
    ...overrides,
  };
}

type RefreshHarness = {
  engine: TakeoverEngine;
  registry: SessionRegistry;
  clock: Clock;
  driver: AgentDriver & { resolveTranscriptPath: (ref: SessionRef) => Promise<string | undefined> };
  calls: () => number;
  close: () => void;
};

/** 只构造 refreshTranscriptPath 所需的引擎；不启动任何 adapter 子进程。 */
function makeRefreshHarness(): RefreshHarness {
  const db = openDb(":memory:");
  migrate(db);
  const clock = makeClock();
  const registry = new SessionRegistry(db);
  const handoffDir = mkdtempSync(join(tmpdir(), "pi-refresh-"));
  let calls = 0;

  const driver: AgentDriver & { resolveTranscriptPath: (ref: SessionRef) => Promise<string | undefined> } = {
    agent: "codex",
    caps: { ...CLAUDE_CAPABILITIES, permissions: false },
    discover: async () => [],
    attach: async () => {},
    inject: async () => ({ messageId: "msg-refresh", effective: "now" }),
    interrupt: async () => ({ stopReason: "cancelled" }),
    resume: async () => {},
    handoff: async () => ({ command: ["codex"], mode: "attach" }),
    onUpdate: (_cb: (update: AdapterUpdate) => void) => () => {},
    dispose: async () => {},
    resolveTranscriptPath: async () => {
      calls += 1;
      return undefined;
    },
  };

  const router = new AgentRouter();
  router.register(driver);
  const engine = new TakeoverEngine({
    store: new EventStore(db),
    leases: new LeaseManager(db, { now: clock.now }),
    registry,
    adapter: makeFake().adapter,
    router,
    checkpoints: new CheckpointStore(db),
    dispatches: new DispatchStore(db),
    handoffDir,
    now: clock.now,
    readTranscript: emptyReader,
  });

  return {
    engine,
    registry,
    clock,
    driver,
    calls: () => calls,
    close: () => {
      db.close();
      rmSync(handoffDir, { recursive: true, force: true });
    },
  };
}

test("refreshTranscriptPath: 同一 key 并发解析只调用 driver 一次（single-flight）", async () => {
  const h = makeRefreshHarness();
  try {
    h.registry.upsert(makeCodexRef());
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    h.driver.resolveTranscriptPath = async () => {
      calls += 1;
      return gate;
    };

    const first = h.engine.refreshTranscriptPath("codex:sess-1");
    const second = h.engine.refreshTranscriptPath("codex:sess-1");
    assert.equal(calls, 1, "并发第二次应复用第一次的 Promise");
    release("C:\\rollout.jsonl");
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, "C:\\rollout.jsonl");
    assert.equal(b, "C:\\rollout.jsonl");
    assert.equal(h.registry.get("codex:sess-1")?.transcriptPath, "C:\\rollout.jsonl");
  } finally {
    h.close();
  }
});

test("refreshTranscriptPath: idle 解析失败负缓存 30s，过期后重试", async () => {
  const h = makeRefreshHarness();
  try {
    h.registry.upsert(makeCodexRef({ status: "idle" }));

    assert.equal(await h.engine.refreshTranscriptPath("codex:sess-1"), undefined);
    assert.equal(h.calls(), 1);
    assert.equal(await h.engine.refreshTranscriptPath("codex:sess-1"), undefined);
    assert.equal(h.calls(), 1, "30s 窗口内不应再次扫描");

    h.clock.advance(30_000);
    assert.equal(await h.engine.refreshTranscriptPath("codex:sess-1"), undefined);
    assert.equal(h.calls(), 2, "窗口过期后必须重新尝试");
  } finally {
    h.close();
  }
});

test("refreshTranscriptPath: running 解析失败不缓存，下一次立即重试", async () => {
  const h = makeRefreshHarness();
  try {
    h.registry.upsert(makeCodexRef({ status: "running" }));

    assert.equal(await h.engine.refreshTranscriptPath("codex:sess-1"), undefined);
    assert.equal(h.calls(), 1);
    assert.equal(await h.engine.refreshTranscriptPath("codex:sess-1"), undefined);
    assert.equal(h.calls(), 2, "running 的新 rollout 不能因一次 miss 被缓存");
  } finally {
    h.close();
  }
});
