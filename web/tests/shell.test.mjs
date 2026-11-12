import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadUi, h, html } from "./helpers.mjs";

let UI;
before(async () => { UI = await loadUi(); });
const noop = () => {};
const caps = (...c) => new Set(["host", ...c]);

test("hash: sections, sub-pages, aliases and parameters", () => {
  assert.deepEqual({ ...UI.parseHash("#/history") , params: undefined }, { section: "history", sub: null, params: undefined });
  assert.equal(UI.parseHash("#/chat").section, "ask");
  const r = UI.parseHash("#/settings/sources?x=1");
  assert.equal(r.section, "settings"); assert.equal(r.sub, "sources"); assert.equal(r.params.get("x"), "1");
  assert.equal(UI.parseHash("").section, null);
  assert.equal(UI.formatHash("settings", "sources"), "#/settings/sources");
});

test("registry: built-ins are ordered; sections hide when the host lacks the capability; hubs hide local-only ones", () => {
  const ids = (host) => UI.visibleSections(host).map((s) => s.id);
  assert.deepEqual(ids({ capabilities: caps("chat", "approvals", "tool_approvals", "read", "compose"), hub: false }), ["ask", "execute", "tasks", "loop", "history", "settings"]);
  assert.deepEqual(ids({ capabilities: caps("chat"), hub: false }), ["ask", "settings"]);
  assert.deepEqual(ids({ capabilities: caps("chat", "read"), hub: false }), ["ask", "tasks", "loop", "history", "settings"]);
  assert.equal(ids({ capabilities: new Set(), hub: false }).length, 6, "unknown capabilities (not connected yet) show everything");
  UI.registerSection({ id: "zz", label: "ZZ", icon: "plug", order: 95, localOnly: true, component: () => null });
  assert.ok(ids({ capabilities: caps("chat"), hub: false }).includes("zz"));
  assert.ok(!ids({ capabilities: caps("chat"), hub: true }).includes("zz"));
  UI.unregisterSection("zz");
});

test("theme preference: only known values; garbage falls back to system", () => {
  assert.equal(UI.parsePref("midnight"), "midnight");
  assert.equal(UI.parsePref("system"), "system");
  assert.equal(UI.parsePref("neon"), "system");
  assert.equal(UI.parsePref(null), "system");
  assert.equal(UI.resolveTheme("system", "light"), "light");
  assert.equal(UI.resolveTheme("midnight", "light"), "midnight");
  assert.equal(UI.readThemePref(), "system", "no storage: still works");
});

test("connection status pill maps the connection state", () => {
  assert.equal(UI.connStatus({ kind: "ready" }, false), "live");
  assert.equal(UI.connStatus({ kind: "reconnecting", attempt: 1, inMs: 1, unopened: 0 }, false), "reconnecting");
  assert.equal(UI.connStatus({ kind: "reconnecting", attempt: 1, inMs: 1, unopened: 0 }, true), "waiting");
  assert.equal(UI.connStatus({ kind: "failed", code: "internal", message: "x" }, false), "idle");
});

const ctx = (o = {}) => ({
  session: {}, conn: { kind: "ready" }, capabilities: caps("chat", "approvals", "tool_approvals", "read", "compose"), hub: false, hostName: "Desk", hostUrl: "wss://h:1/host-api/v1",
  chat: UI.initialChatState ?? undefined, read: UI.initialReadState, compose: UI.initialComposeState,
  projects: { projects: [], selectedId: null, loading: false, loaded: true, error: null, refusal: null }, push: { kind: "unavailable", error: null },
  offlineLinked: false, navigate: noop, actions: { changeAddress: async () => null, forget: noop, selectProject: noop, openSources: noop }, ...o,
});

test("shell: landmarks, the active tab has aria-current, the desktop name and a live pill", () => {
  const out = html(h(UI.Shell, { ctx: ctx({ chat: UI.reduce(UI.initialChatState, { type: "snapshot", messages: [] }) }), forceSection: "history" }));
  assert.match(out, /<header[^>]*class="shell-header"/);
  assert.match(out, /<main[^>]*id="shell-main"/);
  assert.equal((out.match(/<nav /g) ?? []).length, 2, "sidebar and tab bar");
  assert.match(out, /<a[^>]*aria-current="page"[^>]*>(?:(?!<\/a>).)*History/);
  assert.equal((out.match(/aria-current="page"/g) ?? []).length, 2, "one per nav, only the active section");
  assert.match(out, /Desk/);
  assert.match(out, /Live/);
  assert.match(out, /Auto Tasks/);
});

test("shell: a section the host cannot serve is not in the nav", () => {
  const out = html(h(UI.Shell, { ctx: ctx({ capabilities: caps("chat") }), forceSection: "ask" }));
  assert.doesNotMatch(out, /Auto Tasks|History|Execute/);
  assert.match(out, /Settings/);
});

test("Auto Tasks and Loop render their real screens", () => {
  for (const [id, text] of [["tasks", /Recent runs/], ["loop", /Pick a project/]]) {
    assert.match(html(h(UI.Shell, { ctx: ctx(), forceSection: id })), text);
  }
});

test("settings: theme control, forget, version, sources entry; offline copy only for a linked desktop browser, never on a hub", () => {
  const view = (o) => html(h(UI.SettingsScreen, { ctx: ctx(o) }));
  const base = view();
  assert.match(base, /role="radiogroup"[^>]*aria-label="Theme"/);
  assert.match(base, /Forget this desktop/);
  assert.match(base, /Change address/);
  assert.match(base, /Documents and code/);
  assert.match(base, /LLM-IDE web test/);
  assert.match(base, /Not linked/);
  assert.match(view({ offlineLinked: true, actions: { openOffline: noop, openSources: noop, changeAddress: async () => null, forget: noop } }), /Read the desktop&#x27;s last snapshot/);
  const hub = view({ hub: true });
  assert.doesNotMatch(hub, /Offline copy/);
  assert.match(hub, /always-online hub/);
});

test("chat empty state offers three example prompts; toast host is a live region", () => {
  const out = html(h(UI.WebChat, { connection: { kind: "ready" }, capabilities: caps("chat"), state: UI.initialChatState, onSend: noop, onStop: noop, onClear: noop, onForget: noop, onAnswer: noop, onDecline: noop, onTool: noop }));
  assert.equal((out.match(/class="web-example"/g) ?? []).length, 3);
  assert.match(html(h(UI.ui.ToastHost)), /aria-live="polite"/);
});

test("ui: buttons keep the label first, loading is busy and disabled; the segmented control is a radiogroup", () => {
  const { Button, SegmentedControl, TextField } = UI.ui;
  assert.match(html(h(Button, { variant: "danger" }, "Forget")), />Forget<\/button>/);
  const busy = html(h(Button, { loading: true }, "Save"));
  assert.match(busy, /aria-busy="true"/); assert.match(busy, /disabled=""/);
  const seg = html(h(SegmentedControl, { label: "Theme", value: "b", onChange: noop, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }));
  assert.match(seg, /aria-checked="true"[^>]*>B/); assert.match(seg, /tabindex="-1"/);
  const f = html(h(TextField, { label: "Name", error: "Required", hint: "Hint" }));
  assert.match(f, /aria-invalid="true"/); assert.match(f, /aria-describedby="[^"]+-h [^"]+-e"/); assert.match(f, /role="alert"/);
});
