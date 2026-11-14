import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { WORKBENCH_VERSION } from "@pi-workbench/shared";

import { loadConfig } from "./config.ts";
import { InstanceLockError, acquireInstanceLock, ensureDirs, resolvePaths, type InstanceLock } from "./paths.ts";

const config = loadConfig();
const paths = resolvePaths(config.home);
ensureDirs(paths);

/** 单实例：拿不到 PID 锁就直接退出，避免两个 daemon 抢同一份数据 */
function acquireLockOrExit(): InstanceLock {
  try {
    return acquireInstanceLock(paths.pid);
  } catch (err) {
    if (err instanceof InstanceLockError) {
      console.error(`[pi-workbenchd] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const lock = acquireLockOrExit();
const startedAt = Date.now();

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

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
