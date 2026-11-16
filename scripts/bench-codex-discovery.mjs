#!/usr/bin/env node
/**
 * Codex rollout 发现性能基准（B08 S2 / P3-1）。
 *
 *   node --experimental-strip-types scripts/bench-codex-discovery.mjs
 *
 * 生成 1000 个临时 rollout（首行 session_meta），连续调用两次：
 * - firstMs：冷缓存首扫
 * - cachedMs：目录 mtime + 文件 mtime/size 命中后的重复扫描
 * 只使用临时目录，结束自动清理，不触碰 ~/.codex。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearCodexDiscoveryCache, discoverCodexSessions } from "../packages/control-plane/src/discover/codex.ts";

const COUNT = 1000;
const CWD = "E:\\pi-workbench\\bench-workspace";
const root = mkdtempSync(join(tmpdir(), "pi-wb-codex-bench-"));
const dayMs = 86_400_000;
const now = Date.now();

try {
  for (let i = 0; i < COUNT; i += 1) {
    const stamp = new Date(now - (i % 64) * dayMs);
    const yyyy = String(stamp.getUTCFullYear());
    const mm = String(stamp.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(stamp.getUTCDate()).padStart(2, "0");
    const dir = join(root, yyyy, mm, dd);
    mkdirSync(dir, { recursive: true });
    const id = "00000000-0000-7000-8000-" + String(i).padStart(12, "0");
    const meta = {
      type: "session_meta",
      payload: {
        id,
        session_id: id,
        timestamp: stamp.toISOString(),
        cwd: CWD,
        thread_source: "user",
        cli_version: "0.167.0",
      },
    };
    writeFileSync(join(dir, "rollout-" + stamp.toISOString().replace(/[:.]/g, "-") + "-" + id + ".jsonl"), JSON.stringify(meta) + "\n", "utf8");
  }

  clearCodexDiscoveryCache();
  const firstStart = performance.now();
  const first = await discoverCodexSessions({ sessionsRoot: root, cwd: CWD, sinceDays: 3650 });
  const firstMs = performance.now() - firstStart;

  const cachedStart = performance.now();
  const cached = await discoverCodexSessions({ sessionsRoot: root, cwd: CWD, sinceDays: 3650 });
  const cachedMs = performance.now() - cachedStart;

  console.log(JSON.stringify({ count: first.length, cachedCount: cached.length, firstMs: Math.round(firstMs), cachedMs: Math.round(cachedMs) }));
  if (first.length !== COUNT || cached.length !== COUNT) {
    console.error("bench 结果数量不符合预期：" + first.length + " / " + cached.length);
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
