/**
 * PiDriver（0.5-B B04）：用 Pi 包导出的 RpcClient 驱动 `pi --mode rpc` 子进程。
 *
 * 口径（规格 §9）：
 * - 动态 import `@earendil-works/pi-coding-agent`（运行时解析，不把 daemon 绑在 pi 内部 API 上）；
 * - attach：以 `--session <abs file>` 拉起 RPC 子进程；resume：已有客户端走 `switch_session`；
 * - inject → `prompt`（运行中可选 `steer`），interrupt → `abort`，handoff → `pi --session <file>`；
 * - **所有外部子进程调用都带超时**，失败一律 `E_ADAPTER_DOWN`，并清理子进程；
 * - A11 实测 Pi 无文件锁：所有写操作先经 LeaseManager 抢租约，第二写者 `E_LEASE_CONFLICT`，
 *   且必须在拉起/复用 RPC 进程之前失败。
 *
 * 测试注入 `createRpcClient`；生产默认动态 import 包内 `dist/index.js` 的 RpcClient。
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { SessionCaps, SessionRef } from "@pi-workbench/shared";

import type { AdapterUpdate } from "../adapters/types.ts";
import { capsOf } from "../capabilities.ts";
import { discoverPiSessions } from "../discover/pi.ts";
import { isWorkbenchError, WorkbenchError } from "../errors.ts";
import type { LeaseManager } from "../lease.ts";
import type { AgentDriver, DiscoverOptions, HandoffCommand } from "./types.ts";

/** 与 Pi RpcClientOptions 同形；单独声明避免测试 / build 时必须解析 pi 包类型。 */
export type PiRpcClientOptions = {
  cliPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  provider?: string;
  model?: string;
  args?: string[];
};

export type PiRpcEvent = Record<string, unknown>;

/** Pi RpcClient 的最小结构契约（真实 RpcClient 可直接赋值给这个接口）。 */
export interface PiRpcClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: PiRpcEvent) => void): () => void;
  prompt(message: string, images?: unknown[], streamingBehavior?: "steer" | "followUp"): Promise<string>;
  abort(): Promise<void>;
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
  /** 新建会话（Pi 的 new_session 只返回 cancelled，id / 文件要再查 getState） */
  newSession?(): Promise<{ cancelled: boolean }>;
  getState(): Promise<{ sessionId: string; sessionFile?: string; isStreaming?: boolean }>;
}

export type PiProviderStatus = {
  available: boolean;
  /** available=false 时机器可读原因，例如 "E_AGENT_UNAVAILABLE: pi provider 402" */
  reason?: string;
};

export type PiDriverOptions = {
  /** 写操作必须持有的租约管理器（与 Claude 同一套） */
  lease: LeaseManager;
  /** 本 driver 的写者身份；必须与上层接管者一致 */
  clientId: string;
  /** 覆盖 ~/.pi/agent/sessions（测试用） */
  sessionsRoot?: string;
  /** 覆盖 pi 包内 dist/cli.js 绝对路径（测试 / 定制安装用） */
  cliPath?: string;
  /** 启动命令（config.pi.rpcCmd，默认 ["pi","--mode","rpc"]）；首项为绝对路径时覆盖 cliPath */
  rpcCmd?: string[];
  provider?: string;
  model?: string;
  env?: Record<string, string>;
  /** 单次 RPC 调用超时（毫秒），默认 30s */
  timeoutMs?: number;
  /** 租约 TTL；缺省走 LeaseManager 默认值 */
  leaseTtlMs?: number;
  /** D6 预检结果或运行时降级状态 */
  providerStatus?: PiProviderStatus;
  /** 测试注入假 RpcClient；生产不传，走动态 import */
  createRpcClient?: (options: PiRpcClientOptions) => PiRpcClientLike | Promise<PiRpcClientLike>;
};

export const DEFAULT_PI_RPC_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 2_000;

type RpcClientCtor = new (options?: PiRpcClientOptions) => PiRpcClientLike;
type ClientRecord = { client: PiRpcClientLike; transcriptPath: string };

