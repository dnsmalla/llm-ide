import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { SseDecoder, SseError } = await load("sse.ts");

test("decodes events split across arbitrary chunk boundaries", () => {
  const d = new SseDecoder();
  const text = 'event: delta\ndata: {"a":1}\nid: 7\n\ndata: x\ndata: y\n\n';
  const out = [];
  for (const ch of text) out.push(...d.push(ch));
  assert.deepEqual(out.map((e) => [e.event, e.data, e.id]), [["delta", '{"a":1}', "7"], ["message", "x\ny", "7"]]);
});

test("handles CRLF, lone CR, comments, BOM and a CR split from its LF", () => {
  const d = new SseDecoder();
  const out = [...d.push("﻿: keep-alive\r\ndata: a\r"), ...d.push("\n\r\ndata: b\r\r"), ...d.end()];
  assert.deepEqual(out.map((e) => e.data), ["a", "b"]);
});

test("a partial event at end of stream is dropped; retry is parsed; bad retry ignored", () => {
  const d = new SseDecoder();
  assert.equal(d.push("retry: 1500\ndata: k\n\n")[0].retry, 1500);
  assert.equal(d.push("retry: abc\ndata: k\n\n")[0].retry, null);
  d.push("data: partial");
  assert.deepEqual(d.end(), []);
});

test("an oversized event throws instead of buffering without bound", () => {
  const d = new SseDecoder(100);
  assert.throws(() => d.push("data: " + "x".repeat(200)), SseError);
  const d2 = new SseDecoder(100);
  assert.throws(() => {
    for (let i = 0; i < 20; i++) d2.push("data: abcdefgh\n");
  }, SseError);
});
