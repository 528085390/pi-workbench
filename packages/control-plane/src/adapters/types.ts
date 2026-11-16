/**
 * Agent adapter 的公共契约（A05）。
 *
 * 口径见 docs/specs/2026-11-14-phase-0.5a-claude-slice.md 与 task-5-brief 的 Controller 裁定：
 * - `prompt()` **不等回合结束**（否则长回合会卡住 dispatch），回合结束走 `waitForTurn` 与
 *   `AdapterUpdate{kind:"state"}`；
 * - `AdapterUpdate` 只做归一化，不认识的原样挂在 `raw` 上给上层兜底。
 */
import type { SessionStatus } from "@pi-workbench/shared";

import type { ClaudeInitialPermissionMode } from "../config.ts";

/** 归一化后的 update 种类（映射表见 claude.ts 的 mapSessionUpdate） */
export type AdapterUpdateKind =
  | "text"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "state"
  | "permission_request"
  | "error";

/** 一次 adapter 推送的归一化片段 */
export type AdapterUpdate = {
  kind: AdapterUpdateKind;
  /** 优先 messageId / toolCallId，缺失时用递增计数器 u<n> */
  id: string;
  text?: string;
  toolName?: string;
  state?: SessionStatus;
  /** 原始 ACP 负载，未识别的字段都靠它兜底 */
  raw?: unknown;
};

/** 启动参数：测试用 adapterCmd 注入假 agent，生产走 cfg.claude.adapterCmd */
export type AdapterSpawnOptions = {
  /** 覆盖 `cfg.claude.adapterCmd`，例如 [process.execPath, "test/fixtures/fake-acp-agent.mjs"] */
  adapterCmd?: string[];
  /** 额外环境变量；CLAUDE_AGENT_ACP_PROTOCOL=v2 由 adapter 固定注入 */
  env?: NodeJS.ProcessEnv;
  /** 子进程 cwd，默认继承当前进程 */
  cwd?: string;
  /** 新会话建立后要设置的 Claude 权限模式；仅 Claude adapter 使用 */
  initialPermissionMode?: ClaudeInitialPermissionMode;
};

/** 一个回合的结束信息 */
export type AdapterTurnResult = { stopReason: string };

/**
 * 单进程 ACP agent 的适配器接口。
 * 子进程退出后所有调用都必须尽快抛 `E_ADAPTER_DOWN`，禁止挂起。
 */
export interface AgentAdapter {
  newSession(cwd: string): Promise<{ sessionId: string }>;
  resume(sessionId: string, cwd: string): Promise<void>;
  /** 投递用户消息后立即返回，不等回合结束 */
  prompt(sessionId: string, text: string): Promise<{ messageId: string }>;
  cancel(sessionId: string): Promise<{ stopReason: string }>;
  close(sessionId: string): Promise<void>;
  /** 等本回合结束；超时抛 `E_ADAPTER_DOWN`（turn timeout），不挂起 */
  waitForTurn?(sessionId: string, timeoutMs?: number): Promise<AdapterTurnResult>;
  /** 进程是否仍可用；可选，driver 用它决定是否重建缓存（B08 S5） */
  isAlive?(): boolean;
  onUpdate(cb: (update: AdapterUpdate) => void): () => void;
  dispose(): Promise<void>;
}
