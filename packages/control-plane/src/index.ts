import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ClaudeAdapter } from "./adapters/claude.ts";
import { CheckpointStore } from "./checkpoints.ts";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { ReadCursorStore } from "./cursors.ts";
import { migrate, openDb } from "./db.ts";
import { DispatchStore } from "./dispatch-store.ts";
import { isWorkbenchError } from "./errors.ts";
import { EventStore } from "./events.ts";
import { LeaseManager } from "./lease.ts";
import { InstanceLockError, acquireInstanceLock, ensureDirs, resolvePaths } from "./paths.ts";
import type { InstanceLock, WorkbenchPaths } from "./paths.ts";
import { EventPipeline } from "./pipeline.ts";
import { SessionRegistry } from "./registry.ts";
import { startServer } from "./server.ts";
import type { ServerHandle } from "./server.ts";
import { TakeoverEngine } from "./takeover.ts";

/**
 * daemon 主流程（R39）：读配置 → 抢单实例锁 → 开库迁移 → 装配 store / adapter / 管线 / 引擎 →
 * startServer → 打印监听地址；SIGINT / SIGTERM 时 app.close + adapter.dispose + 释放锁。
 * 抽成函数是为了让本模块可被导入而不产生副作用（测试 / 复用），只有直接执行时才启动。
 */
export async function main(): Promise<void> {
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
  const { db, store, leases, registry, restored, checkpoints, dispatches, cursors } = boot;

  let adapter: ClaudeAdapter;
  try {
    adapter = await ClaudeAdapter.spawn(config);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[pi-workbenchd] E_ADAPTER_DOWN：Claude ACP adapter 启动失败（" + reason + "）");
    await closeQuietly(db);
    lock.release();
    process.exitCode = 1;
    return;
  }

  // 事件管线：dispatch 出新会话时由 server 挂到 adapter（见 server.ts 的 pipeline 依赖）
  const pipeline = new EventPipeline(store, registry);
  const engine = new TakeoverEngine({
    store,
    leases,
    registry,
    adapter,
    checkpoints,
    dispatches,
    handoffDir: paths.handoffs,
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
      checkpoints,
      cursors,
      pipeline,
    });
  } catch (err) {
    reportStartupFailure(err, config);
    await disposeQuietly(adapter);
    await closeQuietly(db);
    lock.release();
    process.exitCode = 1;
    return;
  }

  console.log("pi-workbenchd listening on " + handle.url);
  if (restored > 0) {
    console.log("[pi-workbenchd] 已从库里恢复 " + String(restored) + " 个会话");
  }

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
    await disposeQuietly(adapter);
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
  checkpoints: CheckpointStore;
  dispatches: DispatchStore;
  cursors: ReadCursorStore;
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
    migrate(db);
    const store = new EventStore(db);
    const leases = new LeaseManager(db, { ttlMs: config.leaseTtlMs });
    const registry = new SessionRegistry(db);
    // R34：冷启动恢复 —— 否则重启后 /sessions 与 dispatch 幂等复用都看不到历史会话
    const restored = registry.loadFromDb();
    const checkpoints = new CheckpointStore(db);
    const dispatches = new DispatchStore(db);
    const cursors = new ReadCursorStore(db);
    return { db, store, leases, registry, restored, checkpoints, dispatches, cursors };
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

/** 关闭 adapter；退出流程里失败不再上报（进程马上就要退） */
async function disposeQuietly(adapter: ClaudeAdapter): Promise<void> {
  try {
    await adapter.dispose();
  } catch {
    // 退出流程：吞掉
  }
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
