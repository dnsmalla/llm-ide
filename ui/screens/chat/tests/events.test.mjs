import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, fixtures, REPO } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("events"); });

test("every agent/v2 fixture decodes, and its type matches", () => {
  const all = fixtures();
  assert.ok(all.length >= 22, `expected the full fixture set, got ${all.length}`);
  for (const { name, json } of all) {
    const r = c.decodeEvent(json);
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.event.type, json.type, name);
  }
});

test("the schema roster equals the decoder's known types (a new event cannot slip in)", () => {
  const schema = JSON.parse(readFileSync(join(REPO, "schema/agent-v2/agent-v2.schema.json"), "utf8"));
  const types = new Set(schema.oneOf.map((v) => v.properties.type.const));
  assert.deepEqual([...types].sort(), [...c.KNOWN_EVENT_TYPES].sort());
});

test("fixtures carry their fields through the decode", () => {
  const by = Object.fromEntries(fixtures().map((f) => [f.name.replace(".json", ""), f.json]));
  assert.equal(c.decodeEvent(by.delta).event.text, "Reading the file now");
  assert.equal(c.decodeEvent(by.tool_result).event.toolUseId, "toolu_01ABCdefGHIjklMNOpqrs");
  const q = c.decodeEvent(by.approval_request_question).event;
  assert.equal(q.kind, "AskUserQuestion");
  assert.equal(q.questions[0].options[0].preview.startsWith("struct"), true);
  const t = c.decodeEvent(by.approval_request_write).event;
  assert.equal(t.toolName, "Write");
  assert.equal(c.decodeEvent(by.notice_session_budget).event.data.limit, 50000);
  assert.equal(c.decodeEvent(by.error).event.retryable, true);
  assert.equal(c.decodeEvent(by.context_usage).event.categories.length, 4);
});

test("unknown types are ignored, known types with a wrong shape are malformed", () => {
  assert.deepEqual(c.decodeEvent({ type: "brand_new" }), { ok: false, reason: "unknown_type", type: "brand_new" });
  assert.equal(c.decodeEvent({ type: "delta", text: 5 }).reason, "malformed");
  assert.equal(c.decodeEvent({ type: "tool_use_start", index: "0", id: "x", name: "y" }).reason, "malformed");
  assert.equal(c.decodeEvent({ type: "tasks", tasks: [{ id: 1 }] }).reason, "malformed");
  assert.equal(c.decodeEvent([]).reason, "not_object");
  assert.equal(c.decodeEvent(null).reason, "not_object");
  assert.equal(c.decodePayload("{not json").reason, "malformed");
});

test("SseFramer: any chunk split, CRLF, multi-line data, comments, tail without blank line", () => {
  const f = new c.SseFramer();
  const text = ": keepalive\r\ndata: {\"a\":1}\r\n\r\ndata: x\ndata: y\n\nid: 9\ndata:{\"z\":2}\n\n";
  const got = [];
  for (let i = 0; i < text.length; i += 3) got.push(...f.push(text.slice(i, i + 3)));
  assert.deepEqual(got, ['{"a":1}', "x\ny", '{"z":2}']);
  assert.deepEqual(f.push("data: tail"), []);
  assert.deepEqual(f.end(), ["tail"]);
});

test("SseFramer flags an oversize event instead of buffering it forever", () => {
  const f = new c.SseFramer();
  f.push("data: " + "x".repeat(c.MAX_SSE_EVENT_BYTES + 10));
  assert.equal(f.overflow, true);
});

test("SseFramer: a burst of many complete events in one chunk is all delivered; the cap bounds only the unfinished remainder", () => {
  const f = new c.SseFramer();
  const ev = `data: ${"x".repeat(900)}\n\n`;
  const n = Math.ceil((c.MAX_SSE_EVENT_BYTES * 1.5) / ev.length);
  const out = f.push(ev.repeat(n) + "data: tail");
  assert.equal(out.length, n, "every complete event is returned");
  assert.equal(f.overflow, false);
  assert.deepEqual(f.push("\n\n"), ["tail"], "the unfinished event survives the burst");
  // an unfinished event over the cap still overflows, whether one long line or many data lines
  const g = new c.SseFramer();
  g.push(`data: ${"y".repeat(c.MAX_SSE_EVENT_BYTES + 10)}`);
  assert.equal(g.overflow, true);
  const m = new c.SseFramer();
  for (let i = 0; i < 9; i++) m.push(`data: ${"z".repeat(1024 * 1024)}\n`);
  assert.equal(m.overflow, true, "many data lines of one event add up");
});
