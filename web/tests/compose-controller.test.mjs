import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposeController, initialComposeState } from "../src/chat/compose.ts";
function fakeLink(results = {}, caps = ["host", "chat", "compose"]) {
  const ls = { event: new Set(), resync: new Set(), state: new Set() }; const calls = [];
  return { capabilities: new Set(caps), calls,
    send(command, payload) { calls.push({ command, payload }); const r = results[command]; return { id: `c-${calls.length}`, done: r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? {}) }; },
    onEvent: (fn) => (ls.event.add(fn), () => ls.event.delete(fn)), onResync: (fn) => (ls.resync.add(fn), () => ls.resync.delete(fn)),
    onState: (fn) => (ls.state.add(fn), () => ls.state.delete(fn)), resync: () => ls.resync.forEach((fn) => fn()) };
}
const OPTIONS = { modes: ["auto", "ask", "plan"], models: [{ model: "claude-sonnet-5-5", label: "Sonnet 5.5" }] };
const file = (text, name = "a.md") => new File([text], name, { type: "text/markdown" });
test("without compose: no chat.options, no mode or model in extras, attachments still allowed", async () => {
  const link = fakeLink({}, ["host", "chat"]); const c = createComposeController(link); await c.load();
  assert.equal(link.calls.length, 0); c.setMode("plan"); c.setModel("claude-sonnet-5-5"); await c.addFiles([file("x")]);
  assert.deepEqual(c.extras(), { attachments: [{ name: "a.md", text: "x" }] });
});
test("with compose: options load on resync; only offered modes and models can be picked", async () => {
  const link = fakeLink({ "chat.options": OPTIONS }); const c = createComposeController(link); link.resync(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(c.getState().modes, ["auto", "ask", "plan"]); c.setMode("execute"); assert.equal(c.getState().mode, "auto"); c.setMode("plan");
  c.setModel("claude-opus-9"); assert.equal(c.getState().model, null); c.setModel("claude-sonnet-5-5");
  assert.deepEqual(c.extras(), { mode: "plan", model: "claude-sonnet-5-5" }); c.setMode("auto"); c.setModel(""); assert.deepEqual(c.extras(), {});
});
test("attachments: capped at 10, refused files show a reason, remove and clear work", async () => {
  const c = createComposeController(fakeLink({ "chat.options": OPTIONS }));
  await c.addFiles(Array.from({ length: 12 }, (_, i) => file(`t${i}`, `f${i}.md`)));
  assert.equal(c.getState().attachments.length, 10); assert.match(c.getState().error, /10 files/);
  await c.addFiles([new File(["x"], "a.png", { type: "image/png" })]); assert.match(c.getState().error, /images/);
  c.remove(0); assert.equal(c.getState().attachments[0].name, "f1.md"); c.clearAttachments(); assert.deepEqual(c.getState().attachments, []); assert.equal(c.getState().error, null);
});
test("an options error is shown and the picks fall back to the defaults", async () => {
  const c = createComposeController(fakeLink({ "chat.options": new Error("This device was not granted compose — pair again to grant it.") }));
  await c.load(); assert.match(c.getState().error, /pair again/); assert.equal(c.getState().mode, initialComposeState.mode);
});
