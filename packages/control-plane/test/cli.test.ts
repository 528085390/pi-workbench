import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";
import { stop, type CliOptions } from "../src/cli.ts";

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
      killed.push(`${pid}:${signal}`);
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
      `应打印明确原因，实际：${JSON.stringify(h.errors)}`,
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
