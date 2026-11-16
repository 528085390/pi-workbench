/**
 * 控制面统一错误类型（A07 起共用）。
 * 语义见 docs/specs/2026-11-14-phase-0.5a-claude-slice.md §7 与 docs/PRD.md 错误码表：
 * 所有对外错误都带 `code`，HTTP / CLI / 扩展层按 code 映射，不靠 message 匹配。
 */

export type WorkbenchErrorCode =
  | "E_BAD_REQUEST"
  | "E_UNAUTHORIZED"
  | "E_SESSION_NOT_FOUND"
  | "E_LEASE_CONFLICT"
  | "E_NO_LEASE"
  | "E_CAP_UNSUPPORTED"
  | "E_ADAPTER_DOWN"
  | "E_RESUME_REJECTED"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_AGENT_UNAVAILABLE"
  | "E_DISPATCH_IN_PROGRESS"
  | "E_SESSION_BUSY"
  | "E_HANDOFF_FAILED"
  | "E_CHECKPOINT_FAILED";

/**
 * 带错误码的控制面异常。
 * `details` 放机器可读的补充信息（sessionKey / clientId / 冲突持有的 clientId 等），
 * 供 HTTP 层序列化进 error body；不参与 message 拼接。
 */
export class WorkbenchError extends Error {
  readonly code: WorkbenchErrorCode;
  readonly details?: unknown;

  constructor(code: WorkbenchErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorkbenchError";
    this.code = code;
    this.details = details;
  }
}

/**
 * 窄化辅助：`instanceof` 判定，因此要求错误确实是本模块的 `WorkbenchError`。
 * 跨包场景仍可用（`@pi-workbench/shared` 依赖本模块的同一份实现）；但**跨 realm**
 * （vm context / worker 里加载的另一份模块实例）不成立，需依赖方按 `code` 字段自行判定。
 */
export function isWorkbenchError(e: unknown): e is WorkbenchError {
  return e instanceof WorkbenchError;
}
