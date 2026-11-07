// Esc stops the running turn from anywhere on the chat surface, as the Mac's Stop (.cancelAction) did.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("escape-stop"); });
const esc = (o = {}) => ({ key: "Escape", defaultPrevented: false, isComposing: false, ...o });

test("only a fresh Escape on the active surface during a turn stops it", () => {
  assert.equal(c.stopsOnEscape(esc(), true, true), true);
  assert.equal(c.stopsOnEscape(esc(), false, true), false, "another section is on screen");
  assert.equal(c.stopsOnEscape(esc(), true, false), false, "nothing is running");
  assert.equal(c.stopsOnEscape(esc({ defaultPrevented: true }), true, true), false, "the textarea or a popover already handled it");
  assert.equal(c.stopsOnEscape(esc({ isComposing: true }), true, true), false, "an input method owns the key");
  assert.equal(c.stopsOnEscape(esc({ key: "Enter" }), true, true), false);
});

test("the listener is bound only while active and busy, and removed after", () => {
  // Windows checkouts may use CRLF, so the two-line assertion below runs on normalized line endings.
  const src = readFileSync(join(CHAT, "Composer.tsx"), "utf8").replace(/\r/g, "");
  assert.match(src, /if \(!p\.active \|\| !p\.busy\) return undefined;/);
  assert.match(src, /return \(\) => window\.removeEventListener\("keydown", onKey\);\n  \}, \[p\.active, p\.busy\]\);/);
});
