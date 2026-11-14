import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { connectAgent } from "./connection.js";
import { makeEvent, summarizeUpdate } from "./summarize.js";
import type { AgentName, ProbeEvent, ProbeSummary } from "./types.js";

const TIMEOUT_MS = 120_000;

function usage() {
  console.log(`Usage:
  node dist/probe.js --agent claude|codex --flow init|list|full [options]

Options:
  --prompt <text>     Prompt for full flow (default: Reply with exactly ACP_OK)
  --cwd <path>        Working directory (default: spike/workspace)
  --out <path>        JSONL evidence path (default: evidence/<agent>-<flow>.jsonl)
  --help              Show this help
`);
}

function textOf(update: any): string | undefined {
  if (update?.content?.type === "text" && typeof update.content.text === "string") return update.content.text;
  if (Array.isArray(update?.content)) {
    const parts = update.content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text);
    if (parts.length) return parts.join("");
  }
  return undefined;
}

async function main() {
  const parsed = parseArgs({
    options: {
      agent: { type: "string" },
      flow: { type: "string" },
      prompt: { type: "string", default: "Reply with exactly ACP_OK and do not modify any files." },
      cwd: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const a = parsed.values;
  if (a.help) { usage(); return; }
  if (a.agent !== "claude" && a.agent !== "codex") throw new Error("--agent must be claude or codex");
  if (a.flow !== "init" && a.flow !== "list" && a.flow !== "full") throw new Error("--flow must be init, list, or full");

  const agent = a.agent as AgentName;
  const flow = a.flow;
  const cwd = resolve(a.cwd ?? "spike/workspace");
  const outPath = resolve(a.out ?? `evidence/${agent}-${flow}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });

  let seq = 0;
  const events: ProbeEvent[] = [];
  let activeSessionId: string | undefined;
  let idleResolve: (() => void) | undefined;
  let idlePromise = new Promise<void>((r) => { idleResolve = r; });
  let text = "";
  let updates = 0;

  function log(kind: string, data: unknown, sessionId?: string) {
    const event = makeEvent(++seq, agent, kind, data);
    if (sessionId) event.sessionId = sessionId;
    events.push(event);
    appendFileSync(outPath, JSON.stringify(event) + "\n");
  }

  const child = await connectAgent(agent, cwd, (sessionId, update) => {
    activeSessionId = sessionId;
    updates += 1;
    const sum = summarizeUpdate(update);
    const t = textOf(update);
    if (t) text += t;
    log("update", { summary: sum, update }, sessionId);
    if (sum.kind === "state_update" && sum.state === "idle") idleResolve?.();
  }, (params) => {
    log("permission_request", params);
    const options = params?.options ?? [];
    const option = options.find((o: any) => o.kind === "allow_once") ?? options[0];
    if (!option) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  });

  const summary: ProbeSummary = {
    agent,
    flow,
    protocolVersion: child.init?.protocolVersion,
    updates: 0,
    text: "",
    idle: false,
    listed: [],
    resumed: false,
    closed: false,
  };
  log("initialize", child.init);

  try {
    if (flow === "init") {
      // nothing else
    } else if (flow === "list") {
      const list = await child.conn.agent.request(methods.agent.session.list, a.cwd ? { cwd } : {});
      log("session_list", list);
      summary.listed = (list.sessions ?? []).map((s: any) => s.sessionId);
    } else {
      const created = await child.conn.agent.request(methods.agent.session.new, { cwd });
      activeSessionId = created.sessionId;
      summary.sessionId = created.sessionId;
      log("session_new", created, created.sessionId);

      // Reset the idle waiter after session creation, before prompt.
      idlePromise = new Promise<void>((r) => { idleResolve = r; });
      let promptResponse: any;
      try {
        promptResponse = await child.conn.agent.request(methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: a.prompt }],
        });
        log("prompt_response", promptResponse, created.sessionId);
      } catch (e) {
        log("prompt_error", { message: (e as Error).message }, created.sessionId);
        throw e;
      }

      const idle = await Promise.race([
        idlePromise.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), TIMEOUT_MS)),
      ]);
      summary.idle = idle;
      if (!idle) {
        try { await child.conn.agent.notify(methods.agent.session.cancel, { sessionId: created.sessionId }); } catch {}
        log("idle_timeout", { timeoutMs: TIMEOUT_MS }, created.sessionId);
      }

      const list = await child.conn.agent.request(methods.agent.session.list, { cwd });
      log("session_list", list);
      summary.listed = (list.sessions ?? []).map((s: any) => s.sessionId);

      try {
        await child.conn.agent.request(methods.agent.session.close, { sessionId: created.sessionId });
        summary.closed = true;
        log("session_closed", {}, created.sessionId);
      } catch (e) {
        log("close_error", { message: (e as Error).message }, created.sessionId);
      }

      try {
        const resumed = await child.conn.agent.request(methods.agent.session.resume, {
          sessionId: created.sessionId,
          cwd,
        });
        summary.resumed = true;
        log("session_resumed", resumed, created.sessionId);
        try { await child.conn.agent.request(methods.agent.session.close, { sessionId: created.sessionId }); } catch {}
      } catch (e) {
        log("resume_error", { message: (e as Error).message }, created.sessionId);
      }
    }
  } finally {
    summary.updates = updates;
    summary.text = text;
    const summaryPath = outPath.replace(/\.jsonl$/, ".summary.json");
    appendFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
    log("summary", summary, activeSessionId);
    try { child.conn.close(); } catch {}
    try { child.child.kill(); } catch {}
  }

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(() => setTimeout(() => process.exit(0), 50))
  .catch((e) => {
    console.error(e);
    setTimeout(() => process.exit(1), 50);
  });
