import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKBENCH_VERSION } from "@pi-workbench/shared";

import { loadConfig } from "./config.ts";
import { InstanceLockError, acquireInstanceLock, ensureDirs, resolvePaths, type InstanceLock } from "./paths.ts";

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * daemon 主流程：读配置 → 抢单实例锁 → 监听。
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
      console.error(`[pi-workbenchd] ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      console.error(
        `[pi-workbenchd] E_ALREADY_RUNNING：pid 文件 ${paths.pid} 已被占用（另一进程正在启动，或空锁迟迟未写完）`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const startedAt = Date.now();

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? config.host}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        name: "pi-workbenchd",
        version: WORKBENCH_VERSION,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/cp/agents") {
      // A04/A05 之前先返回空能力矩阵，方便前端契约联调
      json(res, 200, { agents: [], note: "skeleton: adapters not wired yet" });
      return;
    }
    json(res, 404, { error: "not_found", path: url.pathname });
  }

  const server = createServer(handle);

  // 监听失败（最常见是 EADDRINUSE）也必须释放锁，别留脏 pid 文件挡住下次启动
  server.on("error", (err: NodeJS.ErrnoException) => {
    const reason = err.code === "EADDRINUSE" ? "端口已被占用" : "监听失败";
    console.error(`[pi-workbenchd] ${reason}：${config.host}:${config.port}（${err.message}）`);
    lock.release();
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `[pi-workbenchd] listening on http://${config.host}:${config.port} (v${WORKBENCH_VERSION}, pid ${process.pid}, home ${config.home})`,
    );
  });

  function shutdown(signal: string): void {
    console.log(`[pi-workbenchd] ${signal} received, shutting down`);
    server.close(() => {
      lock.release();
      process.exit(0);
    });
    setTimeout(() => {
      lock.release();
      process.exit(1);
    }, 5000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
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
