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
/** 会话级 RPC（newSession / resume / close）上限：agent 不回就按 adapter down 失败，不挂起（M8） */
const SESSION_CALL_TIMEOUT_MS = 10_000;
/** #downReason 的初始占位值：还是它说明真实原因得从底层 cause 取（I2） */
const PLACEHOLDER_DOWN_REASON = "未启动";

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
  /** 「adapter 挂掉」的一次性订阅者：每个 RPC 挂一枚，结束就摘（M6：不许随回合累积） */
  readonly #downWaiters = new Set<(error: WorkbenchError) => void>();
  #updateSeq = 0;
  #down = false;
  #downReason = PLACEHOLDER_DOWN_REASON;
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

    // I2：先标 down 再放行 #exit。反过来的话，stdio 关闭引出的请求拒绝会先到 #adaptError，
    // 那时 #down 还是 false，错误文案只剩占位 reason「未启动」。
    child.on("exit", (code, signal) => {
      this.#markDown("子进程退出（code=" + String(code) + ", signal=" + String(signal) + "）");
      this.#exit.resolve();
    });
    child.on("error", (error: Error) => {
      this.#markDown("子进程不可用：" + error.message);
      this.#exit.resolve();
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
    const response = await this.#await(
      "newSession",
      () => this.#conn.agent.request(methods.agent.session.new, { cwd }),
      SESSION_CALL_TIMEOUT_MS,
    );
    return { sessionId: response.sessionId };
  }

  async resume(sessionId: string, cwd: string): Promise<void> {
    try {
      await this.#await(
        "resume",
        () => this.#conn.agent.request(methods.agent.session.resume, { sessionId, cwd }),
        SESSION_CALL_TIMEOUT_MS,
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

    let accepted: unknown = null;
    try {
      accepted = await this.#race("prompt", request, {
        timeoutMs: PROMPT_ACCEPT_TIMEOUT_MS,
        swallowTimeout: true,
      });
    } catch (error) {
      // 请求失败已在 then 里 reject 过回合；这里把同一错误抛给调用方
      throw this.#adaptError(error, "prompt");
    }
    // M7：受理响应若已经给了 messageId 就以它为准；没拿到（受理超时）才自造 msg_<uuid>。
    // R11 允许自造 id 后不回填：这里不会因为晚到的响应再改 messageId。
    const responseRecord = asRecord(accepted);
    const messageId =
      (responseRecord === null ? undefined : optionalString(responseRecord["messageId"])) ??
      "msg_" + randomUUID();
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
    await this.#await(
      "close",
      () => this.#conn.agent.request(methods.agent.session.close, { sessionId }),
      SESSION_CALL_TIMEOUT_MS,
    );
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
    // 单次等子进程退出：不走 #race（#markDown 已把 down 订阅清空，走了会立刻返回）
    await raceWithTimeout(this.#exit.promise, DISPOSE_WAIT_MS);
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
   *
   * M6：退出订阅和定时器都在 finally 里摘掉 / clearTimeout。之前每回合挂一枚 120s 定时器
   * 且 `#exit.promise.then` 永不摘除，长会话里会一直累积。
   */
  async #race<T>(
    label: string,
    promise: Promise<T>,
    options: { timeoutMs?: number; timeoutNote?: string; swallowTimeout?: boolean } = {},
  ): Promise<T | null> {
    const down = this.#downRace(label);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const racers: Array<Promise<T | never | RaceTimeout>> = [promise, down.promise];
      const timeoutMs = options.timeoutMs;
      if (timeoutMs !== undefined) {
        racers.push(
          new Promise<RaceTimeout>((resolve) => {
            timer = setTimeout(() => {
              resolve(RACE_TIMEOUT);
            }, timeoutMs);
            timer.unref();
          }),
        );
      }
      const settled = await Promise.race(racers);
      if (isRaceTimeout(settled)) {
        if (options.swallowTimeout === true) {
          return null;
        }
        throw new WorkbenchError(
          "E_ADAPTER_DOWN",
          label + " timeout：" + (options.timeoutNote ?? "adapter 无响应") + "（" + String(options.timeoutMs) + "ms）",
          {
            reason: options.timeoutNote === "turn timeout" ? "turn_timeout" : "timeout",
            label,
            timeoutMs: options.timeoutMs,
            stderr: this.#stderrTail(),
          },
        );
      }
      return settled;
    } finally {
      down.detach();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /** 订阅「adapter 挂掉」；返回的 detach 必须调用，否则每回合都会留一枚订阅（M6） */
  #downRace(label: string): { promise: Promise<never>; detach: () => void } {
    let detach = (): void => {};
    const promise = new Promise<never>((_resolve, reject) => {
      if (this.#down || this.#disposed) {
        reject(this.#downError(label));
        return;
      }
      const waiter = (error: WorkbenchError): void => {
        reject(error);
      };
      this.#downWaiters.add(waiter);
      detach = () => {
        this.#downWaiters.delete(waiter);
      };
    });
    // 输掉 race 且之后才挂掉时不会有人 await 它，兜一层避免 unhandled rejection
    promise.catch(() => {});
    return { promise, detach };
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
    const record = asRecord(update);
    if (record === null || record["sessionUpdate"] !== "state_update" || record["state"] !== "idle") {
      return;
    }
    const stopReason = optionalString(record["stopReason"]) ?? "unknown";
    if (stopReason === "error") {
      // C1：回合失败绝不能被当成成功。先 emit kind:"error"（监听者先看到原因），再 reject 该回合。
      const failure = turnFailureMessage(record);
      this.#emit({ kind: "error", id: this.#nextId(), text: failure, raw: update });
      this.#failTurn(
        params.sessionId,
        new WorkbenchError("E_BAD_REQUEST", "回合失败：" + failure, {
          sessionId: params.sessionId,
          stopReason,
        }),
      );
      return;
    }
    this.#settleTurn(params.sessionId, { stopReason });
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

  /** C1：回合失败 → reject 该回合（失败路径绝不 resolve） */
  #failTurn(sessionId: string, error: WorkbenchError): void {
    const turn = this.#turns.get(sessionId);
    if (turn === undefined) {
      return;
    }
    turn.reject(error);
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
    // 订阅者一次性兑现后清空：下一轮 RPC 会重新挂，不会累积（M6）
    const waiters = [...this.#downWaiters];
    this.#downWaiters.clear();
    for (const waiter of waiters) {
      waiter(error);
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

  /**
   * adapter down 的统一错误。
   * I2：`#downReason` 还是占位值时（子进程正在退出、真实原因还没落进 #downReason），
   * 改用底层 cause 的文案；错误信息一律带 stderr 尾部，握手失败才有可定位的线索。
   */
  #downError(label: string, cause?: unknown): WorkbenchError {
    const placeholder = this.#downReason === PLACEHOLDER_DOWN_REASON;
    const reason = placeholder && cause !== undefined ? describeError(cause) : this.#downReason;
    const stderr = this.#stderrTail();
    const suffix = stderr.length > 0 ? "\nstderr: " + stderr : "";
    return new WorkbenchError("E_ADAPTER_DOWN", label + " 失败：adapter 已退出（" + reason + "）" + suffix, {
      reason,
      stderr,
      ...(placeholder && cause !== undefined ? { underlying: describeError(cause) } : {}),
    });
  }

  /** 失败归一：WorkbenchError 原样；活着的 agent 明确报错 → E_BAD_REQUEST；其余按 adapter down */
  #adaptError(error: unknown, label: string): WorkbenchError {
    if (isWorkbenchError(error)) {
      return error;
    }
    if (this.#down) {
      return this.#downError(label, error);
    }
    if (isJsonRpcFailure(error)) {
      return new WorkbenchError("E_BAD_REQUEST", label + " 被 agent 拒绝：" + error.message, {
        method: label,
        code: error.code,
        data: error.data,
      });
    }
    return this.#downError(label, error);
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

/**
 * 和超时赛跑：超时返回 `undefined`（哨兵由调用方判断）。
 * M6：定时器必须 clearTimeout（否则每回合一枚会累积），还必须 unref（否则拖住进程退出）。
 */
async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
  // M5：只认 allow*。没有任何 allow 选项就回 cancelled——绝不拿 options[0]，
  // 那可能是 reject_once / reject_always，等于把「不允许」当成了允许。
  const chosen =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind.startsWith("allow"));
  if (chosen === undefined) {
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId: chosen.optionId } };
}

/** C1：`state_update{stopReason:"error"}` 里的 JSON-RPC 错误对象取文案，缺失时给兜底说明 */
function turnFailureMessage(record: Record<string, unknown>): string {
  const failure = asRecord(record["error"]);
  const detail = failure === null ? undefined : optionalString(failure["message"]);
  return detail ?? "agent 报告回合失败（stopReason=error）";
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
