#!/usr/bin/env node
/**
 * pi-workbench 命令入口。
 *
 * 两组职责：
 * - 进程管理（A02）：start / stop / status —— 起停 daemon，pid 身份靠 /health 自报的 pid 校验；
 * - 接管原语（A10 / Task 9）：sessions / see / inject / interrupt / handoff / handback / checkpoint，
 *   一律走 daemon 的 HTTP /api/cp/*（不在 CLI 里碰 SQLite / adapter，业务真相只有一个）。
 *
 * 退出码约定：0 成功；1 运行失败（打印 `<code>: <message>`）；2 用法错误（打印用法到 stderr）。
 * 只提交 argv 里的显式参数，不做隐式副作用（写操作的身份由 --client-id 明确指定）。
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type Config } from "./config.ts";
import { ensureDirs, isProcessAlive, readPidFile, resolvePaths } from "./paths.ts";

const START_HINT = "启动命令：pi-workbench start";

/** 全部子命令（--help 必须逐一列出；测试按这张表断言） */
export const SUBCOMMANDS = [
  "start",
  "stop",
  "status",
  "sessions",
  "see",
  "inject",
  "interrupt",
  "handoff",
  "handback",
  "checkpoint",
  "lease",
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export const USAGE = [
  "用法：pi-workbench <子命令> [参数]",
  "",
  "进程管理：",
  "  start                                        后台启动控制面（等到 /health 就绪）",
  "  stop                                         停止控制面（校验 /health 自报的 pid）",
  "  status                                       查看运行状态与 /health 响应",
  "",
  "接管原语（HTTP /api/cp/*）：",
  "  sessions [--agent A] [--status S] [--json]   列出会话",
  "  see <key> [--after 游标] [--limit N] [--json] 读 transcript 增量（只读）",
  "  lease <key> --action acquire|release|heartbeat --driver pi|human [--client-id ID] [--ttl-ms N]",
  "                                               取 / 续 / 放租约（写操作的前置条件），打印租约 JSON",
  "  inject <key> <文本...> [--client-id ID] [--json]",
  "                                               向会话注入一条用户消息",
  "  interrupt <key> [--client-id ID] [--json]    打断当前回合",
  "  checkpoint <key> --summary S [--next-step N] [--file F]... [--client-id ID] [--json]",
  "                                               写 checkpoint",
  "  handoff <key> [--to human|pi] [--summary S] [--next-step N] [--file F]... [--client-id ID] [--json]",
  "                                               交给人类（默认 human），打印接管命令",
  "  handback <key> [--client-id ID] [--json]     从人类手里接回（ID 用 GET /api/cp/sessions/<key> 的 lease.clientId）",
  "",
  "通用参数：",
  "  --url URL        控制面地址（默认 $PI_WORKBENCH_URL，再回落配置里的 host:port）",
  "  --token TOKEN    鉴权 token（默认 $PI_WORKBENCH_TOKEN，再回落配置里的 authToken）",
  "  --client-id ID   写操作身份（默认 cli:<pid>；必须与租约持有者一致，否则 E_NO_LEASE）",
  "  --json           输出原始 JSON",
  "  -h, --help       显示本帮助",
  "",
  "退出码：",
  "  0  成功",
  "  1  运行失败（stderr 打印 <code>: <message>，例如 E_NO_LEASE / E_DAEMON_DOWN）",
  "  2  用法错误（stderr 打印原因 + 本用法，stdout 不写）",
  "",
  "写操作需要租约：inject / interrupt / checkpoint / handoff / handback 都要求调用方持有该会话的租约，",
  "  否则 daemon 回 E_NO_LEASE（退出码 1）。先取租约：",
  "    pi-workbench lease <key> --action acquire --driver pi --client-id <id>",
  "  之后写操作带同一个 --client-id（省略时缺省 cli:<pid>，同一进程内取租约与写操作天然一致）。",
].join("\n");

/** 运行期失败：打印 `<code>: <message>`，退出码 1 */
export class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

/** 用法错误：打印原因 + 用法到 stderr，退出码 2 */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface HealthResult {
  ok: boolean;
  body: unknown;
}

/**
 * 可注入的运行时依赖（测试用假实现，避免真的开进程 / 真的发信号 / 真的发 HTTP）。
 * config 可传入已构造好的配置，方便测试隔离 home。
 */
export interface CliOptions {
  config?: Config;
  probeHealth?: (cfg: Config) => Promise<HealthResult>;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** 注入 fetch（测试用假 HTTP 服务） */
  fetch?: typeof fetch;
  /** 注入环境变量（隔离测试） */
  env?: NodeJS.ProcessEnv;
}

interface Deps {
  probeHealth: (cfg: Config) => Promise<HealthResult>;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** 探活地址：监听 0.0.0.0 / :: 时回落到本机回环 */
export function healthUrl(cfg: Config): string {
  return originOf(cfg) + "/health";
}

/** 控制面的 origin（不含路径）：监听通配地址时回落到本机回环 */
export function originOf(cfg: Config): string {
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  return "http://" + host + ":" + String(cfg.port);
}

/** 从 /health 响应体里取 pid；取不到返回 null */
export function readPidFromBody(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const pid = (body as { pid?: unknown }).pid;
  return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
}

async function probeHealth(cfg: Config): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(healthUrl(cfg), { signal: controller.signal });
    const body: unknown = await res.json();
    const ok = res.ok && typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
    return { ok, body };
  } catch {
    return { ok: false, body: null };
  } finally {
    clearTimeout(timer);
  }
}

