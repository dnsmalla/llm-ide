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

const Q1 = [{ question: "Pick?", multiSelect: false, options: [{ label: "Yes" }] }];
const ask = (link, id = "r-1") => link.emit({ command: "approval.request", payload: { requestId: id, commandId: "c-1", questions: Q1 }, rev: 1, replyTo: "c-1" });

test("accepted:false keeps the question card and shows an error", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "approvals.answer": { accepted: false } });
  const chat = createChatController(link);
  await chat.send("hi"); ask(link);
  await chat.answerQuestion("r-1", { "Pick?": "Yes" });
  const [a] = chat.getState().approvals;
  assert.deepEqual([a.submitting, typeof a.error], [false, "string"]);
});

test("cancelled:false on decline keeps the card", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "chat.cancel": { cancelled: false } });
  const chat = createChatController(link);
  await chat.send("hi"); ask(link);
  await chat.declineQuestion("r-1");
  assert.equal(chat.getState().approvals.length, 1);
  assert.ok(chat.getState().approvals[0].error);
});

test("tool approvals answer with the card's command id; refusal keeps the card", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "toolApprovals.answer": { accepted: true } });
  link.capabilities = new Set(["host", "chat", "approvals", "tool_approvals"]);
  const chat = createChatController(link);
  await chat.send("hi");
  const tool = (id) => link.emit({ command: "toolApproval.request", payload: { requestId: id, commandId: "c-1", toolName: "Edit", truncated: false }, rev: 1, replyTo: "c-1" });
  tool("t-1");
  await chat.answerTool("t-1", "allow_once");
  assert.deepEqual(link.calls.at(-1), { id: "c-2", command: "toolApprovals.answer", payload: { requestId: "t-1", commandId: "c-1", decision: "allow_once" } });
  assert.equal(chat.getState().approvals.length, 0);
});

test("capabilities apply before any snapshot, so an unserved tool approval is ignored", async () => {
  const link = fakeLink({ "chat.send": { accepted: true } });
  const chat = createChatController(link);
  await chat.send("hi");
  link.emit({ command: "toolApproval.request", payload: { requestId: "t-1", commandId: "c-1", toolName: "Edit", truncated: false }, rev: 1, replyTo: "c-1" });
  assert.equal(chat.getState().approvals.length, 0);
});

test("a successful snapshot clears an earlier refusal notice", async () => {
  const results = { "chat.snapshot": new Error("PROJECT_REQUIRED: a project is required on this hub") };
  const link = fakeLink(results);
  const chat = createChatController(link);
  await chat.resync();
  assert.match(chat.getState().notice, /PROJECT_REQUIRED/);
  results["chat.snapshot"] = { messages: [] };
  await chat.resync();
  assert.equal(chat.getState().loaded, true);
  assert.equal(chat.getState().notice, null, "the successful snapshot is proof the transient refusal is over");
});

test("send carries compose extras and reports whether the host accepted it", async () => {
  const link = fakeLink({ "chat.send": { accepted: true } });
  const chat = createChatController(link);
  const ok = await chat.send("hi", { mode: "plan", attachments: [{ name: "a.md", text: "x" }] });
  assert.equal(ok, true);
  assert.deepEqual(link.calls[0].payload, { text: "hi", mode: "plan", attachments: [{ name: "a.md", text: "x" }] });
  const refused = createChatController(fakeLink({ "chat.send": new Error("That model is not offered on this computer — pick another.") }));
  assert.equal(await refused.send("hi", { model: "x" }), false);
});
test("newChat starts a fresh phone chat and empties the view; refused during a turn", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "chat.new": { sessionId: "chat-2" }, "chat.snapshot": { messages: [] } });
  const chat = createChatController(link);
  await chat.send("hi");
  assert.equal(await chat.newChat(), false, "a turn is running");
  link.emit({ command: "chat.done", payload: { requestId: "c-1" }, rev: 1, replyTo: "c-1" });
  assert.equal(await chat.newChat(), true);
  assert.equal(link.calls.at(-1).command, "chat.new");
  assert.deepEqual(chat.getState().messages, []);
});

test("a frame over 1 MiB (attachments included) is refused up front with a clear notice", async () => {
  const link = fakeLink({ "chat.send": { accepted: true } });
  const chat = createChatController(link);
  // Control characters escape to 6 bytes each in JSON: 200,000 characters stay within the schema but not the frame.
  const attachments = [{ name: "a.log", text: "\u0001".repeat(100_000) }, { name: "b.log", text: "\u0001".repeat(100_000) }];
  assert.equal(await chat.send("hi", { attachments }), false);
  assert.equal(link.calls.length, 0);
  assert.match(chat.getState().notice, /1 MiB/);
});
