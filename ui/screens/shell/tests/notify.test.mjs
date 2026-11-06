// The webview side of notifications and the tray: pure helpers, drift checks against the Rust tables, and the bridge
// with fake stores. The host side has its own tests (desktop/src-tauri/src/notify.rs, tray.rs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load, SHELL } from "./helpers.mjs";

const REPO = resolve(SHELL, "../../..");
const n = await load("notify/notify.ts");
const b = await load("notify/bridge.ts");
const sec = await load("sections.ts");
const bus = await load("bus.ts");
const notifyRs = readFileSync(join(REPO, "desktop/src-tauri/src/notify.rs"), "utf8");
const prefsRs = readFileSync(join(REPO, "desktop/src-tauri/src/prefs.rs"), "utf8");

test("the webview kinds are exactly the Rust table minus the host-only kinds", () => {
  const wireFn = notifyRs.slice(notifyRs.indexOf("pub fn wire"), notifyRs.indexOf("pub fn from_webview"));
  const rust = [...wireFn.matchAll(/Kind::\w+ => "([a-z_]+)"/g)].map((m) => m[1]).filter((k) => k !== "update_ready" && k !== "core_down");
  assert.deepEqual([...n.WEBVIEW_KINDS].sort(), rust.sort());
  for (const s of ["loop", "autotask", "graph", "docgen"]) for (const ok of [true, false]) assert.ok(n.WEBVIEW_KINDS.includes(n.taskKind(s, ok)));
});

test("the host's section list matches the shell's", () => {
  const list = notifyRs.match(/pub const SECTIONS: \[&str; \d+\] = \[([^\]]*)\]/)[1];
  assert.deepEqual([...list.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort(), sec.SECTIONS.map((s) => s.id).sort());
});

test("the Settings switches are exactly the Rust NotifyPrefs fields", () => {
  const body = prefsRs.match(/pub struct NotifyPrefs \{([\s\S]*?)\}/)[1];
  assert.deepEqual([...body.matchAll(/pub (\w+):/g)].map((m) => m[1]).sort(), n.NOTIFY_SWITCHES.map((s) => s.key).sort());
});

test("tray actions: only fixed payloads and known sections pass", () => {
  assert.deepEqual(n.trayAction("capture_toggle"), { type: "capture" });
  assert.deepEqual(n.trayAction("sync_toggle"), { type: "sync" });
  assert.deepEqual(n.trayAction("route:inbox"), { type: "inbox" });
  assert.deepEqual(n.trayAction("route:loop"), { type: "goto", section: "loop" });
  assert.deepEqual(n.trayAction("route:settings:updates"), { type: "goto", section: "settings", anchor: "updates" });
  for (const bad of ["route:nowhere", "route:../x", "route:settings:a:b", "route:settings:Bad Anchor", "route:inbox:x", "open", 3, null, `route:${"a".repeat(90)}`]) assert.equal(n.trayAction(bad), null, String(bad));
});

test("sync report, sync alerts and generation ends", () => {
  assert.equal(n.syncReport(null), "unknown");
  assert.equal(n.syncReport({ configured: false, enabled: false }), "unknown");
  assert.equal(n.syncReport({ configured: true, enabled: true }), "on");
  assert.equal(n.syncReport({ configured: true, enabled: false }), "paused");
  assert.deepEqual(n.syncAlerts([{ id: 7, kind: "sync_attention" }, { id: 6, kind: "loop_engineering_done" }, { id: 4, kind: "sync_device_removed" }], 5), { ids: [7], lastId: 7 });
  assert.deepEqual(n.syncAlerts([], 5), { ids: [], lastId: 5 });
  assert.equal(n.generationEnded("generating", "done"), true);
  assert.equal(n.generationEnded("reading", "error"), false);
  assert.equal(n.generationEnded("generating", "idle"), null, "a cancel is not news");
  assert.equal(n.generationEnded("done", "done"), null);
});

