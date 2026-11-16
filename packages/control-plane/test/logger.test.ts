import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLogger, resolveLogDir } from "../src/logger.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "piwb-logger-"));
}

test("createLogger: 写入 daemon.log，info/error 带级别", () => {
  const dir = tempDir();
  const logger = createLogger({ dir, now: () => Date.parse("2026-11-17T00:00:00.000Z") });
  logger.info("hello");
  logger.error("boom");
  const file = join(dir, "daemon.log");
  assert.equal(readFileSync(file, "utf8"), "[2026-11-17T00:00:00.000Z] [INFO] hello\n[2026-11-17T00:00:00.000Z] [ERROR] boom\n");
});

test("createLogger: 超过 maxBytes 轮转为 .1/.2，keep 之外的旧文件删除", () => {
  const dir = tempDir();
  const logger = createLogger({ dir, maxBytes: 70, keep: 2, now: () => 0 });
  for (let i = 0; i < 6; i += 1) {
    logger.info("x".repeat(30));
  }
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["daemon.log", "daemon.log.1", "daemon.log.2"]);
  for (const name of files) {
    assert.ok(statSync(join(dir, name)).size <= 70, name + " 单文件不得超过 maxBytes");
  }
});

test("createLogger: 目录不存在时自动创建", () => {
  const dir = join(tempDir(), "nested", "logs");
  const logger = createLogger({ dir, now: () => 0 });
  logger.info("x");
  assert.equal(existsSync(join(dir, "daemon.log")), true);
});

test("resolveLogDir: PI_WORKBENCH_LOG_DIR 覆盖默认 home/logs", () => {
  assert.equal(resolveLogDir({ PI_WORKBENCH_LOG_DIR: "E:\\logs" }, "C:\\home"), "E:\\logs");
  assert.equal(resolveLogDir({}, "C:\\home"), join("C:\\home", "logs"));
  assert.equal(resolveLogDir({ PI_WORKBENCH_LOG_DIR: "   " }, "C:\\home"), join("C:\\home", "logs"));
});

test("createLogger: 单行超过 maxBytes 时截断，不写出超限文件", () => {
  const dir = tempDir();
  const logger = createLogger({ dir, maxBytes: 80, keep: 2, now: () => 0 });
  logger.info("x".repeat(500));
  const file = join(dir, "daemon.log");
  const content = readFileSync(file, "utf8");
  assert.ok(statSync(file).size <= 80);
  assert.ok(content.includes("[truncated]"));
});
