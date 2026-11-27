import { test } from "node:test";
import assert from "node:assert/strict";
import { loadQueue, takeLegacyQueue } from "../native/queue.ts";
import { createStartGate } from "../native/start-gate.ts";

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k), map };
}

test("an old persisted queue is answered once, removed, and never restarted", () => {
  const storage = memoryStorage();
  const key = (root) => `llmide.loopQueue.v1.${root}`;
  storage.setItem(key("/p"), JSON.stringify([{ loopId: "a", scheduled: false, at: "t" }, { loopId: "b", scheduled: true, at: "t", command: "x" }, { loopId: "gone", scheduled: false, at: "t" }]));
  storage.setItem(key("/other"), JSON.stringify([{ loopId: "z", scheduled: false, at: "t" }]));
  const loops = [{ id: "a", name: "Plan" }, { id: "b", name: "Test" }];
  assert.deepEqual(loadQueue("/p", storage).map((x) => x.loopId), ["a", "b", "gone"]);
  const notice = takeLegacyQueue("/p", loops, storage);
  assert.match(notice, /^3 runs queued by an older version were not restarted/);
  assert.match(notice, /“Plan”, “Test”/);
  assert.match(notice, /Start them again with ▶ Run\./);
  assert.deepEqual(loadQueue("/p", storage), [], "the stored queue is gone");
  assert.equal(takeLegacyQueue("/p", loops, storage), null, "answered once");
  assert.deepEqual(loadQueue("/other", storage).map((x) => x.loopId), ["z"], "another project's queue is untouched");
  const one = memoryStorage();
  one.setItem(key("/p"), JSON.stringify([{ loopId: "a", scheduled: false, at: "t" }]));
  assert.match(takeLegacyQueue("/p", loops, one), /^1 run queued by an older version was not restarted \(“Plan”\)\. Start it again/);
  assert.equal(takeLegacyQueue("/p", loops, memoryStorage()), null);
});

test("the start gate lets one start through until it is released", () => {
  const gate = createStartGate();
  assert.equal(gate.held, false);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.held, true);
  assert.equal(gate.tryAcquire(), false, "a second start in the same tick is refused");
  gate.release();
  assert.equal(gate.tryAcquire(), true);
});

test("a Factory start still goes through the gate before its first await, and a blocked one is refused", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../native/NativeLoopScreen.tsx", import.meta.url), "utf8");
  const wrapper = src.slice(src.indexOf("const executeLoop = async"), src.indexOf("const startManaged ="));
  assert.ok(wrapper.indexOf("tryAcquire()") < wrapper.indexOf("await "), "the gate is taken before any await");
  assert.match(wrapper, /finally \{\s*releasePageRun\(\);\s*startGateRef\.current\.release\(\)/);
  assert.match(wrapper, /Another run is starting/);
});

test("a non-Factory run goes to the run manager through loopRunItem, and the page keeps no queue of its own", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../native/NativeLoopScreen.tsx", import.meta.url), "utf8");
  const start = src.slice(src.indexOf("const startManaged ="), src.indexOf("const runLoop ="));
  assert.match(start, /startRun\(root, loopRunItem\(target, \{ \.\.\.\(command \? \{ command \} : \{\}\), \.\.\.\(scheduled \? \{ scheduled: true \} : \{\}\) \}\), "full"\)/);
  assert.match(start, /installRunManagerHost\(\)/, "the host is wired before startRun");
  for (const gone of ["queueRef", "saveQueue", "persistQueue", "enqueueLoop", "waitingRef", "resumeQueue", "llmide-loop-board-notice", "shellBus.takePending", "setLiveCard", "runLoopWithDriver\\(\\{\\s*target, runConfig, runDeps, activeRun, oneItem: p"]) {
    assert.equal(new RegExp(gone).test(src), false, `${gone} is gone from the page`);
  }
  // the page observes the manager: run log, pause, stop, queue, end event
  assert.match(src, /subscribeLoopRunEvents\(\(e\) =>/);
  assert.match(src, /setRunPaused\(managed\.runId, true\)/);
  assert.match(src, /cancelRun\(r\.runId\)/);
  assert.match(src, /if \(ship\) setShipRun\(\{ info: ship\.info,/, "a held run opens the Ship panel from the end event");
});

test("the Loop schedule is read on every pass: an edit applies, a cleared one stays cleared, a minute fires once", async () => {
  const { readSchedule, scheduleTick } = await import("../native/schedule-tick.ts");
  const valid = (c) => /^\d+ \d+ \* \* \*$/.test(c);
  const matches = (c, now) => { const [m, h] = c.split(" ").map(Number); return now.getMinutes() === m && now.getHours() === h; };
  const at = (h, m) => new Date(2026, 10, 13, h, m, 5);

  assert.deepEqual(readSchedule(null), { cron: "", last: "" });
  assert.deepEqual(readSchedule("not json"), { cron: "", last: "" });
  assert.deepEqual(readSchedule(JSON.stringify({ cron: " 0 2 * * * ", last: "x" })), { cron: "0 2 * * *", last: "x" });

  // Fires at its minute, once.
  const first = scheduleTick({ cron: "0 2 * * *", last: "" }, at(2, 0), valid, matches);
  assert.equal(first.fire, true);
  assert.equal(scheduleTick(first.next, at(2, 0), valid, matches).fire, false, "the second pass in the same minute does not fire again");

  // The user changed 02:00 to 03:00: the old time no longer fires, the new one does.
  const edited = { cron: "0 3 * * *", last: "" };
  assert.equal(scheduleTick(edited, at(2, 0), valid, matches).fire, false);
  assert.equal(scheduleTick(edited, at(3, 0), valid, matches).fire, true);

  // The user cleared the field: nothing fires and nothing is written back (the old code re-saved the old cron here).
  assert.deepEqual(scheduleTick({ cron: "", last: "" }, at(2, 0), valid, matches), { fire: false, next: null });
  assert.deepEqual(scheduleTick({ cron: "bogus", last: "" }, at(2, 0), valid, matches), { fire: false, next: null });

  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../native/loop-schedule.ts", import.meta.url), "utf8");
  assert.match(src, /scheduleTick\(loadSchedule\(d\.storage, root\), d\.now\(\), d\.valid, d\.matches\)/, "the shell's timer reads the saved schedule on each pass");
  const page = readFileSync(new URL("../native/NativeLoopScreen.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /scheduleTick|setInterval\(tick/, "the page no longer owns a schedule timer");
});
