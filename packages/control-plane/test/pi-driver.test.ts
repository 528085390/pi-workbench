import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import type { SessionRef } from "@pi-workbench/shared";

import type { AdapterUpdate } from "../src/adapters/types.ts";
import { PiDriver, type PiDriverOptions, type PiRpcClientLike, type PiRpcClientOptions } from "../src/agents/pi-driver.ts";
import { capsOf } from "../src/capabilities.ts";
import { migrate, openDb } from "../src/db.ts";
import { isWorkbenchError } from "../src/errors.ts";
import { LeaseManager } from "../src/lease.ts";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/pi/fake-rpc-agent.mjs", import.meta.url));
const START = Date.parse("2026-11-15T00:00:00.000Z");
const TTL = 60_000;

type LogRecord = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** 与 Pi RpcClient 同形状的最小客户端：真的拉起 fixtures 里的 JSONL 假进程。 */
class FixtureRpcClient implements PiRpcClientLike {
  readonly options: PiRpcClientOptions;
  readonly logPath: string;
  readonly listeners = new Set<(event: LogRecord) => void>();
  readonly pending = new Map<string, Pending[]>();
  child: ChildProcessWithoutNullStreams | null = null;
  stopped = false;
  #buffer = "";

  constructor(options: PiRpcClientOptions, logPath: string) {
    this.options = options;
    this.logPath = logPath;
  }

  async start(): Promise<void> {
    const cliPath = this.options.cliPath;
    if (cliPath === undefined) {
      throw new Error("缺少 cliPath");
    }
    const child = spawn(process.execPath, [cliPath, "--mode", "rpc", ...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#onData(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        resolve();
      });
      child.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (child === null) {
      return;
    }
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
    this.child = null;
  }

  onEvent(cb: (event: LogRecord) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  prompt(message: string, _images?: unknown[], streamingBehavior?: "steer" | "followUp"): Promise<string> {
    this.#send({ type: "prompt", message, ...(streamingBehavior === undefined ? {} : { streamingBehavior }) });
    return this.#wait("prompt") as Promise<string>;
  }

  async abort(): Promise<void> {
    this.#send({ type: "abort" });
    await this.#wait("abort");
  }

  newSession(): Promise<{ cancelled: boolean }> {
    this.#send({ type: "new_session" });
    return this.#wait("new_session") as Promise<{ cancelled: boolean }>;
  }

  switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    this.#send({ type: "switch_session", sessionPath });
    return this.#wait("switch_session") as Promise<{ cancelled: boolean }>;
  }

  getState(): Promise<{ sessionId: string; sessionFile?: string; isStreaming?: boolean }> {
    this.#send({ type: "get_state" });
    return this.#wait("get_state") as Promise<{ sessionId: string; sessionFile?: string; isStreaming?: boolean }>;
  }

  #send(command: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify(command) + "\n");
  }

  #wait(command: string): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const queue = this.pending.get(command) ?? [];
      queue.push({ resolve, reject });
      this.pending.set(command, queue);
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const at = this.#buffer.indexOf("\n");
      if (at < 0) break;
      const line = this.#buffer.slice(0, at).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(at + 1);
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line) as LogRecord;
      if (record.type === "response") {
        const queue = this.pending.get(String(record.command)) ?? [];
        const next = queue.shift();
        this.pending.set(String(record.command), queue);
        if (next === undefined) continue;
        if (record.success === true) {
          next.resolve(record.data);
        } else {
          next.reject(new Error(String(record.error)));
        }
        continue;
      }
      for (const listener of this.listeners) {
        listener(record);
      }
    }
  }
}

