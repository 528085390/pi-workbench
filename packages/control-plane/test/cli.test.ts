import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import { main, stop, SUBCOMMANDS, USAGE, type CliOptions } from "../src/cli.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-wb-cli-"));
}

/** 构造一个不碰真实网络 / 真实信号的注入环境 */
function harness(pidInFile: number | null, healthPid: number | null | "unreachable") {
  const killed: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const alive = new Set<number>();
  if (pidInFile !== null) alive.add(pidInFile);

  const options: CliOptions = {
    probeHealth: async () =>
      healthPid === "unreachable"
        ? { ok: false, body: null }
        : { ok: true, body: { ok: true, name: "pi-workbenchd", pid: healthPid } },
    isAlive: (pid) => alive.has(pid),
    kill: (pid, signal) => {
      killed.push(pid + ":" + signal);
      alive.delete(pid);
    },
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  };
  return { options, killed, errors, logs, alive };
}

test("stop: pid 文件存在但 /health 返回别的 pid ⇒ 不发信号、退出 1", async () => {
  const home = freshHome();
  try {
    const cfg = loadConfig({ PI_WORKBENCH_HOME: home });
    const paths = resolvePaths(home);
    writeFileSync(paths.pid, "4321", "utf8");

    // pid 4321 存活，但 /health 自报 9999：说明 pid 已被别的进程复用
    const h = harness(4321, 9999);
    const code = await stop({ ...h.options, config: cfg });

    assert.equal(code, 1);
    assert.deepEqual(h.killed, [], "身份不符时绝不能发任何信号");
    assert.equal(existsSync(paths.pid), true, "不能删掉 pid 文件（不是我们的）");
    assert.ok(
      h.errors.some((line) => line.includes("未发送任何信号") && line.includes("9999")),
      "应打印明确原因，实际：" + JSON.stringify(h.errors),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stop: /health 不可达 ⇒ 不发信号、退出 1", async () => {
  const home = freshHome();
  try {
    const cfg = loadConfig({ PI_WORKBENCH_HOME: home });
    const paths = resolvePaths(home);
    writeFileSync(paths.pid, "4321", "utf8");

    const h = harness(4321, "unreachable");
    const code = await stop({ ...h.options, config: cfg });

    assert.equal(code, 1);
    assert.deepEqual(h.killed, []);
    assert.equal(existsSync(paths.pid), true);
    assert.ok(h.errors.some((line) => line.includes("未发送任何信号")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stop: pid 与 /health 一致 ⇒ 发 SIGTERM、退出 0、清理 pid 文件", async () => {
  const home = freshHome();
  try {
    const cfg = loadConfig({ PI_WORKBENCH_HOME: home });
    const paths = resolvePaths(home);
    writeFileSync(paths.pid, "4321", "utf8");

    const h = harness(4321, 4321);
    const code = await stop({ ...h.options, config: cfg });

    assert.equal(code, 0);
    assert.deepEqual(h.killed, ["4321:SIGTERM"]);
    assert.equal(existsSync(paths.pid), false);
    assert.ok(h.logs.some((line) => line.includes("已停止")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stop: pid 文件里的进程已不存在 ⇒ 清残留、退出 0、不发信号", async () => {
  const home = freshHome();
  try {
    const cfg = loadConfig({ PI_WORKBENCH_HOME: home });
    const paths = resolvePaths(home);
    writeFileSync(paths.pid, "4321", "utf8");

    const h = harness(null, null);
    const code = await stop({ ...h.options, config: cfg });

    assert.equal(code, 0);
    assert.deepEqual(h.killed, []);
    assert.equal(existsSync(paths.pid), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("index.ts: 顶层无副作用，可被导入而不启动（坏配置下也不炸）", async () => {
  const home = freshHome();
  const previous = process.env["PI_WORKBENCH_HOME"];
  try {
    // 若 index.ts 顶层执行 loadConfig，这里会因非法 YAML 抛错
    writeFileSync(join(home, "config.yaml"), "host: [unclosed\n  bad: : :\n", "utf8");
    process.env["PI_WORKBENCH_HOME"] = home;

    const mod: { main?: unknown } = await import("../src/index.ts");
    assert.equal(typeof mod.main, "function", "index.ts 应导出 main 供入口调用");
  } finally {
    if (previous === undefined) delete process.env["PI_WORKBENCH_HOME"];
    else process.env["PI_WORKBENCH_HOME"] = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 子命令：用法、参数解析、假 daemon 端到端
// ---------------------------------------------------------------------------

type RecordedRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
};

/** 假 daemon：监听 0 端口，记录请求，按 reply 返回（单测不依赖真 daemon） */
async function fakeDaemon(reply: (request: RecordedRequest) => { status?: number; body: unknown }) {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      const entry: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: raw.length === 0 ? undefined : (JSON.parse(raw) as unknown),
      };
      requests.push(entry);
      const out = reply(entry);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });

  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    requests,
    url: "http://127.0.0.1:" + String(port),
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((done, fail) => {
        server.close((err) => {
          if (err === undefined) done();
          else fail(err);
        });
      });
    },
  };
}

/** 收集输出：env 传空对象，避免宿主的 PI_WORKBENCH_URL/TOKEN 污染断言 */
function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  const options: CliOptions = {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    env: {},
  };
  return { logs, errors, options };
}

test("--help 列出全部 13 个子命令", async () => {
  const out = output();
  const code = await main(["node", "pi-workbench", "--help"], out.options);
  const text = out.logs.join("\n");

  assert.equal(code, 0);
  assert.equal(SUBCOMMANDS.length, 13);
  for (const name of SUBCOMMANDS) {
    assert.ok(text.includes(name), "用法里缺少子命令 " + name);
    assert.ok(USAGE.includes(name), "USAGE 常量里缺少子命令 " + name);
  }
  assert.ok(text.includes("checkpoint") && text.includes("handback") && text.includes("sessions"));
  assert.ok(text.includes("lease"), "用法里必须有 lease（写操作取租约的唯一入口）");
  assert.ok(text.includes("退出码"), "用法必须写清 0/1/2 退出码");
  assert.ok(text.includes("E_NO_LEASE"), "用法必须写明写操作需要持有租约");
});

test("缺少 key ⇒ 退出码 2，原因与用法都打到 stderr", async () => {
  const out = output();
  const code = await main(["node", "pi-workbench", "see"], out.options);
  const stderr = out.errors.join("\n");

  assert.equal(code, 2);
  assert.equal(out.logs.length, 0, "用法错误不应写到 stdout");
  assert.ok(stderr.includes("需要一个会话 key"), stderr);
  assert.ok(stderr.includes("handoff"), "stderr 里应带上完整用法");
});

test("未知参数 ⇒ 退出码 2", async () => {
  const out = output();
  const code = await main(["node", "pi-workbench", "sessions", "--nope", "x"], out.options);

  assert.equal(code, 2);
  assert.ok(out.errors.join("\n").includes("未知参数：--nope"));
});

test("checkpoint 缺 --summary ⇒ 退出码 2", async () => {
  const out = output();
  const code = await main(["node", "pi-workbench", "checkpoint", "claude:abc"], out.options);

  assert.equal(code, 2);
  assert.ok(out.errors.join("\n").includes("--summary"));
});

test("sessions 打到 /api/cp/sessions，带 Bearer 与过滤查询串", async () => {
  const daemon = await fakeDaemon(() => ({
    body: [{ key: "claude:abc", status: "running", driver: "pi", cwd: "/w" }],
  }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "sessions", "--agent", "claude", "--status", "running", "--url", daemon.url, "--token", "tok"],
      out.options,
    );

    assert.equal(code, 0);
    assert.equal(daemon.requests.length, 1);
    assert.equal(daemon.requests[0]?.method, "GET");
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions?agent=claude&status=running");
    assert.equal(daemon.requests[0]?.authorization, "Bearer tok");
    assert.ok(out.logs.join("\n").includes("claude:abc"), out.logs.join("\n"));
    assert.ok(out.logs.join("\n").includes("running"));
  } finally {
    await daemon.close();
  }
});

test("inject 把文本与 --client-id 放进 body", async () => {
  const daemon = await fakeDaemon(() => ({ body: { messageId: "m-1", effective: "next_turn" } }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "inject", "claude:abc", "你好", "世界", "--client-id", "pi:7", "--url", daemon.url],
      out.options,
    );

    assert.equal(code, 0);
    assert.equal(daemon.requests[0]?.method, "POST");
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions/claude%3Aabc/inject");
    assert.deepEqual(daemon.requests[0]?.body, { text: "你好 世界", clientId: "pi:7" });
    assert.ok(out.logs.join("\n").includes("next_turn"));
  } finally {
    await daemon.close();
  }
});

test("see 拼出 after/limit 查询串并摘要消息", async () => {
  const daemon = await fakeDaemon(() => ({
    body: { messages: [{ role: "assistant", kind: "text", text: "好的" }], nextCursor: "99" },
  }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "see", "claude:abc", "--after", "12", "--limit", "5", "--url", daemon.url],
      out.options,
    );

    assert.equal(code, 0);
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions/claude%3Aabc/transcript?after=12&limit=5");
    const text = out.logs.join("\n");
    assert.ok(text.includes("1 条新消息"), text);
    assert.ok(text.includes("游标 99"), text);
    assert.ok(text.includes("好的"), text);
  } finally {
    await daemon.close();
  }
});

test("handoff 默认交给 human，打印接管命令与 handback 提示", async () => {
  const daemon = await fakeDaemon(() => ({
    body: {
      checkpoint: { sessionKey: "claude:abc", summary: "s", touchedFiles: [], nextStep: "", transcriptCursor: "1", createdAt: "t" },
      command: ["claude", "--resume", "abc"],
      mode: "resume-tui",
    },
  }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "handoff", "claude:abc", "--summary", "交接", "--url", daemon.url],
      out.options,
    );

    assert.equal(code, 0);
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions/claude%3Aabc/handoff");
    const body = daemon.requests[0]?.body as Record<string, unknown>;
    assert.equal(body["to"], "human");
    assert.equal(body["summary"], "交接");
    assert.equal(body["clientId"], "cli:" + process.pid);

    const text = out.logs.join("\n");
    assert.ok(text.includes("接管命令：claude --resume abc"), text);
    assert.ok(text.includes("--client-id handoff-cli:" + process.pid), text);
  } finally {
    await daemon.close();
  }
});

test("daemon 返回 409 ⇒ 退出 1，stderr 打印 code: message", async () => {
  const daemon = await fakeDaemon(() => ({
    status: 409,
    body: { error: { code: "E_NO_LEASE", message: "无有效租约：claude:abc" } },
  }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "interrupt", "claude:abc", "--url", daemon.url],
      out.options,
    );

    assert.equal(code, 1);
    assert.equal(out.errors.join("\n"), "E_NO_LEASE: 无有效租约：claude:abc");
  } finally {
    await daemon.close();
  }
});



// ---------------------------------------------------------------------------
// I1：interrupt / checkpoint / handback 的 method + url + body 断言
// （旧用例只断言退出码，把 /interrupt 改成 /interrupts 也照样绿）
// ---------------------------------------------------------------------------

test("interrupt 打到 /interrupt，body 只有 clientId", async () => {
  const daemon = await fakeDaemon(() => ({ body: { stopReason: "user_cancelled" } }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "interrupt", "claude:abc", "--client-id", "pi:7", "--url", daemon.url],
      out.options,
    );

    assert.equal(code, 0);
    assert.equal(daemon.requests.length, 1);
    assert.equal(daemon.requests[0]?.method, "POST");
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions/claude%3Aabc/interrupt");
    assert.deepEqual(daemon.requests[0]?.body, { clientId: "pi:7" });
    assert.ok(out.logs.join("\n").includes("user_cancelled"), out.logs.join("\n"));
  } finally {
    await daemon.close();
  }
});

test("checkpoint 打到 /checkpoint，body 含 summary / nextStep / touchedFiles / clientId", async () => {
  const daemon = await fakeDaemon(() => ({
    body: {
      sessionKey: "claude:abc",
      summary: "做了一半",
      touchedFiles: ["a.ts"],
      nextStep: "继续",
      transcriptCursor: "7",
      createdAt: "2026-11-15T00:00:00.000Z",
    },
  }));
  try {
    const out = output();
    const code = await main(
      [
        "node",
        "pi-workbench",
        "checkpoint",
        "claude:abc",
        "--summary",
        "做了一半",
        "--next-step",
        "继续",
        "--file",
        "a.ts",
        "--file",
        "b.ts",
        "--client-id",
        "pi:9",
        "--url",
        daemon.url,
      ],
      out.options,
    );

    assert.equal(code, 0);
    assert.equal(daemon.requests.length, 1);
    assert.equal(daemon.requests[0]?.method, "POST");
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions/claude%3Aabc/checkpoint");
    assert.deepEqual(daemon.requests[0]?.body, {
      clientId: "pi:9",
      summary: "做了一半",
      nextStep: "继续",
      touchedFiles: ["a.ts", "b.ts"],
    });
    assert.ok(out.logs.join("\n").includes("cursor=7"), out.logs.join("\n"));
  } finally {
    await daemon.close();
  }
});

test("handback 打到 /handback，body 只有 clientId，并打印 resumed / 增量", async () => {
  const daemon = await fakeDaemon(() => ({ body: { resumed: true, deltaSummary: "人类改了两行" } }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "handback", "claude:abc", "--client-id", "handoff-pi:7", "--url", daemon.url],
      out.options,
    );

    assert.equal(code, 0);
    assert.equal(daemon.requests.length, 1);
    assert.equal(daemon.requests[0]?.method, "POST");
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions/claude%3Aabc/handback");
    assert.deepEqual(daemon.requests[0]?.body, { clientId: "handoff-pi:7" });
    const text = out.logs.join("\n");
    assert.ok(text.includes("resumed=true"), text);
    assert.ok(text.includes("人类改了两行"), text);
  } finally {
    await daemon.close();
  }
});

// ---------------------------------------------------------------------------
// I2：lease 子命令（写操作的前置条件，第 11 个子命令）
// ---------------------------------------------------------------------------

test("lease acquire 打到 /lease，body 含 action/driver/clientId/ttlMs，输出租约 JSON", async () => {
  const daemon = await fakeDaemon(() => ({
    body: {
      sessionKey: "claude:abc",
      driver: "pi",
      clientId: "e2e-1",
      expiresAt: "2026-11-15T00:00:30.000Z",
      heartbeatAt: "2026-11-15T00:00:00.000Z",
    },
  }));
  try {
    const out = output();
    const code = await main(
      [
        "node",
        "pi-workbench",
        "lease",
        "claude:abc",
        "--action",
        "acquire",
        "--driver",
        "pi",
        "--client-id",
        "e2e-1",
        "--ttl-ms",
        "60000",
        "--url",
        daemon.url,
      ],
      out.options,
    );

    assert.equal(code, 0);
    assert.equal(daemon.requests.length, 1);
    assert.equal(daemon.requests[0]?.method, "POST");
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions/claude%3Aabc/lease");
    assert.deepEqual(daemon.requests[0]?.body, {
      action: "acquire",
      clientId: "e2e-1",
      driver: "pi",
      ttlMs: 60000,
    });

    // 租约必须原样打 JSON：expiresAt / clientId 是后续子命令要用的字段
    const printed = out.logs.join("\n");
    const parsed = JSON.parse(printed) as Record<string, unknown>;
    assert.equal(parsed["clientId"], "e2e-1");
    assert.equal(parsed["expiresAt"], "2026-11-15T00:00:30.000Z");
  } finally {
    await daemon.close();
  }
});

test("lease release 不发 driver（服务端按 clientId 释放）", async () => {
  const daemon = await fakeDaemon(() => ({
    body: { released: true, sessionKey: "claude:abc", clientId: "pi:7" },
  }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "lease", "claude:abc", "--action", "release", "--client-id", "pi:7", "--url", daemon.url],
      out.options,
    );

    assert.equal(code, 0);
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions/claude%3Aabc/lease");
    assert.deepEqual(daemon.requests[0]?.body, { action: "release", clientId: "pi:7" });
    assert.ok(out.logs.join("\n").includes("released"));
  } finally {
    await daemon.close();
  }
});

