import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, fixtures } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("state"); });
const ev = (type, o = {}) => c.decodeEvent({ type, ...o }).event;
const fx = (name) => c.decodeEvent(fixtures().find((f) => f.name === `${name}.json`).json).event;
const start = (s = c.initialState("c1"), text = "hi") => c.reduce(s, { type: "send", id: "t1", text });
const last = (s) => s.messages.at(-1);

test("a turn: user bubble + streaming assistant, deltas accumulate, result completes", () => {
  let s = start();
  assert.equal(s.phase, "streaming");
  s = c.reduce(s, { type: "events", events: [fx("init"), fx("mode_set"), ev("delta", { text: "Hel" }), ev("delta", { text: "lo\n\nWor" })] });
  assert.equal(s.model, "claude-sonnet-5");
  assert.equal(s.resolvedMode, "execute");
  assert.equal(c.assistantText(last(s)), "Hello\n\nWor");
  assert.deepEqual(last(s).parts[0].sealed, ["Hello\n\n"]);
  s = c.reduce(s, { type: "events", events: [fx("usage"), fx("context_usage"), fx("result")] });
  assert.equal(s.phase, "idle");
  assert.equal(last(s).status, "done");
  assert.equal(s.context.percentage, 1);
  assert.equal(s.usage.cacheReadTokens, 40000);
});

test("history keeps object identity while streaming (only the last message is replaced)", () => {
  let s = c.reduce(c.initialState("c1"), { type: "load", messages: c.toMessages([{ seq: 1, role: "user", content: "a" }, { seq: 2, role: "assistant", content: "b" }]), hasMoreOlder: false });
  const before = s.messages.slice();
  s = start(s);
  for (let i = 0; i < 50; i++) s = c.reduce(s, { type: "events", events: [ev("delta", { text: "x" })] });
  assert.equal(s.messages[0], before[0]);
  assert.equal(s.messages[1], before[1]);
});

test("sealed blocks never change once sealed; fences do not seal on blank lines", () => {
  let p = c.emptyText();
  p = c.appendText(p, "para one\n\n");
  const sealed = p.sealed;
  p = c.appendText(p, "```js\na\n\nb\n```\n\ntail");
  assert.equal(p.sealed[0], sealed[0]);
  assert.equal(p.sealed.length, 2);
  assert.match(p.sealed[1], /^```js\na\n\nb\n```\n\n$/);
  assert.equal(p.line, "tail");
  assert.equal(c.textOf(p), "para one\n\n```js\na\n\nb\n```\n\ntail");
});

test("tool call: start, args deltas, result matched by id; big output is capped in state", () => {
  let s = start();
  s = c.reduce(s, { type: "events", events: [fx("tool_use_start"), fx("tool_args_delta"), ev("tool_args_delta", { index: 0, partialJson: 'ce/x"}' })] });
  let t = last(s).parts[0];
  assert.equal(t.name, "Read");
  assert.equal(t.args, '{"file_path":"/repo/mac/Sour' + 'ce/x"}');
  s = c.reduce(s, { type: "events", events: [ev("tool_result", { toolUseId: "toolu_01ABCdefGHIjklMNOpqrs", isError: false, text: "y".repeat(c.TOOL_STATE_CAP * 3), truncated: false })] });
  t = last(s).parts[0];
  assert.equal(t.result.text.length, c.TOOL_STATE_CAP);
  assert.equal(t.result.truncated, true);
  assert.equal(t.result.totalChars, c.TOOL_STATE_CAP * 3);
});

test("notices: info is hidden, warning/error and workspace_trust are shown, repeats collapse", () => {
  let s = start();
  const n = (kind, level, text) => ev("notice", { kind, level, text, data: null });
  s = c.reduce(s, { type: "events", events: [n("retry", "warning", "retrying"), n("retry", "warning", "retrying"), n("route_switch", "info", "switched"), n("workspace_trust", "info", "Trust this folder?"), fx("notice_session_budget")] });
  const notices = last(s).notices;
  assert.deepEqual(notices.map((x) => [x.kind, x.visible, x.count]), [["retry", true, 2], ["route_switch", false, 1], ["workspace_trust", true, 1], ["session_budget", true, 1]]);
  assert.deepEqual(s.budget, { used: 50120, limit: 50000, remaining: 0, level: "reached" });
});

test("error event ends the turn in error with the server's retryable flag; later events are ignored", () => {
  let s = start();
  s = c.reduce(s, { type: "events", events: [ev("delta", { text: "x" }), fx("error"), ev("delta", { text: "never" })] });
  assert.equal(s.phase, "error");
  assert.equal(s.error.code, "SESSION_UNRESUMABLE");
  assert.equal(s.error.retryable, true);
  assert.equal(last(s).status, "error");
  assert.equal(c.assistantText(last(s)), "x");
  assert.equal(c.reduce(s, { type: "events", events: [ev("delta", { text: "z" })] }), s, "events in a terminal state change nothing");
});

