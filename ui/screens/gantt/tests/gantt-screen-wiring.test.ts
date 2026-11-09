import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("a queued move is tied to its provider and repo: a change clears the queue, and a save that finishes after one is not reloaded into the new view", () => {
  const gantt = read("../GanttScreen.tsx");
  assert.match(gantt, /useEffect\(\(\) => \{\s*shiftQueueRef\.current\.length = 0;\s*setShiftFailure\(null\);\s*\}, \[provider, repo\]\);/);
  assert.match(gantt, /const savedScope = scopeRef\.current;/);
  assert.match(gantt, /if \(scopeRef\.current !== savedScope\) continue;/);
  assert.match(gantt, /settleShift\(shiftQueueRef\.current, item, savedDays\);/);
});

test("a network failure from a save started in another view never shows its banner in the current one", () => {
  const gantt = read("../GanttScreen.tsx");
  assert.match(gantt, /let itemScope = "";/);
  assert.match(gantt, /itemScope = savedScope;/);
  assert.match(gantt, /catch \{\s*\/\/[^\n]*\n\s*if \(scopeRef\.current !== savedScope\) continue;\s*failShift\(item, "The core is not reachable right now\."\);/);
  assert.match(gantt, /if \(item && scopeRef\.current === itemScope\) failShift\(item, "The core is not reachable right now\."\);/);
});

test("a failed move keeps an explicit retry and reports what was queued behind it", () => {
  const gantt = read("../GanttScreen.tsx");
  assert.match(gantt, /Retry move/);
  assert.match(gantt, /onClick=\{\(\) => onShift\(shiftFailure\.row, shiftFailure\.days\)\}/);
  assert.match(gantt, /queued move\$\{shiftFailure\.dropped === 1 \? " was" : "s were"\} not saved/);
});

test("the detail dialog re-resolves its issue from the reloaded rows", () => {
  const gantt = read("../GanttScreen.tsx");
  assert.match(gantt, /const detailIssue = useMemo\(\(\) => \(detail \? issues\.find\(\(i\) => i\.id === detail\.id\) \?\? detail : null\), \[issues, detail\]\);/);
  assert.match(gantt, /<IssueDetail\s+issue=\{detailIssue\}/);
});
