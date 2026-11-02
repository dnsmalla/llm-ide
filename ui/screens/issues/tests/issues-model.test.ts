import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_LIST_CAP, columnsFor, repoMatches, decodeIssues, filterIssues, isCapped, labelNamespace, openedAgo, overlayRepoSupported, rawIssueCount, repoOptions, repoSlug } from "../issues-model.ts";

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

test("the core's list cap is reported, not hidden", () => {
  assert.equal(CORE_LIST_CAP, 100);
  assert.equal(isCapped(99), false);
  assert.equal(isCapped(100), true);
});

test("the 'first N only' hint counts the core's rows before any title-less row is dropped", () => {
  // 100 rows where one has no title: the screen shows 99, but the core returned the cap, so the hint must show.
  const rows = Array.from({ length: CORE_LIST_CAP }, (_, k) => ({ id: String(k), title: k === 0 ? "" : `t${k}`, number: k + 1 }));
  const body = { issues: rows };
  assert.equal(rawIssueCount(body), 100);
  assert.equal(decodeIssues(body).length, 99);
  assert.equal(isCapped(rawIssueCount(body)), true);
  assert.equal(isCapped(decodeIssues(body).length), false, "the old count hid the hint: this is the defect");
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

test("the schedule overlay keys owner/name only: nested paths and dot segments are not overlay-able", () => {
  assert.equal(overlayRepoSupported("acme/web"), true);
  assert.equal(overlayRepoSupported("acme/platform/web"), false, "the core answers 400 repo must be owner/name");
  assert.equal(overlayRepoSupported("acme/.."), false);
  assert.equal(overlayRepoSupported("acme web/x"), false);
  assert.equal(overlayRepoSupported(""), false);
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