type Harness = {
  dir: string;
  logPath: string;
  db: DatabaseSync;
  lease: LeaseManager;
  created: FixtureRpcClient[];
  drivers: PiDriver[];
  make: (clientId: string, extra?: Partial<PiDriverOptions>) => PiDriver;
  disposeAll: () => Promise<void>;
  ref: SessionRef;
  readLog: () => LogRecord[];
};

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-pi-driver-"));
  const logPath = join(dir, "rpc.log");
  const db = openDb(":memory:");
  migrate(db);
  const lease = new LeaseManager(db, { ttlMs: TTL, now: () => START });
  const created: FixtureRpcClient[] = [];
  const drivers: PiDriver[] = [];
  const factory = (options: PiRpcClientOptions): FixtureRpcClient => {
    const client = new FixtureRpcClient({ ...options, env: { ...options.env, FAKE_PI_LOG: logPath } }, logPath);
    created.push(client);
    return client;
  };
  const transcriptPath = join(dir, "session-1.jsonl");
  const ref: SessionRef = {
    key: "pi:session-1",
    agent: "pi",
    nativeId: "session-1",
    cwd: dir,
    transcriptPath,
    status: "idle",
    driver: "pi",
    capabilities: capsOf("pi"),
    kind: "interactive",
  };
  writeFileSync(transcriptPath, '{"type":"session","version":3,"id":"session-1","timestamp":"2026-11-15T00:00:00.000Z","cwd":"' + dir.replace(/\\/g, "\\\\") + '"}\n', "utf8");
  const make = (clientId: string, extra: Partial<PiDriverOptions> = {}): PiDriver => {
    const driver = new PiDriver({
      lease,
      clientId,
      cliPath: FAKE_AGENT,
      sessionsRoot: dir,
      timeoutMs: 1000,
      createRpcClient: factory,
      ...extra,
    });
    drivers.push(driver);
    return driver;
  };
  return {
    dir,
    logPath,
    db,
    lease,
    created,
    drivers,
    make,
    disposeAll: async () => {
      await Promise.all(drivers.map((driver) => driver.dispose().catch(() => undefined)));
    },
    ref,
    readLog: () => {
      try {
        return readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as LogRecord);
      } catch {
        return [];
      }
    },
  };
}

function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(fn, (error: unknown) => {
    assert.ok(isWorkbenchError(error), "预期 WorkbenchError，实际：" + String(error));
    assert.equal(error.code, code, "错误码不符：" + error.code + " / " + error.message);
    return true;
  });
}

