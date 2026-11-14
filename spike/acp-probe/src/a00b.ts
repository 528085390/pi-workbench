
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { connectAgent } from "./connection.js";

const CLAUDE_BIN = "C:/Users/huang/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
const CWD = resolve("E:/pi-workbench/spike/a00-workspace");
const OUT = resolve("E:/pi-workbench/spike/acp-probe/evidence/a00b-tui-takeover.jsonl");
const SID = process.argv[2];

function log(kind: string, data: unknown) {
  appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), kind, data }) + "\n");
  console.log("[" + kind + "] " + JSON.stringify(data).slice(0, 500));
}
const cap = (s: string, n = 2500) => (s.length > n ? s.slice(0, n) + "..." : s);
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

async function ptyResume(id: string) {
  const pty = await import("node-pty");
  const spawnFn = (pty as any).spawn ?? (pty as any).default?.spawn;
  const p: any = spawnFn("cmd.exe", ["/c", "claude", "--resume", id], { name: "xterm-256color", cols: 160, rows: 45, cwd: CWD, env: { ...process.env, TERM: "xterm-256color" } });
  let buf = "";
  p.onData((d: string) => { buf += d; });
  await new Promise(r => setTimeout(r, 9000));
  const shot1 = cap(strip(buf));
  // 注入一轮 prompt
  p.write("Reply with exactly A00_TUI_INJECT_OK and do not use any tools.\r");
  await new Promise(r => setTimeout(r, 25000));
  const shot2 = cap(strip(buf));
  try { p.kill(); } catch {}
  await new Promise(r => setTimeout(r, 1000));
  return { shot1, shot2 };
}

async function main() {
  if (!SID) throw new Error("usage: tsx src/a00b.ts <sessionId>");
  mkdirSync(resolve("E:/pi-workbench/spike/acp-probe/evidence"), { recursive: true });
  const result: any = { sessionId: SID };
  const tui = await ptyResume(SID);
  result.tuiSawHistory = tui.shot1.includes("A00_") || tui.shot1.toLowerCase().includes("resume");
  result.tuiShot1Tail = tui.shot1.slice(-1200);
  result.tuiSawInjectOk = tui.shot2.includes("A00_TUI_INJECT_OK");
  result.tuiShot2Tail = tui.shot2.slice(-1200);
  log("tui", result);

  // 交回 ACP 后确认能看到 TUI 那轮
  const child = await connectAgent("claude", CWD, () => {}, (params: any) => {
    const opt = (params?.options ?? []).find((o: any) => o.kind === "allow_once") ?? params?.options?.[0];
    return opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } };
  });
  try {
    await child.conn.agent.request(methods.agent.session.resume, { sessionId: SID, cwd: CWD });
    result.acpResumeOk = true;
    await child.conn.agent.request(methods.agent.session.prompt, {
      sessionId: SID,
      prompt: [{ type: "text", text: "Repeat exactly the string you were asked to output in the previous turn. Output only that string." }],
    });
    await new Promise(r => setTimeout(r, 2000));
    try { await child.conn.agent.request(methods.agent.session.close, { sessionId: SID }); } catch {}
  } catch (e) {
    result.acpResumeOk = false;
    result.error = String((e as Error).message);
  }
  try { child.child.kill(); } catch {}
  const trPath = "C:/Users/huang/.claude/projects/E--pi-workbench-spike-a00-workspace/" + SID + ".jsonl";
  try { result.transcriptBytes = statSync(trPath).size; } catch (e) { result.transcriptBytes = String((e as Error).message); }
  log("result", result);
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { log("fatal", { message: String(e?.stack ?? e) }); process.exit(1); });
