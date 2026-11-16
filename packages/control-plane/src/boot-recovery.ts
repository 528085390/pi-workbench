/**
 * 重启对账（C01，spec §7.1）。
 * 计划：docs/superpowers/plans/2026-11-17-phase-0.5c-control-plane-hardening.md Task 4。
 *
 * 单实例锁保证上一个 daemon 已经不在了，但登记在库里的会话仍可能是 starting / running /
 * needs-input。此时原生进程是否还活着无法从 transcript 可靠判断（决策 2：不猜），因此：
 * - driver 为 pi 等控制面驱动的活动会话一律置 `unknown`，等调用方显式 attach；
 * - driver 为 human 的会话保持原状（正常应为 handoff）；
 * - driver 为 none 的会话不动。
 *
 * 每个被改写的会话追加一条 `state_update` 事件，payload 记录改写前的 driver/status；
 * 幂等键带 instanceId，同一实例重复对账不会重复写事件（即使状态被外部改回活动态）。
 */
import type { SessionStatus } from "@pi-workbench/shared";

import type { EventStore } from "./events.ts";
import type { SessionRegistry } from "./registry.ts";

/** 启动对账结果（spec §7.1；写进 daemon 启动日志）。 */
export type RecoveryReport = {
  /** 库里恢复出的会话总数（registry.list().length）。 */
  total: number;
  /** 被置为 unknown 的会话数。 */
  markedUnknown: number;
  /** 保持 handoff 的 human 会话数。 */
  keptHandoff: number;
};

/** 重启后仍算「活动」、需要改判为 unknown 的状态。 */
const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "starting",
  "running",
  "needs-input",
]);

/**
 * 启动对账：把上一个 daemon 留下的活动 driver 会话标记为 unknown。
 *
 * 必须在 `registry.loadFromDb()` 之后、HTTP/WS 对外服务之前调用；
 * 只改状态，不改 driver / capabilities / transcript 等字段。
 */
export function reconcileSessions(deps: {
  registry: SessionRegistry;
  store: EventStore;
  instanceId: string;
}): RecoveryReport {
  const { registry, store, instanceId } = deps;
  const sessions = registry.list();
  let markedUnknown = 0;
  let keptHandoff = 0;

  for (const ref of sessions) {
    if (ref.driver === "human") {
      keptHandoff += 1;
      continue;
    }
    if (ref.driver === "none" || !ACTIVE_STATUSES.has(ref.status)) {
      continue;
    }

    registry.updateStatus(ref.key, "unknown");
    store.append({
      sessionKey: ref.key,
      type: "state_update",
      source: ref.agent,
      payload: {
        reason: "daemon_restart",
        previous: { driver: ref.driver, status: ref.status },
      },
      idempotencyKey: "recovery:" + instanceId + ":" + ref.key,
    });
    markedUnknown += 1;
  }

  return { total: sessions.length, markedUnknown, keptHandoff };
}
