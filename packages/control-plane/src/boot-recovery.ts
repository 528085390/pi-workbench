/**
 * 重启对账（C01，spec §7.1）。
 * 计划：docs/superpowers/plans/2026-11-17-phase-0.5c-control-plane-hardening.md Task 4。
 *
 * 单实例锁保证上一个 daemon 已经不在了，但登记在库里的会话仍可能是 starting / running /
 * needs-input / idle / handoff。此时原生进程是否还活着无法从 transcript 可靠判断（决策 2：不猜），因此：
 * - driver 为 pi 等控制面驱动的会话（终态 exited 除外）一律置 `driver: "none"` + `status: "unknown"`，
 *   等调用方显式 attach；
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

/** 终态：已经结束的会话不再改判（spec §7.1 表格只要求非终态 driver 会话对账）。 */
const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["exited"]);

/**
 * 启动对账：把上一个 daemon 留下的 driver 会话改判为 driver=none、status=unknown。
 *
 * 必须在 `registry.loadFromDb()` 之后、HTTP/WS 对外服务之前调用；
 * 只改 driver / status，不改 capabilities / transcript 等字段。
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
    if (ref.driver === "none" || TERMINAL_STATUSES.has(ref.status)) {
      continue;
    }

    // 先写事件再改状态：即使进程在两步之间崩溃，也只会留下「已记事件、状态仍旧」，
    // 下次对账会按新 instanceId 再写一条并补改状态；反向顺序会出现 unknown 却无审计事件。
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
    registry.upsert({ ...ref, driver: "none", status: "unknown" });
    markedUnknown += 1;
  }

  return { total: sessions.length, markedUnknown, keptHandoff };
}
