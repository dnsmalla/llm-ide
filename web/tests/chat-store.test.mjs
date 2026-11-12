import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, initialChatState as S0 } from "../src/chat/store.ts";

const ev = (command, payload, replyTo = null, rev = 1) => ({ type: "event", event: { command, payload, rev, replyTo } });
const run = (...actions) => actions.reduce(reduce, S0);
const Q = [{ question: "Pick?", multiSelect: false, options: [{ label: "Yes" }] }];

test("a turn streams into one assistant line and ends done", () => {
  const s = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("chat.delta", { text: "Hel" }, "c-1"), ev("chat.delta", { text: "lo" }, "c-1"), ev("chat.done", { requestId: "c-1" }, "c-1"));
  assert.deepEqual(s.messages.map((m) => [m.role, m.text, m.status]), [["user", "hi", "done"], ["assistant", "Hello", "done"]]);
  assert.equal(s.turn, null);
});

test("deltas for another command are ignored; cancel and error end the turn", () => {
  const base = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("chat.delta", { text: "x" }, "c-other"));
  assert.equal(base.messages.at(-1).text, "");
  assert.equal(reduce(base, ev("chat.done", { requestId: "c-1", stopReason: "cancelled" }, "c-1")).messages.at(-1).status, "cancelled");
  const err = reduce(base, ev("chat.error", { message: "boom", retryable: true }, "c-1"));
  assert.deepEqual([err.messages.at(-1).status, err.messages.at(-1).error, err.turn], ["error", "boom", null]);
});

test("a snapshot during a turn keeps the live reply and the asked line", () => {
  const live = run({ type: "sent", commandId: "c-1", text: "q2" }, ev("chat.delta", { text: "part" }, "c-1"));
  const s = reduce(live, { type: "snapshot", messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }] });
  assert.deepEqual(s.messages.map((m) => [m.text, m.status]), [["q1", "done"], ["a1", "done"], ["q2", "done"], ["part", "streaming"]]);
  const again = reduce(live, { type: "snapshot", messages: [{ role: "user", content: "q2" }] });
  assert.deepEqual(again.messages.map((m) => m.text), ["q2", "part"], "no duplicate user line");
  assert.equal(new Set(s.messages.map((m) => m.key)).size, s.messages.length, "keys stay unique");
});

test("snapshots are capped at 500 and clamp content", () => {
  const msgs = Array.from({ length: 600 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i === 599 ? "x".repeat(200_000) : `m${i}` }));
  const s = reduce(S0, { type: "snapshot", messages: msgs });
  assert.equal(s.messages.length, 500);
  assert.equal(s.messages.at(-1).text.length, 100_000);
  assert.equal(s.loaded, true);
});

test("approvals belong to the running turn, dedupe, clear, and follow capabilities", () => {
  let s = run({ type: "sent", commandId: "c-1", text: "hi" },
    ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: Q }, "c-1"),
    ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: Q }, "c-1"),
    ev("approval.request", { requestId: "r-9", commandId: "c-other", questions: Q }),
    ev("toolApproval.request", { requestId: "r-2", commandId: "c-1", toolName: "Edit", summary: "edit a.txt", truncated: false }, "c-1"));
  assert.deepEqual(s.approvals.map((a) => [a.kind, a.requestId]), [["question", "r-1"], ["tool", "r-2"]]);
  s = reduce(s, { type: "capabilities", capabilities: new Set(["host", "chat", "approvals"]) });
  assert.deepEqual(s.approvals.map((a) => a.requestId), ["r-1"]);
  s = reduce(s, ev("approval.cleared", { requestId: "r-1", commandId: "c-1", reason: "answer" }));
  assert.equal(s.approvals.length, 0);
});

test("a closed connection interrupts the reply and drops every approval", () => {
  const s = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: Q }, "c-1"), { type: "connectionClosed" });
  assert.equal(s.messages.at(-1).status, "interrupted");
  assert.match(s.messages.at(-1).error, /connection closed/);
  assert.deepEqual([s.turn, s.approvals.length], [null, 0]);
});

test("a tool approval is ignored when tool_approvals is not served", () => {
  const caps = { type: "capabilities", capabilities: new Set(["host", "chat", "approvals"]) };
  const s = run(caps, { type: "sent", commandId: "c-1", text: "hi" }, ev("toolApproval.request", { requestId: "r-2", commandId: "c-1", toolName: "Edit", truncated: false }, "c-1"));
  assert.equal(s.approvals.length, 0);
});

test("approvalFailed keeps the card with the error", () => {
  let s = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: Q }, "c-1"));
  s = reduce(reduce(s, { type: "approvalSubmitting", requestId: "r-1" }), { type: "approvalFailed", requestId: "r-1", message: "nope" });
  assert.deepEqual([s.approvals[0].submitting, s.approvals[0].error], [false, "nope"]);
});

test("done and error for an unknown or finished request are no-ops", () => {
  const s = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("chat.done", { requestId: "c-1" }, "c-1"));
  assert.equal(reduce(s, ev("chat.done", { requestId: "c-x" }, "c-x")), s);
  assert.equal(reduce(s, ev("chat.error", { message: "late" }, "c-1")), s);
});

test("sent respects the message cap", () => {
  const msgs = Array.from({ length: 500 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const s = reduce(reduce(S0, { type: "snapshot", messages: msgs }), { type: "sent", commandId: "c-1", text: "new" });
  assert.equal(s.messages.length, 500);
  assert.equal(s.messages.at(-2).text, "new");
});

test("a dropped socket keeps the turn waiting instead of failing it", () => {
  const s = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("chat.delta", { text: "a" }, "c-1"), { type: "connectionLost" });
  assert.deepEqual([s.turn, s.waiting, s.messages.at(-1).status, s.messages.at(-1).text], ["c-1", true, "streaming", "a"]);
});

test("resumed replaces the text, later deltas append, done ends the turn", () => {
  let s = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("chat.delta", { text: "a" }, "c-1"), { type: "connectionLost" }, { type: "resumed", text: "abc", truncated: true });
  assert.deepEqual([s.waiting, s.messages.at(-1).text, s.messages.at(-1).truncated], [false, "abc", true]);
  s = reduce(reduce(s, ev("chat.delta", { text: "d" }, "c-1")), ev("chat.done", { requestId: "c-1" }, "c-1"));
  assert.deepEqual([s.messages.at(-1).text, s.messages.at(-1).status, s.turn], ["abcd", "done", null]);
});

test("a re-sent approval card does not duplicate", () => {
  const card = ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: Q }, "c-1");
  const s = run({ type: "sent", commandId: "c-1", text: "hi" }, card, { type: "connectionLost" }, { type: "resumed", text: "", truncated: false }, card, card);
  assert.equal(s.approvals.length, 1);
});