test("notifyUser sends a kind, an opaque key and a count, never text", async () => {
  const calls = [];
  await n.notifyUser("approval_chat", { count: 2 }, async (cmd, args) => { calls.push([cmd, args]); });
  await n.notifyUser("loop_done", {}, async () => { throw new Error("permission"); });
  assert.deepEqual(calls, [["notify_user", { kind: "approval_chat", key: null, count: 2 }]]);
  assert.equal(n.trayNote({ available: true }), null);
  assert.match(n.trayNote({ available: false }), /libayatana-appindicator3-1/);
});

test("live-capture is sticky so a late Live screen still gets the tray's request", () => {
  const sb = bus.createShellBus(() => 0);
  sb.publish({ type: "live-capture" });
  assert.deepEqual(sb.takePending("live-capture"), { type: "live-capture" });
  assert.equal(sb.takePending("live-capture"), null);
});

function store(v) {
  const ls = new Set();
  return { getSnapshot: () => v, subscribe: (l) => { ls.add(l); return () => ls.delete(l); }, set(next) { v = next; for (const l of [...ls]) l(); } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("bridge: approvals, sync alerts and tray actions", async () => {
  const calls = [];
  const published = [];
  let emit = null;
  let opened = 0;
  const chat = store(0);
  const inbox = store({ items: [] });
  const activity = store({ loaded: true, feed: { lastId: 5, items: [] } });
  const session = store({ signedIn: true });
  let syncOn = true;
  const off = b.installNotifyBridge({
    invoke: async (cmd, args) => { calls.push([cmd, args]); return null; },
    listen: async (_event, cb) => { emit = cb; return () => {}; },
    chatApprovals: chat, inbox, activity, session,
    syncStatus: async () => ({ configured: true, enabled: syncOn }),
    setSyncEnabled: async (on) => { syncOn = on; return { configured: true, enabled: on }; },
    publish: (ev) => published.push(ev),
    openInbox: () => { opened += 1; },
  });
  await tick();
  assert.deepEqual(calls.filter(([c]) => c === "tray_report").at(-1)[1], { chatApprovals: 0, jobApprovals: 0, sync: "on" });

  chat.set(1); await tick();
  assert.deepEqual(calls.filter(([c]) => c === "notify_user").at(-1)[1], { kind: "approval_chat", key: null, count: 1 });
  chat.set(0); chat.set(0); await tick();
  assert.equal(calls.filter(([c]) => c === "notify_user").length, 1, "a falling count never notifies");
  const reports = calls.filter(([c]) => c === "tray_report").length;
  inbox.set({ items: [] }); await tick();
  assert.equal(calls.filter(([c]) => c === "tray_report").length, reports, "an unchanged report is not resent");
  inbox.set({ items: [{}, {}] }); await tick();
  assert.equal(calls.filter(([c]) => c === "tray_report").at(-1)[1].jobApprovals, 2);

  activity.set({ loaded: true, feed: { lastId: 6, items: [{ id: 6, kind: "sync_attention" }] } }); await tick();
  assert.deepEqual(calls.filter(([c]) => c === "notify_user").at(-1)[1], { kind: "sync_attention", key: "activity:6", count: null });

  emit("route:settings:updates");
  emit("route:inbox");
  emit("capture_toggle");
  emit("route:../evil");
  assert.deepEqual(published, [{ type: "goto-section", section: "settings", anchor: "updates" }, { type: "goto-section", section: "live" }, { type: "live-capture" }]);
  assert.equal(opened, 1);
  emit("sync_toggle"); await tick(); await tick();
  assert.equal(syncOn, false);
  assert.equal(calls.filter(([c]) => c === "tray_report").at(-1)[1].sync, "paused");

  session.set({ signedIn: false }); await tick();
  assert.equal(calls.filter(([c]) => c === "tray_report").at(-1)[1].sync, "unknown", "signed out: sync unavailable");
  off();
});
