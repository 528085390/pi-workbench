/**
 * Pi Workbench 扩展（Pi 侧入口）。
 *
 * 用法（两种都行）：
 *   pi -e E:/pi-workbench/packages/extension/pi-workbench.plugin.ts        # 单次试验
 *   pi install E:/pi-workbench/packages/extension                           # 常驻
 *
 * 加载时自动确保控制面在跑（PI_WORKBENCH_AUTOSTART=0 关），
 * 并订阅控制面 WS：claude 回合结束 / 等输入 / 出错时叫醒 Pi（spec §6.6）。
 * 提醒模式：PI_WORKBENCH_NOTIFY_MODE=followUp(默认)|steer|nextTurn，PI_WORKBENCH_NOTIFY=0 全关。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASE_URL,
  TurnNotifier,
  connectNotifier,
  createWorkbenchClient,
  ensureDaemon,
  normalizeNotifyMode,
  registerWorkbenchTools,
  wrapToolExecute,
  type NotifierConnection,
  type PiToolApi,
  type PiToolDefinition,
} from "./dist/index.js";

export default function piWorkbench(pi: ExtensionAPI): void {
  const baseUrl = process.env["PI_WORKBENCH_URL"] ?? DEFAULT_BASE_URL;
  const autostart = process.env["PI_WORKBENCH_AUTOSTART"] !== "0";
  const notifyEnabled = process.env["PI_WORKBENCH_NOTIFY"] !== "0";
  const mode = normalizeNotifyMode(process.env["PI_WORKBENCH_NOTIFY_MODE"]);
  const token = process.env["PI_WORKBENCH_TOKEN"] ?? process.env["PI_WORKBENCH_AUTH_TOKEN"];

  // 故意不 await：Pi 启动不该被 daemon 冷启动（约 1–3s）拖住。
  // I3：失败要留证据——beforeCall 会把它抛给工具层，LLM 看到 E_DAEMON_DOWN 而不是 E_INTERNAL: fetch failed。
  let readyError: unknown = null;
  const ready: Promise<unknown> = autostart
    ? ensureDaemon({ baseUrl, log: (line: string) => { console.error(line); } }).catch((err: unknown) => {
        readyError = err;
        console.error("[pi-workbench] 自动启动失败：" + (err instanceof Error ? err.message : String(err)));
      })
    : Promise.resolve();

  let notifier: TurnNotifier | undefined;
  let connection: NotifierConnection | undefined;
  let setStatus: ((text: string | undefined) => void) | undefined;

  const client = createWorkbenchClient({
    baseUrl,
    authToken: token,
    clientId: process.env["PI_WORKBENCH_CLIENT_ID"],
    beforeCall: async () => {
      await ready;
      if (readyError !== null) {
        throw readyError;
      }
      // 注意：这里**不能** noteToolActivity()（评审 B2）——notifier 自己的投递前复核也走这个 client，
      // 每次复核都把连击计数清零，连击上限就永远不触发。清账在工具 execute 包装里做。
    },
    onSessionRead: (key: string) => {
      // 同一轮里 Pi 自己读完的会话，待发提醒立刻作废（规则 3）
      notifier?.clearSession(key);
    },
  });

  const api: PiToolApi = {
    registerTool(name: string, def: PiToolDefinition): void {
      pi.registerTool({
        name,
        label: name,
        description: def.description,
        parameters: def.inputSchema as never,
        async execute(_toolCallId: string, params: unknown) {
          // B2：只有「LLM 真的调了工具」才算 Pi 动了（notifier 内部 HTTP 不算）
          const text = await wrapToolExecute(notifier, () => Promise.resolve(def.handler(params)));
          return { content: [{ type: "text" as const, text: String(text) }], details: {} };
        },
      } as never);
    },
  };
  registerWorkbenchTools(api, client);

  // I2：徽标与唤醒解耦 —— PI_WORKBENCH_NOTIFY=0 只是不发消息，WS/徽标照常
  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    const ui = (ctx as { ui?: { setStatus?: (key: string, text: string | undefined) => void } }).ui;
    if (ui?.setStatus !== undefined) {
      setStatus = (text: string | undefined) => {
        try {
          ui.setStatus?.("pi-workbench", text);
        } catch {
          // 底栏状态不是关键路径，画不出来就算了
        }
      };
    }
  });

  pi.on("session_shutdown", async () => {
    connection?.close();
    connection = undefined;
    notifier?.dispose();
    notifier = undefined;
  });

  void ready.then(() => {
    notifier = new TurnNotifier({
      mode,
      sendEnabled: notifyEnabled,
      listSessions: async () => client.sessions(),
      sink: {
        send: async (message, options) => {
          await pi.sendMessage(message, options as never);
        },
        setStatus: (text: string | undefined) => {
          setStatus?.(text);
        },
      },
      log: (line: string) => { console.error(line); },
    });
    connection = connectNotifier({
      baseUrl,
      token,
      onEvent: (event) => { notifier?.handleEvent(event); },
      onError: (err: unknown) => { console.error("[pi-workbench] WS 错误：" + (err instanceof Error ? err.message : String(err))); },
      log: (line: string) => { console.error(line); },
    });
    void notifier.refreshBadge();
  });
}
