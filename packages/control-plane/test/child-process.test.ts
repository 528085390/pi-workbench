import assert from "node:assert/strict";
import test from "node:test";

import { wrapSpawnWithHiddenWindow } from "../src/child-process.ts";

test("wrapSpawnWithHiddenWindow: Windows 子进程默认带 windowsHide", () => {
  let seen: unknown = null;
  const fake = ((command: unknown, args: unknown, options: unknown) => {
    seen = { command, args, options };
    return { pid: 1 };
  }) as never;
  const wrapped = wrapSpawnWithHiddenWindow(fake);
  const result = wrapped("node", ["x"], { cwd: "C:\\work" }) as unknown as { pid: number };
  assert.equal(result.pid, 1);
  assert.deepEqual(seen, { command: "node", args: ["x"], options: { windowsHide: true, cwd: "C:\\work" } });
});

test("wrapSpawnWithHiddenWindow: 显式 windowsHide=false 不会被覆盖", () => {
  let seen: unknown = null;
  const fake = ((_command: unknown, _args: unknown, options: unknown) => {
    seen = options;
    return { pid: 2 };
  }) as never;
  const wrapped = wrapSpawnWithHiddenWindow(fake);
  wrapped("node", [], { windowsHide: false });
  assert.deepEqual(seen, { windowsHide: false });
});
