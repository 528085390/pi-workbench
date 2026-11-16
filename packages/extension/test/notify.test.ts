import assert from "node:assert/strict";
import test from "node:test";

import {
  TurnNotifier,
  notifierUrl,
  normalizeNotifyMode,
  reasonOf,
  renderMessage,
  type NotifySession,
  type NotifySink,
} from "../src/notify.ts";

const NOW = Date.parse("2026-11-16T08:00:00.000Z");
const LATER = "2026-11-16T08:00:05.000Z";

function recorder() {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const statuses: Array<string | undefined> = [];
  const sink: NotifySink = {
    send(message, options) {
      sent.push({ message, options });
    },
    setStatus(text) {
      statuses.push(text);
    },
  };
  return { sent, statuses, sink };
}

function session(over: Partial<NotifySession> & { key: string }): NotifySession {
  return { driver: "pi", status: "idle", unread: 1, lastReadCursor: "100", ...over };
}

test("reasonOf：只认回合结束 / 等输入 / 出错", () => {
  assert.equal(reasonOf({ seq: 1, sessionKey: "k", type: "state_update", payload: { status: "idle" } }), "turn-end");
  assert.equal(reasonOf({ seq: 1, sessionKey: "k", type: "state_update", payload: { status: "needs-input" } }), "needs-input");
  assert.equal(reasonOf({ seq: 1, sessionKey: "k", type: "error", payload: {} }), "error");
  assert.equal(reasonOf({ seq: 1, sessionKey: "k", type: "state_update", payload: { status: "running" } }), null);
  assert.equal(reasonOf({ seq: 1, sessionKey: "k", type: "token", payload: {} }), null);
});

test("normalizeNotifyMode：未知值回落 followUp", () => {
  assert.equal(normalizeNotifyMode(undefined), "followUp");
  assert.equal(normalizeNotifyMode("steer"), "steer");
  assert.equal(normalizeNotifyMode(" nextTurn "), "nextTurn");
  assert.equal(normalizeNotifyMode("nonsense"), "followUp");
});

test("历史回放不唤醒（ts 早于通知器创建时刻）", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({
    sink,
    now: () => NOW,
    listSessions: async () => [session({ key: "claude:a" })],
  });
  notifier.handleEvent({ seq: 1, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: "2026-11-16T07:59:00.000Z" });
  assert.deepEqual(notifier.pendingKeys, []);
  await notifier.flush();
  assert.equal(sent.length, 0);
});

test("实时事件入队，flush 发送一条指针消息", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({
    sink,
    now: () => NOW,
    listSessions: async () => [session({ key: "claude:a", unread: 3, lastReadCursor: "190607" })],
  });
  notifier.handleEvent({ seq: 9, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  assert.deepEqual(notifier.pendingKeys, ["claude:a"]);
  await notifier.flush();
  assert.equal(sent.length, 1);
  const message = sent[0]!.message as { customType: string; content: string };
  assert.equal(message.customType, "pi-workbench");
  assert.match(message.content, /claude:a/);
  assert.match(message.content, /190607/);
  assert.match(message.content, /3 条/);
  assert.deepEqual(sent[0]!.options, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(notifier.consecutiveWakes, 1);
});

test("投递前复核：未读已清零 → 静默丢弃", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({
    sink,
    now: () => NOW,
    listSessions: async () => [session({ key: "claude:a", unread: 0 })],
  });
  notifier.handleEvent({ seq: 9, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  await notifier.flush();
  assert.equal(sent.length, 0);
  assert.equal(notifier.consecutiveWakes, 0);
});

test("人接管中的会话不唤醒", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({
    sink,
    now: () => NOW,
    listSessions: async () => [session({ key: "claude:a", driver: "human", unread: 2 })],
  });
  notifier.handleEvent({ seq: 9, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  await notifier.flush();
  assert.equal(sent.length, 0);
});

test("多会话在一个窗口内合并成一条消息", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({
    sink,
    now: () => NOW,
    listSessions: async () => [
      session({ key: "claude:a", unread: 3 }),
      session({ key: "claude:b", unread: 1, status: "needs-input", awaiting: true }),
    ],
  });
  notifier.handleEvent({ seq: 9, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  notifier.handleEvent({ seq: 10, sessionKey: "claude:b", type: "state_update", payload: { status: "needs-input" }, ts: LATER });
  await notifier.flush();
  assert.equal(sent.length, 1);
  const content = (sent[0]!.message as { content: string }).content;
  assert.match(content, /2 个会话有更新/);
  assert.match(content, /claude:b 需要你回话/);
});

test("clearSession：Pi 自己读过的会话不再提醒", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({ sink, now: () => NOW, listSessions: async () => [session({ key: "claude:a", unread: 5 })] });
  notifier.handleEvent({ seq: 9, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  notifier.clearSession("claude:a");
  await notifier.flush();
  assert.equal(sent.length, 0);
});

test("连续唤醒上限 5：触顶后只更新徽标，工具调用后恢复", async () => {
  const { sent, statuses, sink } = recorder();
  let unread = 1;
  const notifier = new TurnNotifier({ sink, now: () => NOW, listSessions: async () => [session({ key: "claude:a", unread })] });
  for (let i = 0; i < 6; i += 1) {
    notifier.handleEvent({ seq: 100 + i, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
    await notifier.flush();
  }
  assert.equal(sent.length, 5);
  assert.equal(notifier.consecutiveWakes, 5);
  assert.ok(statuses.includes("pi-workbench: 1 未读"));
  notifier.noteToolActivity();
  assert.equal(notifier.consecutiveWakes, 0);
  notifier.handleEvent({ seq: 200, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  await notifier.flush();
  assert.equal(sent.length, 6);
  unread = 0;
});

test("nextTurn 模式：不触发新一轮", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({ sink, now: () => NOW, mode: "nextTurn", listSessions: async () => [session({ key: "claude:a" })] });
  notifier.handleEvent({ seq: 9, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  await notifier.flush();
  assert.deepEqual(sent[0]!.options, { deliverAs: "nextTurn", triggerTurn: false });
});

test("复核失败（daemon 挂了）不发送也不崩溃", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({ sink, now: () => NOW, listSessions: async () => { throw new Error("ECONNREFUSED"); } });
  notifier.handleEvent({ seq: 9, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  await notifier.flush();
  assert.equal(sent.length, 0);
});

test("renderMessage 不含任务完成断言", () => {
  const text = renderMessage([{ session: session({ key: "claude:a", unread: 2, lastReadCursor: "77" }), reason: "turn-end" }]);
  assert.match(text, /游标 77/);
  assert.ok(!text.includes("完成"), "不应该断言任务完成");
});

test("notifierUrl：http→ws、保留路径前缀、带 after", () => {
  assert.equal(notifierUrl("http://127.0.0.1:7331", 0), "ws://127.0.0.1:7331/api/cp/ws?after=0");
  assert.equal(notifierUrl("https://box.local:8443/prefix/", 42), "wss://box.local:8443/prefix/api/cp/ws?after=42");
});
