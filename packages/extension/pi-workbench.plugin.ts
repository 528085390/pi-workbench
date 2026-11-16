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
  type NotifierConnection,
  type PiToolApi,
  type PiToolDefinition,
} from "./dist/index.js";

export default function piWorkbench(pi: ExtensionAPI): void {
  const baseUrl = process.env["PI_WORKBENCH_URL"] ?? DEFAULT_BASE_URL;
  const autostart = process.env["PI_WORKBENCH_AUTOSTART"] !== "0";
  const notifyEnabled = process.env["PI_WORKBENCH_NOTIFY"] !== "0";
  const mode = normalizeNotifyMode(process.env["PI_WORKBENCH_NOTIFY_MODE"]);
  const token = process.env["PI_WORKBENCH_TOKEN"];

  // 故意不 await：Pi 启动不该被 daemon 冷启动（约 1–3s）拖住；
  // 每个工具调用前由 beforeCall 等这个 Promise，失败也放过（让工具自己报 E_DAEMON_DOWN）。
  const ready: Promise<unknown> = autostart
    ? ensureDaemon({ baseUrl, log: (line: string) => { console.error(line); } }).catch((err: unknown) => {
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
      // Pi 动了 = 不是自激循环，连击计数清零（spec §6.6 规则 4）
      notifier?.noteToolActivity();
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
          const text = await def.handler(params);
          return { content: [{ type: "text" as const, text: String(text) }], details: {} };
        },
      } as never);
    },
  };
  registerWorkbenchTools(api, client);

  if (!notifyEnabled) {
    return;
  }

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
