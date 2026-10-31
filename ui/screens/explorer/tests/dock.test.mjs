import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPLORER, load, React, renderToStaticMarkup } from "./helpers.mjs";
import { makeFs } from "./fakes.mjs";

const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const m = await load("dock-model.ts");
const { ExplorerScreen } = await load("ExplorerScreen.tsx");

const mem = (init = {}) => ({ d: { ...init }, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } });
const hostile = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };

test("dock width: clamped to [300, 720], leaves the editor 320px, junk becomes the default", () => {
  assert.equal(m.clampDockWidth(400, 1600, 280), 400);
  assert.equal(m.clampDockWidth(50, 1600, 280), m.DOCK_MIN);
  assert.equal(m.clampDockWidth(5000, 4000, 280), m.DOCK_MAX);
  assert.equal(m.clampDockWidth(700, 1000, 280), 400, "1000 - 280 tree - 320 editor = 400 for the dock");
  for (const bad of [Number.NaN, Infinity, -Infinity, "400", null, undefined, {}, [] ]) assert.equal(m.clampDockWidth(bad, 1600, 280), m.DOCK_DEFAULT);
  assert.equal(m.clampDockWidth(400, Number.NaN, 280), 400, "unknown viewport: no layout clamp, still within [MIN, MAX]");
  assert.equal(m.clampDockWidth(400.4, 1600, 280), 400, "whole pixels");
  assert.ok(m.dockFits(1600, 280));
  assert.ok(!m.dockFits(800, 280), "too narrow: the dock is hidden, not squeezed");
  assert.ok(!m.dockFits(Number.NaN, 280));
  assert.ok(m.dockFits(m.DOCK_MIN + m.MIN_CENTER + 280, 280), "exact fit");
});

test("dock prefs: default open at 400; stored values are validated; hostile storage never throws", () => {
  assert.deepEqual(m.readDockPrefs(null), { open: true, width: 400 });
  assert.deepEqual(m.readDockPrefs(mem()), { open: true, width: 400 });
  const kv = mem();
  m.writeDockPrefs(kv, { open: false, width: 520 });
  assert.deepEqual(m.readDockPrefs(kv), { open: false, width: 520 });
  assert.equal(kv.d[m.DOCK_KEY], '{"open":false,"width":520}');
  for (const raw of ["", "not json", "[]", "null", "7", '{"open":"yes","width":"wide"}', '{"width":1e999}', "x".repeat(500), '{"open":false,"width":-5}', '{"open":false,"width":99999}']) {
    const p = m.parseDockPrefs(raw);
    assert.equal(typeof p.open, "boolean", raw.slice(0, 20));
    assert.ok(p.width >= m.DOCK_MIN && p.width <= m.DOCK_MAX, `${raw.slice(0, 20)} -> ${p.width}`);
  }
  assert.deepEqual(m.parseDockPrefs('{"open":false,"width":-5}'), { open: false, width: m.DOCK_MIN });
  assert.deepEqual(m.parseDockPrefs('{"open":false,"width":99999}'), { open: false, width: m.DOCK_MAX });
  assert.deepEqual(m.parseDockPrefs('{"open":"yes"}'), { open: true, width: 400 });
  assert.deepEqual(m.readDockPrefs(hostile), { open: true, width: 400 });
  assert.doesNotThrow(() => m.writeDockPrefs(hostile, { open: true, width: 400 }));
  assert.doesNotThrow(() => m.writeDockPrefs(null, { open: true, width: 400 }));
  const prototype = m.parseDockPrefs('{"__proto__":{"open":false},"open":true}');
  assert.equal(prototype.open, true);
});

const screen = (kv, extra = {}) => html(h(ExplorerScreen, { active: true, projectRoot: "/Users/me/proj", deps: { fs: makeFs({ "a.txt": "x" }), kv, loadEditor: () => Promise.reject(new Error("x")), ...extra } }));

test("Explorer layout: tree panel (switcher), editor tabs, and the docked Code Assistant with resize and toggle", () => {
  const out = screen(null);
  assert.match(out, /<aside[^>]*aria-label="Side panel"/);
  assert.match(out, /role="tablist"[^>]*aria-label="Side panel"/);
  for (const l of ["Explorer", "Search", "Source Control"]) assert.match(out, new RegExp(`>${l}<`));
  assert.match(out, /<aside id="ex-chat-dock" class="ex-chat" style="width:400px" aria-label="Code Assistant"/);
  assert.match(out, /role="separator"[^>]*aria-orientation="vertical"[^>]*aria-label="Resize Code Assistant"[^>]*aria-valuenow="400"[^>]*aria-valuemin="300"[^>]*aria-valuemax="720"/);
  assert.match(out, /aria-expanded="true"[^>]*aria-controls="ex-chat-dock"/);
  assert.match(out, /Code Assistant<\/button>/);
  assert.ok(out.indexOf('aria-label="Code Assistant"') > out.indexOf('class="ex-main"'), "the dock is right of the editor column");
  assert.match(out, /not available in this build/, "no seam installed (node): a visible note, never an empty column");
});

test("Explorer dock: remembered closed state hides it; a remembered width is used; hostile storage falls back", () => {
  const closed = screen(mem({ [m.DOCK_KEY]: '{"open":false,"width":500}' }));
  assert.doesNotMatch(closed, /id="ex-chat-dock"/);
  assert.match(closed, /aria-expanded="false"[^>]*aria-controls="ex-chat-dock"/);
  assert.match(screen(mem({ [m.DOCK_KEY]: '{"open":true,"width":560}' })), /style="width:560px" aria-label="Code Assistant"/);
  assert.match(screen(mem({ [m.DOCK_KEY]: '{"open":true,"width":"<script>"}' })), /style="width:400px" aria-label="Code Assistant"/);
  assert.match(screen(hostile), /id="ex-chat-dock"/);
});

test("No project: the Explorer shows the shared card and no dock", () => {
  const out = html(h(ExplorerScreen, { active: true, projectRoot: null }));
  assert.doesNotMatch(out, /Code Assistant/);
});

test("module boundary: Explorer reaches Chat only through the shell's chat-dock seam", () => {
  const files = readdirSync(EXPLORER, { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(String(f)) && !String(f).includes("tests"));
  for (const f of files) {
    const src = readFileSync(join(EXPLORER, String(f)), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/from\s+["'](\.\.\/)+chat\b|@llmide\/screens\/chat/.test(src), `${f} imports the Chat screen directly`);
  }
  assert.match(readFileSync(join(EXPLORER, "ExplorerScreen.tsx"), "utf8"), /from "\.\.\/shell\/chat-dock"/);
});
