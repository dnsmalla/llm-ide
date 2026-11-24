import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_CONFIG_KEY, AUTO_WAIT_MS, autoTickOnce, dayKey, isDue, loadAutoConfig, loadAutoState, readAutoConfig, readAutoState, saveAutoConfig, saveAutoState, type AutoConfig, type AutoDeps, type AutoState } from "../self-heal-auto.ts";
import type { RunResult } from "../self-heal-run.ts";

const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m);
const on: AutoConfig = { enabled: true, time: "12:30" };
const fresh: AutoState = { lastRunDay: "", waitUntil: 0, last: null };

function deps(o: { now?: Date; config?: AutoConfig; state?: AutoState; recording?: boolean; loopBusy?: boolean; run?: () => Promise<RunResult>; before?: string[]; after?: string[] } = {}) {
  let state: AutoState = o.state ?? fresh;
  const seen = { runs: 0, notified: 0, stateAtRun: null as AutoState | null };
  let human = 0;
  const d: AutoDeps = {
    now: () => o.now ?? at(24, 12, 31),
    config: () => o.config ?? on,
    state: () => state,
    save: (s) => { state = s; },
    recording: () => o.recording ?? true,
    loopBusy: () => o.loopBusy ?? false,
    needsHuman: async () => new Set((human++ === 0 ? o.before : o.after) ?? []),
    run: async () => { seen.runs += 1; seen.stateAtRun = state; return o.run ? o.run() : { proposed: 0, message: "No new incidents to fix." }; },
    notify: async () => { seen.notified += 1; },
  };
  return { d, seen, state: () => state };
}

test("readAutoConfig defaults off at 12:30 and rejects a bad time", () => {
  assert.deepEqual(readAutoConfig(null), { enabled: false, time: "12:30" });
  assert.deepEqual(readAutoConfig("{"), { enabled: false, time: "12:30" });
  assert.deepEqual(readAutoConfig('{"enabled":true,"time":"25:99"}'), { enabled: true, time: "12:30" });
  assert.deepEqual(readAutoConfig('{"enabled":true,"time":""}'), { enabled: true, time: "12:30" });
  assert.deepEqual(readAutoConfig('{"enabled":true,"time":"07:05"}'), { enabled: true, time: "07:05" });
  assert.deepEqual(readAutoState("nope"), fresh);
});

test("isDue: before the time no, after it yes, once a day", () => {
  assert.equal(isDue(on, fresh, at(24, 12, 29)), false);
  assert.equal(isDue(on, fresh, at(24, 12, 30)), true);
  assert.equal(isDue(on, fresh, at(24, 18, 0)), true, "a missed time runs later the same day");
  const ran = { ...fresh, lastRunDay: dayKey(at(24, 12, 30)) };
  assert.equal(isDue(on, ran, at(24, 18, 0)), false);
  assert.equal(isDue(on, ran, at(25, 12, 29)), false);
  assert.equal(isDue(on, ran, at(25, 12, 30)), true);
  assert.equal(isDue({ ...on, enabled: false }, fresh, at(24, 13, 0)), false);
  assert.equal(isDue(on, { ...fresh, waitUntil: at(24, 13, 0).getTime() }, at(24, 12, 45)), false);
});

test("a tick marks the day before running, so a reload mid-run does not run again", async () => {
  const f = deps();
  assert.equal(await autoTickOnce(f.d), "ran");
  assert.equal(f.seen.stateAtRun?.lastRunDay, dayKey(at(24, 12, 31)));
  assert.equal(await autoTickOnce(f.d), "skipped");
  assert.equal(f.seen.runs, 1);
});

test("a live Loop run waits 30 minutes and does not use up the day", async () => {
  const f = deps({ loopBusy: true });
  assert.equal(await autoTickOnce(f.d), "waiting");
  assert.equal(f.seen.runs, 0);
  assert.equal(f.state().lastRunDay, "");
  assert.equal(f.state().waitUntil, at(24, 12, 31).getTime() + AUTO_WAIT_MS);
});

test("a 409 RUN_ACTIVE gives the day back and waits", async () => {
  const f = deps({ state: { ...fresh, lastRunDay: "2026-11-23" }, run: async () => { throw Object.assign(new Error("x"), { status: 409, code: "RUN_ACTIVE" }); } });
  assert.equal(await autoTickOnce(f.d), "waiting");
  assert.equal(f.state().lastRunDay, "2026-11-23");
  assert.equal(f.state().waitUntil, at(24, 12, 31).getTime() + AUTO_WAIT_MS);
});

test("a failed run keeps the day and records why", async () => {
  const f = deps({ run: async () => { throw new Error("core down"); } });
  assert.equal(await autoTickOnce(f.d), "ran");
  assert.equal(f.state().lastRunDay, dayKey(at(24, 12, 31)));
  assert.match(f.state().last?.message ?? "", /core down/);
  assert.equal(f.seen.notified, 0);
});

test("notifies when a fix is proposed or an incident newly needs a person", async () => {
  const proposed = deps({ run: async () => ({ proposed: 1, message: "1 fix proposed. Review below." }) });
  await autoTickOnce(proposed.d);
  assert.equal(proposed.seen.notified, 1);
  assert.equal(proposed.state().last?.message, "1 fix proposed. Review below.");
  const stuck = deps({ before: ["a"], after: ["a", "b"] });
  await autoTickOnce(stuck.d);
  assert.equal(stuck.seen.notified, 1);
  const same = deps({ before: ["a"], after: ["a"] });
  await autoTickOnce(same.d);
  assert.equal(same.seen.notified, 0);
});

test("release build or recording off: nothing happens", async () => {
  const f = deps({ recording: false });
  assert.equal(await autoTickOnce(f.d), "skipped");
  assert.equal(f.seen.runs, 0);
  assert.deepEqual(f.state(), fresh);
});

test("a wait expiring after midnight does not run the old day", async () => {
  const f = deps({ now: at(25, 0, 10), state: { ...fresh, waitUntil: at(24, 23, 50).getTime() } });
  assert.equal(await autoTickOnce(f.d), "skipped");
  assert.equal(f.seen.runs, 0);
});

test("storage that throws reads as off and a save reports failure", () => {
  const g = globalThis as { localStorage?: unknown };
  const had = g.localStorage;
  try {
    g.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    assert.deepEqual(loadAutoConfig(), { enabled: false, time: "12:30" });
    assert.deepEqual(loadAutoState(), fresh);
    assert.equal(saveAutoConfig(on), false);
    saveAutoState(fresh); // never throws
    const map = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
    assert.equal(saveAutoConfig(on), true);
    assert.deepEqual(JSON.parse(map.get(AUTO_CONFIG_KEY) ?? "null"), on);
    assert.deepEqual(loadAutoConfig(), on);
  } finally {
    g.localStorage = had;
  }
});
