import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emptyPage, parseCursor, scanJsonl } from "../src/transcript/jsonl.ts";

function tempFile(t: { after: (fn: () => void) => void }, name = "records.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wb-jsonl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

test("parseCursor 容错", () => {
  assert.equal(parseCursor(undefined), 0);
  assert.equal(parseCursor("12"), 12);
  assert.equal(parseCursor("12.9"), 12);
  assert.equal(parseCursor("abc"), 0);
  assert.equal(parseCursor("-3"), 0);
  assert.equal(parseCursor(""), 0);
});

test("emptyPage 返回 pending 空页", () => {
  assert.deepEqual(emptyPage("0"), { messages: [], nextCursor: "0", pending: true });
  assert.deepEqual(emptyPage("42"), { messages: [], nextCursor: "42", pending: true });
});

test("scanJsonl 按完整行回调，nextCursor 是字节偏移", (t) => {
  const file = tempFile(t);
  const first = JSON.stringify({ n: 1 });
  const second = JSON.stringify({ n: 2, text: "你好" });
  writeFileSync(file, `${first}\n${second}\n`, "utf8");

  const records: unknown[] = [];
  const offsets: number[] = [];
  const scan = scanJsonl(file, 0, (record, nextByte) => {
    records.push(record);
    offsets.push(nextByte);
  });

  assert.deepEqual(records, [{ n: 1 }, { n: 2, text: "你好" }]);
  assert.deepEqual(offsets, [bytes(first) + 1, bytes(first) + bytes(second) + 2]);
  assert.equal(scan.nextCursor, bytes(first) + bytes(second) + 2);
  assert.equal(scan.pending, false);
});

test("scanJsonl 不消费末尾半行，补全后从游标继续", (t) => {
  const file = tempFile(t);
  const first = JSON.stringify({ n: 1 });
  const second = JSON.stringify({ n: 2 });
  const head = second.slice(0, 9);
  const tail = second.slice(9);
  writeFileSync(file, `${first}\n${head}`, "utf8");

  const records: unknown[] = [];
  const scan = scanJsonl(file, 0, (record) => records.push(record));

  assert.deepEqual(records, [{ n: 1 }]);
  assert.equal(scan.nextCursor, bytes(first) + 1);
  assert.equal(scan.pending, true);

  appendFileSync(file, `${tail}\n`, "utf8");
  const next: unknown[] = [];
  const rest = scanJsonl(file, scan.nextCursor, (record) => next.push(record));
  assert.deepEqual(next, [{ n: 2 }]);
  assert.equal(rest.nextCursor, bytes(first) + bytes(second) + 2);
  assert.equal(rest.pending, false);
});

test("scanJsonl 文件不存在返回 0 / pending，不抛异常", (t) => {
  const file = tempFile(t, "missing.jsonl");
  assert.deepEqual(scanJsonl(file, 0, () => {}), { nextCursor: 0, pending: true });
});

test("scanJsonl 空文件返回 0 / pending", (t) => {
  const file = tempFile(t);
  writeFileSync(file, "", "utf8");
  assert.deepEqual(scanJsonl(file, 7, () => {}), { nextCursor: 0, pending: true });
});

test("scanJsonl 跳过空行、兼容 CRLF、坏 JSON 以 undefined 回调", (t) => {
  const file = tempFile(t);
  const good = JSON.stringify({ ok: true });
  writeFileSync(file, `\r\n${good}\r\nnot json\n`, "utf8");

  const records: unknown[] = [];
  const scan = scanJsonl(file, 0, (record) => records.push(record));

  assert.deepEqual(records, [{ ok: true }, undefined]);
  assert.equal(scan.nextCursor, bytes(`\r\n${good}\r\nnot json\n`));
  assert.equal(scan.pending, false);
});
