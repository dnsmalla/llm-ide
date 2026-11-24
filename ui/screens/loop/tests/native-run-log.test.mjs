import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RUN_LOG_LINES, TRIMMED_LINE, capRunLog } from "../native/run-log.ts";

test("a log within the cap is returned as is", () => {
  const l = ["a", "b"];
  assert.equal(capRunLog(l), l);
});

test("an over-long log keeps the newest lines under one trimmed marker, and never grows past the cap", () => {
  let l = Array.from({ length: MAX_RUN_LOG_LINES }, (_, i) => `l${i}`);
  for (let i = 0; i < 5; i++) l = capRunLog([...l, `new${i}`]);
  assert.equal(l.length, MAX_RUN_LOG_LINES);
  assert.equal(l[0], TRIMMED_LINE);
  assert.equal(l.filter((x) => x === TRIMMED_LINE).length, 1);
  assert.equal(l.at(-1), "new4");
});
