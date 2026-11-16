/**
 * Agent 注册表与能力门禁（0.5-B B01-b，规格 §6.2）。
 *
 * - get(agent) 未注册 → null（调用方决定映射成 E_AGENT_UNAVAILABLE）；
 * - assertCap 是唯一能力裁决点：未注册 → E_AGENT_UNAVAILABLE，缺能力 → E_CAP_UNSUPPORTED；
 * - list() 是 GET /agents 的数据源，返回副本，调用方改不坏注册表。
 */
import type { AgentName } from "@pi-workbench/shared";

import { WorkbenchError } from "../errors.ts";
import type { AdapterCapability, AgentDriver, AgentStatus } from "./types.ts";

/** 注册时可覆盖的可用性信息（探测层在启动时算好，路由层只存不算） */
export type AgentRegistration = {
  available?: boolean;
  version?: string | null;
  reason?: string;
};

export class AgentRouter {
  readonly #drivers = new Map<AgentName, AgentDriver>();
  readonly #statuses = new Map<AgentName, AgentStatus>();

  register(driver: AgentDriver, info: AgentRegistration = {}): void {
    const status: AgentStatus = {
      agent: driver.agent,
      available: info.available ?? true,
      version: info.version === undefined ? "unknown" : info.version,
      caps: driver.caps,
      ...(info.reason === undefined ? {} : { reason: info.reason }),
    };
    this.#drivers.set(driver.agent, driver);
    this.#statuses.set(driver.agent, status);
  }

  get(agent: AgentName): AgentDriver | null {
    return this.#drivers.get(agent) ?? null;
  }

  list(): AgentStatus[] {
    return [...this.#statuses.values()].map((status) => ({
      ...status,
      caps: { ...status.caps },
      ...(status.reason === undefined ? {} : { reason: status.reason }),
    }));
  }

  assertCap(agent: AgentName, cap: AdapterCapability): AgentDriver {
    const driver = this.get(agent);
    if (driver === null) {
      throw new WorkbenchError("E_AGENT_UNAVAILABLE", "Agent 未注册或不可用：" + String(agent), { agent, cap });
    }
    if (!hasCapability(driver, cap)) {
      throw new WorkbenchError("E_CAP_UNSUPPORTED", "Agent " + String(agent) + " 不支持能力 " + cap, {
        agent,
        cap,
      });
    }
    return driver;
  }
}

/** see 走 SessionCaps.transcript，其余能力与 caps 字段同名 */
function hasCapability(driver: AgentDriver, cap: AdapterCapability): boolean {
  return cap === "see" ? driver.caps.transcript : driver.caps[cap];
}