function withDefaults(overrides: CliOptions = {}): Deps {
  return {
    probeHealth: overrides.probeHealth ?? probeHealth,
    isAlive: overrides.isAlive ?? isProcessAlive,
    kill: overrides.kill ?? ((pid, signal) => void process.kill(pid, signal)),
    log: overrides.log ?? ((line) => console.log(line)),
    error: overrides.error ?? ((line) => console.error(line)),
  };
}

function configOf(options: CliOptions): Config {
  return options.config ?? loadConfig(options.env ?? process.env);
}

function fetchOf(options: CliOptions): typeof fetch {
  return options.fetch ?? fetch;
}

async function waitForHealth(cfg: Config, timeoutMs: number, deps: Deps): Promise<HealthResult> {
  const deadline = Date.now() + timeoutMs;
  let last: HealthResult = { ok: false, body: null };
  while (Date.now() < deadline) {
    last = await deps.probeHealth(cfg);
    if (last.ok) return last;
    await new Promise((done) => setTimeout(done, 200));
  }
  return last;
}

async function waitForExit(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return !isAlive(pid);
}

/** daemon 入口：dist 下用 index.js；源码态（type stripping）用 index.ts */
function daemonEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "index.js");
  return existsSync(built) ? built : join(here, "index.ts");
}

export async function start(options: CliOptions = {}): Promise<number> {
  const deps = withDefaults(options);
  const cfg = configOf(options);
  const paths = resolvePaths(cfg.home);
  ensureDirs(paths);

  const running = readPidFile(paths.pid);
  if (running !== null && deps.isAlive(running)) {
    deps.error("E_ALREADY_RUNNING：控制面已在运行（pid " + String(running) + "，pid 文件 " + paths.pid + "）");
    return 1;
  }

  const logPath = join(paths.logs, "daemon.log");
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [daemonEntry()], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      cwd: process.cwd(),
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const health = await waitForHealth(cfg, 10_000, deps);
  if (!health.ok) {
    deps.error("启动失败：" + healthUrl(cfg) + " 在 10s 内没有健康响应，详见日志 " + logPath);
    return 1;
  }
  const pid = readPidFromBody(health.body) ?? readPidFile(paths.pid);
  deps.log("pi-workbenchd 已启动：" + healthUrl(cfg) + "（pid " + (pid === null ? "?" : String(pid)) + "）");
  return 0;
}

/**
 * 停止控制面。
 * pid 文件只证明「某个 pid」，不证明「这个 pid 是 pi-workbenchd」——pid 会被复用。
 * 所以发信号前必须用 /health 自报的 pid 做身份校验，不一致就不动手。
 */
