import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const api = await load("approvals/bus-api.ts");
const sum = await load("approvals/summary.ts");
const NONCE = "a".repeat(64);
const item = (o = {}) => ({ id: "7c1d2e3f-0000-4000-8000-0000000000a2", kind: "sources.update", tier: "T1", reason: "tier", originClient: "ios-native", args: { sourceIds: ["gcal:aaaaaaaaaaaa", "ical:bbbbbbbbbbbb"] }, createdAt: "2026-11-05T09:00:00.000Z", expiresAt: "2026-11-06T09:00:00.000Z", nonce: NONCE, ...o });

test("decodeApprovals keeps well-formed rows only and never trusts the shape", () => {
  const out = api.decodeApprovals({ items: [item(), item({ nonce: "short" }), item({ id: "../x" }), item({ tier: "D" }), null, "x"] });
  assert.equal(out.length, 1);
  assert.equal(out[0].nonce, NONCE);
  assert.deepEqual(api.decodeApprovals("nope"), []);
  assert.equal(api.decodeApprovals({ items: Array.from({ length: 500 }, () => item()) }).length, 50);
});

test("decodeSchedules: bounds and types", () => {
  const s = { id: "5a1b2c3d-0000-4000-8000-0000000000a1", kind: "sources.update", args: { sourceIds: ["gcal:aaaaaaaaaaaa"] }, intervalHours: 6, standing: true, standingUntil: "2026-12-05T09:00:00.000Z", createdAt: "2026-11-05T09:00:00.000Z", lastRunAt: null };
  assert.deepEqual(api.decodeSchedules({ items: [s, { ...s, intervalHours: 0 }, { ...s, id: 3 }] }), [s]);
});

test("buildScheduleInput: standing needs at least one source; days bounded", () => {
  assert.deepEqual(api.buildScheduleInput({ hours: 6, sourceIds: [], standing: false, days: 30 }), { ok: true, input: { kind: "sources.update", args: {}, intervalHours: 6 } });
  assert.equal(api.buildScheduleInput({ hours: 6, sourceIds: [], standing: true, days: 30 }).ok, false);
  assert.deepEqual(api.buildScheduleInput({ hours: 12, sourceIds: ["gcal:aaaaaaaaaaaa"], standing: true, days: 30 }), { ok: true, input: { kind: "sources.update", args: { sourceIds: ["gcal:aaaaaaaaaaaa"] }, intervalHours: 12, standing: true, standingDays: 30 } });
  assert.equal(api.buildScheduleInput({ hours: 6, sourceIds: ["gcal:aaaaaaaaaaaa"], standing: true, days: 91 }).ok, false);
  assert.equal(api.buildScheduleInput({ hours: 0, sourceIds: [], standing: false, days: 30 }).ok, false);
});

test("busApi: approve sends the nonce (and scheduleId when given); a non-2xx answer throws its error code", async () => {
  const calls = [];
  const raw = async (path, init) => { calls.push({ path, init }); return path.endsWith("/deny") ? { status: 409, body: { error: { code: "NOT_PENDING" } } } : { status: 200, body: { command: {} } }; };
  const b = api.busApi(raw);
  await b.approve(item(), { scheduleId: "5a1b2c3d-0000-4000-8000-0000000000a1" });
  assert.deepEqual(calls[0], { path: "/bus/commands/7c1d2e3f-0000-4000-8000-0000000000a2/approve", init: { method: "POST", body: { nonce: NONCE, scheduleId: "5a1b2c3d-0000-4000-8000-0000000000a1" } } });
  await assert.rejects(b.deny("7c1d2e3f-0000-4000-8000-0000000000a2"), (e) => e.code === "NOT_PENDING" && e.status === 409);
});

test("summarizeApproval: named sources, unknown ids flagged, origin in words, hostile text neutralised", () => {
  const names = sum.decodeSourceNames(
    { accounts: [{ accountId: "aaaaaaaaaaaa", email: "me@example.com", products: ["gcal", "gmail"] }] },
    { sources: [{ sourceId: "cccccccccccc", name: "Team‮" }] },
  );
  assert.deepEqual(names, { "gcal:aaaaaaaaaaaa": "me@example.com", "ical:cccccccccccc": "Team" });
  const s = sum.summarizeApproval(item(), names);
  assert.equal(s.title, "Sync connected sources");
  assert.equal(s.origin, "your iPhone");
  assert.deepEqual(s.lines, ["Google Calendar: me@example.com", "iCal feed bbbbbbbbbbbb (not connected now; it will be refused)"]);
  assert.equal(s.needsConfirm, false);
  assert.deepEqual(sum.summarizeApproval(item({ args: {} }), names).lines, ["Every connected Google Calendar, Google Drive and iCal source"]);
  const evil = sum.summarizeApproval(item({ kind: "x‮<img>", originClient: "relay\u0000", args: { a: "b\nc" } }), {});
  assert.ok(evil.title.startsWith("Unknown kind"));
  assert.ok(!/[‮\u0000\n]/.test(JSON.stringify(evil)));
  const t2 = item({ kind: "issues.implement", tier: "T2", args: { projectId: "p1", issueIds: ["2", "1"], ship: true } });
  assert.equal(sum.summarizeApproval(t2, {}).needsConfirm, true);
  assert.deepEqual(sum.confirmFor(t2), { projectId: "p1", issueIds: ["2", "1"], ship: true });
});