export class PiDriver implements AgentDriver {
  readonly agent = "pi";
  readonly #lease: LeaseManager;
  readonly #clientId: string;
  readonly #sessionsRoot: string | undefined;
  readonly #cliPath: string | undefined;
  readonly #rpcCmd: string[] | undefined;
  readonly #provider: string | undefined;
  readonly #model: string | undefined;
  readonly #env: Record<string, string> | undefined;
  readonly #timeoutMs: number;
  readonly #leaseTtlMs: number | undefined;
  readonly #createRpcClient: PiDriverOptions["createRpcClient"];
  readonly #clients = new Map<string, ClientRecord>();
  readonly #listeners = new Set<(update: AdapterUpdate) => void>();
  #providerStatus: PiProviderStatus;
  #updateSeq = 0;
  #messageSeq = 0;
  #disposed = false;

  constructor(options: PiDriverOptions) {
    if (options.clientId.trim().length === 0) {
      throw new WorkbenchError("E_BAD_REQUEST", "PiDriver 需要非空 clientId", { clientId: options.clientId });
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_PI_RPC_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new WorkbenchError("E_BAD_REQUEST", "PiDriver timeoutMs 必须是正数", { timeoutMs });
    }
    this.#lease = options.lease;
    this.#clientId = options.clientId;
    this.#sessionsRoot = options.sessionsRoot;
    this.#cliPath = options.cliPath;
    this.#rpcCmd = options.rpcCmd;
    this.#provider = options.provider;
    this.#model = options.model;
    this.#env = options.env;
    this.#timeoutMs = timeoutMs;
    this.#leaseTtlMs = options.leaseTtlMs;
    this.#createRpcClient = options.createRpcClient;
    this.#providerStatus = options.providerStatus ?? { available: true };
  }

  /** 能力矩阵是唯一裁决源；provider 402 时降级为 see/dispatch-only（不装假能力）。 */
  get caps(): SessionCaps {
    if (this.#providerStatus.available) {
      return { ...capsOf("pi") };
    }
    return {
      stream: false,
      inject: false,
      interrupt: false,
      attach: false,
      resume: false,
      transcript: true,
      permissions: false,
      background: false,
    };
  }