export async function stop(options: CliOptions = {}): Promise<number> {
  const deps = withDefaults(options);
  const cfg = configOf(options);
  const paths = resolvePaths(cfg.home);

  const pid = readPidFile(paths.pid);
  if (pid === null || !deps.isAlive(pid)) {
    rmSync(paths.pid, { force: true });
    deps.log("控制面未在运行");
    return 0;
  }

  const health = await deps.probeHealth(cfg);
  if (!health.ok) {
    deps.error(
      "停止失败：pid 文件 " + paths.pid + " 里的 pid " + String(pid) + " 存活，但 " + healthUrl(cfg) +
        " 没有健康响应；无法确认它是 pi-workbenchd，为避免误杀无关进程，未发送任何信号。" +
        "确认后请手动处理或删除该 pid 文件。",
    );
    return 1;
  }

  const healthPid = readPidFromBody(health.body);
  if (healthPid !== pid) {
    deps.error(
      "停止失败：pid " + String(pid) + " 不是 pi-workbenchd（" + healthUrl(cfg) + " 自报 pid " +
        (healthPid === null ? "未知" : String(healthPid)) + "），pid 可能已被无关进程复用；" +
        "为避免误杀，未发送任何信号。确认后请手动处理或删除 pid 文件 " + paths.pid + "。",
    );
    return 1;
  }

  try {
    deps.kill(pid, "SIGTERM");
  } catch (err) {
    deps.error(
      "停止失败：无法向 pid " + String(pid) + " 发送 SIGTERM（" +
        (err instanceof Error ? err.message : String(err)) + "）",
    );
    return 1;
  }

  let exited = await waitForExit(pid, 8000, deps.isAlive);
  if (!exited) {
    try {
      deps.kill(pid, "SIGKILL");
    } catch {
      // 进程可能刚好退出，忽略
    }
    exited = await waitForExit(pid, 2000, deps.isAlive);
  }

  if (readPidFile(paths.pid) === pid) rmSync(paths.pid, { force: true });
  deps.log((exited ? "已停止" : "未能停止") + "（pid " + String(pid) + "）");
  return exited ? 0 : 1;
}

export async function status(options: CliOptions = {}): Promise<number> {
  const deps = withDefaults(options);
  const cfg = configOf(options);
  const paths = resolvePaths(cfg.home);

  const pid = readPidFile(paths.pid);
  if (pid === null) {
    deps.error("未运行：找不到 PID 文件 " + paths.pid);
    deps.error(START_HINT);
    return 1;
  }
  if (!deps.isAlive(pid)) {
    deps.error("未运行：pid 文件中的进程 " + String(pid) + " 已不存在（残留文件 " + paths.pid + "）");
    deps.error(START_HINT);
    return 1;
  }

  const health = await deps.probeHealth(cfg);
  if (!health.ok) {
    deps.error("运行中（pid " + String(pid) + "），但 " + healthUrl(cfg) + " 健康检查失败");
    deps.error(START_HINT);
    return 1;
  }

  deps.log("运行中：pid " + String(pid) + "，" + healthUrl(cfg));
  deps.log(JSON.stringify(health.body, null, 2));
  return 0;
}

// ---------------------------------------------------------------------------
// 接管原语：HTTP 客户端 + 子命令
// ---------------------------------------------------------------------------

type FlagValue = string | boolean;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, FlagValue>;
  /** 可重复参数（--file） */
  lists: Map<string, string[]>;
}

/** 需要取值的参数（其余带 -- 前缀的一律拒绝，避免把拼错的参数当无害） */
const VALUE_FLAGS = new Set([
  "url",
  "token",
  "client-id",
  "agent",
  "status",
  "after",
  "limit",
  "text",
  "summary",
  "next-step",
  "file",
  "to",
  "action",
  "driver",
  "ttl-ms",
]);

/** 布尔开关 */
const BOOLEAN_FLAGS = new Set(["json", "help"]);

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: new Map(), lists: new Map() };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) break;

    if (token === "-h") {
      parsed.flags.set("help", true);
      continue;
    }
    if (!token.startsWith("--")) {
      parsed.positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) {
        throw new UsageError("--" + name + " 不接受取值");
      }
      parsed.flags.set(name, true);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new UsageError("未知参数：--" + name);
    }

    const value = inline ?? args[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new UsageError("--" + name + " 需要一个值");
    }
    if (inline === undefined) index += 1;

    parsed.flags.set(name, value);
    if (name === "file") {
      const files = parsed.lists.get("file") ?? [];
      files.push(value);
      parsed.lists.set("file", files);
    }
  }

  return parsed;
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

