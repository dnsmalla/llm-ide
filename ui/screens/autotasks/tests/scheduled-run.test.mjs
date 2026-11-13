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

test("Stop also holds back the rest of the scheduler pass, until the next pass begins", async () => {
  const m = await import("../native/scheduled-run.ts");
  m.beginScheduledPass();
  assert.equal(m.scheduledPassStopped(), false);
  const abort = m.beginScheduledRun("Nightly review");
  assert.equal(m.stopScheduledRun(), true);
  assert.equal(abort.signal.aborted, true);
  assert.equal(m.scheduledPassStopped(), true, "the next due task of this pass must not start");
  m.endScheduledRun(abort);
  assert.equal(m.scheduledPassStopped(), true, "still this pass");
  m.beginScheduledPass();
  assert.equal(m.scheduledPassStopped(), false, "a later pass runs normally");
  assert.equal(m.stopScheduledRun(), false, "nothing running: nothing to stop, and no pass is held back");
  assert.equal(m.scheduledPassStopped(), false);
});
