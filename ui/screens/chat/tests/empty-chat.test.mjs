// An empty chat mirrors the Mac's emptyState: title, one line, four suggestions that fill (never send) the composer.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("empty-chat"); });

test("the empty state has the Mac's title, line and four suggestions", () => {
  const out = html(h(c.EmptyChat, { onPick: () => {} }));
  assert.match(out, /<h3 class="chat-empty-title">Code Assistant<\/h3>/);
  assert.match(out, /Attach context with the buttons below, then describe what you want\./);
  assert.deepEqual([...c.EMPTY_SUGGESTIONS], ["Review for bugs", "Refactor for readability", "Add unit tests", "Explain this code"]);
  for (const s of c.EMPTY_SUGGESTIONS) assert.match(out, new RegExp(`<button type="button" class="chat-suggestion">${s}</button>`));
});

test("a suggestion fills the draft through the controller's view and re-mounts the composer; it does not send", () => {
  const screen = readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8");
  assert.match(screen, /empty=\{<EmptyChat onPick=\{\(text\) => \{ controller\.setView\(activeId, \{ draft: text \}\); setRefineNonce\(\(n\) => n \+ 1\); \}\} \/>\}/);
});

test("the composer's empty-field prompt is the Mac's", () => {
  assert.equal(c.COMPOSER_PLACEHOLDER, "Ask Claude about the attached code…");
  const noop = () => {};
  const out = html(h(c.Composer, { draft: "", onDraft: noop, busy: false, aborting: false, queue: [], history: [], onSend: noop, onStop: noop, onDropQueued: noop }));
  assert.match(out, /placeholder="Ask Claude about the attached code…"/);
});
