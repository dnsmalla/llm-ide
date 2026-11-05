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
