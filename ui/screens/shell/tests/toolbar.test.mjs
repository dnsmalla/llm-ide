import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SHELL, load, React, renderToStaticMarkup } from "./helpers.mjs";

const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const REPO = resolve(SHELL, "../../..");
const MAC = join(REPO, "mac/Sources/LlmIdeMac");

const tb = await load("toolbar-model.ts");
const nav = await load("sections.ts");
const plat = await load("platform.ts");
const { SectionToolbar } = await load("Toolbar.tsx");
const { accountMenuItems, SignOutDialog, AccountMenu, SIGN_OUT_TITLE, SIGN_OUT_BODY } = await load("AccountMenu.tsx");

// ---- drift against the Mac source -------------------------------------------------------------------------------

/** `ShellSection.toolbarOrder` case names, parsed from the Swift source (like scripts/extract-settings-groups.mjs). */
function macToolbarOrder() {
  const src = readFileSync(join(MAC, "Core/Contracts/ShellSection.swift"), "utf8");
  const m = /static let toolbarOrder: \[ShellSection\] = \[([\s\S]*?)\]/.exec(src);
  assert.ok(m, "toolbarOrder not found in ShellSection.swift (the parser needs updating)");
  return [...m[1].matchAll(/\.(\w+)/g)].map((x) => x[1]);
}

