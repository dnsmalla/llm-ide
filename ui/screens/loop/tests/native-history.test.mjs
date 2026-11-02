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
