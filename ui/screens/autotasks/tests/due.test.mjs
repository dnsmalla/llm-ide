import { test } from "node:test";
import assert from "node:assert/strict";
import { takeDueAutoTasks, minuteKey } from "../native/due.ts";

const at = new Date(2026, 10, 2, 9, 0); // Monday 09:00

test("two tasks due in the same minute are both returned, in catalog order", () => {
  const fired = new Set();
  const due = takeDueAutoTasks(
    [
      { id: "reviewCode", cron: "0 9 * * *", allowed: true },
      { id: "reviewDoc", cron: "0 * * * *", allowed: true },
      { id: "regression", cron: "0 9 * * 1-5", allowed: true },
    ],
    at,
    (key) => fired.has(key),
    (key) => fired.add(key),
  );
  assert.deepEqual(due, ["reviewCode", "reviewDoc", "regression"]);
});

test("a task already fired this minute is not returned again", () => {
  const fired = new Set([`reviewCode:${minuteKey(at)}`]);
  const due = takeDueAutoTasks([{ id: "reviewCode", cron: "0 9 * * *", allowed: true }], at, (key) => fired.has(key), () => {});
  assert.deepEqual(due, []);
});

test("disallowed, invalid and non-matching candidates are never returned or marked", () => {
  const marked = [];
  const due = takeDueAutoTasks(
    [
      { id: "off", cron: "0 9 * * *", allowed: false },
      { id: "bad", cron: "0 25 * * *", allowed: true },
      { id: "later", cron: "0 10 * * *", allowed: true },
    ],
    at,
    () => false,
    (key) => marked.push(key),
  );
  assert.deepEqual(due, []);
  assert.deepEqual(marked, []);
});
