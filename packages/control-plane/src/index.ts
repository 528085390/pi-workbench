import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentName, SessionRef } from "@pi-workbench/shared";

import { ClaudeAdapter } from "./adapters/claude.ts";
import { ClaudeDriver } from "./agents/claude-driver.ts";
import { CodexDriver } from "./agents/codex-driver.ts";
import type { CodexWriteAction } from "./agents/codex-driver.ts";
import { PiDriver, resolvePiPackageDir } from "./agents/pi-driver.ts";
import { AgentRouter } from "./agents/router.ts";
import type { AgentDriver } from "./agents/types.ts";
import { AUDIT_RETENTION_DAYS, AuditStore } from "./audit.ts";
import { reconcileSessions } from "./boot-recovery.ts";
import type { RecoveryReport } from "./boot-recovery.ts";
import { hideWindowsChildProcesses } from "./child-process.ts";
import { CheckpointStore } from "./checkpoints.ts";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { ReadCursorStore } from "./cursors.ts";
import { SCHEMA_VERSION, backupDbFile, migrate, openDb, schemaVersion } from "./db.ts";
import { DispatchStore } from "./dispatch-store.ts";
import { isWorkbenchError, WorkbenchError } from "./errors.ts";
import { EventStore } from "./events.ts";
import { InstanceStore } from "./instances.ts";
import { LeaseManager } from "./lease.ts";
import { InstanceLockError, acquireInstanceLock, ensureDirs, resolvePaths } from "./paths.ts";
import type { InstanceLock, WorkbenchPaths } from "./paths.ts";
import { EventPipeline } from "./pipeline.ts";
import { SessionRegistry } from "./registry.ts";
import { startServer } from "./server.ts";
import type { ServerHandle } from "./server.ts";
import { TakeoverEngine } from "./takeover.ts";

/** 与 index 装配的 PiDriver 保持一致的写者身份（takeover.ts 的 piClientId 必须同值） */
export const PI_AGENT_CLIENT_ID = "pi";

/**
 * Codex 写守卫（B08 S6/P0-1）：TakeoverEngine 在 driver 写操作期间把租约临时换到
 * PI_AGENT_CLIENT_ID，因此这里比较的是引擎身份，而不是 HTTP 调用方的 pi:<pid>。
 * handoff/close 发生在租约转交给 human 之后，不能按 writer 身份拦截。
 */
export function makeCodexWriteGuard(
  leases: LeaseManager,
): (ref: SessionRef, action: CodexWriteAction) => void {
  return (ref, action) => {
    if (action === "handoff" || action === "close") {
      return;
    }
    const lease = leases.current(ref.key);
    if (lease !== null && lease.clientId !== PI_AGENT_CLIENT_ID) {
      throw new WorkbenchError("E_LEASE_CONFLICT", "租约被其他客户端持有：" + lease.clientId, {
        sessionKey: ref.key,
        heldBy: lease.clientId,
      });
    }
  };
}

/** spec §11.1：单个探测子进程 / 动态 import 的硬超时 */
export const PROBE_TIMEOUT_MS = 3000;

/** spec §7.1：`instances.heartbeat_at` 刷新间隔（15s）。`unref()` 后不拖住进程退出。 */
const INSTANCE_HEARTBEAT_MS = 15_000;

/** spec §7.1 / 0.5-A D6：租约后台清扫间隔（30s）。`unref()` 后不拖住进程退出。 */
const LEASE_SWEEP_MS = 30_000;

/** C02：dispatch 幂等记录保留 24h，后台每小时清扫一次（含超期 reserved）。 */
const DISPATCH_RETENTION_MS = 24 * 3600_000;
const DISPATCH_SWEEP_MS = 3600_000;

export type AgentProbe = {
  agent: AgentName;
  available: boolean;
  version: string | null;
  /** available=false 时以 E_AGENT_UNAVAILABLE: 开头，机器可读 */
  reason?: string;
};

export type ProbeCommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

