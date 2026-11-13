// Each reply names the model that answered it: the engine's `init.model`, kept in history so a reloaded chat shows it.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("model-badge"); });
const ev = (type, o = {}) => c.decodeEvent({ type, ...o }).event;

test("init stamps the running reply with the model that answered (a Claude CLI-login turn included)", () => {
  let s = c.reduce(c.initialState("c1"), { type: "send", id: "t1", text: "hi" });
  s = c.reduce(s, { type: "events", events: [ev("init", { sessionId: "sdk-1", model: "claude-opus-5-5", tools: [], capabilities: [] }), ev("delta", { text: "ok" })] });
  assert.equal(s.messages.at(-1).model, "claude-opus-5-5");
  assert.equal(s.model, "claude-opus-5-5");
});

test("a reply renders a model badge beside its mode; no model, no badge", () => {
  const m = { role: "assistant", id: "a1", parts: [], notices: [], status: "done", mode: "execute", model: "claude-opus-5-5" };
  assert.match(html(h(c.MessageView, { m, host: {} })), /<span class="chat-badge chat-model-badge" aria-label="Model: claude-opus-5-5" title="Answered by claude-opus-5-5">claude-opus-5-5<\/span>/);
  assert.doesNotMatch(html(h(c.MessageView, { m: { ...m, model: undefined }, host: {} })), /chat-model-badge/);
});

test("the model survives the desktop chat file and the core's history", () => {
  const file = c.toFileMessage({ role: "assistant", content: "x", meta: { mode: "execute", model: "claude-opus-5-5" } }, 0);
  assert.equal(file.metadata.model, "claude-opus-5-5");
  const row = c.fromFileMessage(file, 0);
  assert.equal(row.meta.model, "claude-opus-5-5");
  assert.equal(c.toMessages([row])[0].model, "claude-opus-5-5");
  assert.equal(c.toMessages([{ seq: 1, role: "assistant", content: "x", meta: { model: "glm-5" }, createdAt: 0 }])[0].model, "glm-5", "core history (meta stored verbatim)");
  assert.equal(c.toMessages([{ seq: 1, role: "assistant", content: "x", meta: null, createdAt: 0 }])[0].model, undefined);
});
