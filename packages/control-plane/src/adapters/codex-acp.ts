/**
 * Codex ACP 进程管理（0.5-B B03）。
 *
 * 复用 0.5-A 的 ClaudeAdapter：它本身就是「一个实例 = 一个 ACP v2 子进程」的通用实现，
 * Codex 只需要换 adapterCmd / permissionMode。这里不复制 spawn / 握手 / 退出处理逻辑，
 * 避免出现两套生命周期语义。
 */
import type { Config } from "../config.ts";
import { ClaudeAdapter } from "./claude.ts";
import type { AdapterSpawnOptions, AgentAdapter } from "./types.ts";

/** Codex ACP 启动参数：测试注入假 agent，生产走 cfg.codex.adapterCmd */
export type CodexAcpSpawnOptions = {
  /** 覆盖 cfg.codex.adapterCmd，例如 [node, "test/fixtures/fake-codex-acp-agent.mjs"] */
  adapterCmd?: string[];
  /** 子进程 cwd，默认继承当前进程 */
  cwd?: string;
  /** 额外环境变量 */
  env?: NodeJS.ProcessEnv;
};

/**
 * 起 codex-acp 子进程并完成 ACP initialize 握手。
 *
 * 复用 ClaudeAdapter.spawn 的三个硬约束：10s 握手超时、子进程退出后所有调用立即失败、
 * stderr 尾部进错误详情。失败统一抛 E_ADAPTER_DOWN，由 CodexDriver 映射成
 * E_AGENT_UNAVAILABLE（规格 §6.3）。
 */
export async function spawnCodexAcpAdapter(
  config: Config,
  options: CodexAcpSpawnOptions = {},
): Promise<AgentAdapter> {
  const adapterCmd = options.adapterCmd ?? config.codex.adapterCmd;
  // ClaudeAdapter 的 permissionMode 从 claude 块读；Codex 用 codex.permissionMode 覆盖，
  // 否则会误用 Claude 的权限策略。
  const spawnConfig: Config = {
    ...config,
    claude: {
      adapterCmd,
      permissionMode: config.codex.permissionMode,
      initialPermissionMode: "auto",
    },
  };
  const spawnOptions: AdapterSpawnOptions = {
    adapterCmd,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // codex-acp 的默认模式是 agent（Auto review），会触发 Guardian；显式注入初始模式。
    env: { ...options.env, INITIAL_AGENT_MODE: config.codex.initialAgentMode },
  };
  return await ClaudeAdapter.spawn(spawnConfig, spawnOptions);
}
