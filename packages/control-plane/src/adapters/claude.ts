/**
 * Claude ACP v2 adapter（A05）。
 *
 * 结构与 spike/acp-probe/src/connection.ts 一致：`node:child_process` 的 spawn 起 adapter 子进程，
 * SDK 的 `ndJsonStream` 接它的 stdin/stdout，`ClientApp` 当 ACP 客户端。
 *
 * 关键约定（task-5-brief 的 Controller 裁定 R10–R14）：
 * - R10 用 spawn 不用 execa；环境固定注入 `CLAUDE_AGENT_ACP_PROTOCOL=v2`；
 * - R11 `prompt()` 投递后立即返回，回合结束靠 `waitForTurn()`（超时抛 `E_ADAPTER_DOWN` "turn timeout"）；
 * - R12 `session/update` 的 v2 标签映射到 `AdapterUpdate`，未列出的忽略但保留 raw；
 * - R13 `session/request_permission` 先 emit update，再按 `claude.permissionMode` 自动应答；
 * - R14 adapter 命令惰性解析（见 config.ts 的 `resolveDefaultAdapterCmd`）。
 *
 * 进程级不变式：子进程一退出，所有 pending 调用在毫秒级内失败（`E_ADAPTER_DOWN`），绝不挂起。
 */
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import {
  ClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk/experimental/v2";
import type {
  ClientConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
  UpdateSessionNotification,
} from "@agentclientprotocol/sdk/experimental/v2";
import { WORKBENCH_VERSION } from "@pi-workbench/shared";
import type { SessionStatus } from "@pi-workbench/shared";

import type { Config, PermissionMode } from "../config.ts";
import { isWorkbenchError, WorkbenchError } from "../errors.ts";
import type { AdapterSpawnOptions, AdapterTurnResult, AdapterUpdate, AgentAdapter } from "./types.ts";

// adapter 命令解析住在 config.ts（R14），这里顺带对外暴露，调用方不必同时 import 两个模块。
export { FALLBACK_ADAPTER_CMD, resolveDefaultAdapterCmd } from "../config.ts";

/** 握手超时：超时按 `E_ADAPTER_DOWN` 处理，错误里带 stderr 尾部 */
export const INIT_TIMEOUT_MS = 10_000;
/** 单回合默认上限：真 Claude 回合可能很长，超时按 turn timeout 失败 */
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;
/** prompt 只等「请求被受理」，最多等这么久；超时也照样返回（回合状态走 waitForTurn） */
const PROMPT_ACCEPT_TIMEOUT_MS = 3_000;
/** cancel 等 agent 报「回合真的结束」的窗口，超时按已取消返回 */
const CANCEL_SETTLE_MS = 5_000;
/** stderr 只留最后这么多行，够定位握手失败 */
const STDERR_MAX_LINES = 200;
/** dispose 等子进程退出最多这么久 */
const DISPOSE_WAIT_MS = 1_000;

type Turn = {
  promise: Promise<AdapterTurnResult>;
  result: AdapterTurnResult | null;
  settled: boolean;
  resolve(result: AdapterTurnResult): void;
  reject(error: unknown): void;
};

type JsonRpcFailure = { code: number; message: string; data?: unknown };

/**
 * Claude ACP v2 适配器：一个实例对应一个 adapter 子进程。
 * 用 `ClaudeAdapter.spawn()` 创建（构造函数私有，避免出现半初始化的实例）。
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly #child: ChildProcess;
  readonly #conn: ClientConnection;
  readonly #permissionMode: PermissionMode;
  readonly #exit: Deferred<void>;
  readonly #stderr: string[];
  readonly #listeners = new Set<(update: AdapterUpdate) => void>();
  readonly #turns = new Map<string, Turn>();
  #updateSeq = 0;
  #down = false;
  #downReason = "未启动";
  #disposed = false;

  private constructor(child: ChildProcess, permissionMode: PermissionMode) {
    this.#child = child;
    this.#permissionMode = permissionMode;
    this.#exit = createDeferred<void>();
    this.#stderr = [];

    child.stderr?.on("data", (chunk: Buffer) => {
      appendStderr(this.#stderr, chunk);
    });

    const stdin = child.stdin;
    const stdout = child.stdout;
    if (stdin === null || stdout === null) {
      this.#down = true;
      this.#downReason = "子进程没有可用的 stdin/stdout";
      // #conn 需要一个真实连接，占位不可行，直接抛出让 spawn 收拾
      throw new WorkbenchError("E_ADAPTER_DOWN", "adapter 子进程没有可用的 stdio（stdio 必须是 pipe）");
    }

    const stream = ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const app = new ClientApp({ name: "pi-workbench-control-plane" })
      .onNotification(methods.client.session.update, (ctx) => {
        this.#onSessionUpdate(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, (ctx) => this.#onPermissionRequest(ctx.params));
    this.#conn = app.connect(stream);

    child.on("exit", (code, signal) => {
      this.#exit.resolve();
      this.#markDown("子进程退出（code=" + String(code) + ", signal=" + String(signal) + "）");
    });
    child.on("error", (error: Error) => {
      this.#exit.resolve();
      this.#markDown("子进程不可用：" + error.message);
    });
  }

  /**
   * 起 adapter 子进程并完成 initialize 握手。
   * 握手失败 / 10s 超时 / 子进程立刻退出都抛 `E_ADAPTER_DOWN`，错误里带 stderr 尾部。
   */
  static async spawn(cfg: Config, options: AdapterSpawnOptions = {}): Promise<ClaudeAdapter> {
    const command = options.adapterCmd ?? cfg.claude.adapterCmd;
    const file = command[0];
    if (file === undefined || file.length === 0) {
      throw new WorkbenchError("E_ADAPTER_DOWN", "adapterCmd 为空，无法启动 Claude ACP adapter");
    }
    const args = command.slice(1);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // A00 实测：不注入这个变量，claude-agent-acp 会按 v1 说话
      CLAUDE_AGENT_ACP_PROTOCOL: "v2",
      ...options.env,
    };

    let child: ChildProcess;
    try {
      child = spawnProcess(file, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      throw new WorkbenchError("E_ADAPTER_DOWN", "启动 adapter 子进程失败：" + describeError(error), {
        adapterCmd: command,
      });
    }

    const adapter = new ClaudeAdapter(child, cfg.claude.permissionMode);
    try {
      await adapter.#handshake();
    } catch (error) {
      adapter.#markDown("initialize 握手失败");
      adapter.#killChild();
      throw error;
    }
    return adapter;
  }

  async newSession(cwd: string): Promise<{ sessionId: string }> {
    const response = await this.#await("newSession", () =>
      this.#conn.agent.request(methods.agent.session.new, { cwd }),
    );
    return { sessionId: response.sessionId };
  }

  async resume(sessionId: string, cwd: string): Promise<void> {
    try {
      await this.#await("resume", () =>
        this.#conn.agent.request(methods.agent.session.resume, { sessionId, cwd }),
      );
    } catch (error) {
      const adapted = this.#adaptError(error, "resume");
      if (adapted.code === "E_ADAPTER_DOWN") {
        throw adapted;
      }
      throw new WorkbenchError("E_RESUME_REJECTED", "恢复会话被 agent 拒绝：" + sessionId, {
        sessionId,
        cause: adapted.message,
      });
    }
  }

  /**
   * 投递用户消息后立刻返回（R11）。
   * 只等「请求被受理」或「adapter 挂掉」；回合结束要看 `waitForTurn`。
   */
  async prompt(sessionId: string, text: string): Promise<{ messageId: string }> {
    this.#assertAlive("prompt");
    const turn = this.#turnFor(sessionId);
    const messageId = "msg_" + randomUUID();
    const request = this.#conn.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    request.then(
      () => {
        // 受理成功：回合继续跑，进度靠 session/update + waitForTurn
      },
      (error: unknown) => {
        turn.reject(this.#adaptError(error, "prompt"));
      },
    );

    try {
      await this.#race("prompt", request, { timeoutMs: PROMPT_ACCEPT_TIMEOUT_MS, swallowTimeout: true });
    } catch (error) {
      // 请求失败已在 then 里 reject 过回合；这里把同一错误抛给调用方
      throw this.#adaptError(error, "prompt");
    }
    return { messageId };
  }

  /** 发 session/cancel（通知），再等回合报结束；窗口内没等到就按已取消返回 */
  async cancel(sessionId: string): Promise<{ stopReason: string }> {
    this.#assertAlive("cancel");
    const turn = this.#turnFor(sessionId);
    await this.#await("cancel", async () => {
      await this.#conn.agent.notify(methods.agent.session.cancel, { sessionId });
    });

    try {
      const settled = await this.#race("cancel", turn.promise, {
        timeoutMs: CANCEL_SETTLE_MS,
        swallowTimeout: true,
      });
      return settled === null ? { stopReason: "cancelled" } : { stopReason: settled.stopReason };
    } catch (error) {
      throw this.#adaptError(error, "cancel");
    }
  }

  async close(sessionId: string): Promise<void> {
    await this.#await("close", () => this.#conn.agent.request(methods.agent.session.close, { sessionId }));
  }

  /**
   * 等本回合结束（被 cancel 也算结束）。
   * 已经结束的回合直接返回上次结果；超时抛 `E_ADAPTER_DOWN`（turn timeout）。
   */
  async waitForTurn(sessionId: string, timeoutMs: number = DEFAULT_TURN_TIMEOUT_MS): Promise<AdapterTurnResult> {
    this.#assertAlive("waitForTurn");
    const existing = this.#turns.get(sessionId);
    if (existing !== undefined && existing.settled) {
      return await existing.promise;
    }
    const turn = existing ?? this.#beginTurn(sessionId);
    try {
      const settled = await this.#race("waitForTurn", turn.promise, {
        timeoutMs,
        timeoutNote: "turn timeout",
      });
      return settled === null ? { stopReason: "unknown" } : settled;
    } catch (error) {
      throw this.#adaptError(error, "waitForTurn");
    }
  }

  onUpdate(cb: (update: AdapterUpdate) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  /** 释放：幂等；先拒掉所有 pending 回合，再杀子进程 */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#markDown("adapter 已释放（dispose）");
    try {
      this.#conn.close();
    } catch {
      // 连接已关闭，忽略
    }
    this.#killChild();
    const exited = await this.#race("dispose", this.#exit.promise, {
      timeoutMs: DISPOSE_WAIT_MS,
      swallowTimeout: true,
    });
    void exited;
  }

  async #handshake(): Promise<void> {
    await this.#await(
      "initialize",
      () =>
        this.#conn.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          info: { name: "pi-workbench-control-plane", version: WORKBENCH_VERSION },
        }),
      INIT_TIMEOUT_MS,
    );
  }

  /**
   * 发请求并等待结果：同时和「子进程退出」「可选超时」赛跑。
   * 返回 `null` 表示超时且调用方允许忽略（swallowTimeout）。
   */
  async #race<T>(
    label: string,
    promise: Promise<T>,
    options: { timeoutMs?: number; timeoutNote?: string; swallowTimeout?: boolean } = {},
  ): Promise<T | null> {
    const racers: Array<Promise<T | null | RaceTimeout>> = [
      promise,
      this.#exit.promise.then((): never => {
        throw this.#downError(label);
      }),
    ];
    if (options.timeoutMs !== undefined) {
      racers.push(delay(options.timeoutMs).then((): RaceTimeout => RACE_TIMEOUT));
    }
    const settled = await Promise.race(racers);
    if (isRaceTimeout(settled)) {
      if (options.swallowTimeout === true) {
        return null;
      }
      throw new WorkbenchError(
        "E_ADAPTER_DOWN",
        label + " 超时：" + (options.timeoutNote ?? "adapter 无响应") + "（" + String(options.timeoutMs) + "ms）",
        {
          reason: options.timeoutNote === "turn timeout" ? "turn_timeout" : "timeout",
          label,
          timeoutMs: options.timeoutMs,
          stderr: this.#stderrTail(),
        },
      );
    }
    return settled;
  }

  /** 发请求：带退出赛跑，失败统一映射成 WorkbenchError */
  async #await<T>(label: string, op: () => Promise<T>, timeoutMs?: number): Promise<T> {
    this.#assertAlive(label);
    try {
      const settled = await this.#race(label, op(), { timeoutMs });
      // 未传 timeoutMs 时 #race 不会走到超时分支
      return settled as T;
    } catch (error) {
      throw this.#adaptError(error, label);
    }
  }

  #onSessionUpdate(params: UpdateSessionNotification): void {
    const update = params.update;
    const mapped = mapSessionUpdate(update, () => this.#nextId());
    if (mapped !== null) {
      this.#emit(mapped);
    }
    if (update.sessionUpdate === "state_update" && update.state === "idle") {
      const stopReason =
        typeof update.stopReason === "string" && update.stopReason.length > 0 ? update.stopReason : "unknown";
      this.#settleTurn(params.sessionId, { stopReason });
    }
  }

  #onPermissionRequest(params: RequestPermissionRequest): RequestPermissionResponse {
    this.#emit({
      kind: "permission_request",
      id: this.#nextId(),
      text: params.title,
      raw: params,
    });
    return permissionOutcome(this.#permissionMode, params.options);
  }

  #emit(update: AdapterUpdate): void {
    for (const listener of this.#listeners) {
      try {
        listener(update);
      } catch {
        // 单个监听器抛错不影响其它监听器与 adapter 生命周期
      }
    }
  }

  #nextId(): string {
    this.#updateSeq += 1;
    return "u" + String(this.#updateSeq);
  }

  #turnFor(sessionId: string): Turn {
    const existing = this.#turns.get(sessionId);
    if (existing !== undefined && !existing.settled) {
      return existing;
    }
    return this.#beginTurn(sessionId);
  }

  #beginTurn(sessionId: string): Turn {
    let settleOk: (result: AdapterTurnResult) => void = () => {};
    let settleFail: (error: unknown) => void = () => {};
    const promise = new Promise<AdapterTurnResult>((resolve, reject) => {
      settleOk = resolve;
      settleFail = reject;
    });
    // 没人等这个 promise 时也不该产生 unhandled rejection
    promise.catch(() => {});
    const turn: Turn = {
      promise,
      result: null,
      settled: false,
      resolve: (result) => {
        if (turn.settled) {
          return;
        }
        turn.settled = true;
        turn.result = result;
        settleOk(result);
      },
      reject: (error) => {
        if (turn.settled) {
          return;
        }
        turn.settled = true;
        settleFail(error);
      },
    };
    this.#turns.set(sessionId, turn);
    return turn;
  }

  #settleTurn(sessionId: string, result: AdapterTurnResult): void {
    const turn = this.#turns.get(sessionId);
    if (turn === undefined) {
      // 没有在跑的回合（如 session/resume 的快照）：只更新状态，不造回合
      return;
    }
    turn.resolve(result);
  }

  #markDown(reason: string): void {
    if (this.#down) {
      return;
    }
    this.#down = true;
    this.#downReason = reason;
    const error = this.#downError("adapter 状态");
    for (const turn of this.#turns.values()) {
      turn.reject(error);
    }
    this.#emit({ kind: "error", id: this.#nextId(), text: reason, raw: { reason } });
  }

  #killChild(): void {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return;
    }
    try {
      this.#child.kill();
    } catch {
      // 进程已消失
    }
  }

  #assertAlive(label: string): void {
    if (this.#down || this.#disposed) {
      throw this.#downError(label);
    }
  }

  #downError(label: string): WorkbenchError {
    return new WorkbenchError("E_ADAPTER_DOWN", label + " 失败：adapter 已退出（" + this.#downReason + "）", {
      reason: this.#downReason,
      stderr: this.#stderrTail(),
    });
  }

  /** 失败归一：WorkbenchError 原样；活着的 agent 明确报错 → E_BAD_REQUEST；其余按 adapter down */
  #adaptError(error: unknown, label: string): WorkbenchError {
    if (isWorkbenchError(error)) {
      return error;
    }
    if (this.#down) {
      return this.#downError(label);
    }
    if (isJsonRpcFailure(error)) {
      return new WorkbenchError("E_BAD_REQUEST", label + " 被 agent 拒绝：" + error.message, {
        method: label,
        code: error.code,
        data: error.data,
      });
    }
    return this.#downError(label);
  }

  #stderrTail(): string {
    return this.#stderr.join("\n");
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

