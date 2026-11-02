import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_LIST_CAP, columnsFor, decodeIssues, filterIssues, isCapped, labelNamespace, openedAgo, rawIssueCount, repoOptions, repoSlug } from "../issues-model.ts";

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
