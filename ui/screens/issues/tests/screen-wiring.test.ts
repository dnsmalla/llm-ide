import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the Issues and Gantt screens walk the list with a cancellable, sequence-guarded load and no fixed 100-row hint", () => {
  const issues = read("../IssuesScreen.tsx");
  const gantt = read("../../gantt/GanttScreen.tsx");
  for (const src of [issues, gantt]) {
    assert.equal(src.includes("First ${CORE_LIST_CAP} only"), false, "the old fixed hint is gone");
    assert.equal(src.includes("Showing the first ${CORE_LIST_CAP}"), false);
    assert.match(src, /abortRef\.current\?\.abort\(\);\s*const ctrl = new AbortController\(\);/, "each load aborts the one before it");
    assert.match(src, /useEffect\(\(\) => \(\) => abortRef\.current\?\.abort\(\), \[\]\);/, "unmount cancels the walk");
    assert.match(src, /if \(ctrl\.signal\.aborted\) return;/, "a superseded walk never applies its rows");
    assert.match(src, /pagingNote\(/, "the count line says what was loaded and why it stopped");
  }
  assert.match(issues, /loadIssuePages\(deps\.request, \{ provider: filters\.provider, state: filters\.state \}/);
  assert.match(gantt, /loadTimeline\(deps\.request, provider, repo, \{\s*signal: ctrl\.signal/);
});

test("the detail opens only the vetted URL, and shows milestone and assignees as text", () => {
  const detail = read("../IssueDetail.tsx");
  assert.match(detail, /const openUrl = issueOpenUrl\(issue, gitlabOriginFromConfig\(\)\);/);
  assert.match(detail, /void deps\.openExternal\(openUrl\)/);
  assert.equal(detail.includes("deps.openExternal(issue.url)"), false, "the raw stored URL is never opened");
  assert.match(detail, /disabled=\{!openUrl\}/);
  assert.match(detail, /Assigned to \{issue\.assignees\.join\(", "\)\}/);
  assert.equal(/dangerouslySetInnerHTML|<a\s[^>]*href=\{.*login/i.test(detail), false, "logins are never links or HTML");
});

test("a failed first page clears the count note from the previous load, and a later-page 401 shows the sign-in banner (issues screen)", () => {
  const issues = read("../IssuesScreen.tsx");
  assert.match(issues, /if \(r\.stop === "error" && r\.issues\.length === 0\) \{\s*setPhase\("error"\);\s*setError\(issuesLoadError\(r\)\);\s*(?:\/\/[^\n]*\n\s*)?setPaging\(null\);/, "the error branch drops the previous walk's count note");
  assert.match(issues, /setRows\(r\.issues\);\s*setPaging\(r\);\s*setError\(issuesLoadError\(r\)\);/, "a partial walk with a 401 shows the banner next to the rows it kept");
  assert.equal(issues.includes("r.status === 401 ? \"Sign in again to read issues.\""), false, "the message lives in issuesLoadError, one copy");
});

test("New issue sends one idempotency key per issue and drops it after a success or a key conflict", () => {
  const issues = read("../IssuesScreen.tsx");
  assert.match(issues, /const createIdem = useRef<string \| null>\(null\);/);
  assert.match(issues, /createIdem\.current \?\?= crypto\.randomUUID\(\);/);
  assert.match(issues, /"\/kb\/issues\/create", \{ provider: filters\.provider, repo, title: createTitle\.trim\(\), body: createBody, idem: createIdem\.current \}/);
  assert.match(issues, /if \(r\.status === 409\) createIdem\.current = null;/, "an edited retry after a lost answer gets a new key");
  assert.match(issues, /createIdem\.current = null;\s*setNotice\("Issue created\."\);/);
});
