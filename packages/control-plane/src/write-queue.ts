/**
 * per-session 写队列（C02，spec §7.2）。
 *
 * 目标：同一 sessionKey 的写操作（inject / interrupt / checkpoint / handoff / handback）
 * 在单进程内严格 FIFO；不同 sessionKey 各有独立桶，互不阻塞。
 * 跨进程仍由租约兜底，本队列不尝试分布式锁。
 */
import { WorkbenchError } from "./errors.ts";

export type WriteQueueOptions = {
  /** 单会话最多允许多少个排队等待任务（不含正在执行的 1 个），默认 32 */
  maxPending?: number;
  /** 排队等待超过该时长即 E_SESSION_BUSY，默认 30s；已开始执行的任务不受影响 */
  waitTimeoutMs?: number;
  /** 注入时钟（测试 / 诊断用），默认 Date.now */
  now?: () => number;
};

const DEFAULT_MAX_PENDING = 32;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

type QueueEntry<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 已被等待超时拒绝；drain 时必须跳过，不能再执行任务 */
  timedOut: boolean;
};

type Bucket = {
  running: boolean;
  queue: QueueEntry<unknown>[];
};

/**
 * 单进程内的 per-session FIFO 队列。
 *
 * - 首个任务立即执行；后续同 key 任务进桶排队。
 * - 任务成功 / 失败都会释放槽位并唤醒下一个（失败不会卡死队列）。
 * - 排队超时项会从桶里移除并 reject；同批后续任务照常执行。
 * - 排队上限按桶计算，maxPending 不含当前正在执行的任务。
 */
export class SessionWriteQueue {
  private readonly maxPending: number;
  private readonly waitTimeoutMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: WriteQueueOptions = {}) {
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * 把 task 排到 sessionKey 的桶里。返回 task 的结果 / 异常。
   * 队列满时立即返回 rejected Promise（不占槽位、不执行 task）。
   */
  run<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    let bucket = this.buckets.get(sessionKey);
    if (bucket === undefined) {
      bucket = { running: false, queue: [] };
      this.buckets.set(sessionKey, bucket);
    }
    if (bucket.queue.length >= this.maxPending) {
      return Promise.reject(
        new WorkbenchError("E_SESSION_BUSY", "会话写队列已满（上限 " + String(this.maxPending) + "）", {
          sessionKey,
        }),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        task,
        resolve,
        reject,
        enqueuedAt: this.now(),
        timer: null,
        timedOut: false,
      };
      if (!bucket.running && bucket.queue.length === 0) {
        void this.execute(sessionKey, bucket, entry);
        return;
      }
      bucket.queue.push(entry as QueueEntry<unknown>);
      entry.timer = setTimeout(() => {
        this.expire(sessionKey, bucket, entry as QueueEntry<unknown>);
      }, this.waitTimeoutMs);
      // 队列空闲时别让 30s 定时器拖住进程退出（测试 / CLI 短进程）
      entry.timer.unref?.();
    });
  }

  /** 当前排队等待的任务数（不含正在执行的任务） */
  pending(sessionKey: string): number {
    return this.buckets.get(sessionKey)?.queue.length ?? 0;
  }

  private async execute<T>(sessionKey: string, bucket: Bucket, entry: QueueEntry<T>): Promise<void> {
    bucket.running = true;
    try {
      const value = await entry.task();
      entry.resolve(value);
    } catch (err) {
      entry.reject(err);
    } finally {
      this.drain(sessionKey, bucket);
    }
  }

  /** 当前任务结束后启动下一个未超时任务；没有则回收空桶。 */
  private drain(sessionKey: string, bucket: Bucket): void {
    while (bucket.queue.length > 0) {
      const next = bucket.queue.shift();
      if (next === undefined) {
        break;
      }
      if (next.timer !== null) {
        clearTimeout(next.timer);
        next.timer = null;
      }
      if (next.timedOut) {
        continue;
      }
      void this.execute(sessionKey, bucket, next);
      return;
    }
    bucket.running = false;
    this.buckets.delete(sessionKey);
  }

  /** 排队超时：从桶中摘除并拒绝；正在执行的任务不受影响。 */
  private expire(sessionKey: string, bucket: Bucket, entry: QueueEntry<unknown>): void {
    if (entry.timedOut) {
      return;
    }
    entry.timedOut = true;
    entry.timer = null;
    const index = bucket.queue.indexOf(entry);
    if (index >= 0) {
      bucket.queue.splice(index, 1);
    }
    const waitedMs = Math.max(0, this.now() - entry.enqueuedAt);
    const message =
      "会话写队列等待 " + String(waitedMs) + "ms，超过上限 " + String(this.waitTimeoutMs) + "ms";
    entry.reject(new WorkbenchError("E_SESSION_BUSY", message, { sessionKey }));
  }
}
