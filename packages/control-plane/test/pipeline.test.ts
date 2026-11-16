/**
 * 事件归一化管线（A06）测试：口径见 task-6-brief 的 Controller 裁定 R15–R20。
 * 全离线：假 adapter 直接实现 `AgentAdapter`（比 fixtures/fake-acp-agent.mjs 轻，不拉子进程）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { SessionEvent, SessionRef } from "@pi-workbench/shared";

import type { AdapterUpdate, AdapterUpdateKind, AgentAdapter } from "../src/adapters/types.ts";
import { migrate, openDb } from "../src/db.ts";
import { EventStore, type NewEvent } from "../src/events.ts";
import { EventPipeline, type PipelineLogger } from "../src/pipeline.ts";
import { SessionRegistry } from "../src/registry.ts";
import type { UnifiedMessage } from "../src/transcript/claude.ts";

const CAPS: SessionRef["capabilities"] = {
  stream: true,
  inject: true,
  interrupt: true,
  attach: false,
  resume: true,
  transcript: true,
  permissions: true,
  background: false,
};

function makeRef(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    key: "claude:sess-1",
    agent: "claude",
    nativeId: "sess-1",
    cwd: "E:\\pi-workbench\\spike\\a00-workspace",
    status: "running",
    driver: "none",
    capabilities: CAPS,
    kind: "interactive",
    ...overrides,
  };
}

/** 假 adapter：只保留 onUpdate 语义，其它方法空实现 */
type FakeAdapter = AgentAdapter & {
  emit(update: AdapterUpdate): void;
  listenerCount(): number;
};

function makeAdapter(): FakeAdapter {
  const listeners = new Set<(update: AdapterUpdate) => void>();
  return {
    newSession: async (_cwd: string) => ({ sessionId: "acp-1" }),
    resume: async (_sessionId: string, _cwd: string) => {},
    prompt: async (_sessionId: string, _text: string) => ({ messageId: "m-sent" }),
    cancel: async (_sessionId: string) => ({ stopReason: "cancelled" }),
    close: async (_sessionId: string) => {},
    onUpdate: (cb: (update: AdapterUpdate) => void): (() => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose: async () => {
      listeners.clear();
    },
    emit: (update: AdapterUpdate): void => {
      for (const listener of [...listeners]) {
        listener(update);
      }
    },
    listenerCount: (): number => listeners.size,
  };
}

type Harness = {
  db: DatabaseSync;
  store: EventStore;
  registry: SessionRegistry;
  pipeline: EventPipeline;
  adapter: FakeAdapter;
  logs: string[];
  close(): void;
};

function makeHarness(options: { seed?: Partial<SessionRef>[] } = {}): Harness {
  const db = openDb(":memory:");
  migrate(db);
  const store = new EventStore(db);
  const registry = new SessionRegistry(db);
  const logs: string[] = [];
  const logger: PipelineLogger = {
    debug: (message) => logs.push(message),
    error: (message) => logs.push(message),
  };
  for (const seed of options.seed ?? [{ key: "claude:sess-1" }]) {
    registry.upsert(makeRef(seed));
  }
  return {
    db,
    store,
    registry,
    pipeline: new EventPipeline(store, registry, logger),
    adapter: makeAdapter(),
    logs,
    close: () => {
      db.close();
    },
  };
}

function eventCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  return Number(row.n);
}

function transcriptMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: "msg-1",
    role: "assistant",
    kind: "text",
    text: "hello",
    ts: "2026-11-14T10:00:00.000Z",
    ...overrides,
  };
}

