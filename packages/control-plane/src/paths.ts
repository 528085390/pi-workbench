import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 控制面在磁盘上的固定布局（PRD FR-5.3 / A02） */
export interface WorkbenchPaths {
  /** SQLite 主库 */
  db: string;
  /** 运行日志目录 */
  logs: string;
  /** handoff 交接文件目录 */
  handoffs: string;
  /** 单实例 PID 文件 */
  pid: string;
}

/** 全部返回绝对路径；home 允许传相对路径（按 cwd 解析） */
export function resolvePaths(home: string): WorkbenchPaths {
  const root = resolve(home);
  return {
    db: join(root, "workbench.db"),
    logs: join(root, "logs"),
    handoffs: join(root, "handoffs"),
    pid: join(root, "workbench.pid"),
  };
}

/** 创建运行期需要的目录（幂等） */
export function ensureDirs(paths: WorkbenchPaths): void {
  mkdirSync(dirname(paths.db), { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(paths.handoffs, { recursive: true });
}

/** 单实例被占用：另一进程已持有同一 PID 文件 */
export class InstanceLockError extends Error {
  readonly code = "E_ALREADY_RUNNING";
  readonly pidPath: string;
  readonly holderPid: number;

  constructor(pidPath: string, holderPid: number) {
    super(`E_ALREADY_RUNNING：控制面已在运行（pid ${holderPid}，pid 文件 ${pidPath}）`);
    this.name = "InstanceLockError";
    this.pidPath = pidPath;
    this.holderPid = holderPid;
  }
}

export interface InstanceLock {
  release(): void;
}

/**
 * 空 pid 文件的「新鲜期」（毫秒）。
 * `openSync("wx")` 成功到写入 pid 之间存在一个极短窗口，这段时间文件内容为空。
 * mtime 落在新鲜期内的空文件一律视为「别人正在建锁」，绝不当残留删除——
 * 否则并发启动的两个进程会互相删掉对方的锁，双双跑起来。
 */
export const EMPTY_PID_FILE_FRESH_MS = 1000;
/** 命中新鲜期时的退避重读步长（毫秒），按尝试次数递增 */
export const EMPTY_PID_FILE_BACKOFF_MS = 50;
/** 抢锁最大尝试次数（首次 + 退避重读） */
export const MAX_LOCK_ATTEMPTS = 5;

/** 判断进程是否存活：EPERM 说明进程存在但无权限，按存活处理 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读 PID 文件；文件不存在或内容不是正整数时返回 null */
export function readPidFile(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    if (raw.length === 0) return null;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 同步退避（抢锁是同步 API，这里用 Atomics.wait 阻塞一小会儿） */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function mtimeMsOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * 抢单实例锁：用 "wx" 原子创建 PID 文件。
 * - 文件已存在且其中的进程存活 → 抛 InstanceLockError（code = E_ALREADY_RUNNING）
 * - 文件已存在但内容为空、且 mtime 在新鲜期内 → 可能是并发进程正在写，退避后重读，
 *   绝不 unlink（否则会删掉别人刚建好的锁）
 * - 只有内容为空且 mtime 已过期，或其中的 pid 已死 → 才认定为残留并接管
 * - 重试耗尽仍 EEXIST → 原样抛出 EEXIST（不臆造 pid）
 */
export function acquireInstanceLock(pidPath: string): InstanceLock {
  const target = resolve(pidPath);
  mkdirSync(dirname(target), { recursive: true });

  let lastErr: NodeJS.ErrnoException | null = null;

  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(target, "wx");
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return { release: () => releaseLock(target) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      lastErr = err as NodeJS.ErrnoException;

      const holder = readPidFile(target);
      if (holder !== null && isProcessAlive(holder)) {
        throw new InstanceLockError(target, holder);
      }

      if (holder === null) {
        const mtime = mtimeMsOf(target);
        // 空内容 + mtime 新鲜：交给写锁的人一点时间，退避后重读
        if (mtime !== null && Date.now() - mtime < EMPTY_PID_FILE_FRESH_MS) {
          sleepMs(EMPTY_PID_FILE_BACKOFF_MS * (attempt + 1));
          continue;
        }
      }

      // 残留 pid 文件（pid 已死 / 内容为空且 mtime 已过期）：删掉后重试
      unlinkIfExists(target);
    }
  }

  if (lastErr !== null) throw lastErr;
  throw new Error(`无法获取单实例锁：${target}`);
}

/** 只删属于自己的 PID 文件，避免误删别人的锁 */
function releaseLock(pidPath: string): void {
  const holder = readPidFile(pidPath);
  if (holder !== null && holder !== process.pid) return;
  unlinkIfExists(pidPath);
}
