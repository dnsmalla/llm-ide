import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html, fakeCore } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("dock"); });
const noop = () => {};
const count = (s, re) => (s.match(re) ?? []).length;
const sess = (n, title = (i) => `Chat ${i}`) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: title(i), surface: "any", mode: null, projectId: null, createdAt: 1e9 - i, updatedAt: 1.7e9 - i }));

test("shared UI state: the open chat, picker choices and permission are one set for both chat surfaces", () => {
  const ui = c.createChatUiStore(null);
  let n = 0;
  const off = ui.subscribe(() => n++);
  ui.setActiveId("a");
  ui.setActiveId("a");
  assert.equal(n, 1, "same value: no notification");
  ui.setPrefs((p) => ({ ...p, a: { mode: "plan", provider: "p", model: "m" } }));
  ui.setPermission("accept-edits");
  ui.bumpSessions();
  const s = ui.getSnapshot();
  assert.deepEqual([s.activeId, s.permission, s.sessionsRev, s.prefs.a.model], ["a", "accept-edits", 1, "m"]);
  const same = s.prefs;
  ui.setPrefs((p) => p);
  assert.equal(ui.getSnapshot().prefs, same, "an unchanged update keeps the object");
  off();
  ui.setActiveId("b");
  assert.equal(n, 4, "unsubscribed");
  // remembered choices are bounded
  const big = c.createChatUiStore();
  for (let i = 0; i < c.MAX_REMEMBERED_PREFS + 50; i++) big.setPrefs((p) => ({ ...p, [`id${i}`]: { mode: "auto", provider: null, model: null } }));
  assert.equal(Object.keys(big.getSnapshot().prefs).length, c.MAX_REMEMBERED_PREFS);
  assert.ok(big.getSnapshot().prefs[`id${c.MAX_REMEMBERED_PREFS + 49}`], "the newest are kept");
});

test("two surfaces on one store: a chat opened in one is open in the other", () => {
  const ui = c.createChatUiStore(null);
  const dockSees = [];
  ui.subscribe(() => dockSees.push(ui.getSnapshot().activeId));
  ui.setActiveId("s1"); // the Chat section opens a chat
  ui.setActiveId("s2"); // the dock switches
  assert.deepEqual(dockSees, ["s1", "s2"]);
});

test("DockHeader: CODE ASSISTANT label, history menu, New chat and Hide are named controls", () => {
  const out = html(h(c.DockHeader, { sessions: sess(3), activeId: "s1", busyIds: new Set(["s2"]), route: null, routeDisabled: false, onSelect: noop, onNew: noop, onCollapse: noop, onSetLimit: async () => {} }));
  assert.match(out, /<h2 class="chat-dock-title">CODE ASSISTANT<\/h2>/);
  assert.match(out, /<select[^>]*aria-label="Chat history"/);
  assert.match(out, /<option value="s1" selected="">Chat 1<\/option>/);
  assert.match(out, /Chat 2 \(running\)/);
  assert.match(out, /aria-label="New chat"/);
  assert.match(out, /aria-label="Hide Code Assistant"/);
  const noHide = html(h(c.DockHeader, { sessions: [], activeId: null, busyIds: new Set(), route: null, routeDisabled: true, onSelect: noop, onNew: noop, onSetLimit: async () => {} }));
  assert.doesNotMatch(noHide, /Hide Code Assistant/);
  assert.doesNotMatch(noHide, /<select/, "no chats yet: no history menu");
});

test("history options: bounded, the open chat always listed, titles are text without control or bidi characters", () => {
  const many = sess(500);
  const o = c.historyOptions(many, "s0", new Set());
  assert.equal(o.length, c.DOCK_HISTORY_MAX);
  const beyond = c.historyOptions(many, "s400", new Set());
  assert.equal(beyond.length, c.DOCK_HISTORY_MAX + 1);
  assert.equal(beyond[0].id, "s400", "the open chat leads even beyond the cap");
  const evil = c.historyOptions(sess(1, () => "<img src=x onerror=1>‮\u0000" + "z".repeat(200)), null, new Set());
  assert.ok(!/[‮\u0000]/.test(evil[0].text));
  assert.ok(Array.from(evil[0].text).length <= 60);
  const out = html(h(c.DockHeader, { sessions: sess(1, () => "<img src=x onerror=1>"), activeId: null, busyIds: new Set(), route: null, routeDisabled: false, onSelect: noop, onNew: noop, onSetLimit: async () => {} }));
  assert.ok(!out.includes("<img"), "rendered as text");
  assert.equal(c.historyOptions([], null, new Set()).length, 0);
});

test("ChatScreen docked: one column, Code Assistant landmark, no session list, same controls as the Chat section", () => {
  const store = new c.MemoryChatStore();
  const controller = new c.ChatController({ core: fakeCore(), store, workspaceRoot: () => "/p" });
  const common = { controller, store, core: fakeCore(), host: { openLink: noop, copy: noop }, initialSessionId: "x" };
  const dock = html(h(c.ChatScreen, { ...common, dock: true, onCollapse: noop }));
  assert.match(dock, /class="chat-screen chat-dock-mode"/);
  assert.match(dock, /<section[^>]*class="chat-main"[^>]*aria-label="Code Assistant"/);
  assert.match(dock, /CODE ASSISTANT/);
  assert.doesNotMatch(dock, /aria-label="Chats"/, "no session column in the dock");
  assert.match(dock, /aria-label="Message composer"/);
  assert.match(dock, /aria-label="Hide Code Assistant"/);
  for (const re of [/Permission/i, /Model/i]) assert.match(dock, re);
  const full = html(h(c.ChatScreen, common));
  assert.match(full, /aria-label="Chats"/);
  assert.match(full, /<section[^>]*aria-label="Chat"/);
  assert.doesNotMatch(full, /CODE ASSISTANT/);
  assert.equal(count(dock, /aria-label="Message composer"/g), 1);
});

test("ChatScreen takes the open chat from the shared store (the dock shows what the Chat section opened)", () => {
  const store = new c.MemoryChatStore();
  const controller = new c.ChatController({ core: fakeCore(), store, workspaceRoot: () => "/p" });
  const ui = c.createChatUiStore(null);
  ui.setActiveId("shared-chat");
  const out = html(h(c.ChatScreen, { controller, store, core: fakeCore(), host: { openLink: noop, copy: noop }, shared: ui, dock: true }));
  assert.match(out, /aria-label="Message composer"/, "a chat is open: the composer is shown, not the empty state");
  const empty = html(h(c.ChatScreen, { controller, store, core: fakeCore(), host: { openLink: noop, copy: noop }, shared: c.createChatUiStore(null), dock: true }));
  assert.doesNotMatch(empty, /aria-label="Message composer"/);
  assert.match(empty, /Select a chat or start a new one/);
});