export type ProbeOptions = {
  /** 覆盖子进程执行（测试注入；默认 execFile） */
  runCommand?: ProbeCommandRunner;
  /** 覆盖文件存在判断（测试注入） */
  fileExists?: (path: string) => boolean;
  /** 覆盖 package.json 版本读取（测试注入） */
  readPackageVersion?: (entry: string) => string;
  /** 覆盖 pi 包动态 import（测试注入） */
  importPi?: () => Promise<unknown>;
  /** 覆盖 home（默认 homedir；测试可指向临时目录） */
  home?: string;
};

/**
 * 启动探测（spec §11.1）：三个探测器并行、各自 3s 超时，任何失败只返回
 * available=false + reason，绝不抛出、绝不阻塞 daemon 启动。
 */
export async function probeAgents(config: Config, options: ProbeOptions = {}): Promise<AgentProbe[]> {
  const run = options.runCommand ?? runProbeCommand;
  const fileExists = options.fileExists ?? existsSync;
  const readVersion = options.readPackageVersion ?? readPackageVersionOf;
  const importPi = options.importPi ?? importPiPackage;
  const home = options.home ?? homedir();
  return await Promise.all([
    safeProbe("claude", async () => await probeClaude(config, fileExists, readVersion)),
    safeProbe("codex", async () => await probeCodex(home, fileExists, run)),
    safeProbe("pi", async () => await probePi(importPi, run)),
  ]);
}

async function safeProbe(agent: AgentName, probe: () => Promise<AgentProbe>): Promise<AgentProbe> {
  try {
    return await probe();
  } catch (err) {
    return unavailable(agent, errorMessage(err));
  }
}

async function probeClaude(
  config: Config,
  fileExists: (path: string) => boolean,
  readVersion: (entry: string) => string,
): Promise<AgentProbe> {
  const cmd = config.claude.adapterCmd;
  if (cmd.length === 0) {
    return unavailable("claude", "claude.adapterCmd 为空");
  }
  const head = cmd[0] ?? "";
  if (isAbsolute(head) && !fileExists(head)) {
    return unavailable("claude", "适配器可执行文件不存在：" + head);
  }
  const entry = cmd.length > 1 && isNodeLike(head) ? cmd[1] : head;
  if (entry !== undefined && isAbsolute(entry) && !fileExists(entry)) {
    return unavailable("claude", "适配器入口不存在：" + entry);
  }
  return { agent: "claude", available: true, version: entry === undefined ? "unknown" : readVersion(entry) };
}

async function probeCodex(
  home: string,
  fileExists: (path: string) => boolean,
  run: ProbeCommandRunner,
): Promise<AgentProbe> {
  const authPath = join(home, ".codex", "auth.json");
  if (!fileExists(authPath)) {
    return unavailable("codex", "codex 未登录（~/.codex/auth.json 不存在）");
  }
  try {
    const output = await run("codex", ["--version"], PROBE_TIMEOUT_MS);
    return { agent: "codex", available: true, version: parseVersion(output) };
  } catch (err) {
    return unavailable("codex", "codex --version 失败：" + timeoutReason(err, "codex --version"));
  }
}

async function probePi(importPi: () => Promise<unknown>, run: ProbeCommandRunner): Promise<AgentProbe> {
  try {
    await withProbeTimeout(importPi(), PROBE_TIMEOUT_MS, "pi 包动态 import");
  } catch (err) {
    return unavailable("pi", "pi 包动态 import 失败：" + timeoutReason(err, "pi 包动态 import"));
  }
  try {
    const output = await run("pi", ["--version"], PROBE_TIMEOUT_MS);
    return { agent: "pi", available: true, version: parseVersion(output) };
  } catch (err) {
    return unavailable("pi", "pi --version 失败：" + timeoutReason(err, "pi --version"));
  }
}

function unavailable(agent: AgentName, reason: string): AgentProbe {
  return {
    agent,
    available: false,
    version: null,
    reason: reason.startsWith("E_AGENT_UNAVAILABLE:") ? reason : "E_AGENT_UNAVAILABLE: " + reason,
  };
}

function runProbeCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    // Windows 上 npm 全局安装的 codex / pi 只有 .cmd shim，execFile 直接调用会 ENOENT；
    // 经 cmd.exe /d /s /c 解析（命令与参数都来自固定探测，不接受用户输入）。
    const file = process.platform === "win32" ? "cmd.exe" : command;
    const finalArgs = process.platform === "win32" ? ["/d", "/s", "/c", command, ...args] : args;
    execFile(
      file,
      finalArgs,
      { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(error);
          return;
        }
        resolvePromise(String(stdout).trim());
      },
    );
  });
}

