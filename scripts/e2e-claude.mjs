#!/usr/bin/env node
/**
 * Phase 0.5-A 端到端脚本（Task 9 / R44）。
 *
 *   node scripts/e2e-claude.mjs
 *
 * 环境变量：
 *   PI_WORKBENCH_URL    控制面地址，默认 http://127.0.0.1:7331
 *   PI_WORKBENCH_TOKEN  可选 Bearer token（非回环部署才需要）
 *
 * 流程（严格顺序，任一步失败即退出码 1，但日志照写）：
 *   health → dispatch → 轮询 see（500ms / 最多 60s，等到消息或 state=idle）
 *   → inject（回答 E2E_INJECT_<nonce>）→ 轮询 see 直到看到 nonce
 *   → interrupt → checkpoint → handoff(human) → 打印接管命令 → handback
 *   → PASS/FAIL 摘要
 *
 * 证据：tmp/e2e-<ISO 时间戳>.jsonl，每步一行 {ts, step, ok, detail}。
 *
 * 只用 node 内置能力 + HTTP：不 import packages 下的任何模块（避免把控制面代码
 * import 进脚本，让「跑不通」这件事只剩一种解释：daemon / adapter 真的不行）。
 * 也不进单测 —— 它需要真 claude 与已启动的 daemon（由 Task 10 手工跑）。
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "http://127.0.0.1:7331";
/** 轮询：每 500ms 一次，最多 60s（R44） */
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 60_000;
const DETAIL_MAX_CHARS = 1200;

const baseUrl = (process.env.PI_WORKBENCH_URL ?? DEFAULT_URL).replace(/\/+$/, "");
const authToken = process.env.PI_WORKBENCH_TOKEN ?? "";

const nonce = randomUUID().slice(0, 8);
const clientId = "e2e-" + nonce;
const injectText = "回答 E2E_INJECT_" + nonce;
const task = "E2E 基线任务（nonce " + nonce + "）：请用一句话答复 E2E_READY_" + nonce;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** D3：会话 cwd 显式固定，可用 PI_WORKBENCH_E2E_CWD 覆盖 */
const e2eCwd = process.env.PI_WORKBENCH_E2E_CWD ?? join(repoRoot, "spike", "a00-workspace");
const startedIso = new Date().toISOString();
/** Windows 文件名不允许冒号，ISO 时间戳里的 : 与 . 一律换成 - */
const logPath = join(repoRoot, "tmp", "e2e-" + startedIso.replace(/[:.]/g, "-") + ".jsonl");
mkdirSync(dirname(logPath), { recursive: true });

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 一步一行 JSONL + 同时打到终端（日志写失败不该盖住原始失败原因） */
function record(step, ok, detail) {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  const trimmed = text.length > DETAIL_MAX_CHARS ? text.slice(0, DETAIL_MAX_CHARS) + "…" : text;
  const line = { ts: new Date().toISOString(), step, ok, detail: trimmed };
  try {
    appendFileSync(logPath, JSON.stringify(line) + "\n", "utf8");
  } catch (error) {
    process.stderr.write("[e2e] 写日志失败：" + messageOf(error) + "\n");
  }
  process.stdout.write((ok ? "✔ " : "✘ ") + step + (trimmed.length > 0 ? "：" + trimmed : "") + "\n");
  return line;
}

