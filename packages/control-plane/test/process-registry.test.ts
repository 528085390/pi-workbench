import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { SessionRef } from "@pi-workbench/shared";

import { setProcessRegistry, wrapSpawnWithHiddenWindow } from "../src/child-process.ts";
import { migrate, openDb } from "../src/db.ts";
import { EventStore } from "../src/events.ts";
import { LeaseManager } from "../src/lease.ts";
import { createDriverExitHandler, ProcessRegistry } from "../src/process-registry.ts";
import { SessionRegistry } from "../src/registry.ts";

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

function fakeChild(pid: number): EventEmitter & { pid: number } {
  return Object.assign(new EventEmitter(), { pid });
}

function makeRef(
  key: string,
  status: SessionRef["status"],
  driver: SessionRef["driver"],
  transcriptPath?: string,
): SessionRef {
  return {
    key,
    agent: "pi",
    nativeId: key.split(":")[1] ?? key,
    cwd: "E:\\pi-workbench",
    status,
    driver,
    capabilities: CAPS,
    kind: "interactive",
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
  };
}

test("track 记录子进程，exit 后标记 exited", () => {
  const registry = new ProcessRegistry({ kill: () => true } as never);
  const child = fakeChild(1234);
  registry.track(child, "adapter:claude");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]?.exited, false);
  child.emit("exit");
  assert.equal(registry.list()[0]?.exited, true);
});

test("track 忽略没有 pid 的子进程", () => {
  const registry = new ProcessRegistry({ kill: () => true });
  const child = Object.assign(new EventEmitter(), { pid: undefined });
  registry.track(child, "adapter:pi");
  assert.deepEqual(registry.list(), []);
});

test("killAll 先 SIGTERM，超时后只对存活进程 SIGKILL", async () => {
  const signals: string[] = [];
  const registry = new ProcessRegistry({
    kill: (pid, signal) => {
      signals.push(String(pid) + ":" + signal);
      return true;
    },
  });
  const exited = fakeChild(101);
  const stubborn = fakeChild(102);
  registry.track(exited, "adapter:claude", "claude");
  registry.track(stubborn, "adapter:codex", "codex");

  const done = registry.killAll(20);
  setTimeout(() => exited.emit("exit"), 1);
  await done;

  assert.deepEqual(signals, ["101:SIGTERM", "102:SIGTERM", "102:SIGKILL"]);
  const byPid = new Map(registry.list().map((info) => [info.pid, info]));
  assert.equal(byPid.get(101)?.exited, true);
  assert.equal(byPid.get(102)?.exited, true, "强杀后也标记 exited");
});

test("exit 回调只触发一次，并携带登记信息", () => {
  const seen: unknown[] = [];
  const registry = new ProcessRegistry({ kill: () => true, now: () => Date.parse("2026-11-17T00:00:00.000Z") });
  const child = fakeChild(777);
  registry.setOnExit((info) => seen.push(info));
  registry.track(child, "adapter:pi", "pi");
  child.emit("exit");
  child.emit("exit");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    pid: 777,
    label: "adapter:pi",
    startedAt: "2026-11-17T00:00:00.000Z",
    exited: true,
    agent: "pi",
  });
});

function fresh(): { db: DatabaseSync; sessions: SessionRegistry; events: EventStore; leases: LeaseManager } {
  const db = openDb(":memory:");
  migrate(db);
  return {
    db,
    sessions: new SessionRegistry(db),
    events: new EventStore(db),
    leases: new LeaseManager(db, { ttlMs: 60_000 }),
  };
}

test("adapter 退出：running 会话发 E_ADAPTER_CRASHED、释放租约、status 置 exited", () => {
  const { db, sessions, events, leases } = fresh();
  try {
    sessions.upsert(makeRef("pi:running", "running", "pi"));
    sessions.upsert(makeRef("pi:idle", "idle", "none"));
    leases.acquire("pi:running", "pi", "pi:daemon");

    const info = {
      pid: 4242,
      label: "adapter:pi",
      startedAt: "2026-11-17T00:00:00.000Z",
      exited: true,
      agent: "pi" as const,
    };
    createDriverExitHandler({ agent: "pi", sessions, events, leases })(info);

    assert.equal(sessions.get("pi:running")?.status, "exited");
    assert.equal(sessions.get("pi:idle")?.status, "idle", "非 running 会话不动");
    assert.equal(leases.current("pi:running"), null);

    const errorEvents = events.list("pi:running").filter((event) => event.type === "error");
    assert.equal(errorEvents.length, 1);
    assert.deepEqual(errorEvents[0]?.payload, {
      code: "E_ADAPTER_CRASHED",
      message: "adapter 子进程异常退出（pid 4242，adapter:pi）",
      pid: 4242,
      label: "adapter:pi",
    });

    // 同一进程再次上报不应重复写事件（idempotencyKey 稳定）。
    createDriverExitHandler({ agent: "pi", sessions, events, leases })(info);
    assert.equal(events.list("pi:running").filter((event) => event.type === "error").length, 1);
  } finally {
    db.close();
  }
});

