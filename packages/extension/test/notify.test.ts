import assert from "node:assert/strict";
import test from "node:test";

import {
  TurnNotifier,
  notifierUrl,
  normalizeNotifyMode,
  reasonOf,
  renderMessage,
  renderStatus,
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

test("renderStatus：只列活跃会话，状态优先、带目录短名", () => {
  const line = renderStatus([
    session({ key: "claude:old", driver: "none", status: "unknown", unread: 10, cwd: "E:\\pi-workbench" }),
    session({ key: "claude:a", status: "idle", unread: 0, cwd: "C:\\Users\\huang\\homework\\dl-ch7" }),
    session({ key: "codex:b", status: "running", unread: 2, cwd: "C:\\Users\\huang\\homework\\java-oop" }),
  ]);
  assert.equal(line, "pi-workbench: 2 个会话 · [running] codex:java-oop · [idle] claude:dl-ch7");
});

test("renderStatus：最多列 3 个会话，其余折叠成 +N", () => {
  const line = renderStatus([
    session({ key: "claude:a", cwd: "C:\\a" }),
    session({ key: "claude:b", cwd: "C:\\b" }),
    session({ key: "claude:c", cwd: "C:\\c" }),
    session({ key: "claude:d", cwd: "C:\\d" }),
  ]);
  assert.match(line, /^pi-workbench: 4 个会话 · /);
  assert.match(line, / · \+1$/);
});

test("renderStatus：同目录会话用 nativeId 前缀区分；无会话时明说", () => {
  const line = renderStatus([
    session({ key: "claude:a", nativeId: "aaaa1111", cwd: "C:\\same" }),
    session({ key: "claude:b", nativeId: "bbbb2222", cwd: "C:\\same" }),
  ]);
  assert.match(line, /claude:same#aaaa/);
  assert.match(line, /claude:same#bbbb/);
  assert.equal(renderStatus([]), "pi-workbench: 无活跃会话");
});

test("状态变化（running）即使不唤醒也刷新底栏", async () => {
  const { statuses, sink } = recorder();
  let sessions = [session({ key: "claude:a", status: "idle", unread: 0 })];
  const notifier = new TurnNotifier({ sink, now: () => NOW, debounceMs: 5, listSessions: async () => sessions });
  sessions = [session({ key: "claude:a", status: "running", unread: 0 })];
  notifier.handleEvent({ seq: 3, sessionKey: "claude:a", type: "state_update", payload: { status: "running" }, ts: LATER });
  assert.deepEqual(notifier.pendingKeys, [], "running 不该入队唤醒");
  await notifier.flush();
  assert.ok(statuses.includes("pi-workbench: 1 个会话 · [running] claude:a"));
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

test("I2：sendEnabled=false 只维护徽标、不发消息（PI_WORKBENCH_NOTIFY=0 不该连徽标一起关）", async () => {
  const { sent, statuses, sink } = recorder();
  const notifier = new TurnNotifier({
    sink,
    now: () => NOW,
    sendEnabled: false,
    listSessions: async () => [session({ key: "claude:a", unread: 4 })],
  });
  notifier.handleEvent({ seq: 9, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  await notifier.flush();
  assert.equal(sent.length, 0, "静音模式不发对话消息");
  assert.deepEqual(notifier.pendingKeys, [], "静音也不攒着");
  assert.ok(statuses.includes("pi-workbench: 1 个会话 · [idle] claude:a"), "底栏照常反映会话状态");
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
  assert.ok(statuses.includes("pi-workbench: 1 个会话 · [idle] claude:a"));
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

test("cp_sessions/cp_see 是观察型工具，不重置连击上限", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({
    sink,
    now: () => NOW,
    listSessions: async () => [session({ key: "claude:a", unread: 1 })],
  });
  for (let index = 0; index < 5; index += 1) {
    notifier.handleEvent({ seq: 100 + index, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
    await notifier.flush();
  }
  assert.equal(sent.length, 5);
  notifier.noteToolActivity("cp_sessions");
  notifier.noteToolActivity("cp_see");
  assert.equal(notifier.consecutiveWakes, 5, "纯观察工具不能重置上限");
  notifier.noteToolActivity("cp_inject");
  assert.equal(notifier.consecutiveWakes, 0, "推进型工具才清零");
});

test("唤醒计数超过窗口后自动恢复", async () => {
  const { sent, sink } = recorder();
  let clock = NOW;
  const notifier = new TurnNotifier({
    sink,
    now: () => clock,
    wakeWindowMs: 1000,
    listSessions: async () => [session({ key: "claude:a", unread: 1 })],
  });
  for (let index = 0; index < 5; index += 1) {
    notifier.handleEvent({ seq: 100 + index, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
    await notifier.flush();
  }
  assert.equal(sent.length, 5);
  clock += 1001;
  notifier.handleEvent({ seq: 200, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
  await notifier.flush();
  assert.equal(sent.length, 6, "窗口过期后应恢复一次唤醒");
});

test("同一 seq 重放不会二次唤醒", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({
    sink,
    now: () => NOW,
    listSessions: async () => [session({ key: "claude:a", unread: 1 })],
  });
  const event = { seq: 9, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER };
  notifier.handleEvent(event);
  await notifier.flush();
  notifier.handleEvent(event);
  await notifier.flush();
  assert.equal(sent.length, 1);
});

test("唤醒预算 per-session：a 触顶后 b 的首次唤醒仍投递", async () => {
  const { sent, sink } = recorder();
  const notifier = new TurnNotifier({
    sink,
    now: () => NOW,
    maxConsecutiveWakes: 2,
    listSessions: async () => [session({ key: "claude:a", unread: 1 }), session({ key: "claude:b", unread: 1 })],
  });

  for (let index = 0; index < 2; index += 1) {
    notifier.handleEvent({ seq: 100 + index, sessionKey: "claude:a", type: "state_update", payload: { status: "idle" }, ts: LATER });
    await notifier.flush();
  }
  assert.equal(sent.length, 2, "a 用满自己的预算");
  assert.equal(notifier.consecutiveWakes, 2);

  notifier.handleEvent({ seq: 200, sessionKey: "claude:b", type: "state_update", payload: { status: "idle" }, ts: LATER });
  await notifier.flush();
  assert.equal(sent.length, 3, "b 的首次唤醒不得被 a 的预算挡住");
  const content = (sent[2]!.message as { content: string }).content;
  assert.match(content, /claude:b/);
  assert.ok(!content.includes("claude:a"), "a 已触顶，不应混进 b 的唤醒消息");
});