  async discover(opts: DiscoverOptions = {}): Promise<SessionRef[]> {
    const refs = await discoverPiSessions({
      ...(this.#sessionsRoot === undefined ? {} : { sessionsRoot: this.#sessionsRoot }),
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    });
    // 发现结果的能力声明必须跟 driver 当前状态一致（provider 402 时不能给假能力）
    return refs.map((ref) => ({ ...ref, capabilities: this.caps }));
  }

  /** attach = 首次建立控制通道：以 --session <file> 拉起新 RPC 子进程（不抢占运行中进程）。 */
  async attach(ref: SessionRef): Promise<void> {
    this.#assertNotDisposed();
    const transcriptPath = transcriptPathOf(ref);
    if (this.#clients.has(ref.key)) {
      return;
    }
    const client = await this.#createClient(ref, transcriptPath);
    this.#clients.set(ref.key, { client, transcriptPath });
    await this.#call(ref, "attach", async () => {
      await client.start();
      await client.getState();
    });
  }

  /** resume = 接管已存在会话：已有客户端 → switch_session；否则等价于重新 attach。 */
  async resume(ref: SessionRef): Promise<void> {
    this.#assertProvider();
    this.#claim(ref);
    const transcriptPath = transcriptPathOf(ref);
    const existing = this.#clients.get(ref.key);
    if (existing === undefined) {
      await this.attach(ref);
      return;
    }
    const result = await this.#call(ref, "switch_session", () => existing.client.switchSession(transcriptPath));
    if (result.cancelled) {
      throw new WorkbenchError("E_RESUME_REJECTED", "Pi 拒绝切换会话：" + ref.key, {
        sessionKey: ref.key,
        sessionPath: transcriptPath,
      });
    }
    this.#clients.set(ref.key, { client: existing.client, transcriptPath });
  }

  /** inject → prompt；排队返回 queued 时标 next_turn。运行中不擅自改 steer，保持默认 prompt。 */
  async inject(ref: SessionRef, text: string): Promise<{ messageId: string; effective: "now" | "next_turn" }> {
    this.#assertProvider();
    this.#claim(ref);
    const client = await this.#ensureClient(ref);
    const disposition = await this.#call(ref, "prompt", () => client.prompt(text));
    return {
      messageId: ref.key + ":msg-" + String(++this.#messageSeq),
      effective: disposition === "queued" ? "next_turn" : "now",
    };
  }

  /** interrupt → abort；返回归一化的 stopReason。 */
  async interrupt(ref: SessionRef): Promise<{ stopReason: string }> {
    this.#assertProvider();
    this.#claim(ref);
    const client = await this.#ensureClient(ref);
    await this.#call(ref, "abort", () => client.abort());
    return { stopReason: "aborted" };
  }

  /** handoff 出口：原生终端打开同一 session 文件（A12 实测能看到历史）。 */
  async handoff(ref: SessionRef): Promise<HandoffCommand> {
    this.#claim(ref);
    // 先断开 RPC 子进程：否则人类终端与 daemon 会同时写同一个 session jsonl（A11：Pi 无文件锁）。
    await this.#dropClient(ref.key);
    return { command: ["pi", "--session", transcriptPathOf(ref)], mode: "resume-tui" };
  }

  onUpdate(cb: (update: AdapterUpdate) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const keys = [...this.#clients.keys()];
    await Promise.all(keys.map((key) => this.#dropClient(key)));
    this.#listeners.clear();
  }

  async #ensureClient(ref: SessionRef): Promise<PiRpcClientLike> {
    const existing = this.#clients.get(ref.key);
    if (existing !== undefined) {
      return existing.client;
    }
    await this.attach(ref);
    const created = this.#clients.get(ref.key);
    if (created === undefined) {
      throw new WorkbenchError("E_ADAPTER_DOWN", "Pi RPC 客户端未建立：" + ref.key, { sessionKey: ref.key });
    }
    return created.client;
  }

  async #createClient(ref: SessionRef, transcriptPath?: string): Promise<PiRpcClientLike> {
    const options: PiRpcClientOptions = {
      cliPath: this.#cliPath ?? this.#cliPathOfRpcCmd() ?? resolveDefaultPiCliPath(),
      cwd: ref.cwd,
      args: [...this.#extraRpcArgs(), ...(transcriptPath === undefined ? [] : ["--session", transcriptPath])],
      ...(this.#env === undefined ? {} : { env: this.#env }),
      ...(this.#provider === undefined ? {} : { provider: this.#provider }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
    };
    let client: PiRpcClientLike;
    if (this.#createRpcClient !== undefined) {
      client = await this.#createRpcClient(options);
    } else {
      const Ctor = await loadPiRpcClient();
      client = new Ctor(options);
    }
    client.onEvent((event) => {
      this.#emit(event);
    });
    return client;
  }

  /** config.pi.rpcCmd 的首项是绝对路径时用它覆盖默认 cli.js（其余参数见 #extraRpcArgs）。 */
  #cliPathOfRpcCmd(): string | undefined {
    const first = this.#rpcCmd?.[0];
    return first !== undefined && first.trim().length > 0 && existsSync(first) ? first : undefined;
  }

  /** rpcCmd 里除可执行文件与 "--mode rpc" 之外的参数原样透传。 */
  #extraRpcArgs(): string[] {
    if (this.#rpcCmd === undefined) {
      return [];
    }
    const rest = this.#rpcCmd.slice(1);
    const args: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === undefined) {
        continue;
      }
      if (arg === "--mode") {
        index += 1; // 跳过紧随其后的 "rpc"
        continue;
      }
      args.push(arg);
    }
    return args;
  }

  /**
   * 新建会话：先拉起不带 --session 的 RPC 子进程，再 new_session + get_state。
   * Pi 的 new_session 只返回 {cancelled}，真正的 sessionId / sessionFile 从 get_state 取。
   */
  async newSession(cwd: string): Promise<{ sessionId: string; transcriptPath?: string }> {
    this.#assertProvider();
    this.#assertNotDisposed();
    const pseudo: SessionRef = {
      key: "pi:pending",
      agent: "pi",
      nativeId: "pending",
      cwd,
      status: "starting",
      driver: "pi",
      capabilities: this.caps,
      kind: "interactive",
    };
    const client = await this.#createClient(pseudo);
    await client.start();
    try {
      if (client.newSession === undefined) {
        throw new WorkbenchError("E_CAP_UNSUPPORTED", "Pi RpcClient 不支持 new_session", { agent: "pi" });
      }
      const opened = await withTimeout(client.newSession(), this.#timeoutMs, "Pi RPC new_session");
      if (opened.cancelled) {
        throw new WorkbenchError("E_ADAPTER_DOWN", "Pi new_session 被取消", { agent: "pi" });
      }
      const state = await withTimeout(client.getState(), this.#timeoutMs, "Pi RPC get_state");
      const sessionId = state.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new WorkbenchError("E_ADAPTER_DOWN", "Pi new_session 后 get_state 没有 sessionId", { agent: "pi" });
      }
      const transcriptPath = typeof state.sessionFile === "string" && state.sessionFile.length > 0 ? state.sessionFile : undefined;
      this.#clients.set("pi:" + sessionId, { client, transcriptPath: transcriptPath ?? "" });
      return { sessionId, ...(transcriptPath === undefined ? {} : { transcriptPath }) };
    } catch (error) {
      try {
        await withTimeout(client.stop(), STOP_TIMEOUT_MS, "Pi RPC stop（new_session）");
      } catch {
        // 已清理或进程已退出
      }
      throw error;
    }
  }

  /** handoff 前释放控制通道：停掉 RPC 子进程，避免人类终端与 daemon 同时写同一个 jsonl。 */
  async close(ref: SessionRef): Promise<void> {
    await this.#dropClient(ref.key);
  }

  /**
   * 写操作租约：先 acquire（他人持有 → E_LEASE_CONFLICT），再 assertWriter。
   * acquire 也承担「接管前拿 lease」；同一 clientId 重复 acquire 只是续期。
   */
  #claim(ref: SessionRef): void {
    this.#assertNotDisposed();
    this.#lease.acquire(ref.key, "pi", this.#clientId, this.#leaseTtlMs);
    this.#lease.assertWriter(ref.key, this.#clientId);
  }

  #assertProvider(): void {
    if (!this.#providerStatus.available) {
      throw new WorkbenchError(
        "E_CAP_UNSUPPORTED",
        this.#providerStatus.reason ?? "E_AGENT_UNAVAILABLE: Pi provider 不可用",
        { agent: "pi", reason: this.#providerStatus.reason },
      );
    }
  }

  async #call<T>(ref: SessionRef, action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(fn(), this.#timeoutMs, "Pi RPC " + action + "（" + ref.key + "）");
    } catch (error) {
      await this.#dropClient(ref.key);
      this.#noteProviderFailure(error);
      if (isWorkbenchError(error)) {
        throw error;
      }
      throw new WorkbenchError("E_ADAPTER_DOWN", "Pi RPC " + action + " 失败：" + errorMessage(error), {
        sessionKey: ref.key,
      });
    }
  }

  async #dropClient(sessionKey: string): Promise<void> {
    const record = this.#clients.get(sessionKey);
    if (record === undefined) {
      return;
    }
    this.#clients.delete(sessionKey);
    try {
      await withTimeout(record.client.stop(), STOP_TIMEOUT_MS, "Pi RPC stop（" + sessionKey + "）");
    } catch {
      // 清理失败不覆盖原始错误；子进程由 RpcClient.stop 内部 SIGKILL 兜底
    }
  }

  #noteProviderFailure(error: unknown): void {
    if (!this.#providerStatus.available) {
      return;
    }
    const message = errorMessage(error);
    if (isProviderBalanceFailure(message)) {
      this.#providerStatus = {
        available: false,
        reason: "E_AGENT_UNAVAILABLE: Pi provider 402（" + message.slice(0, 160) + "）",
      };
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new WorkbenchError("E_ADAPTER_DOWN", "PiDriver 已 dispose", { agent: "pi" });
    }
  }

  #emit(event: unknown): void {
    let update: AdapterUpdate | null;
    try {
      update = normalizePiEvent(event, "pi-u" + String(++this.#updateSeq));
    } catch {
      return;
    }
    if (update === null) {
      return;
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(update);
      } catch {
        // 单个订阅者异常不影响其他订阅者 / 事件循环
      }
    }
  }
}

