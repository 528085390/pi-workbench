import { WebSocket as WsWebSocket } from "ws";

/**
 * 事件推送与唤醒（spec §6.6）：claude 回合结束 → 叫醒 Pi 主对话。
 *
 * 三条硬规则（用户 m02516 批准）：
 * 1. 投递前复核：真正发消息之前再查一次未读，unread === 0 直接丢弃——避免"提醒你去看已经看完的东西"。
 * 2. 指针而非断言：消息只说"某会话在游标 X 之后有 N 条"，不说"任务完成了"。
 * 3. 自己的工具动作清账：cp_see / cp_read 成功后清掉该会话待发通知；只有推进型 cp_* 调用才清零连击计数（cp_sessions / cp_see 是观察）。
 *
 * 这里不 import Pi SDK：NotifySink 是最小结构化契约，宿主（Pi 插件 / 测试）自己实现。
 */

/** 与 Pi 的 deliverAs 一致（docs/extensions.md 1639-1649） */
export type NotifyMode = "steer" | "followUp" | "nextTurn";

export const NOTIFY_MODES: readonly NotifyMode[] = ["steer", "followUp", "nextTurn"];

/** 环境变量解析：未知值回落 followUp（默认），不抛错（插件加载不该被打断） */
export function normalizeNotifyMode(raw: string | undefined): NotifyMode {
  const value = (raw ?? "").trim();
  return (NOTIFY_MODES as readonly string[]).includes(value) ? (value as NotifyMode) : "followUp";
}

/** 唤醒原因：决定文案 */
export type NotifyReason = "turn-end" | "needs-input" | "error";

/** 通知里用到的会话字段（WorkbenchClient.sessions 返回的 SessionView 是其超集） */
export type NotifySession = {
  key: string;
  driver: string;
  status?: string;
  unread?: number;
  lastReadCursor?: string;
  awaiting?: boolean;
};

export type NotifyMessage = {
  customType: string;
  content: string;
  display: boolean;
};

export type NotifySendOptions = {
  deliverAs: NotifyMode;
  triggerTurn: boolean;
};

/** 宿主侧出口：发一条对话内消息 + 更新底栏徽标 */
export type NotifySink = {
  send(message: NotifyMessage, options: NotifySendOptions): Promise<void> | void;
  setStatus?(text: string | undefined): void;
};

/** WS 线格式里我们关心的字段（server.ts wireOf） */
export type NotifyEvent = {
  seq: number;
  sessionKey: string;
  type: string;
  payload?: unknown;
  ts?: string;
};

export type TurnNotifierOptions = {
  /** 拿全量会话视图（带 unread）；投递前复核与徽标都靠它 */
  listSessions: () => Promise<NotifySession[]>;
  sink: NotifySink;
  mode?: NotifyMode;
  /** 合并窗口：窗口内多个会话的结束信号合成一条 */
  debounceMs?: number;
  /** 连续自动唤醒上限（期间没有推进型工具调用则累加） */
  maxConsecutiveWakes?: number;
  /** 唤醒计数的滑动窗口：窗口内没有新唤醒就清零（缺省 60s） */
  wakeWindowMs?: number;
  /** 只对 driver=pi 的会话唤醒（人接管中不吵） */
  wakeDrivers?: readonly string[];
  /**
   * false = 静音：不发对话消息，但徽标照常维护（I2：PI_WORKBENCH_NOTIFY=0 只关"叫醒"，
   * 不关"有未读"这个事实）。
   */
  sendEnabled?: boolean;
  log?: (line: string) => void;
  now?: () => number;
};

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MAX_WAKES = 5;
const DEFAULT_WAKE_WINDOW_MS = 60_000;
const CUSTOM_TYPE = "pi-workbench";

/** 从一条事件里读出"需要叫醒"的原因；不需要唤醒的返回 null */
export function reasonOf(event: NotifyEvent): NotifyReason | null {
  if (event.type === "error") {
    return "error";
  }
  if (event.type === "needs_input") {
    return "needs-input";
  }
  if (event.type !== "state_update" && event.type !== "session_status") {
    return null;
  }
  const payload = event.payload as Record<string, unknown> | null | undefined;
  const status = typeof payload?.["status"] === "string" ? payload["status"] : payload?.["state"];
  if (status === "needs-input") {
    return "needs-input";
  }
  if (status === "idle") {
    return "turn-end";
  }
  return null;
}

type Pending = { reason: NotifyReason; seq: number };

