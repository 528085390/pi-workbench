/**
 * Pi Workbench 扩展（Pi 侧入口）。
 *
 * 用法（两种都行）：
 *   pi -e E:/pi-workbench/packages/extension/pi-workbench.plugin.ts        # 单次试验
 *   复制到 %USERPROFILE%/.pi/agent/extensions/ 下                          # 常驻
 *
 * 前置：daemon 已起（node packages/control-plane/src/cli.ts start），环境变量
 * PI_WORKBENCH_URL / PI_WORKBENCH_TOKEN 可选。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkbenchTools, type PiToolApi, type PiToolDefinition } from "./dist/index.js";

export default function piWorkbench(pi: ExtensionAPI): void {
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
    baseUrl: process.env["PI_WORKBENCH_URL"],
    authToken: process.env["PI_WORKBENCH_TOKEN"],
  });
}

