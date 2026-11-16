declare module "@earendil-works/pi-coding-agent" {
  /** Minimal ambient surface used by the plugin entry; the real Pi package is installed globally. */
  export type ExtensionAPI = {
    registerTool(tool: unknown): void;
    on(event: string, handler: (...args: any[]) => unknown): void;
    sendMessage(message: unknown, options?: unknown): Promise<void> | void;
  };
}