/** 回合结束通知器：纯内存 + 注入时钟，不碰 IO（除了注入的 listSessions / sink） */
export class TurnNotifier {
  readonly #options: TurnNotifierOptions & {
    debounceMs: number;
    maxConsecutiveWakes: number;
    wakeWindowMs: number;
  };
  readonly #pending = new Map<string, Pending>();
  readonly #startedAt: number;
  readonly #now: () => number;
  readonly #lastEventSeq = new Map<string, number>();
  readonly #lastNotifiedSeq = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wakes = 0;
  #wakeWindowStartedAt = 0;
  #flushing: Promise<void> | null = null;
  #badge: string | undefined;
  #disposed = false;

  constructor(options: TurnNotifierOptions) {
    this.#options = {
      ...options,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxConsecutiveWakes: options.maxConsecutiveWakes ?? DEFAULT_MAX_WAKES,
      wakeWindowMs: options.wakeWindowMs ?? DEFAULT_WAKE_WINDOW_MS,
    };
    this.#now = options.now ?? (() => Date.now());
    this.#startedAt = this.#now();
  }

  /** 连击计数（测试/诊断用；读取会触发过期窗口归零，符合时间窗语义） */
  get consecutiveWakes(): number {
    this.#resetWakeBudgetIfStale();
    return this.#wakes;
  }

  /** 待发通知的会话 key（测试用） */
  get pendingKeys(): string[] {
    return [...this.#pending.keys()];
  }

  /**
   * 收一条事件。历史回放（ts 早于本通知器创建时刻）只推进游标、绝不入队——
   * 否则 Pi 一启动就会被"上周的回合结束"叫醒。
   */
  handleEvent(event: NotifyEvent): void {
    if (this.#disposed) {
      return;
    }
    if (typeof event.ts === "string") {
      const ts = Date.parse(event.ts);
      if (Number.isFinite(ts) && ts < this.#startedAt) {
        return;
      }
    }
    // 同一 session 的 seq 单调递增；重放/重复事件直接跳过。
    if (typeof event.seq === "number") {
      const previous = this.#lastEventSeq.get(event.sessionKey);
      if (previous !== undefined && event.seq <= previous) {
        return;
      }
      this.#lastEventSeq.set(event.sessionKey, event.seq);
    }
    const reason = reasonOf(event);
    if (reason === null) {
      return;
    }
    this.#pending.set(event.sessionKey, { reason, seq: event.seq });
    this.#scheduleFlush();
  }

  /**
   * 推进型工具调用才清零连击计数。cp_sessions / cp_see 是纯观察：
   * 如果把它们也当成“Pi 动了”，自激循环每轮都能重置上限，上限永远不生效。
   */
  noteToolActivity(toolName?: string): void {
    if (toolName === "cp_sessions" || toolName === "cp_see") {
      return;
    }
    this.#wakes = 0;
    this.#wakeWindowStartedAt = 0;
  }

  /** cp_see / cp_read 读完某会话：把它的待发通知删掉 */
  clearSession(sessionKey: string): void {
    this.#pending.delete(sessionKey);
  }

  /** 只是刷新底栏徽标（与唤醒解耦，nextTurn / 静音时也用） */
  async refreshBadge(): Promise<void> {
    const sessions = await this.#list();
    if (sessions === null) {
      return;
    }
    const total = sessions.reduce((sum, s) => sum + (typeof s.unread === "number" ? s.unread : 0), 0);
    this.#setBadge(total > 0 ? "pi-workbench: " + String(total) + " 未读" : undefined);
  }

  /** 立即投递（测试直接调；生产由 debounce 定时器调） */
  async flush(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (this.#flushing !== null) {
      return this.#flushing;
    }
    const run = this.#flushOnce();
    this.#flushing = run;
    try {
      await run;
    } finally {
      this.#flushing = null;
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pending.clear();
    this.#lastEventSeq.clear();
    this.#lastNotifiedSeq.clear();
  }

  async #flushOnce(): Promise<void> {
    if (this.#pending.size === 0) {
      return;
    }
    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    if (this.#options.sendEnabled === false) {
      // 静音模式：把待发清掉（不攒着，之后不补发），徽标仍反映真实未读
      await this.refreshBadge();
      return;
    }

    const sessions = await this.#list();
    if (sessions === null) {
      // 复核失败（daemon 挂了）：不发，也不留待发——下次回合结束会再来
      return;
    }
    const byKey = new Map(sessions.map((s) => [s.key, s]));
    const drivers = this.#options.wakeDrivers ?? ["pi"];

    const actionable: Array<{ session: NotifySession; reason: NotifyReason; seq: number }> = [];
    for (const [key, pending] of entries) {
      const session = byKey.get(key);
      const unread = session && typeof session.unread === "number" ? session.unread : 0;
      if (!session || unread <= 0) {
        this.#log("[notify] 丢掉过期通知 " + key + "（未读已清零或会话消失）");
        continue;
      }
      if (!drivers.includes(session.driver)) {
        this.#log("[notify] 跳过 " + key + "（driver=" + session.driver + "）");
        continue;
      }
      const lastNotified = this.#lastNotifiedSeq.get(key);
      if (lastNotified !== undefined && pending.seq <= lastNotified) {
        this.#log("[notify] 跳过重复通知 " + key + "（seq=" + String(pending.seq) + "）");
        continue;
      }
      actionable.push({ session, reason: pending.reason, seq: pending.seq });
    }

    if (actionable.length > 0) {
      this.#resetWakeBudgetIfStale();
      if (this.#wakes >= this.#options.maxConsecutiveWakes) {
        this.#log("[notify] 连续唤醒达上限（" + String(this.#wakes) + "），只更新徽标");
      } else {
        const mode = this.#options.mode ?? "followUp";
        try {
          await this.#options.sink.send(
            { customType: CUSTOM_TYPE, content: renderMessage(actionable), display: true },
            { deliverAs: mode, triggerTurn: mode !== "nextTurn" },
          );
          this.#wakes += 1;
          if (this.#wakeWindowStartedAt === 0) {
            this.#wakeWindowStartedAt = this.#now();
          }
          for (const item of actionable) {
            this.#lastNotifiedSeq.set(item.session.key, item.seq);
          }
        } catch (err) {
          this.#log("[notify] 发送失败：" + (err instanceof Error ? err.message : String(err)));
        }
      }
    }

    await this.refreshBadge();
  }

  #resetWakeBudgetIfStale(): void {
    if (this.#wakes === 0) {
      return;
    }
    if (this.#now() - this.#wakeWindowStartedAt >= this.#options.wakeWindowMs) {
      this.#wakes = 0;
      this.#wakeWindowStartedAt = 0;
    }
  }

  #scheduleFlush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#options.debounceMs);
    // 定时器不该把 Pi 的进程吊着
    (this.#timer as { unref?: () => void }).unref?.();
  }

  async #list(): Promise<NotifySession[] | null> {
    try {
      return await this.#options.listSessions();
    } catch (err) {
      this.#log("[notify] 拉会话列表失败：" + (err instanceof Error ? err.message : String(err)));
      return null;
    }
  }

  #setBadge(text: string | undefined): void {
    if (text === this.#badge) {
      return;
    }
    this.#badge = text;
    this.#options.sink.setStatus?.(text);
  }

  #log(line: string): void {
    this.#options.log?.(line);
  }
}

