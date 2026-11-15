/**
 * Pi Workbench 扩展（Pi 侧入口）。
 *
 * 用法（两种都行）：
 *   pi -e E:/pi-workbench/packages/extension/pi-workbench.plugin.ts        # 单次试验
 *   pi install E:/pi-workbench/packages/extension                           # 常驻
 *
 * 加载时自动确保控制面在跑：先探 /health，不在就 detached 起
 * `node packages/control-plane/dist/cli.js start` 并等就绪（不阻塞 Pi 启动，
 * 工具调用前才等）。关掉：PI_WORKBENCH_AUTOSTART=0。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASE_URL,
  ensureDaemon,
  registerWorkbenchTools,
  type PiToolApi,
  type PiToolDefinition,
} from "./dist/index.js";

export default function piWorkbench(pi: ExtensionAPI): void {
  const baseUrl = process.env["PI_WORKBENCH_URL"] ?? DEFAULT_BASE_URL;
  const autostart = process.env["PI_WORKBENCH_AUTOSTART"] !== "0";

  // 故意不 await：Pi 启动不该被 daemon 冷启动（约 1–3s）拖住；
  // 每个工具调用前由 beforeCall 等这个 Promise，失败也放过（让工具自己报 E_DAEMON_DOWN）。
  const ready: Promise<unknown> = autostart
    ? ensureDaemon({ baseUrl, log: (line: string) => { console.error(line); } }).catch((err: unknown) => {
        console.error("[pi-workbench] 自动启动失败：" + (err instanceof Error ? err.message : String(err)));
      })
    : Promise.resolve();

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

  registerWorkbenchTools(api, {
    baseUrl,
    authToken: process.env["PI_WORKBENCH_TOKEN"],
    clientId: process.env["PI_WORKBENCH_CLIENT_ID"],
    beforeCall: () => ready,
  });
}