async function importPiPackage(): Promise<unknown> {
  const dir = resolvePiPackageDir();
  if (dir === null) {
    throw new Error("找不到 @earendil-works/pi-coding-agent");
  }
  return await import(pathToFileURL(join(dir, "dist", "index.js")).href);
}

function readPackageVersionOf(entry: string): string {
  let dir = dirname(entry);
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof pkg === "object" && pkg !== null && typeof (pkg as { version?: unknown }).version === "string") {
          return (pkg as { version: string }).version;
        }
      } catch {
        return "unknown";
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "unknown";
}

function parseVersion(output: string): string {
  const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  if (match !== null) {
    return match[0];
  }
  const first = output.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.length === 0 ? "unknown" : first;
}

function isNodeLike(command: string): boolean {
  return /node(?:\.exe)?$/i.test(command);
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as { killed?: unknown; code?: unknown; signal?: unknown };
  return record.killed === true || record.code === "ETIMEDOUT" || record.signal === "SIGKILL";
}

function timeoutReason(error: unknown, label: string): string {
  return isTimeoutError(error) ? label + " 探测超时（" + String(PROBE_TIMEOUT_MS) + "ms）" : errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withProbeTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(label + " 超时（" + String(timeoutMs) + "ms）"));
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * daemon 主流程（R39）：读配置 → 抢单实例锁 → 开库迁移 → 装配 store / adapter / 管线 / 引擎 →
 * startServer → 打印监听地址；SIGINT / SIGTERM 时 app.close + adapter.dispose + 释放锁。
 * 抽成函数是为了让本模块可被导入而不产生副作用（测试 / 复用），只有直接执行时才启动。
 */
