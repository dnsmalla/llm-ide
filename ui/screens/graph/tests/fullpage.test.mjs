import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEntry, react, server } from "./helpers.mjs";

let G, h, html;
before(async () => {
  G = await loadEntry();
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(HERE, "..", f), "utf8");

test("full page: the canvas sits in a modal dialog with a labelled close button and no other chrome", () => {
  const out = html(h(G.FullPageGraph, { onClose: () => {} }, h("div", { "data-testid": "canvas-stub" })));
  assert.match(out, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Code graph, full page"/);
  assert.match(out, /aria-label="Close full-page graph"/);
  assert.match(out, /title="Close full-page graph \(Esc\)"/);
  assert.match(out, /data-testid="canvas-stub"/);
  assert.doesNotMatch(out, /Nodes|Search nodes|Quick Pick/);
});

test("full page: Escape closes it in the capture phase, so the canvas's own Escape does not also fire", () => {
  const code = src("FullPage.tsx");
  assert.match(code, /window\.addEventListener\("keydown", onKey, true\)/);
  assert.match(code, /e\.key !== "Escape"/);
  assert.match(code, /e\.stopPropagation\(\)/);
  assert.match(code, /window\.removeEventListener\("keydown", onKey, true\)/);
});

test("screen: the toolbar expands to full page; the old OS full-screen toggle is gone", () => {
  const code = src("GraphScreen.tsx");
  assert.match(code, /aria-label="Expand graph to full page"/);
  assert.doesNotMatch(code, /requestFullscreen|exitFullscreen/);
  assert.match(code, /if \(fullPage\) \{[\s\S]*<FullPageGraph onClose=\{closeFullPage\} active=\{active\}>[\s\S]*<GraphCanvas/);
});

test("full page: Escape is taken only when aimed at the overlay or at the body, never at another dialog or section", () => {
  const inside = { id: "canvas" }, elsewhere = { id: "palette-input" };
  const overlay = { contains: (n) => n === inside };
  const doc = { body: { id: "body" }, documentElement: { id: "html" } };
  assert.equal(G.escapeIsOurs(inside, overlay, doc), true);
  assert.equal(G.escapeIsOurs(doc.body, overlay, doc), true);
  assert.equal(G.escapeIsOurs(null, overlay, doc), true);
  assert.equal(G.escapeIsOurs(elsewhere, overlay, doc), false);
  assert.equal(G.escapeIsOurs(inside, null, doc), false);
});

test("full page: the listener exists only while the section is shown, and closing returns focus to the expand button", () => {
  const code = src("FullPage.tsx");
  assert.match(code, /if \(!active\) return;/);
  assert.match(code, /escapeIsOurs\(e\.target/);
  const screen = src("GraphScreen.tsx");
  assert.match(screen, /<FullPageGraph onClose=\{closeFullPage\} active=\{active\}>/);
  assert.match(screen, /wasFull\.current && !fullPage\) expandBtn\.current\?\.focus\(\)/);
  assert.match(screen, /ref=\{expandBtn\}/);
});
