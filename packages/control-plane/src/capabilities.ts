/**
 * 会话能力矩阵（A08 出口，Task 8 复用）。
 * 口径来自 A00 探针实测（docs/specs/2026-11-14-phase-0.5a-claude-slice.md §8）。
 *
 * 关键区分（PRD FR-0.6）：未声明为 true 的能力不注册工具、不显示按钮。
 * - Claude 的 ACP 会话：attach=false、resume=true（attach 与 resume 必须分开）；
 * - claude --bg 后台会话：attach=true、background=true，handoff 出口走 claude attach <id>；
 * - 两者都支持 stream / inject / interrupt / transcript / permissions。
 */
import type { SessionCaps } from "@pi-workbench/shared";

/** 交互式 ACP 会话（claude 前台 / ACP adapter 起的就是这一类） */
export const CLAUDE_CAPABILITIES: SessionCaps = {
  stream: true,
  inject: true,
  interrupt: true,
  attach: false,
  resume: true,
  transcript: true,
  permissions: true,
  background: false,
};

/** claude --bg 后台会话：可以 attach 现有终端 */
export const CLAUDE_BACKGROUND_CAPABILITIES: SessionCaps = {
  stream: true,
  inject: true,
  interrupt: true,
  attach: true,
  resume: true,
  transcript: true,
  permissions: true,
  background: true,
};

export type ClaudeSessionKind = "interactive" | "background" | "unknown";

/**
 * 按会话种类取能力矩阵。unknown 按交互式处理（与 A04 的发现逻辑一致：
 * claude agents 缺字段时默认当交互式，保守地不声明 attach）。
 */
export function claudeCapabilities(kind: ClaudeSessionKind = "interactive"): SessionCaps {
  return kind === "background" ? CLAUDE_BACKGROUND_CAPABILITIES : CLAUDE_CAPABILITIES;
}