/** 正整数参数：本地就挡住（交给服务端校验会变成 exit 1，而它其实是用法错误 exit 2） */
function positiveIntFlag(parsed: ParsedArgs, name: string, command: string): number | undefined {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError(command + " 的 --" + name + " 必须是正整数（收到：" + raw + "）");
  }
  return value;
}

function requireKey(parsed: ParsedArgs, command: Subcommand): string {
  const key = parsed.positionals[0];
  if (key === undefined || key.length === 0) {
    throw new UsageError(command + " 需要一个会话 key（形如 claude:<nativeId>）");
  }
  return key;
}

function clientIdOf(parsed: ParsedArgs): string {
  return stringFlag(parsed, "client-id") ?? "cli:" + String(process.pid);
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function preview(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

interface Endpoint {
  baseUrl: string;
  token: string | null;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** 地址：--url > $PI_WORKBENCH_URL > 配置文件；token：--token > $PI_WORKBENCH_TOKEN > 配置文件 */
function endpointOf(parsed: ParsedArgs, options: CliOptions): Endpoint {
  const env = options.env ?? process.env;
  const urlFlag = stringFlag(parsed, "url");
  const tokenFlag = stringFlag(parsed, "token");
  const explicitUrl = urlFlag ?? nonEmpty(env["PI_WORKBENCH_URL"]);
  const explicitToken = tokenFlag ?? nonEmpty(env["PI_WORKBENCH_TOKEN"]);

  let config: Config | null = null;
  const lazyConfig = (): Config => {
    if (config === null) {
      config = configOf(options);
    }
    return config;
  };

  const baseUrl = trimTrailingSlash(explicitUrl ?? originOf(lazyConfig()));
  const token = explicitToken ?? lazyConfig().authToken;
  return { baseUrl, token };
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorOf(status: number, payload: unknown): { code: string; message: string } {
  const body = recordOf(recordOf(payload)["error"]);
  const code = str(body, "code");
  const message = str(body, "message");
  return {
    code: code.length > 0 ? code : "E_HTTP_" + String(status),
    message: message.length > 0 ? message : "HTTP " + String(status),
  };
}

/** 一次 HTTP 往返：非 2xx → CliError(code, message)；连不上 → E_DAEMON_DOWN */
async function requestJson(
  endpoint: Endpoint,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const url = new URL(path, endpoint.baseUrl + "/");
  const headers: Record<string, string> = {};
  if (endpoint.token !== null && endpoint.token.length > 0) {
    headers["authorization"] = "Bearer " + endpoint.token;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    throw new CliError(
      "E_DAEMON_DOWN",
      "无法连接控制面 " + endpoint.baseUrl + "（" + (err instanceof Error ? err.message : String(err)) + "）。" + START_HINT,
    );
  }

  const payload = parseJson(await response.text());
  if (!response.ok) {
    const failure = errorOf(response.status, payload);
    throw new CliError(failure.code, failure.message);
  }
  return payload;
}

async function cmdSessions(parsed: ParsedArgs, options: CliOptions, deps: Deps): Promise<number> {
  const endpoint = endpointOf(parsed, options);
  const query = new URLSearchParams();
  const agent = stringFlag(parsed, "agent");
  const state = stringFlag(parsed, "status");
  if (agent !== undefined) query.set("agent", agent);
  if (state !== undefined) query.set("status", state);
  const suffix = query.toString().length === 0 ? "" : "?" + query.toString();

  const payload = await requestJson(endpoint, "GET", "/api/cp/sessions" + suffix, undefined, fetchOf(options));
  if (hasFlag(parsed, "json")) {
    deps.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const rows = listOf(payload).map(recordOf);
  if (rows.length === 0) {
    deps.log("（无会话）");
    return 0;
  }
  for (const row of rows) {
    deps.log(
      str(row, "key") + "  " + str(row, "status") + "  driver=" + str(row, "driver") + "  " + str(row, "cwd"),
    );
  }
  return 0;
}

async function cmdSee(parsed: ParsedArgs, options: CliOptions, deps: Deps): Promise<number> {
  const key = requireKey(parsed, "see");
  const endpoint = endpointOf(parsed, options);
  const query = new URLSearchParams();
  const after = stringFlag(parsed, "after");
  const limit = positiveIntFlag(parsed, "limit", "see");
  if (after !== undefined) query.set("after", after);
  if (limit !== undefined) query.set("limit", String(limit));
  const suffix = query.toString().length === 0 ? "" : "?" + query.toString();

  const payload = await requestJson(
    endpoint,
    "GET",
    "/api/cp/sessions/" + encodeURIComponent(key) + "/transcript" + suffix,
    undefined,
    fetchOf(options),
  );
  if (hasFlag(parsed, "json")) {
    deps.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const page = recordOf(payload);
  const messages = listOf(page["messages"]).map(recordOf);
  deps.log(String(messages.length) + " 条新消息，游标 " + str(page, "nextCursor"));
  for (const message of messages) {
    deps.log("[" + str(message, "role") + "/" + str(message, "kind") + "] " + preview(str(message, "text")));
  }
  return 0;
}

async function cmdInject(parsed: ParsedArgs, options: CliOptions, deps: Deps): Promise<number> {
  const key = requireKey(parsed, "inject");
  const rest = parsed.positionals.slice(1).join(" ");
  const text = stringFlag(parsed, "text") ?? (rest.length > 0 ? rest : undefined);
  if (text === undefined || text.trim().length === 0) {
    throw new UsageError("inject 需要注入文本：inject <key> <文本...> 或 --text <文本>");
  }

  const endpoint = endpointOf(parsed, options);
  const payload = await requestJson(
    endpoint,
    "POST",
    "/api/cp/sessions/" + encodeURIComponent(key) + "/inject",
    { text, clientId: clientIdOf(parsed) },
    fetchOf(options),
  );
  if (hasFlag(parsed, "json")) {
    deps.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  const result = recordOf(payload);
  deps.log(
    "已注入 " + key + "（effective=" + str(result, "effective") + "，messageId=" + str(result, "messageId") + "）",
  );
  return 0;
}

async function cmdInterrupt(parsed: ParsedArgs, options: CliOptions, deps: Deps): Promise<number> {
  const key = requireKey(parsed, "interrupt");
  const endpoint = endpointOf(parsed, options);
  const payload = await requestJson(
    endpoint,
    "POST",
    "/api/cp/sessions/" + encodeURIComponent(key) + "/interrupt",
    { clientId: clientIdOf(parsed) },
    fetchOf(options),
  );
  if (hasFlag(parsed, "json")) {
    deps.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  deps.log("已中断 " + key + "（stopReason=" + str(recordOf(payload), "stopReason") + "）");
  return 0;
}

async function cmdCheckpoint(parsed: ParsedArgs, options: CliOptions, deps: Deps): Promise<number> {
  const key = requireKey(parsed, "checkpoint");
  const summary = stringFlag(parsed, "summary");
  if (summary === undefined || summary.trim().length === 0) {
    throw new UsageError("checkpoint 需要 --summary <摘要>");
  }

  const endpoint = endpointOf(parsed, options);
  const payload = await requestJson(
    endpoint,
    "POST",
    "/api/cp/sessions/" + encodeURIComponent(key) + "/checkpoint",
    {
      clientId: clientIdOf(parsed),
      summary,
      nextStep: stringFlag(parsed, "next-step") ?? "",
      touchedFiles: parsed.lists.get("file") ?? [],
    },
    fetchOf(options),
  );
  if (hasFlag(parsed, "json")) {
    deps.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  const checkpoint = recordOf(payload);
  deps.log(
    "已写入 checkpoint：" + str(checkpoint, "sessionKey") + " @ " + str(checkpoint, "createdAt") +
      "（cursor=" + str(checkpoint, "transcriptCursor") + "）",
  );
  const nextStep = str(checkpoint, "nextStep");
  if (nextStep.length > 0) deps.log("下一步：" + preview(nextStep));
  return 0;
}

async function cmdHandoff(parsed: ParsedArgs, options: CliOptions, deps: Deps): Promise<number> {
  const key = requireKey(parsed, "handoff");
  const to = stringFlag(parsed, "to") ?? "human";
  if (to !== "human" && to !== "pi") {
    throw new UsageError("handoff 的 --to 只能是 human 或 pi");
  }

  const endpoint = endpointOf(parsed, options);
  const body: Record<string, unknown> = { to, clientId: clientIdOf(parsed) };
  const summary = stringFlag(parsed, "summary");
  const nextStep = stringFlag(parsed, "next-step");
  const files = parsed.lists.get("file");
  if (summary !== undefined) body["summary"] = summary;
  if (nextStep !== undefined) body["nextStep"] = nextStep;
  if (files !== undefined) body["touchedFiles"] = files;

  const payload = await requestJson(
    endpoint,
    "POST",
    "/api/cp/sessions/" + encodeURIComponent(key) + "/handoff",
    body,
    fetchOf(options),
  );
  if (hasFlag(parsed, "json")) {
    deps.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const result = recordOf(payload);
  const command = listOf(result["command"])
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  deps.log("已交给 " + to + "（mode=" + str(result, "mode") + "）");
  if (command.length > 0) deps.log("接管命令：" + command);
  // 历史口径是 handoff-<原 client-id>，但真正的租约持有者以服务端为准；
  // 这里只做提示，权威读法是 GET /api/cp/sessions/<key> 的 lease.clientId
  const handbackClientId = "handoff-" + clientIdOf(parsed);
  deps.log(
    "接回（handback）时用：--client-id " + handbackClientId + "（以 GET /api/cp/sessions/<key> 的 lease.clientId 为准）",
  );
  return 0;
}

async function cmdHandback(parsed: ParsedArgs, options: CliOptions, deps: Deps): Promise<number> {
  const key = requireKey(parsed, "handback");
  const endpoint = endpointOf(parsed, options);
  const payload = await requestJson(
    endpoint,
    "POST",
    "/api/cp/sessions/" + encodeURIComponent(key) + "/handback",
    { clientId: clientIdOf(parsed) },
    fetchOf(options),
  );
  if (hasFlag(parsed, "json")) {
    deps.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  const result = recordOf(payload);
  deps.log("已接回 " + key + "（resumed=" + String(result["resumed"]) + "）");
  const deltaSummary = str(result, "deltaSummary");
  if (deltaSummary.length > 0) deps.log("人工期间的增量：\n" + deltaSummary);
  return 0;
}

const LEASE_ACTIONS = ["acquire", "release", "heartbeat"] as const;

type LeaseAction = (typeof LEASE_ACTIONS)[number];

function leaseActionOf(parsed: ParsedArgs): LeaseAction {
  const raw = stringFlag(parsed, "action");
  if (raw === undefined) {
    throw new UsageError("lease 需要 --action acquire|release|heartbeat");
  }
  const action = LEASE_ACTIONS.find((candidate) => candidate === raw);
  if (action === undefined) {
    throw new UsageError("lease 的 --action 只能是 acquire / release / heartbeat（收到：" + raw + "）");
  }
  return action;
}

/**
 * 租约身份：只有 acquire 需要 --driver（服务端据此判单 writer）；release / heartbeat 沿用已有租约的 driver。
 * 传了就必须合法，不静默忽略。
 */
function leaseDriverOf(parsed: ParsedArgs, action: LeaseAction): "pi" | "human" | "none" | undefined {
  const raw = stringFlag(parsed, "driver");
  if (raw === undefined) {
    if (action === "acquire") {
      throw new UsageError("lease --action acquire 需要 --driver pi|human");
    }
    return undefined;
  }
  if (raw === "pi" || raw === "human" || raw === "none") return raw;
  throw new UsageError("lease 的 --driver 只能是 pi / human / none（收到：" + raw + "）");
}

/**
 * 租约子命令（I2）：写操作的前置条件。响应一律打 JSON ——
 * Lease 的 expiresAt / clientId 是要续期、要传给后续子命令的结构化字段，压成人读摘要只会丢信息。
 */
async function cmdLease(parsed: ParsedArgs, options: CliOptions, deps: Deps): Promise<number> {
  const key = requireKey(parsed, "lease");
  const action = leaseActionOf(parsed);
  const driver = leaseDriverOf(parsed, action);
  const ttlMs = positiveIntFlag(parsed, "ttl-ms", "lease");

  const body: Record<string, unknown> = { action, clientId: clientIdOf(parsed) };
  if (driver !== undefined) body["driver"] = driver;
  if (ttlMs !== undefined) body["ttlMs"] = ttlMs;

  const endpoint = endpointOf(parsed, options);
  const payload = await requestJson(
    endpoint,
    "POST",
    "/api/cp/sessions/" + encodeURIComponent(key) + "/lease",
    body,
    fetchOf(options),
  );
  deps.log(JSON.stringify(payload, null, 2));
  return 0;
}

function isRemoteCommand(command: string): command is Subcommand {
  return (
    command === "sessions" ||
    command === "see" ||
    command === "inject" ||
    command === "interrupt" ||
    command === "handoff" ||
    command === "handback" ||
    command === "checkpoint" ||
    command === "lease"
  );
}

async function runRemote(command: Subcommand, args: string[], options: CliOptions, deps: Deps): Promise<number> {
  const parsed = parseArgs(args);
  if (hasFlag(parsed, "help")) {
    deps.log(USAGE);
    return 0;
  }
  switch (command) {
    case "sessions":
      return await cmdSessions(parsed, options, deps);
    case "see":
      return await cmdSee(parsed, options, deps);
    case "inject":
      return await cmdInject(parsed, options, deps);
    case "interrupt":
      return await cmdInterrupt(parsed, options, deps);
    case "checkpoint":
      return await cmdCheckpoint(parsed, options, deps);
    case "handoff":
      return await cmdHandoff(parsed, options, deps);
    case "handback":
      return await cmdHandback(parsed, options, deps);
    case "lease":
      return await cmdLease(parsed, options, deps);
    default:
      return 2;
  }
}

/** start/stop/status 只操作本机 daemon：任何远端参数/位置参数都明确拒绝，而不是静默忽略（I5） */
const LOCAL_ONLY_HINT = "start/stop/status 只操作本机 daemon；远端请用 sessions/see/inject/... 子命令";

async function runLocal(
  command: "start" | "stop" | "status",
  args: string[],
  options: CliOptions,
  deps: Deps,
): Promise<number> {
  const parsed = parseArgs(args);
  if (hasFlag(parsed, "help")) {
    // 顺手修掉的 minor：以前 start --help 会真的把 daemon 拉起来
    deps.log(USAGE);
    return 0;
  }
  const offending = [...parsed.flags.keys(), ...parsed.lists.keys()].filter((name) => name !== "help").sort();
  if (offending.length > 0) {
    throw new UsageError(
      command + " 不接受 " + offending.map((name) => "--" + name).join(" / ") + "：" + LOCAL_ONLY_HINT,
    );
  }
  if (parsed.positionals.length > 0) {
    throw new UsageError(command + " 不接受位置参数（收到：" + parsed.positionals.join(" ") + "）：" + LOCAL_ONLY_HINT);
  }
  if (command === "start") return await start(options);
  if (command === "stop") return await stop(options);
  return await status(options);
}

/** 分发子命令，返回退出码（不直接 process.exit，方便测试） */
export async function main(argv: string[] = process.argv, options: CliOptions = {}): Promise<number> {
  const deps = withDefaults(options);
  const args = argv.slice(2);
  const command = args[0];

  if (command === "--help" || command === "-h" || command === "help") {
    deps.log(USAGE);
    return 0;
  }
  if (command === undefined) {
    deps.error(USAGE);
    return 2;
  }

  try {
    switch (command) {
      case "start":
      case "stop":
      case "status":
        return await runLocal(command, args.slice(1), options, deps);
      default:
        if (isRemoteCommand(command)) {
          return await runRemote(command, args.slice(1), options, deps);
        }
        deps.error("未知子命令：" + command + "\n");
        deps.error(USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      deps.error(err.message + "\n");
      deps.error(USAGE);
      return 2;
    }
    if (err instanceof CliError) {
      deps.error(err.code + ": " + err.message);
      return 1;
    }
    // 配置错误等直接给出可读信息，不抛整段 stack
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** 直接执行才分发；被 import（例如测试）时保持无副作用 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(resolve(entry)) === realpathSync(self);
  } catch {
    return resolve(entry) === resolve(self);
  }
}

if (isEntrypoint()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
