import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_LIST_CAP, columnsFor, repoMatches, decodeIssues, filterIssues, assigneeSummary, createFingerprint, errorMessageOf, formatDueDate, createKeyAfter, idemKeyFor, importSummary, issueOpenUrl, labelNamespace, openedAgo, overlayRepoSupported, rawIssueCount, repoOptions, repoSlug } from "../issues-model.ts";

test("an edited create gets a new idempotency key; the same content keeps its key", () => {
  let n = 0;
  const mint = () => `k${++n}`;
  const fp = createFingerprint("github", "acme/web", " Bug ", "body");
  const first = idemKeyFor(null, fp, mint);
  assert.equal(idemKeyFor(first, fp, mint).key, first.key, "a retry with the same content replays the same key");
  const edited = idemKeyFor(first, createFingerprint("github", "acme/web", "Bug fixed", "body"), mint);
  assert.notEqual(edited.key, first.key, "an edited title is a new issue, not a 409 against the old key");
  assert.equal(createFingerprint("github", "acme/web", "Bug", "x") === createFingerprint("github", "acme/web", "Bug", "y"), false);
});

test("an ambiguous create keeps its key across a retry; only a created issue or a 409 ends it", () => {
  let n = 0;
  const mint = () => `k${++n}`;
  const fp = createFingerprint("github", "acme/web", "Bug", "body");
  const first = idemKeyFor(null, fp, mint);
  // A thrown error or a 5xx: the server may already have created it, so the retry must replay the same key.
  const afterTimeout = createKeyAfter(first, "failed");
  assert.equal(afterTimeout, first, "an ambiguous failure keeps the key");
  // Cancel and reopen do not touch the key; the same content still reuses it.
  assert.equal(idemKeyFor(afterTimeout, fp, mint).key, first.key, "the retry after Cancel reuses the key");
  assert.equal(createKeyAfter(first, "created"), null, "a success ends the key");
  assert.equal(createKeyAfter(first, "conflict"), null, "a 409 ends the key");
  // An edited form gets a new key regardless of what was kept.
  const edited = idemKeyFor(afterTimeout, createFingerprint("github", "acme/web", "Bug", "other"), mint);
  assert.notEqual(edited.key, first.key, "changed content is a new issue");
});

test("a truncated import says the rest was not read; a complete one reads as a count", () => {
  assert.equal(importSummary({ count: 1, truncated: false }), "Imported 1 issue.");
  assert.equal(importSummary({ count: 2400, truncated: false }), "Imported 2,400 issues.");
  const stopped = importSummary({ count: 300, truncated: true, retryAfter: 42.2 });
  assert.match(stopped, /^Imported 300 issues, but the import stopped early/);
  assert.match(stopped, /wait 43 s/);
  assert.match(importSummary({ count: 5, truncated: true, retryAfter: null }), /stopped early.*Import again to continue\.$/);
  assert.equal(importSummary(null), "Issues imported.");
});

test("an error message comes from the core's envelope, else the fallback", () => {
  assert.equal(errorMessageOf({ error: { code: "VALIDATION_FAILED", message: "Missing repo (owner/name)" } }, "x"), "Missing repo (owner/name)");
  assert.equal(errorMessageOf({ error: { message: "  " } }, "fallback"), "fallback");
  assert.equal(errorMessageOf("<html>", "fallback"), "fallback");
});

const issue = (over: Record<string, unknown> = {}) => ({
  id: "1", title: "T", body: "b", url: "https://github.com/o/r/issues/1", provider: "github",
  repo: "o/r", number: 1, state: "open", labels: [], author: "a", createdAt: "2026-01-01", isPR: false, ...over,
});

test("decode drops malformed rows, bounds labels, and restricts URLs to http(s)", () => {
  const out = decodeIssues({ issues: [
    issue({ labels: ["x", 1, "y"], url: "javascript:alert(1)" }),
    issue({ title: "" }),
    "nope",
  ] });
  assert.equal(out.length, 1, "the empty title and the non-object row are dropped; the malformed URL row survives without a link");
  assert.equal(out[0]!.url, "");
  assert.deepEqual(out[0]!.labels, ["x", "y"]);
});