test("attach: 3 条 update → seq 单调递增且全部落到该会话", () => {
  const h = makeHarness();
  try {
    h.pipeline.attach(h.adapter, "claude:sess-1");
    h.adapter.emit({ kind: "text", id: "m-1", text: "a", raw: { messageId: "m-1" } });
    h.adapter.emit({ kind: "thought", id: "th-1", text: "b", raw: { messageId: "th-1" } });
    h.adapter.emit({ kind: "text", id: "m-2", text: "c", raw: { messageId: "m-2" } });

    const events = h.store.list("claude:sess-1");
    assert.equal(events.length, 3);
    assert.equal(events[0].seq < events[1].seq, true, "seq 必须递增");
    assert.equal(events[1].seq < events[2].seq, true, "seq 必须递增");
    assert.deepEqual(events.map((e) => e.sessionKey), ["claude:sess-1", "claude:sess-1", "claude:sess-1"]);
    assert.deepEqual(events.map((e) => e.source), ["claude", "claude", "claude"], "source 取 SessionRef.agent");
    assert.deepEqual(events.map((e) => e.idempotencyKey), [
      "claude:sess-1:m-1",
      "claude:sess-1:th-1",
      "claude:sess-1:m-2",
    ]);
  } finally {
    h.close();
  }
});

test("R16 映射: 每个 AdapterUpdate.kind 对应唯一的 SessionEventType 与 payload", () => {
  const h = makeHarness();
  try {
    h.pipeline.attach(h.adapter, "claude:sess-1");

    // 执行顺序 = R16 表格顺序；逐 kind 单独断言，避免一处错掩盖其它
    h.adapter.emit({ kind: "text", id: "u1", text: "tok", raw: { messageId: "u1" } });
    h.adapter.emit({ kind: "thought", id: "u2", text: "think", raw: { messageId: "u2" } });
    h.adapter.emit({ kind: "tool_call", id: "u3", toolName: "Read", raw: { messageId: "u3", name: "Read" } });
    h.adapter.emit({ kind: "tool_result", id: "u4", toolName: "Read", raw: { messageId: "u4", name: "Read" } });
    h.adapter.emit({ kind: "state", id: "u5", state: "idle", raw: { state: "idle" } });
    h.adapter.emit({ kind: "permission_request", id: "u6", text: "allow?", raw: { title: "allow?" } });
    h.adapter.emit({ kind: "error", id: "u7", text: "boom", raw: { reason: "boom" } });

    const events = h.store.list("claude:sess-1");
    assert.equal(events.length, 7, "7 种 kind 各产出一条事件");

    const [text, thought, toolCall, toolResult, state, permission, error] = events;
    assert.equal(text.type, "token");
    assert.deepEqual(text.payload, { text: "tok" });
    assert.equal(thought.type, "thought");
    assert.deepEqual(thought.payload, { text: "think" });
    assert.equal(toolCall.type, "tool_call");
    assert.deepEqual(toolCall.payload, { toolName: "Read", raw: { messageId: "u3", name: "Read" } });
    assert.equal(toolResult.type, "tool_result");
    assert.deepEqual(toolResult.payload, { toolName: "Read", raw: { messageId: "u4", name: "Read" } });
    assert.equal(state.type, "state_update");
    assert.deepEqual(state.payload, { state: "idle", raw: { state: "idle" } });
    assert.equal(permission.type, "permission_request");
    assert.deepEqual(permission.payload, { raw: { title: "allow?" } });
    assert.equal(error.type, "error");
    assert.deepEqual(error.payload, { message: "boom", raw: { reason: "boom" } });
  } finally {
    h.close();
  }
});

test("R18 状态同步: state_update 把 running 改成 idle，registry.get 与 sessions 表都读回新值", () => {
  const h = makeHarness();
  try {
    assert.equal(h.registry.get("claude:sess-1")?.status, "running");
    h.pipeline.attach(h.adapter, "claude:sess-1");
    h.adapter.emit({ kind: "state", id: "st-1", state: "idle", raw: { state: "idle" } });

    assert.equal(h.registry.get("claude:sess-1")?.status, "idle", "内存态必须同步");
    assert.deepEqual(h.registry.list({ status: "idle" }).map((r) => r.key), ["claude:sess-1"], "list 过滤按新状态");
    const row = h.db.prepare("SELECT status FROM sessions WHERE key = ?").get("claude:sess-1") as { status: string };
    assert.equal(row.status, "idle", "sessions 表必须同步");

    // 再回到 running，确认不是一次性写入
    h.adapter.emit({ kind: "state", id: "st-2", state: "needs-input", raw: { state: "needs-input" } });
    assert.equal(h.registry.get("claude:sess-1")?.status, "needs-input");
    const events = h.store.list("claude:sess-1");
    assert.deepEqual(events.map((e) => e.type), ["state_update", "state_update"]);
    assert.deepEqual(events.map((e) => e.payload), [
      { state: "idle", raw: { state: "idle" } },
      { state: "needs-input", raw: { state: "needs-input" } },
    ]);
  } finally {
    h.close();
  }
});

