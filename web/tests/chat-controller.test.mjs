import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatController, MAX_SEND_CHARS } from "../src/chat/controller.ts";

function fakeLink(results = {}) {
  const ls = { event: new Set(), resync: new Set(), state: new Set() };
  const calls = [];
  let n = 0;
  return {
    capabilities: new Set(["host", "chat", "approvals"]),
    calls,
    send(command, payload) {
      const id = `c-${++n}`;
      calls.push({ id, command, payload });
      const r = results[command];
      return { id, done: r instanceof Error ? Promise.reject(r) : Promise.resolve(typeof r === "function" ? r(payload) : r ?? {}) };
    },
    onEvent: (fn) => (ls.event.add(fn), () => ls.event.delete(fn)),
    onResync: (fn) => (ls.resync.add(fn), () => ls.resync.delete(fn)),
    onState: (fn) => (ls.state.add(fn), () => ls.state.delete(fn)),
    emit: (e) => ls.event.forEach((fn) => fn(e)),
    resync: () => ls.resync.forEach((fn) => fn()),
    state: (s) => ls.state.forEach((fn) => fn(s)),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("send dispatches the turn under the command id and the events land on it", async () => {
  const link = fakeLink({ "chat.send": { accepted: true, requestId: "c-1" } });
  const chat = createChatController(link);
  await chat.send("  hi  ");
  assert.deepEqual(link.calls[0], { id: "c-1", command: "chat.send", payload: { text: "hi" } });
  link.emit({ command: "chat.delta", payload: { text: "yo" }, rev: 1, replyTo: "c-1" });
  link.emit({ command: "chat.done", payload: { requestId: "c-1" }, rev: 2, replyTo: "c-1" });
  assert.deepEqual(chat.getState().messages.map((m) => m.text), ["hi", "yo"]);
  assert.equal(chat.getState().turn, null);
});

test("an oversized message is refused before it is sent; a second send during a turn is ignored", async () => {
  const link = fakeLink({ "chat.send": { accepted: true } });
  const chat = createChatController(link);
  await chat.send("x".repeat(MAX_SEND_CHARS + 1));
  assert.equal(link.calls.length, 0);
  assert.match(chat.getState().notice, /under 100,000/);
  await chat.send("a");
  await chat.send("b");
  assert.equal(link.calls.length, 1);
});

test("resync is single-flight and fires on the link's resync", async () => {
  let release;
  const link = fakeLink({ "chat.snapshot": () => new Promise((r) => { release = () => r({ messages: [{ role: "user", content: "old" }] }); }) });
  const chat = createChatController(link);
  link.resync(); link.resync();
  assert.equal(link.calls.filter((c) => c.command === "chat.snapshot").length, 1);
  assert.deepEqual(link.calls[0].payload, { limit: 200 });
  release(); await tick();
  assert.deepEqual(chat.getState().messages.map((m) => m.text), ["old"]);
});

test("a connection drop interrupts; a refused clear shows the host's message", async () => {
  const denied = Object.assign(new Error("This host does not allow clearing chat history from a paired device."), { code: "denied" });
  const link = fakeLink({ "chat.send": { accepted: true }, "chat.history.clear": denied });
  const chat = createChatController(link);
  await chat.send("hi");
  link.state({ kind: "reconnecting", attempt: 1, inMs: 1000 });
  assert.equal(chat.getState().messages.at(-1).status, "interrupted");
  await chat.clearHistory();
  assert.match(chat.getState().notice, /does not allow clearing/);
});

test("answers go out with the card's command id; decline cancels the turn", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "approvals.answer": { accepted: true }, "chat.cancel": { cancelled: true } });
  const chat = createChatController(link);
  await chat.send("hi");
  link.emit({ command: "approval.request", payload: { requestId: "r-1", commandId: "c-1", questions: [{ question: "Pick?", multiSelect: false, options: [{ label: "Yes" }] }] }, rev: 1, replyTo: "c-1" });
  await chat.answerQuestion("r-1", { "Pick?": "Yes" });
  assert.deepEqual(link.calls.at(-1), { id: "c-2", command: "approvals.answer", payload: { requestId: "r-1", commandId: "c-1", answers: { "Pick?": "Yes" } } });
  assert.equal(chat.getState().approvals.length, 0);
  link.emit({ command: "approval.request", payload: { requestId: "r-2", commandId: "c-1", questions: [{ question: "Again?", multiSelect: false, options: [{ label: "No" }] }] }, rev: 2, replyTo: "c-1" });
  await chat.declineQuestion("r-2");
  assert.equal(link.calls.at(-1).command, "chat.cancel");
});