/** 超时哨兵：Promise.race 里区分「超时」与真实结果 */
const RACE_TIMEOUT = Symbol("adapter-race-timeout");
type RaceTimeout = typeof RACE_TIMEOUT;

function isRaceTimeout(value: unknown): value is RaceTimeout {
  return value === RACE_TIMEOUT;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {};
  let rejectFn: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  promise.catch(() => {});
  return { promise, resolve: resolveFn, reject: rejectFn };
}

/** 定时器不 unref 会拖住进程退出（测试最容易踩） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function appendStderr(lines: string[], chunk: Buffer): void {
  const text = chunk.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    lines.push(line);
  }
  while (lines.length > STDERR_MAX_LINES) {
    lines.shift();
  }
}

/**
 * R12：session/update 的 v2 标签 → AdapterUpdate。
 * 未列出的标签一律返回 null（忽略），原文仍可从 raw 拿到。
 * 入参走 unknown + 手工收窄：SDK 的 SessionUpdate 联合里带 UnknownVariant，switch 收不出字段。
 */
export function mapSessionUpdate(update: unknown, nextId: () => string): AdapterUpdate | null {
  const record = asRecord(update);
  if (record === null) {
    return null;
  }
  const tag = optionalString(record["sessionUpdate"]);
  switch (tag) {
    case "agent_message_chunk":
    case "agent_message":
      return { kind: "text", id: resolveId(record, nextId), text: joinText(record["content"]), raw: update };
    case "agent_thought_chunk":
    case "agent_thought":
      return { kind: "thought", id: resolveId(record, nextId), text: joinText(record["content"]), raw: update };
    case "tool_call_update": {
      const status = optionalString(record["status"]);
      const finished = status === "completed" || status === "failed" || status === "cancelled";
      return {
        kind: finished ? "tool_result" : "tool_call",
        id: resolveId(record, nextId),
        toolName: optionalString(record["name"]) ?? optionalString(record["title"]),
        raw: update,
      };
    }
    case "tool_call_content_chunk":
      return { kind: "tool_call", id: resolveId(record, nextId), raw: update };
    case "state_update":
      return { kind: "state", id: resolveId(record, nextId), state: mapState(record["state"]), raw: update };
    case "notice": {
      const level = optionalString(record["severity"]) ?? optionalString(record["level"]);
      if (level !== "error") {
        return null;
      }
      return {
        kind: "error",
        id: resolveId(record, nextId),
        text: optionalString(record["title"]) ?? optionalString(record["message"]) ?? "",
        raw: update,
      };
    }
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** R12：id 优先 messageId / toolCallId / updateId，全缺才用递增兜底 id */
function resolveId(record: Record<string, unknown>, nextId: () => string): string {
  return (
    optionalString(record["messageId"]) ??
    optionalString(record["toolCallId"]) ??
    optionalString(record["updateId"]) ??
    nextId()
  );
}
/** R13：permissionMode → 自动应答 */
function permissionOutcome(
  mode: PermissionMode,
  options: ReadonlyArray<{ optionId: string; kind: string }>,
): RequestPermissionResponse {
  if (mode === "deny") {
    return { outcome: { outcome: "cancelled" } };
  }
  const chosen =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind.startsWith("allow")) ??
    options[0];
  if (chosen === undefined) {
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId: chosen.optionId } };
}

function mapState(state: unknown): SessionStatus {
  if (state === "running") {
    return "running";
  }
  if (state === "idle") {
    return "idle";
  }
  if (state === "requires_action") {
    return "needs-input";
  }
  return "unknown";
}

/** 内容块可能是单个对象或数组；只取 text 块的文本，其它块（图片/资源）忽略 */
function joinText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(blockText).join("");
  }
  return blockText(value);
}

function blockText(block: unknown): string {
  const record = asRecord(block);
  if (record === null || record["type"] !== "text") {
    return "";
  }
  return optionalString(record["text"]) ?? "";
}

function isJsonRpcFailure(value: unknown): value is JsonRpcFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { code?: unknown; message?: unknown };
  return typeof record.code === "number" && typeof record.message === "string";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
