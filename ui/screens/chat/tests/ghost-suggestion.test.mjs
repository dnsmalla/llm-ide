// The Mac's ghost prediction: the newest sent prompt that extends the draft; Tab accepts it, Esc hides it for this draft.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("ghost-suggestion"); });
const noop = () => {};

test("promptSuggestion: newest extending prompt; none for an empty draft, while recalling, or for an exact repeat", () => {
  const hist = ["fix the login bug", "fix the build", "explain"];
  assert.equal(c.promptSuggestion("fix the", hist, false), "fix the build", "the newest match wins");
  assert.equal(c.promptSuggestion("fix the l", hist, false), "fix the login bug");
  assert.equal(c.promptSuggestion("", hist, false), null);
  assert.equal(c.promptSuggestion("fix the", hist, true), null);
  assert.equal(c.promptSuggestion("explain", hist, false), null, "the draft already is that prompt");
  assert.equal(c.promptSuggestion("zzz", hist, false), null);
});

test("the composer shows the prediction above its bar", () => {
  const out = html(h(c.Composer, { draft: "fix the", onDraft: noop, busy: false, aborting: false, queue: [], history: ["fix the build"], onSend: noop, onStop: noop, onDropQueued: noop }));
  assert.match(out, /<p class="chat-muted chat-ghost" role="status">Tab: fix the build<\/p>/);
});

test("Tab accepts after the slash menu had its turn; Esc hides it only while idle (Stop wins during a turn)", () => {
  const src = readFileSync(join(CHAT, "Composer.tsx"), "utf8");
  const menu = src.indexOf("if (p.extras?.onKeyDown(e)) return;");
  const tab = src.indexOf('if (e.key === "Tab" && !e.shiftKey && ghost) { e.preventDefault(); p.onDraft(ghost); return; }');
  const esc = src.indexOf('if (e.key === "Escape" && ghost && !p.busy) { e.preventDefault(); setGhostOffFor(p.draft); return; }');
  assert.ok(menu >= 0 && tab > menu && esc > tab);
});