function macLabels() {
  const src = readFileSync(join(MAC, "Core/Contracts/ShellSection.swift"), "utf8");
  const body = /var label: String \{([\s\S]*?)\n    \}/.exec(src)[1];
  return new Map([...body.matchAll(/case \.(\w+):\s*return "([^"]+)"/g)].map((x) => [x[1], x[2]]));
}

test("toolbar order equals the Mac's ShellSection.toolbarOrder (Live aside: no desktop live capture)", () => {
  const order = macToolbarOrder();
  assert.ok(order.length >= 10);
  for (const c of order) assert.ok(Object.hasOwn(tb.MAC_CASE_TO_ID, c), `Mac toolbar item "${c}" has no desktop mapping: add it to MAC_CASE_TO_ID`);
  const expected = order.map((c) => tb.MAC_CASE_TO_ID[c]).filter((id) => id !== null);
  assert.deepEqual([...tb.TOOLBAR_IDS], expected);
  assert.deepEqual(tb.toolbarSections(false).map((d) => d.id), expected);
  assert.equal(tb.toolbarSections(true).at(-1).id, "spike", "developer tools append Spike");
  assert.equal(tb.toolbarSections(true).length, expected.length + 1);
});

test("toolbar labels equal the Mac's section labels", () => {
  const labels = macLabels();
  for (const [mac, id] of Object.entries(tb.MAC_CASE_TO_ID)) {
    if (id === null) continue;
    assert.equal(nav.SECTIONS.find((s) => s.id === id).label, labels.get(mac), `label of ${mac}`);
  }
});

test("account menu rows and the sign-out dialog use the Mac's wording and order", () => {
  const src = readFileSync(join(MAC, "Shell/Chrome/HeaderAccountMenu.swift"), "utf8");
  const macRows = [...src.matchAll(/Label\("([^"]+)", systemImage/g)].map((m) => m[1]);
  const macSignOut = /Button\("Sign out", role: \.destructive\)/.test(src);
  assert.deepEqual(macRows, ["Settings…", "Help & Guide", "Permissions…"]);
  assert.ok(macSignOut);
  assert.ok(src.includes(`"${SIGN_OUT_TITLE}"`), "dialog title drifted from the Mac");
  const noop = () => {};
  const items = accountMenuItems({ id: "1", email: "a@b.c", displayName: "Ada" }, { openSettings: noop, openHelp: noop, openPermissions: noop, askSignOut: noop }, true);
  const actions = items.filter((i) => !("kind" in i)).map((i) => i.label);
  assert.deepEqual(actions, [...macRows, "Sign out"]);
  assert.deepEqual(items.map((i) => i.id), ["name", "email", "sep1", "settings", "help", "permissions", "sep2", "signout"]);
  assert.equal(items.find((i) => i.id === "settings").hint, "⌘,");
  assert.equal(accountMenuItems({ id: "1", email: "a@b.c", displayName: null }, { openSettings: noop, openHelp: noop, openPermissions: noop, askSignOut: noop }, false)[0].label, "a@b.c", "no display name: the email");
});

test("account text is untrusted: control and bidi characters are stripped, length capped", () => {
  const noop = () => {};
  const evil = "Eve‮<b>x</b>\u0000" + "y".repeat(300);
  const items = accountMenuItems({ id: "1", email: "e@x.y", displayName: evil }, { openSettings: noop, openHelp: noop, openPermissions: noop, askSignOut: noop }, true);
  assert.ok(!/[‮\u0000]/.test(items[0].label));
  assert.ok(Array.from(items[0].label).length <= 80);
  const out = html(h(AccountMenu, { user: { id: "1", email: "e@x.y", displayName: evil }, actions: { openSettings: noop, openHelp: noop, openPermissions: noop, signOut: async () => {} }, mac: true }));
  assert.ok(!out.includes("<b>x"), "rendered as text");
  assert.equal(html(h(AccountMenu, { user: null, actions: {}, mac: true })), "", "nothing while signed out");
});

// ---- roving focus ------------------------------------------------------------------------------------------------

test("toolbar keys: horizontal arrows wrap, Home/End jump, anything else is ignored", () => {
  assert.equal(tb.toolbarKeyTarget("ArrowRight", 4, 5), 0);
  assert.equal(tb.toolbarKeyTarget("ArrowLeft", 0, 5), 4);
  assert.equal(tb.toolbarKeyTarget("Home", 3, 5), 0);
  assert.equal(tb.toolbarKeyTarget("End", 1, 5), 4);
  assert.equal(tb.toolbarKeyTarget("ArrowDown", 1, 5), null, "vertical keys are for menus");
  assert.equal(tb.toolbarKeyTarget("Enter", 1, 5), null);
  assert.equal(tb.toolbarKeyTarget("ArrowRight", 0, 0), null, "empty toolbar");
});

test("roving stop: the active item when focusable, else the first, else none", () => {
  assert.equal(tb.rovingStop(["explorer", "graph"], "graph"), "graph");
  assert.equal(tb.rovingStop(["explorer", "graph"], "chat"), "explorer", "the active section is not in the toolbar");
  assert.equal(tb.rovingStop(["explorer", "graph"], "issues"), "explorer", "disabled items are not focusable");
  assert.equal(tb.rovingStop([], "explorer"), null);
  assert.equal(tb.rovingStop(["a"], null), "a");
});

// ---- overflow ----------------------------------------------------------------------------------------------------

test("overflow partition: everything fits, prefix + More, active item pinned, hostile numbers", () => {
  const w = [100, 100, 100, 100, 100];
  assert.deepEqual(tb.partitionToolbar(w, 1000, 80, 2, -1), { visible: [0, 1, 2, 3, 4], overflow: [] });
  assert.deepEqual(tb.partitionToolbar(w, 510, 80, 2, -1), { visible: [0, 1, 2, 3, 4], overflow: [] }, "exact fit: no More button");
  // 5 x 100 + 4 x 2 = 508 > 400: budget = 400 - 80 - 2 = 318 -> three items (100+2+100+2+100 = 304)
  assert.deepEqual(tb.partitionToolbar(w, 400, 80, 2, -1), { visible: [0, 1, 2], overflow: [3, 4] });
  // The active item (index 4) must stay visible: it replaces the last prefix item(s) that no longer fit with it.
  const pinned = tb.partitionToolbar(w, 400, 80, 2, 4);
  assert.deepEqual(pinned.visible, [0, 1, 4]);
  assert.deepEqual(pinned.overflow, [2, 3]);
  assert.ok(pinned.visible.includes(4));
  // A window narrower than one button: only the pinned item is shown.
  assert.deepEqual(tb.partitionToolbar(w, 10, 80, 2, 2), { visible: [2], overflow: [0, 1, 3, 4] });
  assert.deepEqual(tb.partitionToolbar(w, 10, 80, 2, -1), { visible: [], overflow: [0, 1, 2, 3, 4] });
  // Hostile input never throws and never loses an index.
  for (const bad of [Number.NaN, -5, Infinity, -Infinity]) {
    const p = tb.partitionToolbar([100, Number.NaN, -1, 100], bad, bad, bad, 99);
    assert.deepEqual([...p.visible, ...p.overflow].sort((a, b) => a - b), [0, 1, 2, 3]);
  }
  assert.deepEqual(tb.partitionToolbar([], 100, 80, 2), { visible: [], overflow: [] });
  assert.ok(tb.samePartition({ visible: [0], overflow: [1, 2] }, { visible: [0], overflow: [1, 2] }));
  assert.ok(!tb.samePartition({ visible: [0], overflow: [1] }, { visible: [], overflow: [0, 1] }));
  assert.ok(tb.estimateWidth("Review Conflicts") > tb.estimateWidth("Loop"));
});

// ---- platform ----------------------------------------------------------------------------------------------------

test("platform: host token decode, navigator guess, overlay only on the macOS desktop app", () => {
  assert.equal(plat.decodePlatform("macos"), "macos");
  assert.equal(plat.decodePlatform("windows"), "windows");
  assert.equal(plat.decodePlatform("linux"), "linux");
  assert.equal(plat.decodePlatform("darwin"), "other", "only the host's fixed tokens");
  assert.equal(plat.decodePlatform({ os: "macos" }), "other");
  assert.equal(plat.decodePlatform(null), "other");
  assert.equal(plat.guessPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" }), "macos");
  assert.equal(plat.guessPlatform({ platform: "Win32" }), "windows");
  assert.equal(plat.guessPlatform({ userAgent: "X11; Linux x86_64" }), "linux");
  assert.equal(plat.guessPlatform(null), "other");
  assert.equal(plat.guessPlatform({ platform: 5, userAgent: {} }), "other");
  assert.ok(plat.hasOverlayTitlebar("macos", true));
  assert.ok(!plat.hasOverlayTitlebar("macos", false), "a browser tab on a Mac has no traffic lights");
  assert.ok(!plat.hasOverlayTitlebar("windows", true));
  assert.ok(!plat.hasOverlayTitlebar("linux", true));
  assert.equal(plat.TRAFFIC_LIGHT_INSET_PX, 78);
});

test("the CSS inset is macOS-only and matches the documented 78px", () => {
  const css = readFileSync(join(SHELL, "shell.css"), "utf8");
  assert.match(css, /\.sh-app\[data-overlay-titlebar\] \.sh-titlebar \{ padding-left: 78px; \}/);
  const base = /\.sh-titlebar \{[^}]*\}/.exec(css)[0];
  assert.doesNotMatch(base, /78px/, "the default title bar has no traffic-light inset");
});

test("window chrome config: overlay title bar on, drag permission granted, no broader window permission", () => {
  const conf = JSON.parse(readFileSync(join(REPO, "desktop/src-tauri/tauri.conf.json"), "utf8"));
  const win = conf.app.windows[0];
  assert.equal(win.titleBarStyle, "Overlay");
  assert.equal(win.hiddenTitle, true);
  const cap = JSON.parse(readFileSync(join(REPO, "desktop/src-tauri/capabilities/default.json"), "utf8"));
  assert.ok(cap.permissions.includes("core:window:allow-start-dragging"));
  assert.ok(cap.permissions.includes("allow-host-platform"));
  assert.ok(!cap.permissions.some((p) => /^core:window:(?!allow-(start-dragging|toggle-maximize|internal-toggle-maximize))/.test(p)));
});

// ---- markup ------------------------------------------------------------------------------------------------------

test("toolbar markup: role=toolbar, aria-current on the active item, disabled items announced, one tab stop", () => {
  nav.setDevTools(false);
  const out = html(h(SectionToolbar, { active: "library", onSelect() {}, devTools: false }));
  assert.match(out, /role="toolbar"[^>]*aria-label="Sections"[^>]*aria-orientation="horizontal"/);
  assert.match(out, /data-tauri-drag-region/);
  const labels = [...out.matchAll(/<span class="sh-tool-label">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Explorer", "Graph", "Auto Tasks", "Review Conflicts", "Issues", "Gantt", "Loop", "Doc Gen", "Visual", "Library"]);
  assert.equal((out.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(out, /aria-current="page"[^>]*data-tb-id="library"|data-tb-id="library"[^>]*aria-current="page"/);
  assert.equal((out.match(/tabindex="0"/g) ?? []).length, 1, "exactly one tab stop");
  assert.match(out, /data-tb-id="library"[^>]*tabindex="0"/);
  for (const id of ["autotasks", "conflicts", "issues", "gantt", "loop"]) assert.match(out, new RegExp(`aria-disabled="true"[^>]*data-tb-id="${id}"|data-tb-id="${id}"[^>]*aria-disabled="true"`));
  assert.equal((out.match(/Soon/g) ?? []).length, 5);
  assert.doesNotMatch(out, /Spike/);
  assert.match(html(h(SectionToolbar, { active: "welcome", onSelect() {}, devTools: true })), /Spike/);
  // Active section outside the toolbar (Home, Chat, Settings): the first enabled item is the tab stop.
  const home = html(h(SectionToolbar, { active: "chat", onSelect() {}, devTools: false }));
  assert.equal((home.match(/aria-current="page"/g) ?? []).length, 0);
  assert.match(home, /data-tb-id="explorer"[^>]*tabindex="0"/);
});

test("sign-out dialog: alert dialog with Cancel first, text from the Mac wording", () => {
  const out = html(h(SignOutDialog, { onCancel() {}, onConfirm() {} }));
  assert.match(out, /role="alertdialog"[^>]*aria-modal="true"/);
  assert.match(out, /aria-labelledby="sh-signout-title"/);
  assert.ok(out.includes(SIGN_OUT_TITLE) && out.includes(SIGN_OUT_BODY));
  assert.ok(out.indexOf("Cancel") < out.indexOf(">Sign out<"), "Cancel precedes the destructive action");
});

test("Settings > General developer-tools switch: the adapter exposes it only when wired, and it drives Spike", async () => {
  const { createSettingsEnv } = await load("settings-adapter.ts");
  const base = { core: {}, coreStatus: () => null, invoke: async () => null, hostAvailable: () => false, activeProjectRoot: () => null, theme: { get: () => "dark", set() {} }, appVersion: () => "t", platform: () => "x", clipboard: () => null };
  assert.equal(createSettingsEnv(base).host.getDevTools, undefined, "not wired: no switch");
  nav.setDevTools(false);
  const env = createSettingsEnv({ ...base, devTools: { get: nav.devToolsEnabled, set: nav.setDevTools } });
  assert.equal(env.host.getDevTools(), false);
  env.host.setDevTools(true);
  assert.equal(env.host.getDevTools(), true);
  assert.equal(tb.toolbarSections(nav.devToolsEnabled()).at(-1).id, "spike", "the toolbar follows the flag");
  env.host.setDevTools(false);
  assert.equal(nav.devToolsEnabled(), false);
  assert.equal(tb.toolbarSections(nav.devToolsEnabled()).some((d) => d.id === "spike"), false);
});
