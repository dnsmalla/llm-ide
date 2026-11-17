import { test } from "node:test";
import assert from "node:assert/strict";
import { PENDING_KEY, readPending, writePending } from "../native/pending-records.ts";

function mem(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
}
const rec = (over = {}) => ({ projectRoot: "/p", entry: { id: "e1", startedAt: "2026-11-09T10:00:00Z" }, record: { stages: [], stepReviews: [{ stageName: "x" }] }, copy: { prefix: "w", runId: "r", endedAt: "2026-11-09T10:00:00Z" }, marker: "w/.factory/RUN.json", ...over });

test("a pending record survives write then read, with every record field", () => {
  const s = mem();
  writePending(s, [rec(), rec({ copy: null })]);
  assert.deepEqual(readPending(s), [rec(), rec({ copy: null })]);
});

test("stage stdout over 4000 chars is truncated", () => {
  const s = mem();
  writePending(s, [rec({ record: { stages: [{ stageName: "t", run: { stdout: "a".repeat(9000), exitCode: 0 } }] } })]);
  assert.equal(readPending(s)[0].record.stages[0].run.stdout.length, 4000);
  assert.equal(readPending(s)[0].record.stages[0].run.exitCode, 0);
});

test("garbage, a non-array and malformed entries read as nothing", () => {
  assert.deepEqual(readPending(mem({ [PENDING_KEY]: "{not json" })), []);
  assert.deepEqual(readPending(mem({ [PENDING_KEY]: "{}" })), []);
  assert.deepEqual(readPending(undefined), []);
  const s = mem({ [PENDING_KEY]: JSON.stringify([{ entry: {}, record: {} }, rec()]) });
  assert.deepEqual(readPending(s), [rec()]);
});

test("writePending never throws", () => {
  assert.doesNotThrow(() => writePending({ setItem() { throw new Error("full"); } }, [rec()]));
  assert.doesNotThrow(() => writePending(undefined, [rec()]));
});
