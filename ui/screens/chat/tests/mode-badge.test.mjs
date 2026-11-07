// Each reply names the mode it ran in (the Mac's ModeBadge above an assistant turn), reusing badges/Badges.tsx.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("mode-badge"); });
const ev = (type, o = {}) => c.decodeEvent({ type, ...o }).event;

test("mode_set stamps the running reply with its mode", () => {
  let s = c.reduce(c.initialState("c1"), { type: "send", id: "t1", text: "plan it" });
  s = c.reduce(s, { type: "events", events: [ev("mode_set", { mode: "plan" }), ev("delta", { text: "ok" })] });
  assert.equal(s.messages.at(-1).mode, "plan");
  assert.equal(s.resolvedMode, "plan");
});

test("an assistant reply renders its mode badge after the role label; a reply without a mode shows none", () => {
  const m = { role: "assistant", id: "a1", parts: [], notices: [], status: "done", mode: "review" };
  assert.match(html(h(c.MessageView, { m, host: {} })), /llm-agent<\/span><span class="chat-badge" data-mode="review" aria-label="Mode: Code Review">Code Review<\/span>/);
  assert.doesNotMatch(html(h(c.MessageView, { m: { ...m, mode: undefined }, host: {} })), /chat-badge/);
});

test("Auto and Execute badges are muted, as on the Mac", () => {
  assert.match(readFileSync(join(CHAT, "chat.css"), "utf8"), /\.chat-assistant > \.chat-badge:is\(\[data-mode="auto"\], \[data-mode="execute"\]\)/);
});
