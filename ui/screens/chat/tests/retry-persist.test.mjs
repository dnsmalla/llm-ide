// U#F5 end-to-end: a retried turn must not leave the interrupted partial in the desktop chat file, so a
// reload cannot show the partial and the full reply side by side. Drives the real ChatController over the
// real TauriChatStore against the in-memory host (same commands/rules as chat_store.rs), then reopens the
// chat with a FRESH store over the same files (what a reload does).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, fakeCore, sse, tick, until, fixtures } from "./helpers.mjs";
import { createFakeChatHost } from "../../shell/tests/e2e/fake-host.mjs";

let c;
before(async () => { c = await loadChat("retry-persist"); });

const FX = Object.fromEntries(fixtures().map((f) => [f.name.replace(".json", ""), f.json]));
const turn = () => [sse(FX.init, FX.mode_set), sse({ type: "delta", text: "Hello " }, { type: "delta", text: "world" }), sse(FX.usage, FX.result)];
const dying = async function* () {
  yield JSON.stringify(FX.init);
  yield JSON.stringify({ type: "delta", text: "half a repl" });
  throw new Error("the core went away");
};

async function boundStore() {
  const host = createFakeChatHost();
  await host.invoke("chat_bind_session", { token: "x".repeat(20) });
  const store = new c.TauriChatStore({ invoke: host.invoke, ready: async () => {}, now: () => 1_800_000_000_000 });
  return { host, store };
}

const textOf = (m) => (m.role === "user" ? m.text : c.assistantText(m));
let ids = 0;
const make = (store, core) => new c.ChatController({ core, store, workspaceRoot: () => "/proj", newId: () => `t${++ids}`, sleep: () => tick(1), abortGraceMs: 30 });

test("retry removes exactly the interrupted partial from the chat file: reload shows the full reply, older turns untouched", async () => {
  const { host, store } = await boundStore();
  const s = await store.createSession({ title: "retry" });
  // A chat that already had an interrupted turn the user kept, plus a normal turn.
  await store.appendMessage(s.id, { role: "user", content: "q1" });
  await store.appendMessage(s.id, { role: "assistant", content: "old partial", meta: { interrupted: true, status: "interrupted" } });
  await store.appendMessage(s.id, { role: "user", content: "q2" });
  await store.appendMessage(s.id, { role: "assistant", content: "a2" });

  const ctl = make(store, fakeCore({ streams: [dying, turn()] }));
  await ctl.open(s.id);
  ctl.send(s.id, "go", { mode: "execute" });
  await until(() => ctl.getState(s.id).phase === "error");
  assert.equal(ctl.getState(s.id).messages.at(-1).interrupted, true, "the live bubble says Interrupted");
  assert.equal(host.files.get(s.id).doc.messages.at(-1).metadata.interrupted, true, "the partial was written through to the file");
  ctl.retry(s.id);
  await until(() => ctl.getState(s.id).messages.at(-1)?.status === "done");
  await tick(10); // let the store's serial queue (drop, then the reply's append) settle

  // The file itself: the partial is gone, the retried turn appears once, the older interrupted partial stays.
  const raw = host.files.get(s.id).doc.messages;
  assert.deepEqual(raw.map((m) => m.content), ["q1", "old partial", "q2", "a2", "go", "Hello world"]);
  assert.equal(raw.some((m) => m.content === "half a repl"), false, "the dead turn's partial never stays in the chat file");
  assert.equal(raw[1].metadata.interrupted, true, "an older interrupted partial is history and is not removed");

  // Reload: a fresh store over the same host files (what the app does when the chat is reopened).
  const reloaded = new c.TauriChatStore({ invoke: host.invoke, ready: async () => {}, now: () => 1_800_000_000_000 });
  const ctl2 = make(reloaded, fakeCore());
  await ctl2.open(s.id);
  const view = ctl2.getState(s.id).messages;
  assert.deepEqual(view.map(textOf), ["q1", "old partial", "q2", "a2", "go", "Hello world"]);
  assert.equal(view.filter((m) => m.role === "user").length, 3, "no duplicate bubble for the retried message");
  assert.equal(view.some((m) => m.role === "assistant" && m.interrupted && c.assistantText(m) === "half a repl"), false);
});

test("the host store drops only a trailing interrupted assistant: a user row, a completed reply and a non-trailing seq are no-ops", async () => {
  const { host, store } = await boundStore();
  const s = await store.createSession({ title: "rules" });
  await store.appendMessage(s.id, { role: "user", content: "only user" });
  assert.equal(await store.dropInterruptedMessage(s.id), false, "a user row is never dropped");
  await store.appendMessage(s.id, { role: "assistant", content: "complete" });
  assert.equal(await store.dropInterruptedMessage(s.id), false, "a completed reply is never dropped");
  await store.appendMessage(s.id, { role: "assistant", content: "half", meta: { interrupted: true } });
  const before = host.files.get(s.id).doc.messages.length;
  const wrong = await host.invoke("chat_drop_message", { args: { id: s.id, seq: 2 } });
  assert.equal(wrong.dropped, false, "the host refuses a seq that is not the newest message");
  assert.equal(host.files.get(s.id).doc.messages.length, before);
  assert.equal(await store.dropInterruptedMessage(s.id), true);
  assert.equal(await store.dropInterruptedMessage(s.id), false, "repeating the drop is a no-op (idempotent)");
  const after = await store.loadMessages(s.id, { limit: 100 });
  assert.deepEqual(after.messages.map((m) => m.content), ["only user", "complete"]);
});
