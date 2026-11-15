import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureDaemon, isLoopbackUrl } from "../src/daemon.ts";

type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> };

/** 假 spawn：记录调用，返回带 pid/unref 的最小 ChildProcess */
function fakeSpawn(calls: SpawnCall[]): typeof import("node:child_process").spawn {
  return ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return { pid: 4242, unref: () => {} };
  }) as unknown as typeof import("node:child_process").spawn;
}

/** 造一个真实存在的"入口文件"（ensureDaemon 会 existsSync） */
function entryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-daemon-"));
  const file = join(dir, "cli.js");
  writeFileSync(file, "// fake\n");
  return file;
}

test("已健康 → 不 spawn，started=false", async () => {
  const calls: SpawnCall[] = [];
  const result = await ensureDaemon({
    baseUrl: "http://127.0.0.1:7331",
    probe: async () => true,
    spawnImpl: fakeSpawn(calls),
    entry: entryFile(),
  });
  assert.equal(result.started, false);
  assert.equal(calls.length, 0);
});

test("冷启动：detached spawn cli start，轮询到就绪", async () => {
  const calls: SpawnCall[] = [];
  let probes = 0;
  const result = await ensureDaemon({
    baseUrl: "http://127.0.0.1:7331",
    entry: entryFile(),
    pollMs: 1,
    timeoutMs: 1000,
    probe: async () => {
      probes += 1;
      return probes >= 3; // 前两次没起来
    },
    spawnImpl: fakeSpawn(calls),
  });

  assert.equal(result.started, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args[0]?.endsWith("cli.js"), true);
  assert.equal(calls[0]?.args[1], "start");
  assert.equal(calls[0]?.options["detached"], true);
  assert.equal(calls[0]?.options["stdio"], "ignore");
  // 新 daemon 必须监听 baseUrl 的端口，否则探 A 端口、起 B 端口
  const env = calls[0]?.options["env"] as Record<string, string>;
  assert.equal(env["PI_WORKBENCH_PORT"], "7331");
  assert.equal(env["PI_WORKBENCH_HOST"], "127.0.0.1");
  assert.ok(probes >= 3);
});

test("等超时 → 抛 E_DAEMON_DOWN 并给出手工启动命令", async () => {
  const calls: SpawnCall[] = [];
  await assert.rejects(
    () =>
      ensureDaemon({
        baseUrl: "http://127.0.0.1:7331",
        entry: entryFile(),
        pollMs: 1,
        timeoutMs: 30,
        probe: async () => false,
        spawnImpl: fakeSpawn(calls),
      }),
    (err: unknown) =>
      err instanceof Error && err.message.startsWith("E_DAEMON_DOWN") && err.message.includes(" start"),
  );
  assert.equal(calls.length, 1, "超时前只该起一次");
});

test("非回环地址 → 不起进程（远端 daemon 自己管）", async () => {
  const calls: SpawnCall[] = [];
  const result = await ensureDaemon({
    baseUrl: "http://10.0.0.5:7331",
    entry: entryFile(),
    probe: async () => false,
    spawnImpl: fakeSpawn(calls),
  });
  assert.equal(result.started, false);
  assert.equal(calls.length, 0);
});

test("入口文件不存在 → 立刻报错（先 pnpm -r build），不白等", async () => {
  const calls: SpawnCall[] = [];
  await assert.rejects(
    () =>
      ensureDaemon({
        baseUrl: "http://127.0.0.1:7331",
        entry: join(tmpdir(), "definitely-missing-cli.js"),
        probe: async () => false,
        spawnImpl: fakeSpawn(calls),
      }),
    /E_DAEMON_DOWN: 找不到控制面入口/,
  );
  assert.equal(calls.length, 0);
});

test("isLoopbackUrl：127/8、::1、localhost 算回环，其余不算", () => {
  for (const url of ["http://127.0.0.1:7331", "http://127.5.6.7:1", "http://localhost:7331", "http://[::1]:7331"]) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
  for (const url of ["http://10.0.0.5:7331", "http://example.com:7331", "not-a-url"]) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
});
