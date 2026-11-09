import { test } from "node:test";
import assert from "node:assert/strict";
import * as h from "../native/history.ts";

test("Loop journal index is read newest-first, month-rotated before legacy", async () => {
  const files = {
    "system/loop-runs/index-2026-09.jsonl": JSON.stringify({ id: "r1", startedAt: "2026-09-30T00:00:00Z", loopId: "l", loopName: "L", statusCode: "success" }) + "\n",
    "system/loop-runs/index.jsonl": JSON.stringify({ id: "r2", startedAt: "2026-08-01T00:00:00Z", loopId: "l", loopName: "L", statusCode: "failed" }) + "\n",
  };
  const fs = {
    async list(path) { assert.equal(path, "system/loop-runs"); return { entries: Object.keys(files).map((p) => ({ name: p.split("/").pop(), path: p })) }; },
    async read(path) { return { status: "ok", text: files[path] }; },
  };
  const runs = await h.readRecentRuns(fs);
  assert.deepEqual(runs.map((r) => r.id), ["r1", "r2"]);
  assert.equal((await h.readRecentRuns({ async list() { throw Object.assign(new Error("x"), { code: "missing" }); }, async read() { throw new Error("no"); } })).length, 0);
});

test("a native run appends a month-bucketed record and index line", async () => {
  const writes = [];
  const fs = {
    async create() { return "dir"; },
    async read() { throw Object.assign(new Error("missing"), { code: "missing" }); },
    async write(path, text, opts) { writes.push({ path, text, opts }); return { path, hash: "h" }; },
  };
  await h.appendRunRecord(fs, { id: "r1", loopId: "l", loopName: "L", startedAt: "2026-09-30T00:00:00Z", durationSeconds: 1, iterationsUsed: 1, statusCode: "success", statusSummary: "ok", trigger: "manual" }, { id: "r1" });
  assert.equal(writes[0].path, "system/loop-runs/2026-09/r1.json");
  assert.equal(writes[1].path, "system/loop-runs/index-2026-09.jsonl");
  assert.match(writes[1].text, /"id":"r1"/);
  assert.equal(writes[1].opts.expected_hash, null);
});

test("a run record is read from its month bucket", async () => {
  const fs = { async read(path) { assert.equal(path, "system/loop-runs/2026-09/r9.json"); return { status: "ok", text: '{"id":"r9","statusCode":"success"}' }; } };
  const r = await h.loadRunRecord(fs, "r9", "2026-09-30T01:02:03Z");
  assert.equal(r.statusCode, "success");
  assert.equal(await h.loadRunRecord({ async read() { throw new Error("no"); } }, "r9", "2026-09-30T01:02:03Z"), null);
});

test("a run record path is the month bucket its index entry names", async () => {
  const { runRecordPath } = await import("../native/history.ts");
  assert.equal(runRecordPath("abc", "2026-03-15T12:00:00Z"), "system/loop-runs/2026-03/abc.json");
});

function journalFs() {
  const files = new Map();
  const writes = [];
  return {
    files, writes,
    async create() { return "dir"; },
    async read(path) {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "not_found" });
      return { status: "ok", text: files.get(path), hash: `h-${path}` };
    },
    async write(path, text, opts) { writes.push({ path, opts }); files.set(path, text); return { path, hash: "h2" }; },
  };
}

const factoryEntry = { id: "r1", loopId: "l", loopName: "Factory", startedAt: "2026-11-09T10:00:00Z", durationSeconds: 5, iterationsUsed: 1, statusCode: "failed", statusSummary: "needs decision: see .factory/READINESS.md", trigger: "manual" };

test("run record keeps factory fields through the journal round trip", async () => {
  const fs = journalFs();
  const fields = {
    workItem: { source: "issue", id: "12", title: "Fix login" },
    worktree: { runId: "20261109-100000-abc123", branch: "factory/20261109-100000-abc123", baseCommit: "0123456789abcdef", repo: "/p/code/web" },
    ship: null,
    needsDecision: "needs decision: see .factory/READINESS.md",
    diffSummary: { files: ["src/a.ts"], truncated: false },
  };
  await h.appendRunRecord(fs, factoryEntry, { ...factoryEntry, ...fields });
  assert.deepEqual(h.decodeFactoryFields(await h.loadRunRecord(fs, "r1", factoryEntry.startedAt)), fields);

  const ship = { provider: "gitlab", url: "https://gitlab.com/g/p/-/merge_requests/3", commit: "abc123", reused: false };
  assert.equal(await h.setRunRecordShip(fs, factoryEntry, ship), true);
  const path = h.runRecordPath("r1", factoryEntry.startedAt);
  assert.equal(fs.writes.at(-1).path, path);
  assert.equal(fs.writes.at(-1).opts.expected_hash, `h-${path}`, "the update is a compare-and-set on the read hash");
  const after = h.decodeFactoryFields(await h.loadRunRecord(fs, "r1", factoryEntry.startedAt));
  assert.deepEqual(after.ship, ship);
  assert.deepEqual(after.workItem, fields.workItem, "the other fields survive the ship update");
});

test("factory fields decode to null for a plain run and for malformed values", async () => {
  const empty = { workItem: null, worktree: null, ship: null, needsDecision: null, diffSummary: null };
  assert.deepEqual(h.decodeFactoryFields(null), empty);
  assert.deepEqual(h.decodeFactoryFields({ id: "r9", statusCode: "success" }), empty);
  assert.deepEqual(h.decodeFactoryFields({
    workItem: { source: "evil", title: "x" },
    worktree: { runId: "r", branch: 3 },
    ship: { provider: "bitbucket", url: "u", commit: "c" },
    needsDecision: 7,
    diffSummary: { files: "nope" },
  }), empty);
  assert.deepEqual(h.decodeFactoryFields({ diffSummary: { files: ["a", 2], truncated: "yes" } }).diffSummary, { files: ["a"], truncated: false });
  assert.equal(await h.setRunRecordShip(journalFs(), factoryEntry, { provider: "github", url: "u", commit: "c", reused: false }), false, "a missing record is not created");
});