test("lease 的用法错误一律退出码 2：缺 --action / 非法 action / acquire 缺 --driver / --ttl-ms 非正整数", async () => {
  const cases: Array<{ args: string[]; match: string }> = [
    { args: ["lease", "claude:abc"], match: "--action" },
    { args: ["lease", "claude:abc", "--action", "steal"], match: "acquire / release / heartbeat" },
    { args: ["lease", "claude:abc", "--action", "acquire"], match: "--driver" },
    { args: ["lease", "claude:abc", "--action", "heartbeat", "--ttl-ms", "abc"], match: "正整数" },
  ];

  for (const item of cases) {
    const out = output();
    const code = await main(["node", "pi-workbench", ...item.args], out.options);
    assert.equal(code, 2, JSON.stringify(item.args));
    assert.equal(out.logs.length, 0, "用法错误不写 stdout：" + JSON.stringify(item.args));
    assert.ok(out.errors.join("\n").includes(item.match), JSON.stringify(item.args) + " → " + out.errors.join("\n"));
  }
});

// ---------------------------------------------------------------------------
// 其它评审修复：--limit 本地校验、start/stop/status 拒远端参数、start --help
// ---------------------------------------------------------------------------

test("see --limit abc ⇒ 退出 2，且一个请求都不发（以前会变成服务端 400 ⇒ exit 1）", async () => {
  const daemon = await fakeDaemon(() => ({ body: { messages: [], nextCursor: "0" } }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "see", "claude:abc", "--limit", "abc", "--url", daemon.url],
      out.options,
    );

    assert.equal(code, 2);
    assert.ok(out.errors.join("\n").includes("正整数"));
    assert.equal(daemon.requests.length, 0);
  } finally {
    await daemon.close();
  }
});