const REASON_TEXT: Record<NotifyReason, string> = {
  "turn-end": "本轮结束",
  "needs-input": "需要你回话",
  error: "出错了",
};

/** 多会话合并成一条指针式消息（不含"任务已完成"这类断言） */
export function renderMessage(items: ReadonlyArray<{ session: NotifySession; reason: NotifyReason }>): string {
  const total = items.reduce((sum, item) => sum + (item.session.unread ?? 0), 0);
  const head = "[pi-workbench] " + String(items.length) + " 个会话有更新（未读共 " + String(total) + " 条）：";
  const body = items.map((item) => {
    const cursor = item.session.lastReadCursor ?? "0";
    return (
      "- " +
      item.session.key +
      " " +
      REASON_TEXT[item.reason] +
      "，游标 " +
      cursor +
      " 之后有 " +
      String(item.session.unread ?? 0) +
      " 条"
    );
  });
  return [head, ...body, "用 cp_see <key> 读取（peek:true 只看不标记）。"].join("\n");
}

export type NotifierConnectionOptions = {
  baseUrl: string;
  token?: string;
  /** 收到事件（含回放；历史由 TurnNotifier 按 ts 自行丢弃） */
  onEvent: (event: NotifyEvent) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  log?: (line: string) => void;
  /** 断线重连基础间隔（默认 2s，线性退避到 10s） */
  reconnectMs?: number;
  WebSocketImpl?: typeof WsWebSocket;
};

export type NotifierConnection = { close(): void };

/** http://host:port → ws://host:port/api/cp/ws（保留路径前缀） */
export function notifierUrl(baseUrl: string, after: number): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/+$/, "") + "/api/cp/ws";
  url.search = "?after=" + String(after);
  return url.toString();
}

/**
 * 连控制面 WS 并把事件喂给 onEvent。断线自动重连，用 after=<最后 seq> 补拉。
 * 认证只走 header（服务端不接受 query token，见 T8 I1 用例）。
 */
export function connectNotifier(options: NotifierConnectionOptions): NotifierConnection {
  const Impl = options.WebSocketImpl ?? WsWebSocket;
  let lastSeq = 0;
  let closed = false;
  let socket: WsWebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    if (closed) {
      return;
    }
    const headers: Record<string, string> = {};
    if (options.token) {
      headers["authorization"] = "Bearer " + options.token;
    }
    const ws = new Impl(notifierUrl(options.baseUrl, lastSeq), { headers });
    socket = ws;
    ws.on("open", () => {
      attempt = 0;
      options.onOpen?.();
    });
    ws.on("message", (data: unknown) => {
      const text = typeof data === "string" ? data : String(data);
      let event: NotifyEvent;
      try {
        event = JSON.parse(text) as NotifyEvent;
      } catch {
        return;
      }
      if (typeof event.seq === "number" && event.seq > lastSeq) {
        lastSeq = event.seq;
      }
      try {
        options.onEvent(event);
      } catch (err) {
        options.onError?.(err);
      }
    });
    ws.on("error", (err: unknown) => {
      options.onError?.(err);
    });
    ws.on("close", () => {
      socket = null;
      if (closed) {
        return;
      }
      attempt += 1;
      const base = options.reconnectMs ?? 2000;
      const delay = Math.min(base * attempt, 10_000);
      options.log?.("[notify] WS 断开，" + String(delay) + "ms 后重连（after=" + String(lastSeq) + "）");
      timer = setTimeout(open, delay);
      (timer as { unref?: () => void }).unref?.();
    });
  };

  open();

  return {
    close(): void {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}
