import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnCodexAcpAdapter } from "../src/adapters/codex-acp.ts";
import type { Config } from "../src/config.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-codex-acp-agent.mjs", import.meta.url));
const WORKSPACE = fileURLToPath(new URL("./", import.meta.url));

function makeConfig(initialAgentMode: Config["codex"]["initialAgentMode"]): Config {
  return {
    host: "127.0.0.1",
    port: 7331,
    home: WORKSPACE,
    authToken: null,
    leaseTtlMs: 30_000,
    dispatchReservedTtlMs: 120_000,
    claude: { adapterCmd: [process.execPath, FIXTURE], permissionMode: "auto_allow", initialPermissionMode: "auto" },
    codex: { adapterCmd: [process.execPath, FIXTURE], permissionMode: "auto_allow", initialAgentMode },
    pi: { rpcCmd: ["pi", "--mode", "rpc"] },
  };
}

test("spawnCodexAcpAdapter 把 codex.initialAgentMode 注入 INITIAL_AGENT_MODE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-acp-env-"));
  const envPath = join(dir, "env.txt");
  const adapter = await spawnCodexAcpAdapter(makeConfig("agent-full-access"), {
    adapterCmd: [process.execPath, FIXTURE, "--record-env", envPath],
    cwd: WORKSPACE,
  });
  try {
    assert.equal(readFileSync(envPath, "utf8").trim(), "agent-full-access");
  } finally {
    await adapter.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnCodexAcpAdapter 默认 workspace-write 时也注入该值", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-acp-env-"));
  const envPath = join(dir, "env.txt");
  const adapter = await spawnCodexAcpAdapter(makeConfig("workspace-write"), {
    adapterCmd: [process.execPath, FIXTURE, "--record-env", envPath],
    cwd: WORKSPACE,
  });
  try {
    assert.equal(readFileSync(envPath, "utf8").trim(), "workspace-write");
  } finally {
    await adapter.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
