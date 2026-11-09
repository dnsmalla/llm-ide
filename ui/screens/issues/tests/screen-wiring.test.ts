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

test("New issue derives its idempotency key from the content, drops it only on a success or a 409, and keeps it through Cancel and ambiguous failures", () => {
  const issues = read("../IssuesScreen.tsx");
  assert.match(issues, /const createKey = useRef<\{ fingerprint: string; key: string \} \| null>\(null\);/);
  assert.match(issues, /createKey\.current = idemKeyFor\(createKey\.current, createFingerprint\(filters\.provider, repo, createTitle, createBody\), \(\) => crypto\.randomUUID\(\)\);/);
  assert.match(issues, /"\/kb\/issues\/create", \{ provider: filters\.provider, repo, title: createTitle\.trim\(\), body: createBody, idem: createKey\.current\.key \}/);
  assert.match(issues, /createKey\.current = createKeyAfter\(createKey\.current, r\.status === 409 \? "conflict" : "failed"\);/);
  assert.match(issues, /createKey\.current = createKeyAfter\(createKey\.current, "created"\);\s*setNotice\("Issue created\."\);/);
  assert.match(issues, /onClick=\{\(\) => setCreateOpen\(false\)\}/, "Cancel only closes the form");
  assert.equal(issues.includes("setCreateOpen(false); createKey.current = null"), false, "Cancel must not drop the key");
  assert.equal(issues.includes("createIdem"), false, "the old single-key ref is gone");
  assert.equal(issues.includes("|| filters.repo"), false, "a substring repo filter never becomes the create repo");
});

test("the create form prefills from the saved repository select only", () => {
  const issues = read("../IssuesScreen.tsx");
  assert.match(issues, /onClick=\{openCreate\}/);
  assert.match(issues, /setCreateRepo\(saved \? filters\.repo : ""\);/);
});

test("the import banner uses the core's message, and says when the import stopped early", () => {
  const issues = read("../IssuesScreen.tsx");
  assert.match(issues, /errorMessageOf\(r\.body, `The GitHub import failed \(\$\{r\.status\}\)\.`\)/);
  assert.match(issues, /setNotice\(importSummary\(r\.body\)\);/);
  assert.equal(issues.includes('`Imported ${n.toLocaleString'), false, "the bare count line is gone");
});

test("the detail dialog shows the row as the latest reload has it, by id, not the click-time snapshot", () => {
  const issues = read("../IssuesScreen.tsx");
  assert.match(issues, /const detailIssue = useMemo\(\(\) => \(selected \? rows\.find\(\(r\) => r\.id === selected\.id\) \?\? selected : null\), \[rows, selected\]\);/);
  assert.match(issues, /<IssueDetail issue=\{detailIssue\}/);
});

test("a successful close closes the dialog; the write resolves to whether it succeeded", () => {
  const detail = read("../IssueDetail.tsx");
  assert.match(detail, /write\("\/kb\/issues\/close", \{\}, "Issue closed\."\)\.then\(\(ok\) => \{ if \(ok\) onClose\(\); \}\)/);
});

test("the board says it is per user, and project switches remount the section (so filters and selection reset)", () => {
  const issues = read("../IssuesScreen.tsx");
  assert.match(issues, /per user, not per project/);
  const shell = readFileSync(new URL("../../shell/Shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /key=\{`\$\{def\.id\}:\$\{def\.id === "spike" \? "" : \(project\?\.root \?\? ""\)\}`\}/, "the shell keys section slots by project root");
});
