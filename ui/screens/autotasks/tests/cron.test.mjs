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
