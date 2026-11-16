/**
 * 会话能力矩阵（A08 出口，Task 8 复用；0.5-B B01-a 扩三 Agent）。
 * 口径来自 A00 探针实测（docs/specs/2026-11-14-phase-0.5a-claude-slice.md §8）
 * 与 0.5-B 规格 §8/§9（Codex/Pi 初值；未实测的能力一律 false）。
 *
 * 关键区分（PRD FR-0.6）：未声明为 true 的能力不注册工具、不显示按钮。
 * - Claude 的 ACP 会话：attach=false、resume=true（attach 与 resume 必须分开）；
 * - claude --bg 后台会话：attach=true、background=true，handoff 出口走 claude attach <id>；
 * - Codex / Pi：attach=false（无接管语义）、permissions=false（未观测到握手）、background=false；
 * - 两者都支持 stream / inject / interrupt / transcript。
 */
import type { AgentName, SessionCaps } from "@pi-workbench/shared";

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

/** Codex 初值（规格 §8）：ACP 控制，attach/permissions/background 未观测 → false */
export const CODEX_CAPABILITIES: SessionCaps = {
  stream: true,
  inject: true,
  interrupt: true,
  attach: false,
  resume: true,
  transcript: true,
  permissions: false,
  background: false,
};

/** Pi 初值（规格 §9）：RPC 子进程，attach/permissions/background → false */
export const PI_CAPABILITIES: SessionCaps = {
  stream: true,
  inject: true,
  interrupt: true,
  attach: false,
  resume: true,
  transcript: true,
  permissions: false,
  background: false,
};

/** 未知 Agent 的保守矩阵：一律不声明能力（宁可不给按钮，不可点了没反应） */
export const NO_CAPABILITIES: SessionCaps = {
  stream: false,
  inject: false,
  interrupt: false,
  attach: false,
  resume: false,
  transcript: false,
  permissions: false,
  background: false,
};

export type SessionKind = "interactive" | "background" | "unknown";
export type ClaudeSessionKind = SessionKind;

/**
 * 按会话种类取 Claude 能力矩阵。unknown 按交互式处理（与 A04 的发现逻辑一致：
 * claude agents 缺字段时默认当交互式，保守地不声明 attach）。
 */
export function claudeCapabilities(kind: SessionKind = "interactive"): SessionCaps {
  return kind === "background" ? CLAUDE_BACKGROUND_CAPABILITIES : CLAUDE_CAPABILITIES;
}

/**
 * 能力矩阵的唯一入口（0.5-B B01-a）：按 agent 分发，kind 只影响 Claude。
 * 未注册的 agent 返回 NO_CAPABILITIES —— 调用方应先用 AgentRouter 判存在性。
 */
export function capsOf(agent: AgentName, kind: SessionKind = "interactive"): SessionCaps {
  if (agent === "claude") {
    return claudeCapabilities(kind);
  }
  if (agent === "codex") {
    return CODEX_CAPABILITIES;
  }
  if (agent === "pi") {
    return PI_CAPABILITIES;
  }
  return NO_CAPABILITIES;
}