test("I5：start/stop/status 收到 --url/--json/--client-id ⇒ 退出 2 并指向远端子命令", async () => {
  const cases: string[][] = [
    ["start", "--url", "http://remote:7331"],
    ["stop", "--token", "t"],
    ["status", "--json"],
    ["status", "--client-id", "x"],
  ];

  for (const item of cases) {
    const out = output();
    const code = await main(["node", "pi-workbench", ...item], out.options);
    assert.equal(code, 2, JSON.stringify(item));
    const stderr = out.errors.join("\n");
    assert.ok(stderr.includes("只操作本机 daemon"), JSON.stringify(item) + " → " + stderr);
    assert.ok(stderr.includes("sessions/see/inject"), stderr);
    assert.equal(out.logs.length, 0, "用法错误不写 stdout");
  }
});

test("start --help 打印用法，不启动 daemon", async () => {
  const home = freshHome();
  try {
    const paths = resolvePaths(home);
    const logs: string[] = [];
    const code = await main(["node", "pi-workbench", "start", "--help"], { log: (line) => logs.push(line), env: { PI_WORKBENCH_HOME: home } });

    assert.equal(code, 0);
    assert.ok(logs.join("\n").includes("用法：pi-workbench"), logs.join("\n"));
    assert.equal(existsSync(paths.pid), false, "不应写 pid 文件");
    assert.equal(existsSync(join(paths.logs, "daemon.log")), false, "不应 spawn daemon（start 一定会先建日志文件）");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("连不上 daemon ⇒ 退出 1 并提示启动命令", async () => {
  const daemon = await fakeDaemon(() => ({ body: {} }));
  const url = daemon.url;
  await daemon.close();

  const out = output();
  const code = await main(["node", "pi-workbench", "sessions", "--url", url], out.options);

  assert.equal(code, 1);
  const stderr = out.errors.join("\n");
  assert.ok(stderr.includes("E_DAEMON_DOWN"), stderr);
  assert.ok(stderr.includes("pi-workbench start"), stderr);
});
// ---------------------------------------------------------------------------
// 读语义 v2：unread / read / sessions --client-id
// ---------------------------------------------------------------------------

test("unread 默认 ack=1，--peek 传 ack=0", async () => {
  const daemon = await fakeDaemon(() => ({
    body: {
      messages: [{ id: "m1", role: "assistant", kind: "text", text: "干完了" }],
      nextCursor: "42",
      lastReadCursor: "42",
      unread: 1,
      awaiting: false,
      acked: true,
    },
  }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "unread", "claude:abc", "--client-id", "pi:7", "--url", daemon.url],
      out.options,
    );
    assert.equal(code, 0);
    assert.equal(daemon.requests[0]?.method, "GET");
    assert.equal(
      daemon.requests[0]?.url,
      "/api/cp/sessions/claude%3Aabc/unread?clientId=pi%3A7&ack=1",
    );
    assert.ok(out.logs.join("\n").includes("干完了"), out.logs.join("\n"));

    const peekOut = output();
    const peekCode = await main(
      ["node", "pi-workbench", "unread", "claude:abc", "--client-id", "pi:7", "--peek", "--url", daemon.url],
      peekOut.options,
    );
    assert.equal(peekCode, 0);
    assert.equal(daemon.requests[1]?.url, "/api/cp/sessions/claude%3Aabc/unread?clientId=pi%3A7&ack=0");
  } finally {
    await daemon.close();
  }
});

test("read 默认 body 只有 clientId；--cursor 才带游标", async () => {
  const daemon = await fakeDaemon(() => ({
    body: { sessionKey: "claude:abc", clientId: "pi:7", lastReadCursor: "42" },
  }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "read", "claude:abc", "--client-id", "pi:7", "--url", daemon.url],
      out.options,
    );
    assert.equal(code, 0);
    assert.equal(daemon.requests[0]?.method, "POST");
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions/claude%3Aabc/read");
    assert.deepEqual(daemon.requests[0]?.body, { clientId: "pi:7" });
    assert.ok(out.logs.join("\n").includes("42"), out.logs.join("\n"));

    const withCursor = output();
    const code2 = await main(
      ["node", "pi-workbench", "read", "claude:abc", "--client-id", "pi:7", "--cursor", "9", "--url", daemon.url],
      withCursor.options,
    );
    assert.equal(code2, 0);
    assert.deepEqual(daemon.requests[1]?.body, { clientId: "pi:7", cursor: "9" });
  } finally {
    await daemon.close();
  }
});

test("sessions --client-id 带 reader 并显示未读", async () => {
  const daemon = await fakeDaemon(() => ({
    body: [
      {
        key: "claude:abc",
        status: "idle",
        driver: "pi",
        cwd: "E:\\w",
        unread: 3,
        awaiting: false,
      },
    ],
  }));
  try {
    const out = output();
    const code = await main(
      ["node", "pi-workbench", "sessions", "--client-id", "pi:7", "--url", daemon.url],
      out.options,
    );
    assert.equal(code, 0);
    assert.equal(daemon.requests[0]?.url, "/api/cp/sessions?clientId=pi%3A7");
    assert.ok(out.logs.join("\n").includes("unread=3"), out.logs.join("\n"));
  } finally {
    await daemon.close();
  }
});
