/**
 * AgentDriver 契约（0.5-B B01-b，规格 §6.1）。
 *
 * 六个语义方法：discover / attach / see / inject / interrupt / resume / handoff。
 * - attach = 首次建立控制通道；resume = 接管已存在会话（入参与幂等要求不同，不得合并）；
 * - caps 是唯一能力裁决源（AgentRouter.assertCap 读它）；
 * - ACP 细节留在各 Driver 内部，路由层不 import 具体 adapter。
 */
import type { AgentName, SessionCaps, SessionRef, UnifiedMessage } from "@pi-workbench/shared";

import type { AdapterUpdate } from "../adapters/types.ts";

/** 可被 assertCap 裁决的语义能力（see 落在 SessionCaps.transcript 上） */
export type AdapterCapability = "see" | "inject" | "interrupt" | "attach" | "resume";

/** GET /agents 的单行数据（规格 §6.2） */
export type AgentStatus = {
  agent: AgentName;
  available: boolean;
  version: string | null;
  caps: SessionCaps;
  /** available=false 时必须是机器可读码，例如 "E_AGENT_UNAVAILABLE: codex 未登录" */
  reason?: string;
};

/** 发现参数：cwd 过滤 + 条数上限 */
export type DiscoverOptions = {
  cwd?: string;
  limit?: number;
};

/** see 的返回：游标语义与文件 transcript 读取一致（文件字节偏移字符串） */
export type SeeResult = {
  messages: UnifiedMessage[];
  nextCursor: string;
  pending: boolean;
};

/** 原生终端接管出口：命令数组与模式 */
export type HandoffCommand = {
  command: string[];
  mode: "resume-tui" | "attach";
};

export interface AgentDriver {
  readonly agent: AgentName;
  /** 本 Agent 的能力声明（PRD FR-0.6：没声明就不暴露） */
  readonly caps: SessionCaps;

  /** 发现：扫原生会话（Codex=rollout 文件，Pi=session 文件，Claude=既有实现） */
  discover(opts: DiscoverOptions): Promise<SessionRef[]>;

  /** 建立/重连控制通道（不抢占 driver 权） */
  attach(ref: SessionRef): Promise<void>;

  /** 读：可选；未实现时由路由层回落到统一的文件 transcript 读取 */
  see?(ref: SessionRef, cursor: string, limit?: number): Promise<SeeResult>;

  inject(ref: SessionRef, text: string): Promise<{ messageId: string; effective: "now" | "next_turn" }>;
  interrupt(ref: SessionRef): Promise<{ stopReason: string }>;
  resume(ref: SessionRef): Promise<void>;

  /** 原生终端接管出口：返回命令数组与模式 */
  handoff(ref: SessionRef): Promise<HandoffCommand>;

  onUpdate(cb: (update: AdapterUpdate) => void): () => void;
  dispose(): Promise<void>;
}
