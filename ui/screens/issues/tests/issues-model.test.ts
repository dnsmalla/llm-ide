import { test } from "node:test";
import assert from "node:assert/strict";
import { columnsFor, decodeIssues, filterIssues, labelNamespace, repoOptions } from "../issues-model.ts";

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
  assert.deepEqual(cols.map((c) => c.title), ["doing", "todo", "No status"]);
  assert.deepEqual(cols.find((c) => c.title === "No status")?.issues.map((i) => i.id), ["c", "d"]);
});

test("without a namespaced label the board is Open/Closed, including empty columns", () => {
  const rows = decodeIssues({ issues: [issue({ id: "a", state: "open" }), issue({ id: "b", state: "closed" })] });
  const cols = columnsFor(rows);
  assert.deepEqual(cols.map((c) => [c.title, c.issues.length]), [["Open", 1], ["Closed", 1]]);
  assert.deepEqual(columnsFor([]).map((c) => c.title), ["Open", "Closed"]);
});

test("filters: provider, state, repo substring, text; pull requests never appear", () => {
  const rows = decodeIssues({ issues: [
    issue({ id: "a", title: "Fix login", repo: "o/app" }),
    issue({ id: "b", title: "Docs", repo: "o/docs", state: "closed" }),
    issue({ id: "c", title: "PR", isPR: true }),
    issue({ id: "d", title: "GitLab", provider: "gitlab", repo: "g/p" }),
  ] });
  const base = { provider: "github" as const, state: "all" as const, repo: "", query: "" };
  assert.deepEqual(filterIssues(rows, base).map((i) => i.id), ["a", "b"]);
  assert.deepEqual(filterIssues(rows, { ...base, query: "login" }).map((i) => i.id), ["a"]);
  assert.deepEqual(filterIssues(rows, { ...base, state: "closed" }).map((i) => i.id), ["b"]);
  assert.deepEqual(filterIssues(rows, { ...base, repo: "docs" }).map((i) => i.id), ["b"]);
  assert.deepEqual(repoOptions(rows), ["g/p", "o/app", "o/docs"]);
});