const sch = await load("approvals/scheduler.ts");
const H = 3_600_000;
const schedule = (o = {}) => ({ id: "5a1b2c3d-0000-4000-8000-0000000000a1", kind: "sources.update", args: { sourceIds: ["gcal:aaaaaaaaaaaa"] }, intervalHours: 6, standing: true, standingUntil: "2026-12-05T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", lastRunAt: null, ...o });

function fakeBus({ state = "awaiting_approval", deduped = false, origin = "desktop-ui", args } = {}) {
  const log = [];
  return {
    log,
    deps: (list, nowMs) => ({
      now: () => nowMs,
      schedules: async () => list,
      enqueue: async (f) => { log.push(["enqueue", f]); return { command: { id: `cmd-${f.idem.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 60), state }, deduped }; },
      approvals: async () => { log.push(["approvals"]); return list.map((s) => ({ id: `cmd-${sch.idemFor(s, nowMs).replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 60), kind: s.kind, originClient: origin, args: args ?? s.args, nonce: "a".repeat(64), tier: "T1" })); },
      approve: async (a, extra) => { log.push(["approve", a.id, extra]); },
    }),
  };
}

test("scheduler: one idem per slot; ttl is min(interval, 24 h); slots are epoch-anchored", () => {
  const s = schedule();
  const t = Date.parse("2026-11-05T13:00:00Z");
  assert.equal(sch.idemFor(s, t), `sched:${s.id}:${Math.floor(t / (6 * H))}`);
  assert.equal(sch.idemFor(s, t + H), sch.idemFor(s, t), "same slot within the interval");
  assert.notEqual(sch.idemFor(s, t + 6 * H), sch.idemFor(s, t));
  assert.ok(sch.idemFor(s, t).length <= 64, "fits the idem limit");
});

test("scheduler: a live standing approval enqueues then approves with the nonce and scheduleId", async () => {
  const f = fakeBus();
  const now = Date.parse("2026-11-05T13:00:00Z");
  const out = await sch.runSchedulesOnce(f.deps([schedule()], now));
  assert.deepEqual(out.approved, [schedule().id]);
  const enq = f.log.find((x) => x[0] === "enqueue")[1];
  assert.deepEqual(enq, { kind: "sources.update", args: { sourceIds: ["gcal:aaaaaaaaaaaa"] }, idem: sch.idemFor(schedule(), now), ttlMs: 6 * H });
  assert.deepEqual(f.log.find((x) => x[0] === "approve")[2], { scheduleId: schedule().id });
});

test("scheduler: never approves without a live standing approval, a different origin or different args", async () => {
  const now = Date.parse("2026-11-05T13:00:00Z");
  for (const [f, list, why] of [
    [fakeBus(), [schedule({ standing: false, standingUntil: null })], "ask each run"],
    [fakeBus(), [schedule({ standingUntil: "2026-11-05T12:59:00.000Z" })], "expired"],
    [fakeBus({ origin: "ios-native" }), [schedule()], "a phone command"],
    [fakeBus({ args: { sourceIds: ["gcal:aaaaaaaaaaaa", "ical:bbbbbbbbbbbb"] } }), [schedule()], "wider args"],
    [fakeBus({ state: "queued" }), [schedule()], "already approved"],
  ]) {
    const out = await sch.runSchedulesOnce(f.deps(list, now));
    assert.deepEqual(out.approved, [], why);
    assert.equal(f.log.filter((x) => x[0] === "approve").length, 0, why);
  }
});

test("scheduler: one failing schedule does not stop the others; errors carry the code only", async () => {
  const now = Date.parse("2026-11-05T13:00:00Z");
  const { BusCallError } = api;
  const good = schedule({ id: "5a1b2c3d-0000-4000-8000-0000000000b2" });
  const deps = {
    ...fakeBus().deps([schedule(), good], now),
    enqueue: async (f) => { if (f.idem.includes("0000000000a1")) throw new BusCallError(429, "QUOTA_EXCEEDED"); return { command: { id: "x", state: "queued" }, deduped: false }; },
  };
  const out = await sch.runSchedulesOnce(deps);
  assert.deepEqual(out.errors, [`${schedule().id}:QUOTA_EXCEEDED`]);
  assert.deepEqual(out.enqueued, [good.id]);
});

const inbox = await load("approvals/inbox-store.ts");

test("inbox: notifies once per new pending id with our own kind title; a 403 is a quiet error", async () => {
  let list = [item()];
  const notes = [];
  const s = inbox.createInboxStore({ approvals: async () => list, notify: (d) => { notes.push(d); } });
  await s.refresh(); await s.refresh();
  assert.deepEqual(notes, ["Sync connected sources"], "once per id");
  list = [item(), item({ id: "7c1d2e3f-0000-4000-8000-0000000000b9", kind: "evil‮" }), item({ id: "7c1d2e3f-0000-4000-8000-0000000000c9" })];
  await s.refresh();
  assert.deepEqual(notes, ["Sync connected sources", "2 jobs"]);
  assert.equal(s.getSnapshot().items.length, 3);
  const denied = inbox.createInboxStore({ approvals: async () => { throw new api.BusCallError(403, "TIER_DENIED"); }, notify: () => assert.fail("no notification") });
  await denied.refresh();
  assert.deepEqual(denied.getSnapshot(), { items: [], error: "TIER_DENIED" });
});