/** 一次 HTTP 往返；非 2xx 抛 Error(<code>: <message>) */
async function request(method, path, body) {
  const headers = { accept: "application/json" };
  if (authToken.length > 0) headers.authorization = "Bearer " + authToken;
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(new URL(path, baseUrl + "/"), init);
  } catch (error) {
    throw new Error("连不上控制面 " + baseUrl + "（" + messageOf(error) + "）：先跑 pi-workbench start");
  }

  const raw = await response.text();
  let payload = null;
  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw: raw.slice(0, 400) };
    }
  }

  if (!response.ok) {
    const failure = payload !== null && typeof payload === "object" ? payload.error : undefined;
    const code = failure !== undefined && typeof failure.code === "string" ? failure.code : "E_HTTP_" + response.status;
    const message =
      failure !== undefined && typeof failure.message === "string" ? failure.message : "HTTP " + response.status;
    const error = new Error(code + ": " + message);
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function textOf(message) {
  return typeof message === "object" && message !== null && typeof message.text === "string" ? message.text : "";
}

function messagesOf(page) {
  return page !== null && typeof page === "object" && Array.isArray(page.messages) ? page.messages : [];
}

function cursorOf(page, fallback) {
  return page !== null && typeof page === "object" && typeof page.nextCursor === "string" ? page.nextCursor : fallback;
}

function statusOf(ref) {
  return ref !== null && typeof ref === "object" && typeof ref.status === "string" ? ref.status : "unknown";
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 轮询 transcript 增量，直到 predicate 命中或超时。
 * 返回 { hit, cursor, messages, waitedMs }；超时不算抛错，由调用方判定。
 */
async function pollSee(sessionKey, startCursor, predicate) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let cursor = startCursor;
  let messages = [];
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const path =
      "/api/cp/sessions/" + encodeURIComponent(sessionKey) + "/transcript?after=" + encodeURIComponent(cursor);
    const page = await request("GET", path);
    const fresh = messagesOf(page);
    cursor = cursorOf(page, cursor);
    if (fresh.length > 0) messages = messages.concat(fresh);

    if (predicate(messages)) {
      return { hit: true, cursor, messages, status: lastStatus, waitedMs: POLL_TIMEOUT_MS - (deadline - Date.now()) };
    }

    // 「state idle」也算一个可推进的信号（模型可能只回了非文本消息）
    const detail = await request("GET", "/api/cp/sessions/" + encodeURIComponent(sessionKey));
    lastStatus = statusOf(detail !== null && typeof detail === "object" ? detail.session : undefined);
    if (lastStatus === "idle" && messages.some((m) => m.role === "assistant")) {
      return { hit: true, cursor, messages, status: lastStatus, waitedMs: POLL_TIMEOUT_MS - (deadline - Date.now()) };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return { hit: false, cursor, messages, status: lastStatus, waitedMs: POLL_TIMEOUT_MS };
}

async function main() {
  const results = [];
  let sessionKey = null;
  let cursor = "0";

  record("start", true, { baseUrl, clientId, nonce, logPath });

  try {
    // 1. health
    const health = await request("GET", "/health");
    record("health", true, health);

    // 2. dispatch
    const ref = await request("POST", "/api/cp/dispatch", {
      agent: "claude",
      task,
      // D3：cwd 显式固定（可用 PI_WORKBENCH_E2E_CWD 覆盖），否则从仓库根跑会把会话
      // cwd / 幂等哈希 / ~/.claude/projects slug 一起漂到运行目录
      cwd: e2eCwd,
      idempotencyKey: "e2e:" + nonce,
    });
    sessionKey = ref !== null && typeof ref === "object" && typeof ref.key === "string" ? ref.key : null;
    if (sessionKey === null) throw new Error("dispatch 没返回 session key：" + JSON.stringify(ref));
    record("dispatch", true, { key: sessionKey, status: statusOf(ref), nativeId: ref.nativeId });

    // 3. 取租约：后面所有写操作（inject / interrupt / checkpoint / handoff）都要它
    // 真 claude 首轮可能 >30s（默认 TTL），这里直接要 30 分钟，避免中途 E_NO_LEASE
    const lease = await request("POST", "/api/cp/sessions/" + encodeURIComponent(sessionKey) + "/lease", {
      action: "acquire",
      driver: "pi",
      clientId,
      ttlMs: 30 * 60 * 1000,
    });
    record("lease", true, { clientId, expiresAt: lease !== null && typeof lease === "object" ? lease.expiresAt : null });

    // 4. 轮询 see，等第一条 assistant 消息 / state idle
    // D1：必须等 **assistant** 产出 —— dispatch 的 user prompt 516ms 就进 transcript，
    // 只判「任意非空文本」会让 see-ready 被自己的 prompt 满足（假绿）。
    const first = await pollSee(
      sessionKey,
      cursor,
      (messages) => messages.some((m) => m.role === "assistant" && textOf(m).trim().length > 0),
    );
    cursor = first.cursor;
    if (!first.hit) {
      throw new Error("60s 内没有等到任何 transcript 消息（status=" + first.status + "）");
    }
    record("see-ready", true, {
      waitedMs: first.waitedMs,
      status: first.status,
      messages: first.messages.length,
      preview: first.messages.slice(-2).map((m) => textOf(m).slice(0, 80)),
    });

    // 5. inject
    const injected = await request("POST", "/api/cp/sessions/" + encodeURIComponent(sessionKey) + "/inject", {
      text: injectText,
      clientId,
    });
    record("inject", true, injected);

    // 6. 轮询 see，等 nonce 回流
    const echoed = await pollSee(sessionKey, cursor, (messages) =>
      messages.some((m) => {
        const text = textOf(m);
        return text.includes(injectText) || text.includes("E2E_INJECT_" + nonce);
      }),
    );
    cursor = echoed.cursor;
    if (!echoed.hit) {
      throw new Error("60s 内没在 transcript 里看到 " + injectText + "（status=" + echoed.status + "）");
    }
    record("see-inject", true, { waitedMs: echoed.waitedMs, messages: echoed.messages.length });

    // 7. interrupt
    const interrupted = await request("POST", "/api/cp/sessions/" + encodeURIComponent(sessionKey) + "/interrupt", {
      clientId,
    });
    record("interrupt", true, interrupted);

    // 8. checkpoint
    const checkpoint = await request("POST", "/api/cp/sessions/" + encodeURIComponent(sessionKey) + "/checkpoint", {
      clientId,
      summary: "E2E " + nonce + "：已跑通 dispatch / see / inject / interrupt",
      touchedFiles: [],
      nextStep: "人工接管确认一轮，再 handback 回 Pi",
    });
    record("checkpoint", true, checkpoint);

    // 9. handoff(human)
    const handoff = await request("POST", "/api/cp/sessions/" + encodeURIComponent(sessionKey) + "/handoff", {
      to: "human",
      clientId,
      summary: "E2E " + nonce + " 交接摘要",
      nextStep: "在原生 claude 里回一轮，然后 handback",
      touchedFiles: [],
    });
    const command =
      handoff !== null && typeof handoff === "object" && Array.isArray(handoff.command) ? handoff.command.join(" ") : "";
    if (command.length === 0) throw new Error("handoff 没给接管命令：" + JSON.stringify(handoff));
    record("handoff", true, { mode: handoff.mode, command });
    process.stdout.write("\n>>> 接管命令：" + command + "\n\n");

    // 9.5 人类回合（D2）：由脚本扮演接管人，在原生进程里写一轮，
    //     这样 handback 的 deltaSummary 才有东西可证；Gate #7 从此能由脚本自证。
    const humanNonce = "E2E_HUMAN_" + nonce;
    if (process.env.PI_WORKBENCH_E2E_SKIP_HUMAN !== "1") {
      const nativeId = ref !== null && typeof ref === "object" && typeof ref.nativeId === "string" ? ref.nativeId : null;
      if (nativeId === null) throw new Error("dispatch 没返回 nativeId，无法模拟人类回合：" + JSON.stringify(ref));
      // Windows 上 shell:true 会把 argv 直接拼成命令行，带空格的 prompt 会被拆散
      // （实测 claude 只收到 "回答"）——因此这里显式拼一条命令，prompt 用 JSON 引号包住。
      const humanPrompt = "回答" + humanNonce;
      const humanCommand = "claude -p --resume " + nativeId + " " + JSON.stringify(humanPrompt);
      const human = spawnSync(humanCommand, {
        cwd: e2eCwd,
        encoding: "utf8",
        timeout: 180_000,
        shell: true,
      });
      const humanOut = (human.stdout ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      record("human-turn", human.status === 0, { status: human.status, sample: humanOut });
      if (human.status !== 0) {
        throw new Error("人类回合（claude -p --resume）失败：exit=" + String(human.status) + " " + (human.stderr ?? "").slice(0, 300));
      }
    }

    // 10. handback：先问服务端「现在谁持有租约」，不靠客户端猜命名。
    //     历史实现把租约换成了 handoff-<原 clientId>（engine 口径），但那是实现细节：
    //     脚本一旦抄这个前缀，engine 改口径就静默失效 —— 因此一律读 lease.clientId。
    const detail = await request("GET", "/api/cp/sessions/" + encodeURIComponent(sessionKey));
    const currentLease = detail !== null && typeof detail === "object" ? detail.lease : null;
    const handbackClientId =
      currentLease !== null && typeof currentLease === "object" && typeof currentLease.clientId === "string"
        ? currentLease.clientId
        : null;
    if (handbackClientId === null) {
      throw new Error(
        "handback 前 GET /api/cp/sessions/" +
          sessionKey +
          " 没有返回 lease.clientId（租约可能已过期）——先 lease acquire 再 handback，别用 handoff- 前缀去猜",
      );
    }
    record("lease-handback", true, { clientId: handbackClientId });
    const handback = await request("POST", "/api/cp/sessions/" + encodeURIComponent(sessionKey) + "/handback", {
      clientId: handbackClientId,
    });
    const deltaSummary =
      handback !== null && typeof handback === "object" && typeof handback.deltaSummary === "string"
        ? handback.deltaSummary
        : null;
    record("handback", true, {
      resumed: handback !== null && typeof handback === "object" ? handback.resumed : null,
      deltaSummary,
    });
    // D2：deltaSummary 必须非空且真的包含 handoff 期间那一轮（Gate #7 的自证）
    if (deltaSummary === null || deltaSummary.trim().length === 0) {
      throw new Error("handback 的 deltaSummary 为空 —— handoff 期间的人类回合没有被读到");
    }
    if (process.env.PI_WORKBENCH_E2E_SKIP_HUMAN !== "1" && !deltaSummary.includes("E2E_HUMAN_" + nonce)) {
      throw new Error("deltaSummary 未包含 handoff 期间的人类回合 nonce：E2E_HUMAN_" + nonce);
    }

    results.push({ ok: true });
  } catch (error) {
    results.push({ ok: false, error: messageOf(error) });
    record("error", false, messageOf(error));
  }

  const passed = results.every((result) => result.ok);
  record("summary", passed, {
    result: passed ? "PASS" : "FAIL",
    sessionKey,
    nonce,
    logPath,
    error: passed ? null : results.find((result) => !result.ok).error,
  });
  process.stdout.write("\n" + (passed ? "PASS" : "FAIL") + " —— 证据：" + logPath + "\n");
  return passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write("[e2e] 未预期异常：" + messageOf(error) + "\n");
    process.exitCode = 1;
  },
);
