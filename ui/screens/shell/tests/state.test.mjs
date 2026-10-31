import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const host = await load("host.ts");
const { createStatusStore, nextDelay, statusEqual } = await load("status-store.ts");
const { deriveStatusView } = await load("status-view.ts");
const nav = await load("sections.ts");

const status = (o = {}) => host.normalizeCoreStatus({ url: "http://127.0.0.1:3456", state: "ready", trust: "spawned", ...o });
const state = (o = {}, extra = {}) => ({ status: status(o), pollError: null, everReady: false, ...extra });

test("normalizeCoreStatus fills additive fields and fails closed on unknown state", () => {
  const s = host.normalizeCoreStatus({ url: "http://127.0.0.1:1", state: "ready" });
  assert.deepEqual([s.restarts, s.restart_in_ms, s.fatal, s.claude, s.trust], [0, null, false, "unknown", "pending"]);
  assert.equal(host.normalizeCoreStatus({ state: "exploded" }).state, "failed");
  assert.equal(host.normalizeCoreStatus(null).state, "failed");
});

test("host: browser fallback and injected bridge", async () => {
  host.setHostBridge(null);
  assert.equal(host.host.isAvailable(), false);
  assert.equal((await host.host.coreStatus()).url, host.DEV_CORE_URL);
  assert.deepEqual(await host.host.projectRecent(), []);
  assert.equal(await host.host.projectOpen(), null);
  await assert.rejects(host.invokeHost("x"), host.HostUnavailableError);
  const calls = [];
  host.setHostBridge({ invoke: async (c, a) => (calls.push([c, a]), c === "core_status" ? { state: "starting", url: "http://127.0.0.1:2" } : { name: "p", root: "/r" }) });
  assert.equal((await host.host.coreStatus()).state, "starting");
  await host.host.projectOpenRecent(2);
  assert.deepEqual(calls[1], ["project_open_recent", { index: 2 }]);
  await assert.rejects(host.host.projectOpenRecent(-1), RangeError);
  await assert.rejects(host.host.projectOpenRecent(1.5), RangeError);
  host.setHostBridge(null);
});

test("status view: every core state maps to a visible, non-blank state", () => {
  assert.deepEqual(
    ["starting", "ready", "restarting", "failed"].map((st) => deriveStatusView(state({ state: st })).down),
    [true, false, true, true],
  );
  const none = deriveStatusView({ status: null, pollError: null, everReady: false });
  assert.equal(none.label, "Starting core…");
  assert.equal(deriveStatusView({ status: null, pollError: "ipc dead", everReady: false }).level, "error");
  const r = deriveStatusView(state({ state: "restarting", restart_in_ms: 2400, restarts: 2 }));
  assert.match(r.label, /Restarting core in 3 s/);
  const f = deriveStatusView(state({ state: "failed", fatal: true, error: "boom" }));
  assert.ok(f.fatal && f.level === "error" && f.detail === "boom" && f.label === "Core crashed repeatedly");
  assert.equal(deriveStatusView(state({ state: "failed" })).fatal, false);
});

test("status view: claude missing notice and unverified adopted core", () => {
  const v = deriveStatusView(state({ claude: "missing", claude_notice: "Install Claude Code" }));
  assert.equal(v.claudeNotice, "Install Claude Code");
  assert.equal(deriveStatusView(state({ claude: "found" })).claudeNotice, null);
  assert.ok(deriveStatusView(state({ claude: "missing" })).claudeNotice.length > 0);
  const a = deriveStatusView(state({ adopted: true, trust: "adopted_unverified", notice: "external" }));
  assert.equal(a.level, "warn");
  assert.equal(a.trustNotice, "external");
  assert.equal(a.down, false);
  assert.equal(deriveStatusView(state({}, { pollError: "x" })).down, true);
});

test("status store: notifies only on real change; everReady sticks; polling cadence", async () => {
  let n = 0;
  const seq = [status({ state: "starting" }), status({ state: "starting" }), status({ state: "ready" }), status({ state: "ready" }), status({ state: "restarting" })];
  const timers = [];
  const store = createStatusStore({
    fetchStatus: async () => seq[Math.min(n++, seq.length - 1)],
    setTimer: (fn, ms) => (timers.push(ms), fn, 1),
    clearTimer: () => {},
    isHidden: () => false,
  });
  let notifications = 0;
  store.subscribe(() => notifications++);
  await store.refreshNow();
  await store.refreshNow(); // identical -> no notification
  assert.equal(notifications, 1);
  const first = store.getSnapshot().status;
  await store.refreshNow();
  assert.equal(store.getSnapshot().everReady, true);
  await store.refreshNow();
  assert.equal(notifications, 2);
  await store.refreshNow();
  assert.equal(store.getSnapshot().status.state, "restarting");
  assert.equal(store.getSnapshot().everReady, true, "stays true across a restart");
  assert.notEqual(first, store.getSnapshot().status);
  assert.equal(nextDelay(state({ state: "ready" }), { fast: 1, slow: 4, hidden: 15 }, false), 4);
  assert.equal(nextDelay(state({ state: "ready" }), { fast: 1, slow: 4, hidden: 15 }, true), 15);
  assert.equal(nextDelay(state({ state: "restarting" }), { fast: 1, slow: 4, hidden: 15 }, true), 1);
  assert.equal(nextDelay(state({}, { pollError: "e" }), { fast: 1, slow: 4, hidden: 15 }, false), 1);
  assert.ok(statusEqual(status(), status()));
});

