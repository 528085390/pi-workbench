/**
 * ClaudeDriver（0.5-B B01-b）：把现有 ClaudeAdapter 包成 AgentDriver。
 *
 * 包装层原则（规格 §16 回退表）：只做委托，不重写任何 ACP 逻辑 ——
 * 0.5-A 的 dispatch / inject / interrupt / handoff / handback 语义全部保持。
 */
import type { SessionCaps, SessionRef } from "@pi-workbench/shared";

import type { AdapterUpdate, AgentAdapter } from "../adapters/types.ts";
import { capsOf } from "../capabilities.ts";
import { listClaudeSessions, readClaudeTranscript } from "../transcript/claude.ts";
import type { AgentDriver, DiscoverOptions, HandoffCommand, SeeResult } from "./types.ts";

export class ClaudeDriver implements AgentDriver {
  readonly agent = "claude";
  readonly caps: SessionCaps = capsOf("claude");
  readonly #adapter: AgentAdapter;

  constructor(adapter: AgentAdapter) {
    this.#adapter = adapter;
  }

  async discover(opts: DiscoverOptions = {}): Promise<SessionRef[]> {
    return await listClaudeSessions({ cwd: opts.cwd });
  }

  /** attach / resume 底层都是 ACP resume；入参与幂等语义由上层 TakeoverEngine 区分 */
  async attach(ref: SessionRef): Promise<void> {
    await this.#adapter.resume(ref.nativeId, ref.cwd);
  }

  async see(ref: SessionRef, cursor: string, limit?: number): Promise<SeeResult> {
    const path = ref.transcriptPath;
    if (path === undefined || path.length === 0) {
      return { messages: [], nextCursor: cursor, pending: true };
    }
    const page = readClaudeTranscript(path, cursor, limit);
    return { messages: page.messages, nextCursor: page.nextCursor, pending: page.pending };
  }

  async inject(ref: SessionRef, text: string): Promise<{ messageId: string; effective: "now" | "next_turn" }> {
    const { messageId } = await this.#adapter.prompt(ref.nativeId, text);
    return { messageId, effective: ref.status === "running" ? "next_turn" : "now" };
  }

  async interrupt(ref: SessionRef): Promise<{ stopReason: string }> {
    return await this.#adapter.cancel(ref.nativeId);
  }

  async resume(ref: SessionRef): Promise<void> {
    await this.#adapter.resume(ref.nativeId, ref.cwd);
  }

  /** 接管模式（纯函数，不执行命令）：能力门禁在 close 之前用它判断是否需要 attach */
  handoffMode(ref: SessionRef): "resume-tui" | "attach" {
    return ref.kind === "background" ? "attach" : "resume-tui";
  }

  async handoff(ref: SessionRef): Promise<HandoffCommand> {
    const mode = this.handoffMode(ref);
    return {
      command: mode === "attach" ? ["claude", "attach", ref.nativeId] : ["claude", "--resume", ref.nativeId],
      mode,
    };
  }

  onUpdate(cb: (update: AdapterUpdate) => void): () => void {
    return this.#adapter.onUpdate(cb);
  }

  async dispose(): Promise<void> {
    await this.#adapter.dispose();
  }
}