test("the label namespace with the most issues wins; columns keep values and a no-status bucket", () => {
  const rows = decodeIssues({ issues: [
    issue({ id: "a", labels: ["status::todo"] }),
    issue({ id: "b", labels: ["status::doing"] }),
    issue({ id: "c", labels: ["priority::high"] }),
    issue({ id: "d", labels: [] }),
  ] });
  assert.equal(labelNamespace(rows), "status");
  const cols = columnsFor(rows);
  assert.deepEqual(cols.map((c) => c.title), ["No status", "doing", "todo"]);
  assert.deepEqual(cols.find((c) => c.title === "No status")?.issues.map((i) => i.id), ["c", "d"]);
});

test("without a namespaced label the board is Open/Closed and hides empty columns", () => {
  const rows = decodeIssues({ issues: [issue({ id: "a", state: "open" }), issue({ id: "b", state: "closed" })] });
  const cols = columnsFor(rows);
  assert.deepEqual(cols.map((c) => [c.title, c.issues.length]), [["Open", 1], ["Closed", 1]]);
  assert.deepEqual(columnsFor([]).map((c) => c.title), []);
});

test("filters: provider, state, repo substring, text; pull requests never appear", () => {
  const rows = decodeIssues({ issues: [
    issue({ id: "a", title: "Fix login", repo: "o/app" }),
    issue({ id: "b", title: "Docs", repo: "o/docs", state: "closed" }),
    issue({ id: "c", title: "PR", isPR: true }),
    issue({ id: "d", title: "GitLab", provider: "gitlab", repo: "g/p" }),
  ] });
  const base = { provider: "github" as const, state: "all" as const, repo: "", label: "", query: "" };
  assert.deepEqual(filterIssues(rows, base).map((i) => i.id), ["a", "b"]);
  assert.deepEqual(filterIssues(rows, { ...base, query: "login" }).map((i) => i.id), ["a"]);
  assert.deepEqual(filterIssues(rows, { ...base, state: "closed" }).map((i) => i.id), ["b"]);
  assert.deepEqual(filterIssues(rows, { ...base, repo: "docs" }).map((i) => i.id), ["b"]);
  assert.deepEqual(repoOptions(rows), ["g/p", "o/app", "o/docs"]);
});

test("decodeIssues strips a duplicated #number prefix from old cached titles", () => {
  const [row] = decodeIssues({ issues: [issue({ title: "#24 InboxStore: no concurrency protection", number: 24 })] });
  assert.equal(row.title, "InboxStore: no concurrency protection");
  assert.equal(row.number, 24);
});

test("the core's page size is 100 rows (the request limit); a page cap is reported by issue-paging, not here", () => {
  assert.equal(CORE_LIST_CAP, 100);
});

test("the 'first N only' hint counts the core's rows before any title-less row is dropped", () => {
  // 100 rows where one has no title: the screen shows 99, but the core returned a full page.
  const rows = Array.from({ length: CORE_LIST_CAP }, (_, k) => ({ id: String(k), title: k === 0 ? "" : `t${k}`, number: k + 1 }));
  const body = { issues: rows };
  assert.equal(rawIssueCount(body), 100);
  assert.equal(decodeIssues(body).length, 99);
  // Paging advances by the raw count, so the title-less row does not shift the next offset (see issue-paging).
  assert.equal(rawIssueCount({}), 0);
  assert.equal(rawIssueCount("nope"), 0);
});

test("repository URLs become owner/name slugs", () => {
  assert.equal(repoSlug("https://github.com/acme/web.git"), "acme/web");
  assert.equal(repoSlug("https://github.com/acme/web/"), "acme/web");
  assert.equal(repoSlug("acme/web"), "acme/web");
  assert.equal(repoSlug("not a repo"), "not a repo");
});

