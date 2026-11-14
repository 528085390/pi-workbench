import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { loadConfig } from "../src/config.ts";
import { acquireInstanceLock, resolvePaths } from "../src/paths.ts";

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

test("loadConfig: 空目录时写入默认值", () => {
  const home = freshHome();
  try {
    const cfg = loadConfig({ PI_WORKBENCH_HOME: home });
    assert.equal(cfg.host, "127.0.0.1");
    assert.equal(cfg.port, 7331);
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
    assert.equal(obj["port"], 7331);
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