/** 解析 Pi 包根目录：优先 node 解析包入口，其次常见全局安装位置（Windows npm / Linux）。 */
export function resolvePiPackageDir(): string | null {
  try {
    // 不能直接 resolve <pkg>/package.json：Pi 的 exports 未暴露 package.json，会报
    // ERR_PACKAGE_PATH_NOT_EXPORTED；先解析包入口再向上找 package.json。
    const entry = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
    const dir = packageRootOf(entry);
    if (dir !== null) {
      return dir;
    }
  } catch {
    // 未作为本地依赖安装：继续找全局安装
  }
  const candidates: string[] = [];
  const appData = process.env.APPDATA;
  if (appData !== undefined && appData.length > 0) {
    candidates.push(join(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent"));
  }
  candidates.push(join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent"));
  candidates.push(join(homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent"));
  candidates.push(join(dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent"));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "dist", "cli.js"))) {
      return candidate;
    }
  }
  return null;
}

/** 从包入口向上找 name 匹配的 package.json 所在目录。 */
function packageRootOf(entryPath: string): string | null {
  let dir = dirname(entryPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        if (isJsonObject(pkg) && pkg.name === "@earendil-works/pi-coding-agent") {
          return dir;
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

/** 默认 CLI 入口：包内 dist/cli.js 绝对路径（RpcClient 默认相对路径会解析失败）。 */
export function resolveDefaultPiCliPath(): string {
  const dir = resolvePiPackageDir();
  if (dir === null) {
    throw new WorkbenchError(
      "E_AGENT_UNAVAILABLE",
      "找不到 @earendil-works/pi-coding-agent（需要本机安装 pi 包）",
      { specifier: "@earendil-works/pi-coding-agent" },
    );
  }
  return join(dir, "dist", "cli.js");
}

/** 懒加载 RpcClient：只在真实路径 import，测试注入 createRpcClient 时不触碰 pi 包。 */
async function loadPiRpcClient(): Promise<RpcClientCtor> {
  const dir = resolvePiPackageDir();
  if (dir === null) {
    throw new WorkbenchError("E_AGENT_UNAVAILABLE", "找不到 @earendil-works/pi-coding-agent", {
      specifier: "@earendil-works/pi-coding-agent",
    });
  }
  const moduleUrl = pathToFileURL(join(dir, "dist", "index.js")).href;
  const loaded: unknown = await import(moduleUrl);
  if (!isJsonObject(loaded) || typeof loaded.RpcClient !== "function") {
    throw new WorkbenchError("E_AGENT_UNAVAILABLE", "Pi 包没有导出 RpcClient", { moduleUrl });
  }
  return loaded.RpcClient as RpcClientCtor;
}

/** 把 Pi RPC 事件流归一化成 AdapterUpdate；未知事件返回 null（只跳过，不抛）。 */
export function normalizePiEvent(event: unknown, id: string): AdapterUpdate | null {
  if (!isJsonObject(event)) {
    return null;
  }
  const type = event.type;
  if (type === "message_update") {
    const inner = event.assistantMessageEvent;
    if (!isJsonObject(inner)) {
      return null;
    }
    if (inner.type === "text_delta" && typeof inner.delta === "string" && inner.delta.length > 0) {
      return { kind: "text", id, text: inner.delta, raw: event };
    }
    if (inner.type === "thinking_delta" && typeof inner.delta === "string" && inner.delta.length > 0) {
      return { kind: "thought", id, text: inner.delta, raw: event };
    }
    if (inner.type === "toolcall_start" && typeof inner.toolName === "string") {
      return { kind: "tool_call", id, text: "", toolName: inner.toolName, raw: event };
    }
    return null;
  }
  if (type === "tool_execution_start") {
    return {
      kind: "tool_call",
      id,
      text: stringifyUnknown(event.args),
      ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
      raw: event,
    };
  }
  if (type === "tool_execution_end") {
    return {
      kind: "tool_result",
      id,
      text: stringifyUnknown(event.result),
      ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
      raw: event,
    };
  }
  if (type === "agent_start" || type === "auto_retry_start") {
    return { kind: "state", id, state: "running", raw: event };
  }
  if (type === "agent_settled") {
    return { kind: "state", id, state: "idle", raw: event };
  }
  if (type === "auto_retry_end" || type === "compaction_start" || type === "compaction_end") {
    return { kind: "state", id, state: "running", raw: event };
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, action: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new WorkbenchError("E_ADAPTER_DOWN", action + " 超时（" + String(ms) + "ms）", { action, ms }));
    }, ms);
    timer?.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function transcriptPathOf(ref: SessionRef): string {
  const path = ref.transcriptPath;
  if (path === undefined || path.length === 0) {
    throw new WorkbenchError("E_BAD_REQUEST", "Pi 会话缺少 transcriptPath：" + ref.key, { sessionKey: ref.key });
  }
  return path;
}

function isProviderBalanceFailure(message: string): boolean {
  return /\b402\b|payment required|insufficient (?:balance|credit|quota)|余额不足|欠费/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
