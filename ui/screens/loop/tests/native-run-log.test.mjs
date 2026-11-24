import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RUN_LOG_LINES, TRIMMED_LINE, MAX_RUN_LOG_LINE_CHARS, appendRunLog, capRunLog } from "../native/run-log.ts";

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

test("a streamed chunk continues the last line and several newlines make new lines", () => {
  assert.deepEqual(appendRunLog(["$ x", "ab"], "cd"), ["$ x", "abcd"]);
  assert.deepEqual(appendRunLog(["ab"], "cd\nef\ngh"), ["abcd", "ef", "gh"]);
  assert.deepEqual(appendRunLog([], "x\ny"), ["x", "y"]);
  assert.deepEqual(appendRunLog(["a"], "b\n"), ["ab", ""]);
});

test("streaming past the line cap keeps the trimmed marker and a single over-long line is capped", () => {
  let l = [];
  for (let i = 0; i < MAX_RUN_LOG_LINES + 50; i++) l = appendRunLog(l, `l${i}\n`);
  assert.equal(l.length, MAX_RUN_LOG_LINES);
  assert.equal(l[0], TRIMMED_LINE);
  let big = [];
  for (let i = 0; i < 10; i++) big = appendRunLog(big, "x".repeat(1000));
  assert.equal(big.length, 1);
  assert.equal(big[0].length, MAX_RUN_LOG_LINE_CHARS + 1);
  assert.ok(big[0].endsWith("…"));
});
