/**
 * C05 资产只读清单（Task 10）。
 * 口径：spec §7.5 —— 只读清单；缺失文件=空清单；结构错误=E_ASSET_CONFIG_INVALID（400）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadAssets } from "../src/assets.ts";
import type { Config } from "../src/config.ts";
import { WorkbenchError } from "../src/errors.ts";
import { createServer } from "../src/server.ts";
import type { ServerDeps } from "../src/server.ts";

function assetsDir(): string {
  return mkdtempSync(join(tmpdir(), "pw-assets-"));
}

function writeAssets(dir: string, value: unknown): string {
  const file = join(dir, "assets.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function makeConfig(home: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    home,
    authToken: null,
    leaseTtlMs: 30_000,
    dispatchReservedTtlMs: 120_000,
    claude: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialPermissionMode: "auto" },
    codex: { adapterCmd: [process.execPath], permissionMode: "auto_allow", initialAgentMode: "workspace-write" },
    pi: { rpcCmd: ["pi", "--mode", "rpc"] },
  };
}

test("缺失文件返回空清单", () => {
  assert.deepEqual(loadAssets(join(tmpdir(), "nope-assets.json")), {
    mcpServers: [],
    skills: [],
    memory: { projection: "disabled" },
  });
});

test("skills 带 exists 判定", () => {
  const dir = assetsDir();
  const file = writeAssets(dir, {
    mcpServers: [{ name: "m", transport: "stdio", command: ["x"] }],
    skills: [{ name: "s", path: "/definitely/not/here" }],
  });
  const inv = loadAssets(file);
  assert.equal(inv.skills[0]?.exists, false);
  assert.deepEqual(inv.mcpServers[0], { name: "m", transport: "stdio", command: ["x"] });
  assert.equal(inv.memory.projection, "disabled");
});

test("结构错误抛 E_ASSET_CONFIG_INVALID", () => {
  const dir = assetsDir();
  const file = writeAssets(dir, { skills: "nope" });
  assert.throws(
    () => loadAssets(file),
    (e: unknown) => e instanceof WorkbenchError && e.code === "E_ASSET_CONFIG_INVALID",
  );
});

test("GET /api/cp/assets 返回只读清单并标注 exists", async () => {
  const dir = assetsDir();
  const skillDir = join(dir, "skills", "s");
  mkdirSync(skillDir, { recursive: true });
  const file = writeAssets(dir, {
    mcpServers: [{ name: "m", transport: "stdio", command: ["x"] }],
    skills: [
      { name: "s", path: skillDir },
      { name: "gone", path: join(dir, "skills", "gone") },
    ],
  });
  const app = await createServer({ config: makeConfig(dir), assetsPath: file } as unknown as ServerDeps);
  try {
    const res = await app.inject({ method: "GET", url: "/api/cp/assets" });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      mcpServers: [{ name: "m", transport: "stdio", command: ["x"] }],
      skills: [
        { name: "s", path: skillDir, exists: true },
        { name: "gone", path: join(dir, "skills", "gone"), exists: false },
      ],
      memory: { projection: "disabled" },
    });
  } finally {
    await app.close();
  }
});

test("GET /api/cp/assets 结构错误映射为 400 E_ASSET_CONFIG_INVALID", async () => {
  const dir = assetsDir();
  const file = writeAssets(dir, { skills: "nope" });
  const app = await createServer({ config: makeConfig(dir), assetsPath: file } as unknown as ServerDeps);
  try {
    const res = await app.inject({ method: "GET", url: "/api/cp/assets" });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json<{ error: { code: string } }>().error.code, "E_ASSET_CONFIG_INVALID");
  } finally {
    await app.close();
  }
});
