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

// Minimal DOM stand-ins: a node knows its ancestors, so closest/contains behave like the real thing.
const node = (tagName, { parent = null, attrs = [], editable = false } = {}) => {
  const n = { tagName, parent, attrs, isContentEditable: editable };
  n.contains = (o) => { for (let x = o; x; x = x.parent) if (x === n) return true; return false; };
  n.closest = (sel) => { for (let x = n; x; x = x.parent) if (x.attrs.some((a) => sel.includes(a))) return x; return null; };
  return n;
};
const MODAL = 'aria-modal="true"';

test("Escape aimed at an unrelated dialog or field does not stop the turn", () => {
  const root = node("DIV");
  const inChat = node("TEXTAREA", { parent: root, editable: true });
  const body = node("BODY");
  const dialog = node("DIV", { attrs: [MODAL] });
  const dialogButton = node("BUTTON", { parent: dialog });
  const outsideInput = node("INPUT", { editable: true });
  assert.equal(c.stopsOnEscape(esc({ target: inChat }), true, true, root), true, "the chat's own box");
  assert.equal(c.stopsOnEscape(esc({ target: body }), true, true, root), true, "nothing focused");
  assert.equal(c.stopsOnEscape(esc({ target: dialogButton }), true, true, root), false, "a modal dialog elsewhere");
  assert.equal(c.stopsOnEscape(esc({ target: outsideInput }), true, true, root), false, "a text field outside this surface");
  const alertDialog = node("DIV", { attrs: ['role="alertdialog"'] });
  assert.equal(c.stopsOnEscape(esc({ target: node("BUTTON", { parent: alertDialog }) }), true, true, root), false, "an alertdialog");
  const innerDialog = node("DIV", { parent: root, attrs: ['role="dialog"'] });
  assert.equal(c.stopsOnEscape(esc({ target: node("BUTTON", { parent: innerDialog }) }), true, true, root), true, "the chat's own popover");
});

test("the dictation shortcut applies only where the user is working", () => {
  const root = node("DIV");
  const inChat = node("TEXTAREA", { parent: root, editable: true });
  const outside = node("INPUT", { editable: true });
  const body = node("BODY");
  assert.equal(c.ownsDictationShortcut(inChat, root, false), true, "focus inside the popup");
  assert.equal(c.ownsDictationShortcut(outside, root, true), false, "focus in another field");
  assert.equal(c.ownsDictationShortcut(body, root, true), true, "nothing focused on the Chat section");
  assert.equal(c.ownsDictationShortcut(body, root, false), false, "nothing focused, but this is only a popup");
});

test("Esc with a dialog open outside the chat is the dialog's, even when focus sits on the page body", async () => {
  const c = await (await import("./helpers.mjs")).loadChat("escape-modal");
  const body = { closest: () => null, contains: () => false };
  const ev = { key: "Escape", defaultPrevented: false, target: body };
  assert.equal(c.stopsOnEscape(ev, true, true, null, false), true, "no dialog: Esc stops the turn as before");
  assert.equal(c.stopsOnEscape(ev, true, true, null, true), false, "a shell dialog is open: the turn keeps running");
});
