import { test } from "node:test";
import assert from "node:assert/strict";
import * as c from "../native/cron.ts";

test("Auto Task cron validates five fields and describes the common schedules", () => {
  assert.equal(c.validateCron("0 * * * *"), true);
  assert.equal(c.validateCron("*/15 9-17 * * 1-5"), true);
  assert.equal(c.validateCron("0 25 * * *"), false);
  assert.equal(c.validateCron("0 * * *"), false);
  assert.equal(c.validateCron("0 */0 * * *"), false);
  assert.equal(c.describeCron("0 * * * *"), "Every hour");
  assert.equal(c.describeCron("0 9 * * 1-5"), "Weekdays at 09:00");
});

test("a range with a step is valid, like the plain step and the range forms cronMatches supports", () => {
  assert.equal(c.validateCron("0-30/10 * * * *"), true);
  assert.equal(c.validateCron("*/10 * * * *"), true);
  assert.equal(c.validateCron("0-30 * * * *"), true);
  assert.equal(c.validateCron("0-60/10 * * * *"), false); // range beyond the field's maximum
  assert.equal(c.validateCron("30-0/10 * * * *"), false); // reversed range
  assert.equal(c.validateCron("0-30/0 * * * *"), false); // zero step
  assert.equal(c.validateCron("0-30/x * * * *"), false);
  assert.equal(c.validateCron("5/10 * * * *"), false); // a step needs a range or *
  assert.equal(c.validateCron("1-2-3 * * * *"), false);
  assert.equal(c.validateCron("0-30/10/2 * * * *"), false);
  assert.equal(c.validateCron("0-30/10,45 * * * *"), true);
  assert.equal(c.cronMatches("0-30/10 * * * *", new Date(2026, 10, 2, 9, 20)), true);
  assert.equal(c.cronMatches("0-30/10 * * * *", new Date(2026, 10, 2, 9, 35)), false);
});

test("cronMatches handles steps, ranges, lists and the day OR rule", () => {
  const t = new Date(2026, 10, 2, 9, 30); // Monday
  assert.equal(c.cronMatches("30 9 * * *", t), true);
  assert.equal(c.cronMatches("*/15 9-17 * * 1-5", t), true);
  assert.equal(c.cronMatches("0,30 9 * * *", t), true);
  assert.equal(c.cronMatches("30 9 1 * 1", t), true); // dom OR dow
  assert.equal(c.cronMatches("31 9 * * *", t), false);
});