test("spawn 补丁登记子进程：label 取命令首项，并识别 adapter agent", () => {
  const registry = new ProcessRegistry({ kill: () => true });
  setProcessRegistry(registry);
  try {
    let nextPid = 555;
    const wrapped = wrapSpawnWithHiddenWindow((() => fakeChild(nextPid++)) as never);
    wrapped("C:\\Program Files\\nodejs\\node.exe", ["C:\\repo\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js"], {});
    wrapped("pi", ["--mode", "rpc", "--session", "C:\\tmp\\s.jsonl"], {});
    assert.deepEqual(
      registry.list().map((info) => ({ pid: info.pid, label: info.label, agent: info.agent, exited: info.exited, sessionPath: info.sessionPath })),
      [
        { pid: 555, label: "C:\\Program Files\\nodejs\\node.exe", agent: "claude", exited: false, sessionPath: undefined },
        { pid: 556, label: "pi", agent: "pi", exited: false, sessionPath: "C:\\tmp\\s.jsonl" },
      ],
    );
  } finally {
    setProcessRegistry(null);
  }
});

test("已退出进程释放 child 句柄，历史按 historyLimit 有界", () => {
  const registry = new ProcessRegistry({ kill: () => true, historyLimit: 2 });
  for (let pid = 1; pid <= 4; pid += 1) {
    const child = fakeChild(pid);
    registry.track(child, "adapter:pi", "pi");
    child.emit("exit");
  }
  assert.deepEqual(registry.list().map((info) => info.pid), [3, 4]);
  assert.equal(registry.list().every((info) => info.exited), true);
});

test("adapter 退出只 reconcile 同 sessionKey 的 running 会话", () => {
  const { db, sessions, events, leases } = fresh();
  try {
    sessions.upsert(makeRef("pi:a", "running", "pi"));
    sessions.upsert(makeRef("pi:b", "running", "pi"));
    createDriverExitHandler({ agent: "pi", sessions, events, leases })({
      pid: 1,
      label: "adapter:pi",
      startedAt: "2026-11-17T00:00:00.000Z",
      exited: true,
      agent: "pi",
      sessionKey: "pi:a",
    });
    assert.equal(sessions.get("pi:a")?.status, "exited");
    assert.equal(sessions.get("pi:b")?.status, "running", "同 agent 的其它会话不能被误杀");
  } finally {
    db.close();
  }
});

test("adapter 退出按 sessionPath 匹配 transcriptPath，只 reconcile 本会话", () => {
  const { db, sessions, events, leases } = fresh();
  try {
    sessions.upsert(makeRef("pi:a", "running", "pi", "C:\\tmp\\a.jsonl"));
    sessions.upsert(makeRef("pi:b", "running", "pi", "C:\\tmp\\b.jsonl"));
    createDriverExitHandler({ agent: "pi", sessions, events, leases })({
      pid: 2,
      label: "adapter:pi",
      startedAt: "2026-11-17T00:00:00.000Z",
      exited: true,
      agent: "pi",
      sessionPath: "C:\\tmp\\a.jsonl",
    });
    assert.equal(sessions.get("pi:a")?.status, "exited");
    assert.equal(sessions.get("pi:b")?.status, "running");
  } finally {
    db.close();
  }
});

test("beginShutdown 后子进程 exit 不再触发 crash 回调", () => {
  const seen: unknown[] = [];
  const registry = new ProcessRegistry({ kill: () => true });
  registry.setOnExit((info) => seen.push(info));
  const child = fakeChild(900);
  registry.track(child, "adapter:pi", "pi");
  registry.beginShutdown();
  child.emit("exit");
  assert.equal(seen.length, 0);
  assert.equal(registry.list()[0]?.exited, true);
});

test("killAll 优先使用 killTree 并杀整棵进程树", async () => {
  const calls: string[] = [];
  const registry = new ProcessRegistry({
    killTree: (pid, signal) => {
      calls.push(String(pid) + ":" + signal);
      return true;
    },
    kill: () => {
      throw new Error("killTree 成功时不应退回 direct kill");
    },
  });
  const child = fakeChild(700);
  registry.track(child, "adapter:pi", "pi");
  await registry.killAll(0);
  assert.deepEqual(calls, ["700:SIGTERM", "700:SIGKILL"]);
  assert.equal(registry.list()[0]?.exited, true);
});

test("killAll 真杀子进程树（Windows taskkill /T）", { skip: process.platform !== "win32" }, async () => {
  const script = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(c.pid); setInterval(()=>{},1000);";
  const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const parentPid = parent.pid;
  assert.equal(typeof parentPid, "number");
  const grandPid = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("等待孙进程 pid 超时")), 3_000);
    parent.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split(/\r?\n/)[0]?.trim() ?? "";
      if (line.length > 0) {
        clearTimeout(timer);
        resolve(Number(line));
      }
    });
    parent.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  try {
    const registry = new ProcessRegistry();
    registry.track(parent, "adapter:tree", "pi");
    await registry.killAll(300);
    assert.equal(await waitDead(parentPid as number, 3_000), true, "父进程应被杀死");
    assert.equal(await waitDead(grandPid, 3_000), true, "孙进程应被 taskkill /T 一并杀死");
  } finally {
    if (parentPid !== undefined && isAlive(parentPid)) {
      parent.kill("SIGKILL");
    }
    if (isAlive(grandPid)) {
      process.kill(grandPid, "SIGKILL");
    }
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}
