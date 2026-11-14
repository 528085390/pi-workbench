import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentName } from "./types.js";

const ADAPTER_PATH: Record<AgentName, string> = {
  claude: fileURLToPath(new URL("../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.url)),
  codex: fileURLToPath(new URL("../node_modules/@agentclientprotocol/codex-acp/dist/index.js", import.meta.url)),
};

export interface ConnectedAgent {
  child: ReturnType<typeof spawn>;
  conn: any;
  init: any;
}

export function spawnAgent(agent: AgentName, cwd: string) {
  const env = { ...process.env };
  if (agent === "claude") env.CLAUDE_AGENT_ACP_PROTOCOL = "v2";
  const child = spawn(process.execPath, [ADAPTER_PATH[agent]], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  child.stderr.on("data", (b) => process.stderr.write("[" + agent + "] " + b));
  return child;
}

export async function connectAgent(
  agent: AgentName,
  cwd: string,
  onUpdate: (sessionId: string, update: any) => void,
  onPermission: (params: any) => any,
): Promise<ConnectedAgent> {
  const child = spawnAgent(agent, cwd);
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );
  const app = new ClientApp({ name: "pi-workbench-acp-probe" })
    .onNotification(methods.client.session.update, (ctx: any) => {
      onUpdate(ctx.params.sessionId, ctx.params.update);
    })
    .onRequest(methods.client.session.requestPermission, (ctx: any) => {
      return onPermission(ctx.params);
    });
  const conn = app.connect(stream);
  const init = await conn.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    info: { name: "pi-workbench-acp-probe", version: "0.1.0" },
  });
  return { child, conn, init };
}
