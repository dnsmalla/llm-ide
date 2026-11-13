import assert from "node:assert/strict";
import test from "node:test";
import { beginScheduledRun, endScheduledRun, getScheduledRun, stopScheduledRun, subscribeScheduledRun } from "../native/scheduled-run.ts";

test("the scheduled run is visible, stoppable through its signal, and cleared when it ends", () => {
  let notified = 0;
  const off = subscribeScheduledRun(() => { notified++; });
  assert.equal(getScheduledRun(), null);
  assert.equal(stopScheduledRun(), false);
  const abort = beginScheduledRun("Review code", () => new Date("2026-11-13T00:00:00Z"));
  assert.deepEqual(getScheduledRun(), { label: "Review code", startedAt: "2026-11-13T00:00:00.000Z" });
  assert.strictEqual(getScheduledRun(), getScheduledRun(), "a stable snapshot for useSyncExternalStore");
  assert.equal(abort.signal.aborted, false);
  assert.equal(stopScheduledRun(), true);
  assert.equal(abort.signal.aborted, true);
  endScheduledRun(new AbortController());
  assert.notEqual(getScheduledRun(), null, "an unrelated controller does not clear it");
  endScheduledRun(abort);
  assert.equal(getScheduledRun(), null);
  assert.equal(notified, 2);
  off();
});