test("opened date reads as a relative age, '' when the timestamp is missing or malformed", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  assert.equal(openedAgo(null, now), "");
  assert.equal(openedAgo("garbage", now), "");
  // RelativeDateTimeFormatter's default is numeric, so the Mac says "1 day ago", not "yesterday".
  assert.equal(openedAgo("2026-11-01T12:00:00Z", now), "1 day ago");
  assert.equal(openedAgo("2026-10-19T12:00:00Z", now), "2 wk. ago");
  assert.equal(openedAgo("2026-07-01T12:00:00Z", now), "4 mo. ago");
  assert.equal(openedAgo("2024-10-01T12:00:00Z", now), "2 yr. ago");
  assert.equal(openedAgo("2026-11-04T12:00:00Z", now), "in 2 days", "a future timestamp (clock skew) reads forward");
  assert.equal(openedAgo("2026-10-30T12:00:00Z", now), "3 days ago");
  assert.equal(openedAgo("2026-11-02T10:00:00Z", now), "2 hr. ago");
});

test("nested GitLab groups keep their full path: 2-, 3- and 4-part repositories all slug and match issues", () => {
  assert.equal(repoSlug("https://gitlab.com/acme/web.git"), "acme/web");
  assert.equal(repoSlug("https://gitlab.com/acme/platform/web"), "acme/platform/web");
  assert.equal(repoSlug("https://gitlab.com/acme/platform/tools/web/"), "acme/platform/tools/web");
  assert.equal(repoSlug("https://gitlab.com/acme/platform/web.git?tab=issues#top"), "acme/platform/web");
  assert.equal(repoSlug("acme/platform/web"), "acme/platform/web");
  assert.equal(repoSlug("https://gitlab.com/acme"), "https://gitlab.com/acme", "one segment is not a project: the input itself");
  assert.equal(repoSlug("https://gitlab.com/acme/../web"), "https://gitlab.com/acme/../web");
  // The saved project's slug selects the same rows the core stored under its full path.
  const rows = decodeIssues({ issues: [
    issue({ id: "n", provider: "gitlab", repo: "acme/platform/web" }),
    issue({ id: "o", provider: "gitlab", repo: "acme/web" }),
  ] });
  const f = { provider: "gitlab" as const, state: "all" as const, repo: repoSlug("https://gitlab.com/acme/platform/web.git"), label: "", query: "" };
  assert.deepEqual(filterIssues(rows, f).map((i) => i.id), ["n"]);
});

test("the schedule overlay keys GitHub owner/name only; GitLab takes 2 to 20 segments (kb/issue-schedule.mjs assertRepo)", () => {
  assert.equal(overlayRepoSupported("acme/web", "github"), true);
  assert.equal(overlayRepoSupported("acme/platform/web", "github"), false, "the core answers 400 repo must be owner/name");
  assert.equal(overlayRepoSupported("acme/..", "github"), false);
  assert.equal(overlayRepoSupported("acme/web", "gitlab"), true, "2-part GitLab is unchanged");
  assert.equal(overlayRepoSupported("acme/platform/web", "gitlab"), true, "nested GitLab (3 parts) is keyed");
  assert.equal(overlayRepoSupported("a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t", "gitlab"), true, "20 segments is the core's limit");
  assert.equal(overlayRepoSupported("a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u", "gitlab"), false, "21 segments is a 400 in the core");
  assert.equal(overlayRepoSupported("acme/platform/../web", "gitlab"), false, "a dot segment is a 400 in the core");
  assert.equal(overlayRepoSupported("acme//web", "gitlab"), false, "an empty segment is a 400 in the core");
  assert.equal(overlayRepoSupported("acme/pla tform/web", "gitlab"), false, "a space is outside the segment set");
  assert.equal(overlayRepoSupported("acme web/x", "github"), false);
  assert.equal(overlayRepoSupported("", "github"), false);
  assert.equal(overlayRepoSupported("acme/web", "bitbucket"), false, "only github and gitlab are keyed");
});

