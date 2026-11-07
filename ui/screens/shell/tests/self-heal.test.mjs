import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const sh = await load("self-heal.ts");
beforeEach(() => sh.resetSelfHealForTests());
const take = (enabled, incidents = []) => async () => ({ enabled, incidents });
const ok = { source: "server", category: "server", message: "Error: x", stack: null };

test("decodeTake keeps only well-formed host reports and reads anything else as off", () => {
  assert.deepEqual(sh.decodeTake(null), { enabled: false, incidents: [] });
  assert.deepEqual(sh.decodeTake({ enabled: "yes", incidents: [ok] }), { enabled: false, incidents: [] });
  assert.deepEqual(sh.decodeTake({ enabled: true, incidents: [ok, { source: "ui", category: "chat", message: 3 }, { source: "evil", category: "c", message: "m" }, { source: "log", category: " ", message: "m" }, null] }), { enabled: true, incidents: [ok] });
});

test("a release build (enabled false) posts nothing, keeps no UI error and is not shown", async () => {
  const posted = [];
  await sh.pumpOnce({ take: take(false), post: async (b) => { posted.push(b); } });
  sh.reportUiIncident("chat", "boom");
  assert.equal(sh.selfHealEnabled(), false);
  assert.equal(sh.pendingCount(), 0);
  assert.deepEqual(posted, []);
});

test("a debug build posts host and UI reports in batches of 50 and keeps them while the post fails", async () => {
  const posted = [];
  const host = Array.from({ length: 60 }, (_, i) => ({ ...ok, message: `Error: ${i}` }));
  let fail = true;
  const post = async (b) => { if (fail) throw new Error("core restarting"); posted.push(b); };
  await sh.pumpOnce({ take: take(true, host), post });
  assert.equal(sh.selfHealEnabled(), true);
  sh.reportUiIncident("chat", "The stream ended before the turn finished.");
  assert.equal(sh.pendingCount(), 61, "kept for the next tick");
  fail = false;
  await sh.pumpOnce({ take: take(true), post });
  assert.deepEqual(posted.map((b) => b.length), [50, 11]);
  assert.equal(posted[0][0].message, "Error: 0", "order is kept across a failed post");
  assert.deepEqual(posted[1].at(-1), { source: "ui", category: "chat", message: "The stream ended before the turn finished.", stack: null });
  assert.equal(sh.pendingCount(), 0);
});

test("the buffer keeps the newest 100; an empty or non-text UI error is dropped; a failing take changes nothing", async () => {
  await sh.pumpOnce({ take: take(true), post: async () => {} });
  for (let i = 0; i < 120; i++) sh.reportUiIncident("loop", `fail ${i}`);
  sh.reportUiIncident("chat", "   ");
  sh.reportUiIncident("chat", null);
  assert.equal(sh.pendingCount(), 100);
  await sh.pumpOnce({ take: async () => { throw new Error("no host"); }, post: async () => {} });
  assert.equal(sh.pendingCount(), 100);
  const posted = [];
  await sh.pumpOnce({ take: take(true), post: async (b) => { posted.push(...b); } });
  assert.equal(posted[0].message, "fail 20");
});

test("subscribers hear the switch once", async () => {
  let n = 0;
  const off = sh.subscribeSelfHeal(() => { n += 1; });
  await sh.pumpOnce({ take: take(true), post: async () => {} });
  await sh.pumpOnce({ take: take(true), post: async () => {} });
  off();
  assert.equal(n, 1);
});

test("flushSelfHealNow drains the host once more through the running pump, and does nothing without one", async () => {
  let takes = 0;
  const posted = [];
  await sh.flushSelfHealNow(0);
  assert.equal(takes, 0);
  const stop = sh.startSelfHealPump({ take: async () => { takes += 1; return { enabled: true, incidents: [{ ...ok, message: `Error: ${takes}` }] }; }, post: async (b) => { posted.push(...b); } }, 1e9);
  await sh.flushSelfHealNow(0);
  stop();
  assert.ok(takes >= 2, "the first tick and the flush");
  assert.ok(posted.some((p) => p.message === "Error: 2"));
  const before = takes;
  await sh.flushSelfHealNow(0);
  assert.equal(takes, before, "a stopped pump is not flushed");
});
