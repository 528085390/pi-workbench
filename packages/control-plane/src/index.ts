import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAdapter } from "./adapters/claude.ts";
import { CheckpointStore } from "./checkpoints.ts";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { migrate, openDb } from "./db.ts";
import { DispatchStore } from "./dispatch-store.ts";
import { isWorkbenchError } from "./errors.ts";
import { EventStore } from "./events.ts";
import { LeaseManager } from "./lease.ts";
import { InstanceLockError, acquireInstanceLock, ensureDirs, resolvePaths } from "./paths.ts";
import type { InstanceLock } from "./paths.ts";
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

  const db = openDb(paths.db);
  migrate(db);

  const store = new EventStore(db);
  const leases = new LeaseManager(db, { ttlMs: config.leaseTtlMs });
  const registry = new SessionRegistry(db);
  // R34：冷启动恢复 —— 否则重启后 /sessions 与 dispatch 幂等复用都看不到历史会话
  const restored = registry.loadFromDb();
  const checkpoints = new CheckpointStore(db);
  const dispatches = new DispatchStore(db);

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
    handle = await startServer({ config, store, leases, registry, engine, adapter, checkpoints, pipeline });
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
  void main();
}