export async function main(): Promise<void> {
  hideWindowsChildProcesses();
  const config = loadConfig();
  const paths = resolvePaths(config.home);
  ensureDirs(paths);

  let lock: InstanceLock;
  try {
    lock = acquireInstanceLock(paths.pid);
  } catch (err) {
    if (err instanceof InstanceLockError) {
      console.error("[pi-workbenchd] " + err.message);
      process.exitCode = 1;
      return;
    }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      console.error(
        "[pi-workbenchd] E_ALREADY_RUNNING：pid 文件 " + paths.pid + " 已被占用（另一进程正在启动，或空锁迟迟未写完）",
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // 评审 Minor 5：开库 / 迁移 / 装配 store 都在抢到实例锁之后，失败时必须释放锁，
  // 否则下次启动只能靠 stale lock 自愈（R39 要求「启动失败也要释放锁」）。
  const boot = bootStores(config, paths, lock);
  if (boot === null) {
    process.exitCode = 1;
    return;
  }
  const { db, store, leases, registry, restored, recovery, checkpoints, dispatches, cursors, instances } = boot;

  // C03 / spec §7.4：审计只追加；启动先按 30 天保留期清一次，失败只告警不阻断启动。
  const audit = new AuditStore(db, { instanceId: instances.id ?? "unknown" });
  try {
    const pruned = audit.prune(AUDIT_RETENTION_DAYS);
    console.log(
      "[pi-workbenchd] 审计日志清理完成：删除 " +
        String(pruned) +
        " 条（保留 " +
        String(AUDIT_RETENTION_DAYS) +
        " 天）",
    );
  } catch (err) {
    console.error("[pi-workbenchd] 审计日志清理失败（启动继续）：" + errorMessage(err));
  }

  // C02：dispatch 幂等记录保留 24h；启动先扫一次，之后每小时扫一次（含超期 reserved）。
  const sweepDispatches = (): number => {
    const retained = dispatches.pruneRetained(DISPATCH_RETENTION_MS);
    const stale = dispatches.pruneStaleReserved(DISPATCH_RETENTION_MS);
    return retained + stale;
  };
  try {
    const swept = sweepDispatches();
    console.log("[pi-workbenchd] dispatch 幂等记录清理完成：删除 " + String(swept) + " 条（保留 24h）");
  } catch (err) {
    console.error("[pi-workbenchd] dispatch 幂等记录清理失败（启动继续）：" + errorMessage(err));
  }

  // spec §7.1：15s 心跳刷新 instances.heartbeat_at，让「这个 daemon 还活着」可被外部观测。
  // 心跳失败只告警：DB 偶发错误不该打崩 daemon，下个周期重试。
  const heartbeat = setInterval(() => {
    try {
      instances.touch();
    } catch (err) {
      console.error("[pi-workbenchd] 实例心跳写入失败（下个周期重试）：" + errorMessage(err));
    }
  }, INSTANCE_HEARTBEAT_MS);
  heartbeat.unref();

  // 0.5-A D6：惰性过期之外再做周期清扫，避免过期行长期堆在库里。
  // 清扫失败只告警：单个周期出错不该打崩 daemon，下个周期重试。
  const leaseSweep = setInterval(() => {
    try {
      leases.sweepExpired();
    } catch (err) {
      console.error("[pi-workbenchd] 租约清扫失败（下个周期重试）：" + errorMessage(err));
    }
  }, LEASE_SWEEP_MS);
  leaseSweep.unref();

  // C02：保留期清扫不能只在启动时跑；每小时清一次，失败只告警。
  const dispatchSweep = setInterval(() => {
    try {
      const swept = sweepDispatches();
      if (swept > 0) {
        console.log("[pi-workbenchd] dispatch 幂等记录清理完成：删除 " + String(swept) + " 条（保留 24h）");
      }
    } catch (err) {
      console.error("[pi-workbenchd] dispatch 幂等记录清理失败（下个周期重试）：" + errorMessage(err));
    }
  }, DISPATCH_SWEEP_MS);
  dispatchSweep.unref();

  let adapter: ClaudeAdapter;
  try {
    adapter = await ClaudeAdapter.spawn(config, {
      initialPermissionMode: config.claude.initialPermissionMode,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[pi-workbenchd] E_ADAPTER_DOWN：Claude ACP adapter 启动失败（" + reason + "）");
    clearInterval(heartbeat);
    clearInterval(leaseSweep);
    clearInterval(dispatchSweep);
    await closeQuietly(db);
    lock.release();
    process.exitCode = 1;
    return;
  }

  // 事件管线：dispatch 出新会话时由 server 挂到 adapter（见 server.ts 的 pipeline 依赖）
  const pipeline = new EventPipeline(store, registry);

  // 0.5-B B06：三 Agent 注册表。PiDriver 必须与接管层共用同一个 LeaseManager，
  // 并用固定 clientId "pi"（引擎在写操作期间临时换租约，见 takeover.ts #driverWrite）。
  const router = new AgentRouter();
  const claudeDriver = new ClaudeDriver(adapter);
  // B08 S6/P0-1：driver 级再兜一层租约检查。dispatch 首轮 inject 没有 lease（0.5-A 口径），放行；
  // 若已有别的 writer，则在碰 ACP 之前直接 E_LEASE_CONFLICT，不依赖调用方一定走 TakeoverEngine。
  const codexDriver = new CodexDriver(config, {
    authorizeWrite: makeCodexWriteGuard(leases),
  });
  const piDriver = new PiDriver({
    lease: leases,
    clientId: PI_AGENT_CLIENT_ID,
    rpcCmd: config.pi.rpcCmd,
    ...(config.pi.provider === undefined ? {} : { provider: config.pi.provider }),
    ...(config.pi.model === undefined ? {} : { model: config.pi.model }),
  });
  const drivers: Record<string, AgentDriver> = {
    claude: claudeDriver,
    codex: codexDriver,
    pi: piDriver,
  };
  for (const driver of Object.values(drivers)) {
    router.register(driver, {
      available: driver.agent === "claude",
      version: "unknown",
      ...(driver.agent === "claude" ? {} : { reason: "E_AGENT_UNAVAILABLE: 启动探测尚未完成" }),
    });
  }
  /**
   * GET /agents 的 30s 缓存数据源；启动时后台跑第一次，任何探测失败只降级该行。
   * in-flight Promise 复用：监听后立刻来的 /agents 不会重复拉起第二组探测子进程。
   */
  let agentProbe: Promise<ReturnType<AgentRouter["list"]>> | null = null;
  const refreshAgentStatuses = async (): Promise<ReturnType<AgentRouter["list"]>> => {
    if (agentProbe !== null) {
      return await agentProbe;
    }
    agentProbe = (async () => {
      let probes: AgentProbe[] = [];
      try {
        probes = await probeAgents(config);
      } catch {
        probes = [];
      }
      for (const probe of probes) {
        const driver = drivers[probe.agent];
        if (driver === undefined) {
          continue;
        }
        router.register(driver, {
          available: probe.available,
          version: probe.version,
          ...(probe.reason === undefined ? {} : { reason: probe.reason }),
        });
      }
      return router.list();
    })().finally(() => {
      agentProbe = null;
    });
    return await agentProbe;
  };

  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter,
    router,
    checkpoints,
    dispatches,
    dispatchReservedTtlMs: config.dispatchReservedTtlMs,
    handoffDir: paths.handoffs,
    piClientId: PI_AGENT_CLIENT_ID,
  });

  let handle: ServerHandle;
  try {
    handle = await startServer({
      config,
      store,
      leases,
      registry,
      engine,
      adapter,
      router,
      agentStatuses: refreshAgentStatuses,
      checkpoints,
      cursors,
      audit,
      pipeline,
    });
  } catch (err) {
    reportStartupFailure(err, config);
    clearInterval(heartbeat);
    clearInterval(leaseSweep);
    clearInterval(dispatchSweep);
    await disposeDriversQuietly([claudeDriver, codexDriver, piDriver]);
    await closeQuietly(db);
    lock.release();
    process.exitCode = 1;
    return;
  }

  console.log("pi-workbenchd listening on " + handle.url);
  // spec §7.1 第 8 步：HTTP/WS 起来后再补上一个实例的 ended_at；失败只告警，不影响本次启动。
  try {
    const closedStale = instances.closeStale();
    if (closedStale > 0) {
      console.log("[pi-workbenchd] 已补齐 " + String(closedStale) + " 个历史实例的 ended_at");
    }
  } catch (err) {
    console.error("[pi-workbenchd] 补齐历史实例 ended_at 失败（启动继续）：" + errorMessage(err));
  }
  // 探测最长 3s，绝不把监听卡在子进程上；首个 GET /agents 会 await 同一个 in-flight Promise。
  void refreshAgentStatuses().catch(() => {});
  if (restored > 0) {
    console.log("[pi-workbenchd] 已从库里恢复 " + String(restored) + " 个会话");
  }
  // spec §7.1：启动对账结果写进启动日志，便于重启验收与故障排查。
  console.log(
    "[pi-workbenchd] 重启对账：共 " +
      String(recovery.total) +
      " 个会话，" +
      String(recovery.markedUnknown) +
      " 个置为 unknown，" +
      String(recovery.keptHandoff) +
      " 个保持 handoff",
  );

  let closing = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (closing) {
      return;
    }
    closing = true;
    console.log("[pi-workbenchd] " + signal + " received, shutting down");
    const force = setTimeout(() => {
      lock.release();
      process.exit(1);
    }, 5000);
    force.unref();
    await handle.close();
    clearInterval(heartbeat);
    clearInterval(leaseSweep);
    clearInterval(dispatchSweep);
    // spec §7.1：关库前给本实例写 ended_at；写失败也不阻断后面的释放锁（force 计时器兜底）。
    try {
      instances.finish();
    } catch (err) {
      console.error("[pi-workbenchd] 写 instances.ended_at 失败：" + errorMessage(err));
    }
    await disposeDriversQuietly([claudeDriver, codexDriver, piDriver]);
    await closeQuietly(db);
    lock.release();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

/** 抢到实例锁之后装配出来的运行期对象（R39） */
type Boot = {
  db: DatabaseSync;
  store: EventStore;
  leases: LeaseManager;
  registry: SessionRegistry;
  /** R34：loadFromDb 恢复出来的会话条数 */
  restored: number;
  /** Task 4：启动对账结果（main 写启动日志） */
  recovery: RecoveryReport;
  checkpoints: CheckpointStore;
  dispatches: DispatchStore;
  cursors: ReadCursorStore;
  /** 本次 daemon 的实例记录（心跳 / 收尾在 main 里装配） */
  instances: InstanceStore;
};

/**
 * 开库 → 迁移 → 装配 store（R39）。
 * 失败时（库损坏 SQLITE_NOTADB / 迁移报错 / store 构造抛错）关闭半开的库、释放实例锁、打印人话并返回 null，
 * 由 main 设置 exitCode —— 评审 Minor 5。
 */
function bootStores(config: Config, paths: WorkbenchPaths, lock: InstanceLock): Boot | null {
  let db: DatabaseSync | null = null;
  try {
    db = openDb(paths.db);
    const currentVersion = schemaVersion(db);
    // 只有真正要升级旧库时才备份：否则每次启动都会新增备份，两次重启就把升级前的备份轮换掉。
    if (currentVersion > 0 && currentVersion < SCHEMA_VERSION) {
      try {
        backupDbFile(paths.db, join(dirname(paths.db), "db-backup"), currentVersion);
      } catch (err) {
        // 备份失败只告警不阻断：升级仍可继续，不能让备份故障挡住 daemon 启动（spec §5 约束 6）。
        console.error(
          "[pi-workbenchd] 迁移前备份数据库失败（继续启动）：" +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    migrate(db);
    // spec §7.1 第 3 步：迁移成功后立刻登记本次实例，心跳与收尾由 main 装配。
    const instances = new InstanceStore(db);
    const instance = instances.begin();
    const store = new EventStore(db);
    // spec §7.1 第 4 步：租约按实例归属；启动清扫必须早于 loadFromDb，避免恢复出别家实例的租约。
    const leases = new LeaseManager(db, { ttlMs: config.leaseTtlMs, instanceId: instance.id });
    leases.sweepForBoot();
    const registry = new SessionRegistry(db);
    // R34：冷启动恢复 —— 否则重启后 /sessions 与 dispatch 幂等复用都看不到历史会话
    const restored = registry.loadFromDb();
    // spec §7.1 第 6 步：恢复后立即对账，driver 会话不按 transcript 猜状态（决策 2），
    // 一律置 unknown 等显式 attach；必须早于 startServer，避免对外短暂暴露 running。
    const recovery = reconcileSessions({ registry, store, instanceId: instance.id });
    const checkpoints = new CheckpointStore(db);
    const dispatches = new DispatchStore(db);
    const cursors = new ReadCursorStore(db);
    return { db, store, leases, registry, restored, recovery, checkpoints, dispatches, cursors, instances };
  } catch (err) {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // 半开的库关不掉也不该盖住原始失败原因
      }
    }
    lock.release();
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[pi-workbenchd] E_DB_INIT：打开数据库 / 迁移失败（" + reason + "），已释放实例锁");
    return null;
  }
}

/** 启动失败给一句人话：鉴权拒绝（R32）直接报错误码，端口占用保留 T1 的口径 */
function reportStartupFailure(err: unknown, config: Config): void {
  if (isWorkbenchError(err)) {
    console.error("[pi-workbenchd] " + err.code + "：" + err.message);
    return;
  }
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error("[pi-workbenchd] 端口已被占用：" + config.host + ":" + String(config.port));
    return;
  }
  const reason = err instanceof Error ? err.message : String(err);
  console.error("[pi-workbenchd] 监听失败：" + reason);
}

/** 关闭全部 driver（ClaudeDriver 内部即 adapter.dispose）；退出流程里失败不再上报 */
async function disposeDriversQuietly(drivers: readonly AgentDriver[]): Promise<void> {
  await Promise.all(
    drivers.map(async (driver) => {
      try {
        await driver.dispose();
      } catch {
        // 退出流程：吞掉
      }
    }),
  );
}

async function closeQuietly(db: { close(): void }): Promise<void> {
  try {
    db.close();
  } catch {
    // 退出流程：吞掉
  }
}

/** 直接执行（node dist/index.js / dev 脚本）才启动；被 import 时保持无副作用 */
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
  // 评审 Minor 6：main 内未捕获异常（config.yaml 解析失败 / 迁移失败等）走 unhandled rejection
  // 只会打原始栈；这里统一收口成人话 + 非零 exitCode。
  main().catch((err: unknown) => {
    const reason = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error("[pi-workbenchd] 启动失败：" + reason);
    process.exitCode = 1;
  });
}
