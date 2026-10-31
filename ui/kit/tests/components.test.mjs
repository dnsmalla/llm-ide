import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KIT, read } from "./helpers.mjs";

let kit;
before(async () => {
  // Bundle next to node_modules so `react` resolves to the kit's own copy.
  const dir = join(KIT, "node_modules/.cache/kit-test");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, "index.mjs");
  await build({ entryPoints: [join(KIT, "src/index.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent" });
  kit = await import(`${outfile}?t=${Date.now()}`);
});

const html = (el) => renderToStaticMarkup(el);

test("StatusBanner: errors are alerts, others are polite status; dismiss has a name", () => {
  const err = html(h(kit.StatusBanner, { severity: "error", message: "boom", onDismiss: () => {} }));
  assert.match(err, /role="alert"/);
  assert.match(err, /aria-label="Dismiss message"/);
  assert.match(html(h(kit.StatusBanner, { severity: "info", message: "fyi" })), /role="status"/);
});

test("StatusBanner escapes its message (no raw HTML)", () => {
  const out = html(h(kit.StatusBanner, { severity: "info", message: "<img src=x onerror=alert(1)>" }));
  assert.ok(!out.includes("<img"));
  assert.match(out, /&lt;img/);
});

test("Chip: a button exposes aria-pressed; a static chip is labelled", () => {
  assert.match(html(h(kit.Chip, { label: "Go", active: true, onClick: () => {} })), /<button[^>]*aria-pressed="true"/);
  assert.match(html(h(kit.Chip, { label: "Tag" })), /aria-label="Tag"/);
});

test("EditorTabBar: tablist, selected state, named close buttons", () => {
  const out = html(h(kit.EditorTabBar, { tabs: [{ id: "a", label: "a.ts", dirty: true }, { id: "b", label: "b.ts" }], activeId: "a", onSelect() {}, onClose() {} }));
  assert.match(out, /role="tablist"/);
  assert.match(out, /aria-selected="true"/);
  assert.match(out, /aria-label="Close a\.ts"/);
  assert.match(out, /aria-label="Unsaved changes"/);
});

test("ResizableDivider: keyboard-focusable separator with value range and a name", () => {
  const out = html(h(kit.ResizableDivider, { width: 300, onWidthChange() {}, label: "Resize sidebar" }));
  assert.match(out, /role="separator"/);
  assert.match(out, /tabindex="0"/);
  assert.match(out, /aria-valuenow="300"/);
  assert.match(out, /aria-label="Resize sidebar"/);
  assert.equal(kit.clampWidth(NaN, 160, 520), 160);
  assert.equal(kit.clampWidth(900, 160, 520), 520);
});

test("ResizableDivider: a right-hand panel (invert) widens when dragged or keyed to the left", () => {
  assert.equal(kit.dragWidth(300, 40, 160, 520), 340);
  assert.equal(kit.dragWidth(300, 40, 160, 520, true), 260);
  assert.equal(kit.dragWidth(300, -900, 160, 520, true), 520, "clamped");
  assert.equal(kit.keyWidth("ArrowRight", 300, 160, 520, 16), 316);
  assert.equal(kit.keyWidth("ArrowLeft", 300, 160, 520, 16), 284);
  assert.equal(kit.keyWidth("ArrowLeft", 300, 160, 520, 16, true), 316);
  assert.equal(kit.keyWidth("ArrowRight", 300, 160, 520, 16, true), 284);
  assert.equal(kit.keyWidth("Home", 300, 160, 520, 16, true), 160);
  assert.equal(kit.keyWidth("End", 300, 160, 520, 16), 520);
  assert.equal(kit.keyWidth("x", 300, 160, 520, 16), null);
  assert.equal(kit.keyWidth("ArrowLeft", Number.NaN, 160, 520, 16), 160, "non-finite snaps to the minimum");
});

test("SectionChromeBar: toolbar whose toggles carry pressed state and a state-specific name", () => {
  const out = html(h(kit.SectionChromeBar, { title: "Files", toggles: [{ id: "t", icon: "i", isOn: true, helpOn: "Hide tree", helpOff: "Show tree", onToggle() {} }] }));
  assert.match(out, /role="toolbar"/);
  assert.match(out, /aria-pressed="true"/);
  assert.match(out, /aria-label="Hide tree"/);
});

test("SettingsSectionCard: header button reports expanded state", () => {
  const out = html(h(kit.SettingsSectionCard, { icon: "g", title: "General", defaultExpanded: true }, "body"));
  assert.match(out, /aria-expanded="true"/);
});

test("icons are decorative unless labelled", () => {
  assert.match(html(h(kit.GraphIcon)), /aria-hidden="true"/);
  const labelled = html(h(kit.Icon, { name: "bell", label: "Notifications" }));
  assert.match(labelled, /role="img"/);
  assert.match(labelled, /aria-label="Notifications"/);
  assert.ok(!/aria-hidden/.test(labelled));
});

test("themes: exported from tokens.json, applyTheme sets data-theme and color-scheme", () => {
  assert.deepEqual(kit.THEMES.map((t) => t.id), ["dark", "light", "midnight"]);
  assert.ok(kit.isThemeId("midnight") && !kit.isThemeId("neon"));
  const root = { dataset: {}, style: {} };
  kit.applyTheme("light", root);
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
  kit.applyTheme("midnight", root);
  assert.equal(root.style.colorScheme, "dark");
});

test("CSS: focus ring and reduced-motion rules exist, and use tokens", () => {
  const css = read("src/styles/components.css");
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--tok-color-accent\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

// The relay's untrusted-output rules (README): the kit must stay safe to render model/relay text.
function sources(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|css)$/.test(f) ? [p] : [];
  });
}
test("no raw-HTML or remote-resource sinks anywhere in the kit source", () => {
  for (const f of sources(join(KIT, "src"))) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
    assert.doesNotMatch(text, /<img\b|<iframe\b|<script\b|<link\b|<object\b|<embed\b/i, f);
    assert.doesNotMatch(text, /url\(\s*['"]?(https?:)?\/\//i, f);
    assert.doesNotMatch(text, /@import\s+(url\()?['"]?(https?:)?\/\//i, f);
  }
});