test("status store: a failing host call is reported, then recovers; start/stop are idempotent", async () => {
  let fail = true;
  const store = createStatusStore({ fetchStatus: async () => { if (fail) throw new Error("ipc down"); return status(); }, setTimer: () => 1, clearTimer: () => {} });
  await store.refreshNow();
  assert.equal(store.getSnapshot().pollError, "ipc down");
  fail = false;
  await store.refreshNow();
  assert.equal(store.getSnapshot().pollError, null);
  store.start();
  store.start();
  store.stop();
  store.stop();
});

test("navigation: select keeps visited sections, ignores disabled/unknown, steps wrap", () => {
  nav.setDevTools(false);
  let s = nav.initialNav(null);
  assert.deepEqual([s.active, s.visited], ["welcome", ["welcome"]], "nothing known: the Welcome page");
  s = nav.navReducer(s, { type: "select", id: "library" });
  s = nav.navReducer(s, { type: "select", id: "chat" });
  assert.deepEqual([s.active, s.visited], ["chat", ["welcome", "library", "chat"]]);
  const before = s;
  for (const id of ["issues", "gantt", "loop", "autotasks"]) assert.equal(nav.navReducer(s, { type: "select", id }), before, `${id} is a disabled placeholder`);
  assert.equal(nav.navReducer(s, { type: "select", id: "nope" }), before);
  assert.equal(nav.navReducer(s, { type: "select", id: "chat" }), before, "same section: same object (no re-render)");
  assert.equal(nav.navReducer(s, { type: "select", id: "spike" }), before, "Spike is not selectable without developer tools");
  const back = nav.navReducer(nav.initialNav("welcome"), { type: "step", delta: -1 });
  assert.equal(back.active, "settings", "wraps to the last selectable item (Settings, not Spike)");
  assert.equal(nav.initialNav("issues").active, "welcome");
  nav.setDevTools(true);
  assert.equal(nav.navReducer(s, { type: "select", id: "spike" }).active, "spike", "developer tools make Spike selectable");
  assert.equal(nav.navReducer(nav.initialNav("welcome"), { type: "step", delta: -1 }).active, "spike");
  nav.setDevTools(false);
});

test("nav order follows the Mac toolbar; Settings is last; Spike only with developer tools", () => {
  nav.setDevTools(false);
  const labels = nav.visibleSections().map((d) => d.label);
  assert.deepEqual(labels, ["Home", "Explorer", "Code Graph", "Auto Tasks", "Issues", "Gantt", "Loop", "Doc Gen", "Visual", "Library", "Chat", "Settings"]);
  assert.equal(nav.devToolsEnabled(), false);
  nav.setDevTools(true);
  assert.equal(nav.visibleSections().at(-1).id, "spike");
  assert.equal(nav.visibleSections().at(-2).id, "settings");
  nav.setDevTools(false);
  nav.enableDevToolsForSession();
  assert.equal(nav.devToolsEnabled(), true, "a spike launch shows its item for this session");
  nav.setDevTools(false);
  for (const id of ["autotasks", "issues", "gantt", "loop"]) assert.match(nav.SECTIONS.find((d) => d.id === id).note, /later phase/);
});

test("navigation: shortcuts, nav keys, launch section", () => {
  const k = (key, o = {}) => ({ key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(nav.sectionForShortcut(k("2")), "explorer");
  assert.equal(nav.sectionForShortcut(k("2", { ctrlKey: false, metaKey: true })), "explorer");
  assert.equal(nav.sectionForShortcut(k("9")), null);
  assert.equal(nav.sectionForShortcut(k("2", { ctrlKey: false })), null);
  assert.equal(nav.sectionForShortcut(k("2", { shiftKey: true })), null);
  assert.equal(nav.navKeyTarget("ArrowDown", 4, 5), 0);
  assert.equal(nav.navKeyTarget("ArrowUp", 0, 5), 4);
  assert.equal(nav.navKeyTarget("Home", 3, 5), 0);
  assert.equal(nav.navKeyTarget("x", 3, 5), null);
  assert.equal(nav.launchSection("all", null), "spike");
  assert.equal(nav.launchSection(null, "terminal"), "spike");
  assert.equal(nav.launchSection(null, "library"), "library");
  assert.equal(nav.launchSection(null, "graphzzz"), "welcome");
  assert.equal(nav.readStoredSection(), null, "no storage in node: no throw");
});
