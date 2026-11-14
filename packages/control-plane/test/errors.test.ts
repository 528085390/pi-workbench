import test from "node:test";
import assert from "node:assert/strict";

import { WorkbenchError, isWorkbenchError } from "../src/errors.ts";

test("WorkbenchError: 带 code / message / details，且是 Error 实例", () => {
  const err = new WorkbenchError("E_LEASE_CONFLICT", "租约冲突", { sessionKey: "claude:sess-1" });

  assert.ok(err instanceof Error);
  assert.ok(err instanceof WorkbenchError);
  assert.equal(err.name, "WorkbenchError");
  assert.equal(err.code, "E_LEASE_CONFLICT");
  assert.equal(err.message, "租约冲突");
  assert.deepEqual(err.details, { sessionKey: "claude:sess-1" });
});

test("WorkbenchError: details 可省略", () => {
  const err = new WorkbenchError("E_NO_LEASE", "无租约");
  assert.equal(err.details, undefined);
  assert.equal(err.code, "E_NO_LEASE");
});

test("isWorkbenchError: 只认 WorkbenchError", () => {
  assert.equal(isWorkbenchError(new WorkbenchError("E_BAD_REQUEST", "x")), true);
  assert.equal(isWorkbenchError(new Error("x")), false);
  assert.equal(isWorkbenchError("E_NO_LEASE"), false);
  assert.equal(isWorkbenchError(null), false);
  assert.equal(isWorkbenchError(undefined), false);
  assert.equal(isWorkbenchError({ code: "E_NO_LEASE" }), false);
});

test("isWorkbenchError: 可用于窄化后再读 code", () => {
  const err: unknown = new WorkbenchError("E_ADAPTER_DOWN", "adapter 已退出");
  if (!isWorkbenchError(err)) {
    assert.fail("应窄化为 WorkbenchError");
  }
  const code: string = err.code;
  assert.equal(code, "E_ADAPTER_DOWN");
});
