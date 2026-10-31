import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";
import { makeFs, makeEditor, settle } from "./fakes.mjs";

const h = React.createElement;
const text = await load("terminal/text.ts");
const mgr = await load("terminal/manager.ts");
const { TerminalDock, clampDock, DOCK_MIN, DOCK_MAX } = await load("terminal/TerminalDock.tsx");
const { ExplorerController } = await load("controller.ts");
const { ExplorerScreen } = await load("ExplorerScreen.tsx");

const status = (o = {}) => ({ enabled: true, consent: "unasked", shell: "zsh", ...o });

function fakeHost(opts = {}) {
  const host = { spawns: 0, kills: [], acks: [], writes: [], consent: opts.consent ?? "unasked", enabled: opts.enabled ?? true, retryError: null, refuse: opts.refuse ?? false, handles: [] };
  const st = () => ({ enabled: host.enabled, consent: host.consent, shell: "zsh" });
  host.status = async () => st();
  host.retryConsent = async () => {
    if (host.retryError) throw host.retryError;
    host.refuse = false; host.consent = "unasked";
    return st();
  };
  host.spawn = async (cols, rows, onBytes, onExit) => {
    host.spawns++;
    if (!host.enabled) throw "the Terminal feature is disabled";
    if (host.refuse) { host.consent = "denied"; throw "terminal access was not approved"; }
    if (opts.limit) throw "too many terminals (max 8)";
    host.consent = "granted";
    const id = host.spawns;
    const hd = { id, shell: "zsh", onBytes, onExit, cols, rows,
      write: async (d) => { if (host.dead?.has(id)) throw "no such terminal"; host.writes.push([id, d]); },
      resize: async () => {}, ack: async (n) => { host.acks.push([id, n]); }, kill: async () => { host.kills.push(id); } };
    host.handles.push(hd);
    return hd;
  };
  return host;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("text: paste is sanitised (ESC / C0 / C1 / line separators removed), CRLF normalised, size capped", () => {
  assert.equal(text.sanitizePaste("ls\x1b[201~; rm -rf ~\r\nok"), "ls[201~; rm -rf ~\nok");
  assert.equal(text.sanitizePaste("a\u0000b\u0007c\u009bd e\tf"), "abcde\tf");
  assert.equal(text.sanitizePaste("x".repeat(text.MAX_PASTE_CHARS + 50)).length, text.MAX_PASTE_CHARS);
});

test("text: only a multi-line paste into a non-bracketed shell needs confirmation", () => {
  assert.equal(text.needsPasteConfirm("ls\n", false), false, "a single command with a trailing newline");
  assert.equal(text.needsPasteConfirm("ls\npwd", false), true);
  assert.equal(text.needsPasteConfirm("ls\npwd", true), false, "bracketed paste protects the shell");
  assert.equal(text.needsPasteConfirm("single", false), false);
});

test("text: URL detection strips sentence punctuation, keeps balanced parens, only http(s)", () => {
  const f = (s) => text.findUrls(s).map((x) => x.url);
  assert.deepEqual(f("see https://example.com/a?b=1, then (https://x.dev/y)."), ["https://example.com/a?b=1", "https://x.dev/y"]);
  assert.deepEqual(f("https://en.wikipedia.org/wiki/Rust_(language)."), ["https://en.wikipedia.org/wiki/Rust_(language)"]);
  assert.deepEqual(f("file:///etc/passwd javascript:alert(1) ftp://x.y http://"), []);
  const [u] = text.findUrls("go to http://a.b/c now");
  assert.deepEqual([u.start, u.end], [6, 18]);
  assert.deepEqual(text.findUrls("x".repeat(5000) + " https://a.b/c"), [], "absurd lines are not scanned");
});

test("text: scrollback is bounded and credit is batched below the host's high-water mark", () => {
  assert.equal(text.DEFAULT_SCROLLBACK, 10_000);
  assert.equal(text.clampScrollback(1e9), text.MAX_SCROLLBACK);
  assert.equal(text.clampScrollback(5), text.MIN_SCROLLBACK);
  assert.equal(text.clampScrollback("x"), 10_000);
  const sent = [];
  const a = new text.AckBatcher((n) => sent.push(n), 100);
  a.processed(60); a.processed(30);
  assert.deepEqual(sent, []);
  a.processed(20);
  assert.deepEqual(sent, [110]);
  a.processed(5); a.flush(); a.flush();
  assert.deepEqual(sent, [110, 5]);
});

test("manager: reading status never spawns or prompts; phases follow feature and consent", async () => {
  const host = fakeHost();
  const m = new mgr.TerminalManager(host);
  assert.equal(m.getSnapshot().phase, "loading");
  await m.refresh();
  assert.equal(m.getSnapshot().phase, "needs-consent");
  assert.equal(host.spawns, 0);
  const off = new mgr.TerminalManager(fakeHost({ enabled: false }));
  await off.refresh();
  assert.equal(off.getSnapshot().phase, "disabled");
  assert.equal(off.openTab(), null, "no tab when the feature is off");
  const den = new mgr.TerminalManager(fakeHost({ consent: "denied" }));
  await den.refresh();
  assert.equal(den.getSnapshot().phase, "denied");
  const ok = new mgr.TerminalManager(fakeHost({ consent: "granted" }));
  await ok.refresh();
  assert.equal(ok.getSnapshot().phase, "ready");
});

test("manager: open -> start spawns once with the view size; output goes to the callback; credit handle works", async () => {
  const host = fakeHost();
  const m = new mgr.TerminalManager(host);
  await m.refresh();
  const id = m.openTab();
  assert.equal(m.getSnapshot().tabs[0].state, "starting");
  const got = [];
  const hd = await m.start(id, 120, 30, (b) => got.push(b));
  assert.equal(host.spawns, 1);
  assert.deepEqual([hd.cols, hd.rows], [120, 30]);
  assert.equal(m.getSnapshot().tabs[0].state, "running");
  assert.equal(m.getSnapshot().phase, "ready");
  hd.onBytes(new Uint8Array([1]));
  assert.equal(got.length, 1);
  assert.equal(await m.start(id, 1, 1, () => {}), null, "a running tab is not spawned twice");
  assert.equal(host.spawns, 1);
});

test("manager: a refused consent shows denied; Try again re-asks; the retry limit message is surfaced", async () => {
  const host = fakeHost({ refuse: true });
  const m = new mgr.TerminalManager(host);
  await m.refresh();
  const id = m.openTab();
  assert.equal(await m.start(id, 80, 24, () => {}), null);
  let s = m.getSnapshot();
  assert.equal(s.phase, "denied");
  assert.equal(s.tabs.length, 0, "the dead tab is removed");
  host.retryError = "please wait a few seconds before trying again";
  await m.retry();
  s = m.getSnapshot();
  assert.equal(s.phase, "denied");
  assert.match(s.retryMessage, /wait a few seconds/);
  host.retryError = null;
  await m.retry();
  assert.equal(m.getSnapshot().phase, "needs-consent", "re-armed: the next spawn asks again");
  host.refuse = false;
  const id2 = m.openTab();
  assert.ok(await m.start(id2, 80, 24, () => {}));
  assert.equal(m.getSnapshot().phase, "ready");
});

test("manager: tab cap, spawn limit message, kill on close, closeAll on project change, exited detection", async () => {
  const host = fakeHost({ consent: "granted" });
  const m = new mgr.TerminalManager(host);
  await m.refresh();
  const ids = [];
  for (let i = 0; i < mgr.MAX_TABS; i++) { const id = m.openTab(); ids.push(id); await m.start(id, 80, 24, () => {}); }
  assert.equal(m.openTab(), null, "capped at MAX_TABS");
  await m.closeTab(ids[0]);
  assert.deepEqual(host.kills, [1], "closing a tab kills its shell");
  assert.equal(m.getSnapshot().tabs.length, mgr.MAX_TABS - 1);
  assert.equal(m.getSnapshot().active, ids[mgr.MAX_TABS - 1], "active falls back to a neighbour or stays");
  m.markExited(ids[1]);
  assert.equal(m.getSnapshot().tabs.find((t) => t.id === ids[1]).state, "exited");
  await m.closeAll();
  assert.equal(m.getSnapshot().tabs.length, 0);
  assert.equal(host.kills.length, mgr.MAX_TABS - 1 + 0 + 0, "every live shell was killed (the exited one is already gone)");
  const lim = new mgr.TerminalManager(fakeHost({ limit: true }));
  await lim.refresh();
  const id = lim.openTab();
  await lim.start(id, 80, 24, () => {});
  assert.match(lim.getSnapshot().error, /Too many terminals/);
});

test("manager: a tab closed while its spawn is in flight does not leak a shell", async () => {
  const host = fakeHost({ consent: "granted" });
  const m = new mgr.TerminalManager(host);
  await m.refresh();
  const id = m.openTab();
  const p = m.start(id, 80, 24, () => {});
  await m.closeTab(id);
  assert.equal(await p, null);
  assert.deepEqual(host.kills, [1]);
  const m2 = new mgr.TerminalManager(host);
  const id2 = m2.openTab();
  const p2 = m2.start(id2, 80, 24, () => {});
  await m2.dispose();
  await p2;
  assert.ok(host.kills.length >= 2);
});

test("manager: spawn error classification", () => {
  assert.equal(mgr.classifySpawnError("terminal access was not approved"), "denied");
  assert.equal(mgr.classifySpawnError("the Terminal feature is disabled"), "disabled");
  assert.equal(mgr.classifySpawnError("too many terminals (max 8)"), "limit");
  assert.equal(mgr.classifySpawnError("cannot start /bin/zsh: ENOENT"), "other");
});

const fakeRuntime = { create: () => ({ write() {}, fit: () => ({ cols: 80, rows: 24 }), size: () => ({ cols: 80, rows: 24 }), focus() {}, notice() {}, dispose() {} }), openUrl: async () => true };
const dock = (m, o = {}) => renderToStaticMarkup(h(TerminalDock, { manager: m, runtime: fakeRuntime, projectRoot: "/p", projectName: "demo", open: true, height: 260, onHeightChange() {}, onClose() {}, ...o }));

test("dock: pre-consent explanation, no auto-spawn, ARIA tablist and separator", async () => {
  const host = fakeHost();
  const m = new mgr.TerminalManager(host);
  await m.refresh();
  const out = dock(m);
  assert.match(out, /Open a terminal in demo/);
  assert.match(out, /runs with all of your user permissions/);
  assert.match(out, /Start terminal/);
  assert.match(out, /role="separator"[^>]*aria-orientation="horizontal"[^>]*aria-label="Resize terminal"/);
  assert.match(out, /role="tablist"[^>]*aria-label="Terminals"/);
  assert.match(out, /aria-label="New terminal"/);
  assert.equal(host.spawns, 0, "rendering never spawns");
});

test("dock: denied, disabled, no-project and error states", async () => {
  const den = new mgr.TerminalManager(fakeHost({ consent: "denied" }));
  await den.refresh();
  const out = dock(den);
  assert.match(out, /Terminal access was not approved/);
  assert.match(out, /Try again/);
  assert.match(out, /aria-label="New terminal"[^>]*disabled/);
  const off = new mgr.TerminalManager(fakeHost({ enabled: false }));
  await off.refresh();
  assert.match(dock(off), /turned off in this build/);
  assert.match(dock(den, { projectRoot: null }), /Open a project to use the terminal/);
  const bad = new mgr.TerminalManager({ status: async () => { throw new Error("pty down"); } });
  await bad.refresh();
  assert.match(dock(bad), /Terminal unavailable: pty down/);
});

test("dock: tabs render with labelled close buttons; hidden dock stays in the DOM (sessions survive)", async () => {
  const host = fakeHost({ consent: "granted" });
  const m = new mgr.TerminalManager(host);
  await m.refresh();
  const a = m.openTab(); const b = m.openTab();
  await Promise.all([m.start(a, 80, 24, () => {}), m.start(b, 80, 24, () => {})]);
  const out = dock(m, { open: false });
  assert.match(out, /<section[^>]*aria-label="Terminal"[^>]*hidden/);
  assert.equal((out.match(/role="tab"/g) ?? []).length, 2);
  assert.match(out, /aria-label="Close zsh 1"/);
  assert.equal((out.match(/role="tabpanel"/g) ?? []).length, 2);
  assert.match(out, /id="tm-pane-2"[^>]*aria-labelledby="tm-tab-2"[^>]*(?!hidden)/);
});

test("dock: height clamps to bounds and non-finite input", () => {
  assert.equal(clampDock(10), DOCK_MIN);
  assert.equal(clampDock(5000, 5000), DOCK_MAX);
  assert.equal(clampDock(Number.NaN), 260);
  assert.equal(clampDock(500, 500), 300, "never taller than the window minus 200");
});

test("screen: explorer renders the panel switcher, search panel and terminal strip; terminal is not started", async () => {
  const fs = makeFs({ "a.ts": "x" });
  const editor = makeEditor();
  const host = fakeHost();
  const out = renderToStaticMarkup(h(ExplorerScreen, { active: true, projectRoot: "/proj", deps: { fs, loadEditor: async () => editor, terminal: { host, runtime: fakeRuntime }, search: { start: async () => ({ id: 1 }), cancel: async () => {} } } }));
  assert.match(out, /role="tablist"[^>]*aria-label="Side panel"/);
  assert.match(out, /id="ex-panel-search"[^>]*hidden/);
  assert.doesNotMatch(out, /id="ex-panel-explorer"[^>]*hidden/);
  assert.match(out, /role="searchbox"/);
  assert.match(out, /aria-expanded="false"[^>]*>Terminal</);
  assert.equal(host.spawns, 0);
});

test("controller: openAt opens a regular tab and reveals line/col in the editor", async () => {
  const fs = makeFs({ "src/a.ts": "one\ntwo needle\n" });
  const editor = makeEditor();
  const c = new ExplorerController({ fs, editor: () => editor, kv: null, settleMs: 0 });
  editor.mount(null, { onDirty() {}, onSave() {}, onEvict() {} });
  await c.init("/proj");
  await settle();
  await c.openAt("src/a.ts", 2, 5);
  assert.equal(c.getSnapshot().tabs.activeId, "src/a.ts");
  assert.deepEqual(editor.reveals, [["src/a.ts", 2, 5]]);
  assert.equal(c.getSnapshot().tabs.tabs[0].preview, false);
});

test("manager: the host's shell-exit event marks the tab exited at once, even if it fires before spawn resolves", async () => {
  const host = fakeHost({ consent: "granted" });
  const m = new mgr.TerminalManager(host);
  await m.refresh();
  const id = m.openTab();
  await m.start(id, 80, 24, () => {});
  assert.equal(m.getSnapshot().tabs[0].state, "running");
  host.handles[0].onExit();
  assert.equal(m.getSnapshot().tabs[0].state, "exited", "no write was needed to notice");
  host.handles[0].onExit();
  assert.equal(m.getSnapshot().tabs[0].state, "exited", "a second event is harmless");
  // early exit: the event arrives while spawn is still in flight
  const early = fakeHost({ consent: "granted" });
  const spawn = early.spawn;
  early.spawn = async (c, r, b, onExit) => { onExit(); return spawn(c, r, b, onExit); };
  const m2 = new mgr.TerminalManager(early);
  await m2.refresh();
  const id2 = m2.openTab();
  await m2.start(id2, 80, 24, () => {});
  assert.equal(m2.getSnapshot().tabs[0].state, "exited");
});
