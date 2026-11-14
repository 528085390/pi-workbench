import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DEFAULT_PORT, WORKBENCH_VERSION } from "@pi-workbench/shared";

const HOST = process.env.PI_WORKBENCH_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PI_WORKBENCH_PORT ?? DEFAULT_PORT);
const startedAt = Date.now();

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
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

server.listen(PORT, HOST, () => {
  console.log(`[pi-workbenchd] listening on http://${HOST}:${PORT} (v${WORKBENCH_VERSION}, pid ${process.pid})`);
});

function shutdown(signal: string): void {
  console.log(`[pi-workbenchd] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
