import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
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

/**
 * 抢单实例锁：用 "wx" 原子创建 PID 文件。
 * - 文件已存在且其中的进程存活 → 抛 InstanceLockError（code = E_ALREADY_RUNNING）
 * - 文件已存在但进程已死或内容损坏 → 视为残留，接管
 */
export function acquireInstanceLock(pidPath: string): InstanceLock {
  const target = resolve(pidPath);
  mkdirSync(dirname(target), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
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

      const holder = readPidFile(target);
      if (holder !== null && isProcessAlive(holder)) {
        throw new InstanceLockError(target, holder);
      }
      // 残留 pid 文件：删掉后重试一次
      try {
        unlinkSync(target);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkErr;
      }
    }
  }

  throw new InstanceLockError(target, readPidFile(target) ?? -1);
}

/** 只删属于自己的 PID 文件，避免误删别人的锁 */
function releaseLock(pidPath: string): void {
  const holder = readPidFile(pidPath);
  if (holder !== null && holder !== process.pid) return;
  try {
    unlinkSync(pidPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
