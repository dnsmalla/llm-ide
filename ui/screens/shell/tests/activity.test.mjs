import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const m = await load("activity-model.ts");
const { createActivityStore } = await load("activity-store.ts");
const { ActivityList } = await load("ActivityBell.tsx");

const NOW = Date.parse("2026-10-31T12:00:00Z");
const row = (id, title, created_at, extra = {}) => ({ id, kind: "knowledge_updated", title, created_at, ...extra });

test("decodeFeed: SQLite UTC times, bad rows skipped, text sanitised, counts bounded", () => {
  const f = m.decodeFeed({
    items: [row(3, "Three", "2026-10-31 11:00:00"), row(2, "<img src=x onerror=1>‮", "2026-10-30 09:00:00"), { id: "x" }, null, row(4, "", "2026-10-31 11:00:00"), row(5, "bad time", "nope")],
    unread: 7,
    lastId: 9,
  });
  assert.deepEqual(f.items.map((i) => i.id), [3, 2]);
  assert.equal(f.items[0].at, Date.parse("2026-10-31T11:00:00Z"));
  assert.ok(!f.items[1].title.includes("‮"));
  assert.equal(f.unread, 7);
  assert.equal(f.lastId, 9);
  assert.deepEqual(m.decodeFeed("nope"), m.EMPTY_FEED);
  assert.deepEqual(m.decodeFeed({ items: "x", unread: -1 }), { items: [], unread: 0, lastId: 0 });
  const big = m.decodeFeed({ items: Array.from({ length: 5000 }, (_, i) => row(i, `t${i}`, "2026-10-31 11:00:00")) });
  assert.ok(big.items.length <= 200, "a hostile page is cut at decode");
  assert.ok(Number.isNaN(m.parseServerTime("x".repeat(100))), "NaN for an over-long string");
});

test("visibleItems: 48-hour window, newest first, capped; groups by local day", () => {
  const items = m.decodeFeed({ items: [row(1, "old", "2026-10-28 10:00:00"), row(2, "yesterday", "2026-10-30 23:00:00"), row(3, "today", "2026-10-31 10:00:00"), row(4, "today2", "2026-10-31 11:30:00")] }).items;
  const vis = m.visibleItems(items, NOW);
  assert.deepEqual(vis.map((i) => i.title), ["today2", "today", "yesterday"]);
  const g = m.groupByDay(vis, NOW, 0);
  assert.deepEqual(g.map((x) => [x.label, x.items.length]), [["Today", 2], ["Yesterday", 1]]);
  const many = Array.from({ length: 500 }, (_, i) => ({ id: i, kind: null, title: "t", at: NOW - i * 1000 }));
  assert.equal(m.visibleItems(many, NOW).length, m.MAX_FEED_ROWS);
  assert.equal(m.badgeText(0), null);
  assert.equal(m.badgeText(5), "5");
  assert.equal(m.badgeText(400), "99");
  assert.equal(m.badgeText(Number.NaN), null);
});

function fakeApi(handler) {
  const calls = [];
  return { calls, get: async (p, s) => (calls.push(["GET", p]), handler("GET", p, s)), post: async (p, b, s) => (calls.push(["POST", p, b]), handler("POST", p, s)) };
}

test("activity store: polls, keeps the old feed on failure, marks seen optimistically, stops cleanly", async () => {
  let fail = false;
  const api = fakeApi((method) => {
    if (method === "POST") return { ok: true };
    if (fail) throw new Error("down");
    return { items: [row(8, "A", "2026-10-31 11:00:00")], unread: 2, lastId: 8 };
  });
  const timers = [];
  const store = createActivityStore({ api, setTimer: (fn, ms) => (timers.push([fn, ms]), timers.length), clearTimer: () => {}, isHidden: () => false });
  let n = 0;
  store.subscribe(() => n++);
  store.start();
  store.start(); // idempotent
  await store.refreshNow();
  assert.equal(store.getSnapshot().feed.unread, 2);
  assert.equal(api.calls.filter((c) => c[0] === "GET").length >= 1, true);
  assert.match(api.calls[0][1], /^\/kb\/activity\?limit=50$/);
  fail = true;
  await store.refreshNow();
  assert.equal(store.getSnapshot().error, "unavailable");
  assert.equal(store.getSnapshot().feed.items.length, 1, "the last known feed stays");
  fail = false;
  await store.refreshNow();
  assert.equal(store.getSnapshot().error, null);
  await store.markSeen();
  assert.equal(store.getSnapshot().feed.unread, 0);
  assert.deepEqual(api.calls.at(-1), ["POST", "/kb/activity/seen", { uptoId: 8 }]);
  store.stop();
  store.stop();
  assert.ok(n > 0);
});

test("activity store: a hidden window skips the poll but keeps the timer; no id, no seen call", async () => {
  const api = fakeApi(() => ({ items: [], unread: 0, lastId: 0 }));
  let hidden = true;
  const timers = [];
  const store = createActivityStore({ api, intervalMs: 10, setTimer: (fn) => (timers.push(fn), 1), clearTimer: () => {}, isHidden: () => hidden });
  store.start();
  await Promise.resolve();
  assert.equal(api.calls.length, 0, "hidden: no request");
  assert.equal(timers.length, 1, "but the next check is scheduled");
  hidden = false;
  timers.shift()();
  await new Promise((r) => setImmediate(r));
  assert.equal(api.calls.filter((c) => c[0] === "GET").length, 1);
  await store.markSeen();
  assert.equal(api.calls.filter((c) => c[0] === "POST").length, 0, "nothing to mark");
  store.stop();
});

test("ActivityList: grouped rows as text, empty state, unavailable note", () => {
  const items = m.visibleItems(m.decodeFeed({ items: [row(1, "<b>bold</b> done", "2026-10-31 11:00:00")] }).items, NOW);
  const out = html(h(ActivityList, { items, nowMs: NOW, error: null }));
  assert.match(out, /<h3 class="sh-activity-day">Today<\/h3>/);
  assert.match(out, /&lt;b&gt;bold&lt;\/b&gt; done/);
  assert.ok(!out.includes("<b>bold"));
  assert.match(out, /knowledge updated/);
  assert.match(html(h(ActivityList, { items: [], nowMs: NOW })), /No activity in the last 48 hours/);
  assert.match(html(h(ActivityList, { items, nowMs: NOW, error: "unavailable" })), /Activity is unavailable right now/);
});
