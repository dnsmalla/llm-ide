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

test("reportChatProblem records at once through the running pump, and does nothing in a release build", async () => {
  assert.equal(await sh.reportChatProblem("it crashes"), false, "off before the host says debug");
  const posted = [];
  let stop = () => {};
  stop = sh.startSelfHealPump({ take: take(true), post: async (b) => { posted.push(b); } }, 3_600_000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await sh.reportChatProblem("   "), false, "empty text is not a report");
  assert.equal(await sh.reportChatProblem("the plan card never saves"), true);
  assert.deepEqual(posted.flat().at(-1), { source: "ui", category: "chat report", message: "the plan card never saves", stack: null });
  assert.equal(sh.pendingCount(), 0, "posted now, not on the next tick");
  stop();
});

// ── Capture from every section, uncaught errors and host commands ──
const enable = async (posted = []) => {
  await sh.pumpOnce({ take: take(true), post: async (b) => { posted.push(...b); } });
  return posted;
};
const flush = async (posted) => { await sh.pumpOnce({ take: take(true), post: async (b) => { posted.push(...b); } }); return posted; };

test("reportAppError keeps the Error's stack and the extra stack", async () => {
  const posted = await enable();
  const err = new Error("kaboom");
  sh.reportAppError("section:Library", err, "\n    in Library");
  await flush(posted);
  assert.equal(posted.length, 1);
  const [r] = posted;
  assert.deepEqual([r.source, r.category, r.message], ["ui", "section:Library", "kaboom"]);
  assert.ok(r.stack.includes(err.stack.split("\n")[1].trim()), r.stack);
  assert.ok(r.stack.endsWith("\n    in Library"), r.stack);
});

test("reportAppError is a no-op in a release build and for an empty message", async () => {
  sh.reportAppError("uncaught", new Error("release"));
  assert.equal(sh.pendingCount(), 0, "not enabled yet");
  await sh.pumpOnce({ take: take(true), post: async () => { throw new Error("hold"); } });
  sh.reportAppError("uncaught", "");
  sh.reportAppError("uncaught", undefined);
  sh.reportAppError("uncaught", {});
  assert.equal(sh.pendingCount(), 0);
});

test("a repeated error while pending is kept once", async () => {
  await sh.pumpOnce({ take: take(true), post: async () => { throw new Error("hold"); } });
  for (let i = 0; i < 5; i += 1) sh.reportAppError("section:Graph", new Error("same"));
  assert.equal(sh.pendingCount(), 1);
  sh.reportAppError("section:Graph", new Error("other"));
  assert.equal(sh.pendingCount(), 2);
  sh.reportUiIncident("chat", "dup");
  sh.reportUiIncident("chat", "dup");
  assert.equal(sh.pendingCount(), 3);
});

test("hostErrorWorthReporting: unexplained and internal failures only, never Self-Heal's own commands", () => {
  assert.equal(sh.hostErrorWorthReporting("git_status", "spawn failed"), true);
  assert.equal(sh.hostErrorWorthReporting("git_status", new Error("bridge broke")), true);
  assert.equal(sh.hostErrorWorthReporting("x", { code: "internal", message: "m" }), true);
  assert.equal(sh.hostErrorWorthReporting("x", { code: "bad_core_response", message: "m" }), true);
  assert.equal(sh.hostErrorWorthReporting("x", { code: "cancelled", message: "m" }), false);
  assert.equal(sh.hostErrorWorthReporting("x", { code: "io", message: "m" }), false);
  assert.equal(sh.hostErrorWorthReporting("x", { code: "SSH_TIMEOUT", message: "m" }), false);
  assert.equal(sh.hostErrorWorthReporting("self_heal_take", "boom"), false);
  assert.equal(sh.hostErrorWorthReporting("x", ""), false);
});

test("installGlobalErrorCapture reports error and unhandledrejection and the remover stops it", async () => {
  const posted = await enable();
  const target = new EventTarget();
  const fire = (type, props) => target.dispatchEvent(Object.assign(new Event(type), props));
  const stop = sh.installGlobalErrorCapture(target);
  fire("error", { error: new Error("e1"), message: "e1" });
  fire("unhandledrejection", { reason: "r1" });
  fire("unhandledrejection", { reason: undefined });
  fire("error", { error: null, message: "Script error." });
  stop();
  fire("error", { error: new Error("after"), message: "after" });
  await flush(posted);
  assert.deepEqual(posted.map((r) => [r.category, r.message]), [["uncaught", "e1"], ["uncaught", "r1"], ["uncaught", "Script error."]]);
});

test("hostErrorWorthReporting reads a `code: message` string's prefix as its code", () => {
  assert.equal(sh.hostErrorWorthReporting("capture_start", "already_recording: a capture is running"), false);
  assert.equal(sh.hostErrorWorthReporting("note_read", "io: No such file or directory (os error 2)"), false);
  assert.equal(sh.hostErrorWorthReporting("x", "internal: state lock poisoned"), true);
  assert.equal(sh.hostErrorWorthReporting("x", "Error: something broke"), true, "a capitalised word is not a code");
  assert.equal(sh.hostErrorWorthReporting("x", "that folder is not a git repository"), true);
});
