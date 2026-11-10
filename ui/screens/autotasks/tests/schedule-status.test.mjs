import { test } from "node:test";
import assert from "node:assert/strict";
import * as c from "../native/cron.ts";
import * as m from "../native/model.ts";

test("nextFireAfter finds the next matching minute, skipping weekends for a weekday schedule", () => {
  const monday930 = new Date(2026, 10, 2, 9, 30); // Monday 2026-11-02
  const next = c.nextFireAfter("0 9 * * 1-5", monday930);
  assert.equal(next.getFullYear(), 2026); assert.equal(next.getMonth(), 10); assert.equal(next.getDate(), 3);
  assert.equal(next.getHours(), 9); assert.equal(next.getMinutes(), 0);
  assert.equal(c.nextFireAfter("0 9 * * *", monday930).getDate(), 3);
  assert.equal(c.nextFireAfter("bad", monday930), null);
  assert.equal(c.nextFireAfter("0 0 31 2 *", monday930, 60 * 24 * 3), null); // never fires inside the horizon
});

test("fireLabel shows the time as HH:mm", () => {
  assert.match(c.fireLabel(new Date(2026, 10, 2, 9, 5)), / 09:05$/);
});

test("the schedule status line follows the Mac's order of checks", () => {
  const now = new Date(2026, 10, 2, 9, 30);
  const on = { enabled: true, inputPath: "", outputPath: "", skillName: "", template: "builtin", prompt: "", cron: "0 * * * *", scheduleActive: true };
  assert.equal(m.scheduleStatusLine(true, { ...on, scheduleActive: false }, "reviewCode", now), "Schedule off — runs only when you press Run");
  assert.equal(m.scheduleStatusLine(false, on, "reviewCode", now), "Auto Tasks paused — master switch off");
  assert.equal(m.scheduleStatusLine(true, { ...on, enabled: false }, "reviewCode", now), "Task disabled — won't run");
  assert.match(m.scheduleStatusLine(true, on, "reviewCode", now), /^Scheduled · next \S+ 10:00$/);
  assert.match(m.scheduleStatusLine(true, on, "implementIssues", now), /Mac app only/);
  assert.equal(m.scheduleStatusLine(true, on, "issues.from_notes", now), "Manual only — runs only when you press Run");
});