test("R17 幂等: 同一 update 重放不新增事件（依赖 INSERT OR IGNORE，管线不自建缓存）", () => {
  const h = makeHarness();
  try {
    h.pipeline.attach(h.adapter, "claude:sess-1");
    const update: AdapterUpdate = { kind: "text", id: "m-1", text: "once", raw: { messageId: "m-1" } };
    h.adapter.emit(update);
    h.adapter.emit(update);
    h.adapter.emit({ ...update, text: "changed" });

    assert.equal(eventCount(h.db), 1, "重放不得新增行");
    const events = h.store.list("claude:sess-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].idempotencyKey, "claude:sess-1:m-1");
    assert.deepEqual(events[0].payload, { text: "once" }, "保留首次写入内容");
  } finally {
    h.close();
  }
});

test("R19 transcript 去重: ACP 已见的 messageId 跳过，只写新增；重复 ingest 返回 0", () => {
  const h = makeHarness();
  try {
    h.pipeline.attach(h.adapter, "claude:sess-1");
    h.adapter.emit({ kind: "text", id: "acp-1", text: "from acp", raw: { messageId: "acp-1" } });

    const added = h.pipeline.ingestTranscript("claude:sess-1", [
      transcriptMessage({ id: "acp-1", text: "同一条（ACP 已覆盖）" }),
      transcriptMessage({ id: "tr-1", text: "transcript only" }),
      transcriptMessage({ id: "tr-2", kind: "thinking", text: "hmm" }),
    ]);

    // 3 条里 acp-1 被 ACP 覆盖而跳过，tr-1 / tr-2 各写一条
    assert.equal(added, 2, "返回新增条数");

    const keys = h.store.list("claude:sess-1").map((e) => e.idempotencyKey);
    assert.deepEqual(keys, ["claude:sess-1:acp-1", "claude:sess-1:transcript:tr-1", "claude:sess-1:transcript:tr-2"]);

    assert.equal(h.pipeline.ingestTranscript("claude:sess-1", [transcriptMessage({ id: "tr-1" })]), 0, "重复 ingest 不新增");
    assert.equal(eventCount(h.db), 3);
  } finally {
    h.close();
  }
});

test("R19 transcript 映射: text→token、thinking→thought、tool_call/tool_result 带 toolName", () => {
  const h = makeHarness();
  try {
    const added = h.pipeline.ingestTranscript("claude:sess-1", [
      transcriptMessage({ id: "t-text", kind: "text", text: "hi" }),
      transcriptMessage({ id: "t-think", kind: "thinking", text: "ponder" }),
      transcriptMessage({ id: "t-call", kind: "tool_call", text: "{\"path\":\"a\"}", toolName: "Read" }),
      transcriptMessage({ id: "t-res", kind: "tool_result", text: "file body" }),
    ]);
    assert.equal(added, 4);

    const events = h.store.list("claude:sess-1");
    assert.deepEqual(events.map((e) => e.type), ["token", "thought", "tool_call", "tool_result"]);
    assert.deepEqual(events[0].payload, { text: "hi" });
    assert.deepEqual(events[1].payload, { text: "ponder" });
    assert.deepEqual(events[2].payload, { text: "{\"path\":\"a\"}", toolName: "Read" });
    assert.deepEqual(events[3].payload, { text: "file body" });
    assert.deepEqual(events.map((e) => e.source), ["claude", "claude", "claude", "claude"]);
  } finally {
    h.close();
  }
});

test("R18 未知会话: state_update 不抛异常，且不写事件（只记一次日志）", () => {
  const h = makeHarness({ seed: [] });
  try {
    h.pipeline.attach(h.adapter, "claude:ghost");
    assert.doesNotThrow(() => {
      h.adapter.emit({ kind: "state", id: "st-1", state: "idle", raw: { state: "idle" } });
      h.adapter.emit({ kind: "state", id: "st-2", state: "running", raw: { state: "running" } });
    });
    assert.deepEqual(h.store.list("claude:ghost"), [], "未知会话不落事件");
    assert.equal(eventCount(h.db), 0);
    assert.equal(h.logs.length, 1, "同一未知会话只记一次，不刷屏");
    assert.match(h.logs[0], /claude:ghost/);
  } finally {
    h.close();
  }
});

test("R16/R20 未知 kind 与坏 update 被丢弃，不中断后续事件", () => {
  const h = makeHarness();
  try {
    h.pipeline.attach(h.adapter, "claude:sess-1");
    const bogus = { kind: "no-such-kind" as AdapterUpdateKind, id: "x-1" };
    assert.doesNotThrow(() => {
      h.adapter.emit(bogus);
      h.adapter.emit({ kind: "state", id: "x-2" }); // state 缺 state 字段
    });
    assert.deepEqual(h.store.list("claude:sess-1"), []);

    h.adapter.emit({ kind: "text", id: "ok-1", text: "still alive", raw: { messageId: "ok-1" } });
    assert.deepEqual(h.store.list("claude:sess-1").map((e) => e.payload), [{ text: "still alive" }]);
  } finally {
    h.close();
  }
});

test("R20 退订: unsubscribe 后不再写入", () => {
  const h = makeHarness();
  try {
    const off = h.pipeline.attach(h.adapter, "claude:sess-1");
    h.adapter.emit({ kind: "text", id: "m-1", text: "a", raw: { messageId: "m-1" } });
    off();
    assert.equal(h.adapter.listenerCount(), 0);
    h.adapter.emit({ kind: "text", id: "m-2", text: "b", raw: { messageId: "m-2" } });
    assert.equal(eventCount(h.db), 1, "退订后不再写事件");
    assert.doesNotThrow(() => off(), "退订函数可重复调用");
  } finally {
    h.close();
  }
});

test("R20 重 attach: 同一 sessionKey 先退掉旧的，不会双写", () => {
  const h = makeHarness();
  try {
    const first = h.pipeline.attach(h.adapter, "claude:sess-1");
    h.pipeline.attach(h.adapter, "claude:sess-1");
    assert.equal(h.adapter.listenerCount(), 1, "旧订阅必须被移除");

    h.adapter.emit({ kind: "text", id: "m-1", text: "a", raw: { messageId: "m-1" } });
    assert.equal(eventCount(h.db), 1, "同一条 update 只产生一条事件");

    first(); // 旧退订函数不应杀掉新订阅
    h.adapter.emit({ kind: "text", id: "m-2", text: "b", raw: { messageId: "m-2" } });
    assert.equal(eventCount(h.db), 2);
  } finally {
    h.close();
  }
});

test("R20 dispose: 退订所有 adapter，之后不再写入", () => {
  const h = makeHarness({ seed: [{ key: "claude:sess-1" }, { key: "claude:sess-2", nativeId: "sess-2" }] });
  try {
    h.pipeline.attach(h.adapter, "claude:sess-1");
    h.pipeline.attach(h.adapter, "claude:sess-2");
    assert.equal(h.adapter.listenerCount(), 2);

    h.pipeline.dispose();
    assert.equal(h.adapter.listenerCount(), 0, "dispose 必须退订全部");

    h.adapter.emit({ kind: "text", id: "m-1", text: "a", raw: { messageId: "m-1" } });
    assert.equal(eventCount(h.db), 0);
    assert.doesNotThrow(() => h.pipeline.dispose(), "dispose 可重复调用");
  } finally {
    h.close();
  }
});


test("R19 回归: 被丢弃的 update 不得毒化去重集合（只有落库成功的 update 才记账）", () => {
  const h = makeHarness();
  try {
    h.pipeline.attach(h.adapter, "claude:sess-1");

    // kind=state 缺 state → 该 update 被丢弃，但 raw 里带着 messageId
    assert.doesNotThrow(() => {
      h.adapter.emit({ kind: "state", id: "st-dropped", raw: { messageId: "m-shared" } });
    });
    assert.deepEqual(h.store.list("claude:sess-1"), [], "缺 state 的 update 不得落事件");

    // 同 id 的 transcript 消息仍必须落库（旧实现把它记进 seenAcp 后此处会静默跳过）
    const added = h.pipeline.ingestTranscript("claude:sess-1", [
      transcriptMessage({ id: "m-shared", text: "must not be skipped" }),
    ]);
    assert.equal(added, 1, "被丢弃 update 的 messageId 不得拦住 transcript 消息");

    const events = h.store.list("claude:sess-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "token");
    assert.equal(events[0].idempotencyKey, "claude:sess-1:transcript:m-shared");
    assert.deepEqual(events[0].payload, { text: "must not be skipped" });
  } finally {
    h.close();
  }
});

test("R20 异常隔离: store.append 抛错一次不中断管线，第二条 update 仍落库且错误被记录", () => {
  const db = openDb(":memory:");
  migrate(db);
  try {
    const registry = new SessionRegistry(db);
    registry.upsert(makeRef());

    // 薄 stub：只实现管线实际用到的 append / list / subscribe
    let appendCalls = 0;
    const written: SessionEvent[] = [];
    const stub: Pick<EventStore, "append" | "list" | "subscribe"> = {
      append: (event: NewEvent): SessionEvent => {
        appendCalls += 1;
        if (appendCalls === 1) {
          throw new Error("stub: 磁盘写入失败");
        }
        const stored: SessionEvent = { seq: appendCalls, ts: new Date().toISOString(), ...event };
        written.push(stored);
        return stored;
      },
      list: (sessionKey: string): SessionEvent[] => written.filter((event) => event.sessionKey === sessionKey),
      subscribe: (): (() => void) => () => {},
    };

    const logs: string[] = [];
    const pipeline = new EventPipeline(stub as unknown as EventStore, registry, {
      debug: (message) => logs.push(message),
      error: (message) => logs.push(message),
    });
    const adapter = makeAdapter();
    pipeline.attach(adapter, "claude:sess-1");

    assert.doesNotThrow(() => {
      adapter.emit({ kind: "text", id: "boom-1", text: "first", raw: { messageId: "boom-1" } });
      adapter.emit({ kind: "text", id: "ok-2", text: "second", raw: { messageId: "ok-2" } });
    }, "store 抛错不得冒泡出管线");

    assert.equal(appendCalls, 2, "两次 update 都必须到 store（第一条的异常不得拦住第二条）");
    assert.deepEqual(written.map((e) => e.idempotencyKey), ["claude:sess-1:ok-2"], "第二条必须写成功");
    assert.equal(logs.length, 1, "错误只记一条，不刷屏");
    assert.match(logs[0], /磁盘写入失败/, "日志带上原始错误");
    assert.match(logs[0], /claude:sess-1/);
  } finally {
    db.close();
  }
});

test("R18 未知会话: 所有 kind 都丢弃且不抛，每个会话只记一条 error", () => {
  const h = makeHarness({ seed: [] });
  try {
    h.pipeline.attach(h.adapter, "claude:ghost-a");
    h.pipeline.attach(h.adapter, "claude:ghost-b");

    assert.doesNotThrow(() => {
      h.adapter.emit({ kind: "text", id: "g-1", text: "x", raw: { messageId: "g-1" } });
      h.adapter.emit({ kind: "tool_call", id: "g-2", toolName: "Read", raw: { messageId: "g-2" } });
      h.adapter.emit({ kind: "state", id: "g-3", state: "idle", raw: { messageId: "g-3" } });
    });

    assert.deepEqual(h.store.list("claude:ghost-a"), [], "未知会话不落事件");
    assert.deepEqual(h.store.list("claude:ghost-b"), [], "未知会话不落事件");
    assert.equal(eventCount(h.db), 0);
    assert.equal(h.logs.length, 2, "两个未知会话各记一条，后续 update 不再刷屏");
    assert.match(h.logs[0], /claude:ghost-a/);
    assert.match(h.logs[1], /claude:ghost-b/);

    assert.equal(h.pipeline.ingestTranscript("claude:ghost-a", [transcriptMessage({ id: "tr-ghost" })]), 0);
    assert.equal(h.logs.length, 2, "同一会话的第二次告警被抑制");
  } finally {
    h.close();
  }
});