test("abort: aborting then aborted returns to idle, marks the message, drops the queue", () => {
  let s = start();
  s = c.reduce(s, { type: "send", id: "t2", text: "next" });
  assert.deepEqual(s.queue, ["next"]);
  s = c.reduce(s, { type: "abort_requested" });
  assert.equal(s.phase, "aborting");
  s = c.reduce(s, { type: "events", events: [ev("delta", { text: "late" })] });
  assert.equal(c.assistantText(last(s)), "late", "events still apply while aborting (they arrive before the stream closes)");
  s = c.reduce(s, { type: "aborted" });
  assert.equal(s.phase, "idle");
  assert.equal(last(s).status, "aborted");
  assert.deepEqual(s.queue, []);
});

test("stream end without a terminal event is a retryable error (reconnect path)", () => {
  let s = start();
  s = c.reduce(s, { type: "events", events: [ev("delta", { text: "x" })] });
  s = c.reduce(s, { type: "stream_end" });
  assert.equal(s.phase, "error");
  assert.equal(s.error.code, "STREAM_ENDED");
  assert.equal(s.error.retryable, true);
  assert.equal(c.reduce(c.reduce(start(), { type: "events", events: [fx("result")] }), { type: "stream_end" }).phase, "idle");
});

test("approval requests are tracked until resolved (S-G renders them)", () => {
  let s = start();
  s = c.reduce(s, { type: "events", events: [fx("approval_request_tool"), fx("approval_request_question")] });
  assert.deepEqual(s.pendingApprovals.map((a) => a.kind), ["ToolApproval", "AskUserQuestion"]);
  s = c.reduce(s, { type: "events", events: [fx("approval_resolved")] });
  assert.deepEqual(s.pendingApprovals.map((a) => a.kind), ["AskUserQuestion"]);
});

test("every fixture can be applied in a turn without throwing", () => {
  let s = start();
  for (const f of fixtures()) { const d = c.decodeEvent(f.json); s = c.reduce(s, { type: "events", events: [d.event] }); if (s.phase !== "streaming") s = start(c.reduce(s, { type: "clear_error" })); }
  assert.ok(s.messages.length > 0);
});

test("queue is capped; send while idle after error starts a turn", () => {
  let s = start();
  for (let i = 0; i < c.MAX_QUEUE + 5; i++) s = c.reduce(s, { type: "send", id: `q${i}`, text: "m" });
  assert.equal(s.queue.length, c.MAX_QUEUE);
  s = c.reduce(c.reduce(s, { type: "transport_error", code: "X", message: "m", retryable: true }), { type: "send", id: "n", text: "again" });
  assert.equal(s.phase, "streaming");
});

test("memory bound: the in-memory window never exceeds the cap and flags older history", () => {
  const rows = Array.from({ length: c.MAX_MESSAGES_IN_MEMORY }, (_, i) => ({ seq: i + 1, role: i % 2 ? "assistant" : "user", content: "m" }));
  let s = c.reduce(c.initialState("c1"), { type: "load", messages: c.toMessages(rows), hasMoreOlder: false });
  s = start(s);
  assert.equal(s.messages.length, c.MAX_MESSAGES_IN_MEMORY);
  assert.equal(s.hasMoreOlder, true);
  assert.equal(s.oldestSeq, 3);
});

test("prepend keeps order and moves the paging cursor", () => {
  let s = c.reduce(c.initialState("c1"), { type: "load", messages: c.toMessages([{ seq: 5, role: "user", content: "e" }]), hasMoreOlder: true });
  s = c.reduce(s, { type: "prepend", messages: c.toMessages([{ seq: 3, role: "user", content: "c" }, { seq: 4, role: "assistant", content: "d" }]), hasMoreOlder: false });
  assert.deepEqual(s.messages.map((m) => m.seq), [3, 4, 5]);
  assert.equal(s.oldestSeq, 3);
  assert.equal(s.hasMoreOlder, false);
});

test("10k-token reply reduces fast and keeps a small open tail", () => {
  let s = start();
  const t0 = Date.now();
  for (let i = 0; i < 10_000; i++) s = c.reduce(s, { type: "events", events: [ev("delta", { text: i % 40 === 39 ? "word.\n\n" : "word " })] });
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  const part = last(s).parts[0];
  assert.ok(part.sealed.length > 200);
  assert.ok((part.open + part.line).length < 400);
});

test("tool_result: empty ids match nothing, duplicate ids are not attached to the first tool and are flagged", () => {
  const toolStart = (index, id) => ({ type: "tool_use_start", index, id, name: "Read" });
  const result = (toolUseId) => ({ type: "tool_result", toolUseId, isError: false, text: "out", truncated: false });
  // empty ids: a result with an empty id must not land on a tool that also has none
  let s = c.reduce(start(), { type: "events", events: [toolStart(0, ""), result("")] });
  assert.equal(last(s).parts[0].result, null);
  // duplicate ids: ambiguous, nothing attached, a visible warning
  s = c.reduce(start(), { type: "events", events: [toolStart(0, "dup"), toolStart(1, "dup"), toolStart(2, "ok"), result("dup"), result("ok")] });
  const [a, b, d] = last(s).parts;
  assert.equal(a.result, null); assert.equal(b.result, null);
  assert.equal(d.result.text, "out", "a unique id still matches");
  assert.ok(last(s).notices.some((n) => n.kind === "duplicate_tool_id" && n.level === "warning"));
  assert.equal(last(s).notices.filter((n) => n.kind === "duplicate_tool_id").length, 1);
});
