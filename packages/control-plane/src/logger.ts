/**
 * daemon 运行日志（C04）。
 *
 * 规格 §7.4：默认 ~/.pi-workbench/logs/daemon.log，单文件 10 MB、保留 5 份；
 * PI_WORKBENCH_LOG_DIR 可覆盖。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const LOG_FILE_NAME = "daemon.log";
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_KEEP = 5;

export type LoggerOptions = {
  dir: string;
  maxBytes?: number;
  keep?: number;
  now?: () => number;
};

export type Logger = {
  info(msg: string): void;
  error(msg: string): void;
};

export function resolveLogDir(env: NodeJS.ProcessEnv = process.env, home: string = join(homedir(), ".pi-workbench")): string {
  const override = env.PI_WORKBENCH_LOG_DIR?.trim();
  return resolve(override !== undefined && override.length > 0 ? override : join(home, "logs"));
}

export function createLogger(options: LoggerOptions): Logger {
  const dir = resolve(options.dir);
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_LOG_MAX_BYTES, "maxBytes");
  const keep = positiveInteger(options.keep ?? DEFAULT_LOG_KEEP, "keep");
  const now = options.now ?? Date.now;
  const file = join(dir, LOG_FILE_NAME);
  mkdirSync(dir, { recursive: true });

  const write = (level: "INFO" | "ERROR", message: string): void => {
    const raw = "[" + new Date(now()).toISOString() + "] [" + level + "] " + message + "\n";
    const line = truncateLine(raw, maxBytes);
    rotateIfNeeded(file, Buffer.byteLength(line), maxBytes, keep);
    appendFileSync(file, line);
  };

  return {
    info: (message: string): void => write("INFO", message),
    error: (message: string): void => write("ERROR", message),
  };
}

function truncateLine(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line) <= maxBytes) {
    return line;
  }
  const marker = "…[truncated]\n";
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= maxBytes) {
    return truncateUtf8(line, maxBytes);
  }
  return truncateUtf8(line, maxBytes - markerBytes) + marker;
}

function truncateUtf8(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("createLogger: " + name + " 必须是正整数");
  }
  return value;
}

function rotateIfNeeded(file: string, incomingBytes: number, maxBytes: number, keep: number): void {
  let currentBytes = 0;
  try {
    currentBytes = statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
  if (currentBytes === 0 || currentBytes + incomingBytes <= maxBytes) {
    return;
  }
  unlinkIfExists(file + "." + String(keep));
  for (let index = keep - 1; index >= 1; index -= 1) {
    renameIfExists(file + "." + String(index), file + "." + String(index + 1));
  }
  renameIfExists(file, file + ".1");
}

function renameIfExists(from: string, to: string): void {
  if (!existsSync(from)) {
    return;
  }
  renameSync(from, to);
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