test("repoSlug reads pasted page URLs, ssh and scp remotes without mistaking the page suffix for a nested group (review)", () => {
  assert.equal(repoSlug("https://gitlab.com/acme/web/-/issues"), "acme/web");
  assert.equal(repoSlug("https://gitlab.com/acme/platform/web/-/tree/main"), "acme/platform/web");
  assert.equal(repoSlug("https://github.com/o/r/issues/12"), "o/r");
  assert.equal(repoSlug("https://github.com/o/r/pulls"), "o/r");
  assert.equal(repoSlug("https://github.com/o/issues-tracker"), "o/issues-tracker", "whole segments only");
  assert.equal(repoSlug("git@gitlab.com:acme/platform/web.git"), "acme/platform/web");
  assert.equal(repoSlug("ssh://git@gitlab.com:2222/acme/web.git"), "acme/web");
  assert.equal(repoSlug("https://user:tok@gitlab.com/acme/web.git/"), "acme/web");
  assert.equal(repoSlug("HTTPS://GitHub.com/Owner/Repo.GIT"), "Owner/Repo", "case kept: the core stores the repo as typed");
  assert.notEqual(repoSlug("https://gitlab.com/a/b/c"), repoSlug("https://github.com/a/b"));
});

test("a chosen saved repository filters exactly and case-sensitively; the free-text box still matches substrings (review F6)", () => {
  const rows = decodeIssues({ issues: [
    issue({ id: "w", provider: "gitlab", repo: "acme/web" }),
    issue({ id: "api", provider: "gitlab", repo: "acme/web-api" }),
    issue({ id: "sub", provider: "gitlab", repo: "acme/web/sub" }),
    issue({ id: "up", provider: "gitlab", repo: "Acme/Web" }),
  ] });
  const f = { provider: "gitlab" as const, state: "all" as const, repo: "acme/web", label: "", query: "" };
  assert.deepEqual(filterIssues(rows, { ...f, repoExact: true }).map((i) => i.id), ["w"], "the select picks one repository, as the core and the Gantt match it");
  assert.deepEqual(filterIssues(rows, { ...f, repo: "acme/web/sub", repoExact: true }).map((i) => i.id), ["sub"]);
  assert.deepEqual(filterIssues(rows, { ...f, repoExact: false }).map((i) => i.id), ["w", "api", "sub", "up"], "typed text is a search");
  assert.equal(repoMatches("acme/web", "acme/web", true), true);
  assert.equal(repoMatches("acme/web-api", "acme/web", true), false);
  assert.equal(repoMatches("Acme/Web", "acme/web", true), false);
});

test("milestone (title and due day) and assignee logins decode as plain values, bounded; absent ones are null and []", () => {
  const [a, b] = decodeIssues({ issues: [
    issue({ id: "a", milestone: { title: "v1.0", dueOn: "2026-11-30T07:00:00Z" }, assignees: ["ann", 7, "", "bo"] }),
    issue({ id: "b", milestone: { title: "", dueOn: null }, assignees: "bo" }),
  ] });
  assert.deepEqual(a!.milestone, { title: "v1.0", dueOn: "2026-11-30T07:00:00Z" });
  assert.deepEqual(a!.assignees, ["ann", "bo"], "non-strings and blanks are dropped");
  assert.equal(b!.milestone, null, "a milestone with no title is no milestone");
  assert.deepEqual(b!.assignees, [], "a non-array assignees is empty");
  const [c] = decodeIssues({ issues: [issue({ milestone: { title: "x", dueOn: "not a date" } })] });
  assert.deepEqual(c!.milestone, { title: "x", dueOn: null }, "a malformed due date is dropped, the title kept");
  const [d] = decodeIssues({ issues: [issue({ assignees: Array.from({ length: 80 }, (_, k) => `u${k}`) })] });
  assert.equal(d!.assignees.length, 50, "at most 50 logins, as the schema says");
  assert.equal(formatDueDate(null), "");
  assert.match(formatDueDate("2026-11-30T12:00:00Z"), /^(Nov 30|Dec 1), 2026$/);
  assert.equal(formatDueDate("2026-11-30"), "Nov 30, 2026", "a bare day is the local day, never a day early");
  const [e] = decodeIssues({ issues: [issue({ milestone: { title: "x", dueOn: "1" } })] });
  assert.equal(e!.milestone!.dueOn, null, "a non-ISO date that Date.parse accepts is still dropped");
});

