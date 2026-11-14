
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { connectAgent } from "./connection.js";

const CLAUDE_BIN = "C:/Users/huang/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
const CWD = resolve("E:/pi-workbench/spike/a00-workspace");
const OUT = resolve("E:/pi-workbench/spike/acp-probe/evidence/a00-claude-carrier.jsonl");
const NONCE = "A00_" + Date.now().toString(36).toUpperCase();

function log(kind: string, data: unknown) {
  appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), kind, data }) + "\n");
  console.log("[" + kind + "] " + JSON.stringify(data).slice(0, 600));
}

function cap(s: string, n = 1200) { return s.length > n ? s.slice(0, n) + "..." : s; }

function cli(args: string[], timeout = 180_000) {
  const r = spawnSync(CLAUDE_BIN, args, { cwd: CWD, encoding: "utf8", timeout, env: { ...process.env, TERM: "xterm-256color" } });
  return { status: r.status, signal: r.signal, stdout: cap(r.stdout ?? ""), stderr: cap(r.stderr ?? ""), error: r.error ? String(r.error) : undefined };
}

function agentsJson() {
  try {
    const r = execFileSync(CLAUDE_BIN, ["agents", "--json", "--all"], { cwd: CWD, encoding: "utf8", timeout: 60_000 });
    const rows = JSON.parse(r) as any[];
    return rows.map(x => ({ sessionId: x.sessionId, name: x.name, status: x.status, kind: x.kind, cwd: x.cwd }));
  } catch (e) { return { error: String((e as Error).message).slice(0, 400) }; }
}

function transcriptsFor(cwd: string) {
  const dir = join(homedir(), ".claude", "projects", cwd.replace(/[\\/:]/g, "-"));
  if (!existsSync(dir)) return { dir, files: [] as string[] };
  return { dir, files: readdirSync(dir).filter(f => f.endsWith(".jsonl")).slice(-10) };
}

async function ptyAttach(id: string, seconds: number) {
  const pty = await import("node-pty");
  const spawnFn = (pty as any).spawn ?? (pty as any).default?.spawn;
  return await new Promise<any>((done) => {
    let buf = "";
    let p: any;
    let finished = false;
    const finish = (v: any) => { if (!finished) { finished = true; done(v); } };
    try {
      p = spawnFn("cmd.exe", ["/c", "claude", "attach", id], { name: "xterm-256color", cols: 140, rows: 40, cwd: CWD, env: { ...process.env, TERM: "xterm-256color" } });
    } catch (e) { finish({ spawned: false, error: String((e as Error).message) }); return; }
    p.onData((d: string) => { buf += d; });
    p.onExit(({ exitCode }: any) => finish({ spawned: true, exitCode, output: cap(buf, 1500) }));
    setTimeout(() => { try { p.kill(); } catch {} ; finish({ spawned: true, killed: true, output: cap(buf, 1500) }); }, seconds * 1000);
  });
}

async function main() {
  mkdirSync(CWD, { recursive: true });
  mkdirSync(resolve("E:/pi-workbench/spike/acp-probe/evidence"), { recursive: true });
  const result: any = { nonce: NONCE, cwd: CWD };
  log("start", { nonce: NONCE, cwd: CWD, claude: cli(["--version"], 30_000).stdout.trim() });

  const child = await connectAgent("claude", CWD, (_sid: string, _u: any) => {}, (params: any) => {
    const opt = (params?.options ?? []).find((o: any) => o.kind === "allow_once") ?? params?.options?.[0];
    return opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } };
  });
  log("initialize", child.init);

  const created = await child.conn.agent.request(methods.agent.session.new, { cwd: CWD });
  const sid: string = created.sessionId;
  result.sessionId = sid;
  log("session_new", { sessionId: sid });

  try {
    const pr = await child.conn.agent.request(methods.agent.session.prompt, {
      sessionId: sid,
      prompt: [{ type: "text", text: "Reply with exactly " + NONCE + " and do not use any tools." }],
    });
    log("prompt_response", { keys: Object.keys(pr ?? {}) });
  } catch (e) {
    log("prompt_error", { message: String((e as Error).message) });
  }
  await new Promise(r => setTimeout(r, 1500));

  const tr = transcriptsFor(CWD);
  result.transcripts = tr;
  const listing = agentsJson();
  result.agentsJson = listing;
  result.agentsHasSession = Array.isArray(listing) ? listing.some((x: any) => x.sessionId === sid) : false;
  result.transcriptFileExists = tr.files.includes(sid + ".jsonl");
  log("native_visibility", { dir: tr.dir, files: tr.files, agentsHasSession: result.agentsHasSession, transcriptFileExists: result.transcriptFileExists });

  result.attachWhileRunning = await ptyAttach(sid, 6);
  log("attach_while_running", { exitCode: result.attachWhileRunning.exitCode, killed: !!result.attachWhileRunning.killed, head: (result.attachWhileRunning.output ?? "").slice(0, 800) });

  try { await child.conn.agent.request(methods.agent.session.close, { sessionId: sid }); result.closed = true; log("session_close", { ok: true }); }
  catch (e) { result.closed = false; log("session_close_error", { message: String((e as Error).message) }); }

  result.resumePrint = cli(["-p", "--resume", sid, "Repeat exactly the string I asked you to reply with in the previous turn. Output only that string."]);
  log("native_resume_print", { status: result.resumePrint.status, stdout: result.resumePrint.stdout.trim().slice(0, 300), stderr: result.resumePrint.stderr.slice(0, 400) });
  result.resumeSawNonce = (result.resumePrint.stdout ?? "").includes(NONCE);
  result.resumeWrite = cli(["-p", "--resume", sid, "Reply with exactly A00_NATIVE_TAKEOVER_OK and do not use any tools."]);
  log("native_resume_write", { status: result.resumeWrite.status, stdout: result.resumeWrite.stdout.trim().slice(0, 300), stderr: result.resumeWrite.stderr.slice(0, 400) });

  try {
    await child.conn.agent.request(methods.agent.session.resume, { sessionId: sid, cwd: CWD });
    result.acpResumeAfterNative = true;
    await child.conn.agent.request(methods.agent.session.prompt, {
      sessionId: sid,
      prompt: [{ type: "text", text: "Repeat exactly the string you were asked to reply with in the immediately previous turn. Output only that string." }],
    });
    result.handbackPrompt = { ok: true };
    await new Promise(r => setTimeout(r, 1500));
    try { await child.conn.agent.request(methods.agent.session.close, { sessionId: sid }); } catch {}
  } catch (e) {
    result.acpResumeAfterNative = false;
    result.handbackError = String((e as Error).message);
    log("acp_resume_after_native_error", { message: String((e as Error).message) });
  }

  result.attachAfterClose = await ptyAttach(sid, 6);
  log("attach_after_close", { exitCode: result.attachAfterClose.exitCode, killed: !!result.attachAfterClose.killed, head: (result.attachAfterClose.output ?? "").slice(0, 800) });

  log("result", result);
  try { child.child.kill(); } catch {}
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { log("fatal", { message: String(e?.stack ?? e) }); process.exit(1); });
