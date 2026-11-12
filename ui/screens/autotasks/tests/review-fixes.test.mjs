import { test } from "node:test";
import assert from "node:assert/strict";
import * as c from "../native/cron.ts";
import * as m from "../native/model.ts";
import * as u from "../native/usage.ts";
import { budget } from "../../test-support/perf.ts";

test("a resolve error does not block the run (Mac resolveModelForRun parity) and is logged", async () => {
  const d = await u.decideRun(async () => { throw new Error("404"); });
  assert.equal(d.proceed, true);
  assert.equal(d.model, undefined);
  assert.match(d.warning, /could not be checked \(404\)/);
  const ok = await u.decideRun(async () => ({ provider: "anthropic", model: "m2", status: "ok", engaged: true }));
  assert.deepEqual(ok, { proceed: true, model: "m2" });
});

test("a paused notice carries the reset time, as on the Mac", () => {
  const d = u.runDecision({ provider: "anthropic", model: null, status: "paused", reason: "All anthropic models have hit their limit.", resetAt: "2026-11-03T00:00:00.000Z" });
  assert.equal(d.notice, "All anthropic models have hit their limit. Resets 2026-11-03T00:00:00.000Z.");
});

test("Save writes only the providers the user changed", () => {
  const r = (model) => ({ provider: "x", model, label: model, priority: 0, enabled: true, limit_value: 0, unit: "runs", window_kind: "daily", threshold_pct: 90, custom: false });
  const rows = { anthropic: [r("a")], openai: [r("b")], empty: [] };
  assert.deepEqual(u.providersToSave(rows, new Set(["anthropic", "empty"])).map(([p]) => p), ["anthropic"]);
  assert.deepEqual(u.providersToSave(rows, new Set()), []);
});

test("a task that cannot run says so first, whatever its schedule flags", () => {
  const now = new Date(2026, 10, 2, 9, 30);
  const off = { enabled: false, inputPath: "", outputPath: "", skillName: "", template: "builtin", prompt: "", cron: "0 * * * *", scheduleActive: false };
  assert.equal(m.scheduleStatusLine(true, off, "generateKnowledge", now), m.taskUnavailableReason("generateKnowledge"));
  assert.equal(m.scheduleStatusLine(false, { ...off, scheduleActive: true }, "generateKnowledge", now), m.taskUnavailableReason("generateKnowledge"));
  assert.doesNotMatch(m.scheduleStatusLine(true, off, "generateKnowledge", now), /Mac app/);
});

test("day-of-week 7 is Sunday, as validateCron accepts it", () => {
  const sunday = new Date(2026, 10, 1, 9, 0);
  assert.equal(c.cronMatches("0 9 * * 7", sunday), true);
  assert.equal(c.cronMatches("0 9 * * 5-7", sunday), true);
  assert.equal(c.cronMatches("0 9 * * 7", new Date(2026, 10, 2, 9, 0)), false);
  assert.equal(c.nextFireAfter("0 9 * * 7", new Date(2026, 10, 2, 9, 30)).getDate(), 8);
});

test("nextFireAfter is fast for yearly and never-firing expressions and still exact", () => {
  const t0 = performance.now();
  const next = c.nextFireAfter("30 9 1 1 *", new Date(2026, 0, 2));
  assert.equal(c.nextFireAfter("0 0 31 2 *", new Date(2026, 0, 2)), null);
  assert.ok(performance.now() - t0 < budget(100), "should skip whole days and hours");
  assert.deepEqual([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()], [2027, 0, 1, 9, 30]);
  // Minute precision inside a matching hour, and strictly after `from`.
  const n2 = c.nextFireAfter("*/15 10 * * *", new Date(2026, 10, 2, 10, 15, 20));
  assert.deepEqual([n2.getDate(), n2.getHours(), n2.getMinutes()], [2, 10, 30]);
  const n3 = c.nextFireAfter("0 9 * * *", new Date(2026, 10, 2, 23, 59));
  assert.deepEqual([n3.getDate(), n3.getHours(), n3.getMinutes()], [3, 9, 0]);
});