test("'Open on GitHub/GitLab' uses the core's url only on https://github.com or the saved GitLab origin", () => {
  const gh = { provider: "github", url: "https://github.com/o/r/issues/1" };
  assert.equal(issueOpenUrl(gh, "https://gitlab.example.com"), "https://github.com/o/r/issues/1");
  assert.equal(issueOpenUrl({ ...gh, url: "https://GitHub.COM/o/r/issues/1" }, null), "https://github.com/o/r/issues/1", "case is normalised");
  for (const bad of [
    "https://evil.example/o/r/issues/1",
    "https://github.com.evil.example/x",
    "https://evil.example/github.com",
    "https://github.com@evil.example/x",
    "https://github.com./o/r",
    "https://gíthub.com/o/r",
    "//github.com/o/r",
    "javascript:alert(1)//github.com",
    "data:text/html,https://github.com",
    "http://github.com/o/r/issues/1",
    "https://user:pw@github.com/o/r",
    "https://github.com:8443/o/r",
    "https://ghe.example.com/o/r/issues/1",
    "",
  ]) assert.equal(issueOpenUrl({ ...gh, url: bad }, null), "", bad);
  const gl = { provider: "gitlab", url: "https://gitlab.example.com/g/sub/p/-/issues/3" };
  assert.equal(issueOpenUrl(gl, "https://gitlab.example.com"), gl.url, "the saved GitLab origin");
  assert.equal(issueOpenUrl(gl, "https://gitlab.com"), "", "a GitLab link is not trusted from another host");
  assert.equal(issueOpenUrl(gl, null), "", "no saved GitLab origin, no link");
  assert.equal(issueOpenUrl({ ...gl, url: "http://gitlab.example.com/g/p/-/issues/3" }, "https://gitlab.example.com"), "", "scheme must match");
  // A self-hosted GitLab the user saved (http, private address, port) opens on that exact origin only.
  assert.equal(issueOpenUrl({ provider: "gitlab", url: "http://10.0.0.5:8080/g/p/-/issues/1" }, "http://10.0.0.5:8080"), "http://10.0.0.5:8080/g/p/-/issues/1");
  assert.equal(issueOpenUrl({ provider: "gitlab", url: "http://10.0.0.5/g/p/-/issues/1" }, "http://10.0.0.5:8080"), "", "port must match");
  assert.equal(issueOpenUrl({ provider: "gitlab", url: "https://u:p@gitlab.example.com/x" }, "https://gitlab.example.com"), "");
  // An over-long stored URL is dropped at decode, never cut into a different link.
  const [long] = decodeIssues({ issues: [issue({ url: `https://github.com/o/r/issues/1?${"a".repeat(3000)}` })] });
  assert.equal(long!.url, "");
});

test("the card's assignee line lists the first three logins as plain text, then a count", () => {
  assert.equal(assigneeSummary([]), "");
  assert.equal(assigneeSummary(["ann"]), "ann");
  assert.equal(assigneeSummary(["ann", "bo", "cy"]), "ann, bo, cy");
  assert.equal(assigneeSummary(["ann", "bo", "cy", "di", "ed"]), "ann, bo, cy +2");
});

test("the overlay's 255-character limit is inclusive, as in the core (review)", () => {
  assert.equal(overlayRepoSupported(`a/${"x".repeat(253)}`, "gitlab"), true, "255 characters");
  assert.equal(overlayRepoSupported(`a/${"x".repeat(254)}`, "gitlab"), false, "256 characters");
});
