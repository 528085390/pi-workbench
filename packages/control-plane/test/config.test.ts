import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { DEFAULT_PORT } from "@pi-workbench/shared";

import { loadConfig } from "../src/config.ts";
import { MAX_LOCK_ATTEMPTS, acquireInstanceLock, resolvePaths } from "../src/paths.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-wb-cfg-"));
}

function errCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function pathsModuleUrl(): string {
  const here = fileURLToPath(import.meta.url);
  return pathToFileURL(join(here, "..", "..", "src", "paths.ts")).href;
}

test("loadConfig: 空目录时写入默认值", () => {
  const home = freshHome();
  try {
    const cfg = loadConfig({ PI_WORKBENCH_HOME: home });
    assert.equal(cfg.host, "127.0.0.1");
    assert.equal(cfg.port, DEFAULT_PORT);
    assert.equal(cfg.leaseTtlMs, 30000);
    assert.equal(cfg.authToken, null);
    assert.equal(cfg.home, home);
    assert.equal(cfg.claude.permissionMode, "auto_allow");
    assert.ok(Array.isArray(cfg.claude.adapterCmd));
    assert.ok(cfg.claude.adapterCmd.length > 0);
    assert.ok(cfg.claude.adapterCmd.every((part) => typeof part === "string"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig: 缺省时在 home 下生成 config.yaml", () => {
  const home = freshHome();
  try {
    const cfgPath = join(home, "config.yaml");
    assert.equal(existsSync(cfgPath), false);
    loadConfig({ PI_WORKBENCH_HOME: home });
    assert.equal(existsSync(cfgPath), true);
    const text = readFileSync(cfgPath, "utf8");
    const written: unknown = parseYaml(text);
    assert.equal(typeof written, "object");
    const obj = written as Record<string, unknown>;
    assert.equal(obj["host"], "127.0.0.1");
    assert.equal(obj["port"], DEFAULT_PORT);
    assert.equal(obj["leaseTtlMs"], 30000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig: env 覆盖端口与主机", () => {
  const home = freshHome();
  try {
    const cfg = loadConfig({ PI_WORKBENCH_HOME: home, PI_WORKBENCH_PORT: "7400", PI_WORKBENCH_HOST: "0.0.0.0" });
    assert.equal(cfg.port, 7400);
    assert.equal(typeof cfg.port, "number");
    assert.equal(cfg.host, "0.0.0.0");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig: 文件字段优先，缺失字段回填并回写", () => {
  const home = freshHome();
  try {
    const cfgPath = join(home, "config.yaml");
    writeFileSync(cfgPath, "authToken: secret-token\nport: 7500\n", "utf8");
    const cfg = loadConfig({ PI_WORKBENCH_HOME: home });
    assert.equal(cfg.authToken, "secret-token");
    assert.equal(cfg.port, 7500);
    assert.equal(cfg.host, "127.0.0.1");
    assert.equal(cfg.leaseTtlMs, 30000);
    const rewritten = parseYaml(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    assert.equal(rewritten["leaseTtlMs"], 30000);
    assert.equal(rewritten["authToken"], "secret-token");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig: YAML 非法时抛出清晰错误", () => {
  const home = freshHome();
  try {
    const cfgPath = join(home, "config.yaml");
    writeFileSync(cfgPath, "host: [unclosed\n  bad: : :\n", "utf8");
    assert.throws(
      () => loadConfig({ PI_WORKBENCH_HOME: home }),
      (err: unknown) => err instanceof Error && err.message.includes("config.yaml"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolvePaths: 返回 home 下的绝对路径", () => {
  const home = freshHome();
  try {
    const paths = resolvePaths(home);
    assert.ok(isAbsolute(paths.db));
    assert.ok(isAbsolute(paths.logs));
    assert.ok(isAbsolute(paths.handoffs));
    assert.ok(isAbsolute(paths.pid));
    assert.ok(paths.db.endsWith("workbench.db"));
    assert.equal(paths.db, join(home, "workbench.db"));
    assert.equal(paths.logs, join(home, "logs"));
    assert.equal(paths.handoffs, join(home, "handoffs"));
    assert.equal(paths.pid, join(home, "workbench.pid"));
    assert.ok(paths.db.startsWith(home + sep));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acquireInstanceLock: 二次获取抛 E_ALREADY_RUNNING，release 后可再取", () => {
  const home = freshHome();
  try {
    const paths = resolvePaths(home);
    const first = acquireInstanceLock(paths.pid);
    assert.equal(existsSync(paths.pid), true);
    assert.equal(readFileSync(paths.pid, "utf8").trim(), String(process.pid));

    assert.throws(
      () => acquireInstanceLock(paths.pid),
      (err: unknown) => errCode(err) === "E_ALREADY_RUNNING",
    );

    first.release();
    assert.equal(existsSync(paths.pid), false);

    const second = acquireInstanceLock(paths.pid);
    second.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acquireInstanceLock: 残留死进程 pid 文件可被接管", async () => {
  const home = freshHome();
  try {
    const paths = resolvePaths(home);
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    const deadPid = child.pid;
    await once(child, "exit");
    assert.equal(typeof deadPid, "number");
    writeFileSync(paths.pid, String(deadPid), "utf8");

    const lock = acquireInstanceLock(paths.pid);
    assert.equal(readFileSync(paths.pid, "utf8").trim(), String(process.pid));
    lock.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acquireInstanceLock: 新鲜的空 pid 文件不被当作残留（不删别人的锁）", () => {
  const home = freshHome();
  try {
    const paths = resolvePaths(home);
    // 模拟 P1 刚 openSync("wx") 成功、还没写 pid 的窗口
    writeFileSync(paths.pid, "", "utf8");
    const age = Date.now() - statSync(paths.pid).mtimeMs;
    assert.ok(age < 1000, `空 pid 文件应当是新鲜的（age=${age}ms）`);

    assert.throws(
      () => acquireInstanceLock(paths.pid),
      (err: unknown) => errCode(err) === "EEXIST",
      "新鲜的空 pid 文件必须拒绝抢锁（原样抛 EEXIST），而不是接管",
    );
    // 关键断言：拒绝时不能删掉别人正在持有的锁文件
    assert.equal(existsSync(paths.pid), true);
    assert.equal(readFileSync(paths.pid, "utf8"), "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acquireInstanceLock: 已过期（mtime 老）的空 pid 文件才按残留接管", () => {
  const home = freshHome();
  try {
    const paths = resolvePaths(home);
    writeFileSync(paths.pid, "", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(paths.pid, old, old);

    const lock = acquireInstanceLock(paths.pid);
    assert.equal(readFileSync(paths.pid, "utf8").trim(), String(process.pid));
    lock.release();
    assert.equal(existsSync(paths.pid), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acquireInstanceLock: 重试耗尽仍 EEXIST 时抛原始 EEXIST（不臆造 pid -1）", () => {
  const home = freshHome();
  try {
    const paths = resolvePaths(home);
    // 新鲜空文件 + 退避重读也追不上写锁者：重试耗尽后应原样抛 EEXIST
    writeFileSync(paths.pid, "", "utf8");
    let thrown: unknown = null;
    const startedAt = Date.now();
    try {
      acquireInstanceLock(paths.pid);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown !== null, "应当抛错");
    assert.equal(errCode(thrown), "EEXIST");
    assert.equal((thrown as Error).name, "Error", "不应再被包装成 InstanceLockError(pid -1)");
    assert.ok(!String((thrown as Error).message).includes("pid -1"), "错误信息里不应出现 pid -1");
    assert.ok(Date.now() - startedAt >= (MAX_LOCK_ATTEMPTS - 1) * 50, "应做过退避重读");
    assert.equal(existsSync(paths.pid), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acquireInstanceLock: 两个并发进程抢同一 pid 文件，只有一个成功", async () => {
  const home = freshHome();
  try {
    const paths = resolvePaths(home);
    const script = join(home, "lock-race.mjs");
    writeFileSync(
      script,
      [
        `import { acquireInstanceLock } from "${pathsModuleUrl()}";`,
        "const pidPath = process.argv[2];",
        "const startAt = Number(process.argv[3]);",
        "while (Date.now() < startAt) { /* 同步对齐起跑线 */ }",
        "try {",
        "  const lock = acquireInstanceLock(pidPath);",
        '  process.stdout.write("ACQUIRED:" + String(process.pid) + "\\n");',
        // 故意不 release：保证败者在竞态窗口里始终看到「活着的持有者」，
        // 也让测试结束后还能验证 pid 文件没被别人删掉
        "  void lock;",
        "  setTimeout(() => process.exit(0), 500);",
        "} catch (err) {",
        '  const code = err && err.code ? String(err.code) : String(err);',
        '  process.stdout.write("REJECTED:" + code + "\\n");',
        "  process.exit(0);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const startAt = Date.now() + 250;
    const run = () =>
      spawn(process.execPath, ["--experimental-strip-types", script, paths.pid, String(startAt)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    const children = [run(), run()];
    const outs = await Promise.all(
      children.map(async (child) => {
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          out += chunk;
        });
        await once(child, "exit");
        return out.trim();
      }),
    );

    const acquired = outs.filter((line) => line.startsWith("ACQUIRED:"));
    const rejected = outs.filter((line) => line.startsWith("REJECTED:"));
    assert.equal(acquired.length, 1, `只能有一个进程抢到锁，实际输出：${JSON.stringify(outs)}`);
    assert.equal(rejected.length, 1, `另一个进程必须被拒绝，实际输出：${JSON.stringify(outs)}`);
    assert.ok(
      ["E_ALREADY_RUNNING", "EEXIST"].includes(rejected[0]?.split(":")[1] ?? ""),
      `被拒绝方应给出 E_ALREADY_RUNNING / EEXIST，实际：${rejected[0]}`,
    );
    const winnerPid = Number(acquired[0]?.split(":")[1]);
    assert.equal(readFileSync(paths.pid, "utf8").trim(), String(winnerPid), "pid 文件应属于胜者");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
