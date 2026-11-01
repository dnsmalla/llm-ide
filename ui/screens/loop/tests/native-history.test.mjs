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