test("PiDriver.caps: 默认与 capsOf('pi') 一致；provider 不可用时降级为 see/dispatch-only", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a");
    assert.deepEqual(driver.caps, capsOf("pi"));
    assert.equal(driver.caps.attach, false);

    const degraded = h.make("client-b", {
      providerStatus: { available: false, reason: "E_AGENT_UNAVAILABLE: pi provider 402" },
    });
    assert.equal(degraded.caps.inject, false);
    assert.equal(degraded.caps.interrupt, false);
    assert.equal(degraded.caps.attach, false);
    assert.equal(degraded.caps.resume, false);
    assert.equal(degraded.caps.transcript, true);
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver.attach: 以 --session <file> 拉起 RPC 子进程并完成 get_state 握手", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a");
    await driver.attach(h.ref);

    const log = h.readLog();
    const start = log.find((record) => record.event === "start");
    assert.ok(start !== undefined, "假 RPC 进程没有记录 start");
    const argv = start.argv as string[];
    assert.deepEqual(argv.slice(0, 2), ["--mode", "rpc"]);
    const at = argv.indexOf("--session");
    assert.ok(at >= 0, "argv 缺少 --session");
    assert.equal(argv[at + 1], h.ref.transcriptPath);

    assert.ok(log.some((record) => record.event === "request" && record.command === "get_state"));
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver.inject→prompt / interrupt→abort，RPC 事件归一化为 AdapterUpdate", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a", { env: { FAKE_PI_EMIT_EVENTS: "1", FAKE_PI_EMIT_UNKNOWN: "1" } });
    const updates: AdapterUpdate[] = [];
    driver.onUpdate((update) => updates.push(update));
    await driver.attach(h.ref);

    const injected = await driver.inject(h.ref, "继续");
    assert.equal(injected.effective, "now");
    assert.equal(typeof injected.messageId, "string");
    assert.ok(injected.messageId.length > 0);

    const interrupted = await driver.interrupt(h.ref);
    assert.deepEqual(interrupted, { stopReason: "aborted" });

    const log = h.readLog();
    assert.ok(log.some((record) => record.event === "request" && record.command === "prompt" && record.message === "继续"));
    assert.ok(log.some((record) => record.event === "request" && record.command === "abort"));

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(updates.some((update) => update.kind === "text" && update.text === "OK"));
    assert.ok(updates.some((update) => update.kind === "tool_call" && update.toolName === "read"));
    assert.ok(updates.some((update) => update.kind === "tool_result"));
    assert.ok(updates.some((update) => update.kind === "state" && update.state === "idle"));
    assert.equal(updates.some((update) => update.kind === "error"), false, "未知事件不得变成 error");
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver.resume: 已有客户端时发 switch_session 到目标文件", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a");
    await driver.attach(h.ref);
    const other = join(h.dir, "session-2.jsonl");
    writeFileSync(other, '{"type":"session","version":3,"id":"session-1","cwd":"' + h.dir.replace(/\\/g, "\\\\") + '"}\n', "utf8");

    await driver.resume({ ...h.ref, transcriptPath: other });

    const log = h.readLog();
    assert.ok(
      log.some(
        (record) => record.event === "request" && record.command === "switch_session" && record.sessionPath === other,
      ),
    );
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver.inject: RPC 超时会停止子进程并抛 E_ADAPTER_DOWN", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a", { timeoutMs: 120, env: { FAKE_PI_HANG_PROMPT: "1" } });
    await expectCode(() => driver.inject(h.ref, "不会返回"), "E_ADAPTER_DOWN");
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0]?.stopped, true);
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver 第二写者被 lease 拦住：E_LEASE_CONFLICT 且不拉起第二个子进程", async () => {
  const h = makeHarness();
  try {
    const first = h.make("client-a");
    const second = h.make("client-b");
    await first.inject(h.ref, "第一写者");
    assert.equal(h.created.length, 1);

    await expectCode(() => second.inject(h.ref, "第二写者"), "E_LEASE_CONFLICT");
    await expectCode(() => second.interrupt(h.ref), "E_LEASE_CONFLICT");

    assert.equal(h.created.length, 1, "冲突时不得拉起第二个 Pi RPC 子进程");
    const prompts = h.readLog().filter((record) => record.event === "request" && record.command === "prompt");
    assert.equal(prompts.length, 1);
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver provider 402: 运行时降级，首次 E_ADAPTER_DOWN，之后 E_CAP_UNSUPPORTED 且不再发 prompt", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a", { env: { FAKE_PI_PROMPT_ERROR: "402 Payment Required: 余额不足" } });
    await driver.attach(h.ref);

    await expectCode(() => driver.inject(h.ref, "第一次"), "E_ADAPTER_DOWN");
    assert.equal(driver.caps.inject, false);
    assert.equal(driver.caps.interrupt, false);

    await expectCode(() => driver.inject(h.ref, "第二次"), "E_CAP_UNSUPPORTED");
    const prompts = h.readLog().filter((record) => record.event === "request" && record.command === "prompt");
    assert.equal(prompts.length, 1);
    assert.equal(h.created.length, 1);
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver.handoff: 返回 pi --session <abs file>", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a");
    assert.deepEqual(await driver.handoff(h.ref), {
      command: ["pi", "--session", h.ref.transcriptPath],
      mode: "resume-tui",
    });
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver.dispose: 停止所有 RPC 子进程", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a");
    await driver.attach(h.ref);
    assert.equal(h.created.length, 1);
    await driver.dispose();
    assert.equal(h.created[0]?.stopped, true);
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver.close: 停掉该会话的 RPC 子进程（handoff 前必须断开，避免双写）", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a");
    await driver.attach(h.ref);
    assert.equal(h.created.length, 1);
    await driver.close(h.ref);
    assert.equal(h.created[0]?.stopped, true);
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver.newSession: 不带 --session 启动，new_session 后用 get_state 取 id 与文件", async () => {
  const h = makeHarness();
  try {
    const sessionFile = join(h.dir, "pi-new-new-session-1.jsonl");
    const driver = h.make("client-a", {
      env: { FAKE_PI_NEW_SESSION_ID: "new-session-1", FAKE_PI_NEW_SESSION_FILE: sessionFile },
    });
    const opened = await driver.newSession(h.dir);
    assert.equal(opened.sessionId, "new-session-1");
    assert.equal(opened.transcriptPath, sessionFile);

    const log = h.readLog();
    const start = log.find((record) => record.event === "start");
    assert.ok(start !== undefined);
    assert.ok(!(start.argv as string[]).includes("--session"), "newSession 不应带 --session");
    assert.ok(log.some((record) => record.event === "request" && record.command === "new_session"));
    assert.ok(log.some((record) => record.event === "request" && record.command === "get_state"));

    // 新会话已进入 clients 映射：再 inject 应复用同一个子进程
    await driver.inject({ ...h.ref, key: "pi:new-session-1", nativeId: "new-session-1", transcriptPath: opened.transcriptPath }, "hi");
    assert.equal(h.created.length, 1, "inject 不应再拉起第二个 RPC 进程");
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("PiDriver.rpcCmd: 额外参数透传，--mode rpc 不重复", async () => {
  const h = makeHarness();
  try {
    const driver = h.make("client-a", {
      cliPath: undefined,
      rpcCmd: [FAKE_AGENT, "--mode", "rpc", "--provider", "zz"],
    });
    await driver.attach(h.ref);
    const start = h.readLog().find((record) => record.event === "start");
    assert.ok(start !== undefined);
    const argv = start.argv as string[];
    assert.deepEqual(argv.slice(0, 5), ["--mode", "rpc", "--provider", "zz", "--session"]);
  } finally {
    await h.disposeAll();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
