import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceKey, missingChoices, repoChoices, resolveScope, syncRepos } from "../repo-scope.ts";
import { mergePaging } from "../issue-paging.ts";
import { defaultRepoConfig } from "../../settings/repo-config.ts";

const cfg = (github: string[], gitlab: string[]) => {
  const c = defaultRepoConfig();
  const row = (url: string, displayName = "") => ({ id: url, displayName, url, clonePath: "", active: true });
  c.saved.github = github.map((u) => row(u));
  c.saved.gitlab = gitlab.map((u) => row(u, u.endsWith("project") ? "Main project" : ""));
  return c;
};

test("repoChoices lists each saved repository once, keeps GitLab nested groups, and drops unreadable rows", () => {
  const out = repoChoices(cfg(["https://github.com/o/r", "o/r", "nonsense"], ["https://gitlab.com/group/sub/project"]));
  assert.deepEqual(out.map((c) => [c.provider, c.slug, c.label]), [["github", "o/r", "o/r"], ["gitlab", "group/sub/project", "Main project"]]);
  assert.equal(out[0]!.key, choiceKey("github", "o/r"));
});

test("one saved repository is selected with no picker; several offer All; none reads both providers", () => {
  const one = repoChoices(cfg([], ["group/project"]));
  assert.deepEqual(resolveScope(one, "anything"), { selected: one[0], providers: ["gitlab"], picker: false });
  const two = repoChoices(cfg(["o/r"], ["group/project"]));
  assert.deepEqual(resolveScope(two, ""), { selected: null, providers: ["github", "gitlab"], picker: true });
  assert.deepEqual(resolveScope(two, two[1]!.key), { selected: two[1], providers: ["gitlab"], picker: true });
  assert.deepEqual(resolveScope(two, "stale-key"), { selected: null, providers: ["github", "gitlab"], picker: true }, "a removed repository falls back to All");
  assert.deepEqual(resolveScope([], ""), { selected: null, providers: ["github", "gitlab"], picker: false });
  const sameSlug = repoChoices(cfg(["a/b"], ["a/b"]));
  assert.equal(sameSlug.length, 2, "the same slug on two providers stays two choices");
});

test("missingChoices: only a repository in view with no cached issue and not tried yet", () => {
  const cs = repoChoices(cfg(["o/r"], ["g/p"]));
  const all = resolveScope(cs, "");
  const issues = [{ provider: "github", repo: "o/r" }];
  assert.deepEqual(missingChoices(cs, all, issues, new Set()).map((c) => c.slug), ["g/p"]);
  assert.deepEqual(missingChoices(cs, all, issues, new Set([cs[1]!.key])), [], "tried once this session");
  assert.deepEqual(missingChoices(cs, resolveScope(cs, cs[0]!.key), [], new Set()).map((c) => c.slug), ["o/r"], "only the selected one");
});

test("syncRepos sends the provider and repository, adds the counts, and reports each failure plainly", async () => {
  const cs = repoChoices(cfg(["o/r"], ["g/p", "g/private", "g/down"]));
  const sent: unknown[] = [];
  const out = await syncRepos(async (_m, _p, body) => {
    sent.push(body);
    const repo = (body as { repo: string }).repo;
    if (repo === "g/private") return { status: 400, body: { error: { code: "GITLAB_INDEX_FAILED", message: "GitLab auth failed (401) — check the token." } } };
    if (repo === "g/down") throw new Error("offline");
    return { status: 200, body: { ok: true, count: repo === "o/r" ? 3 : 4 } };
  }, cs);
  assert.deepEqual(sent[0], { provider: "github", repo: "o/r", state: "all" });
  assert.deepEqual(sent[1], { provider: "gitlab", repo: "g/p", state: "all" });
  assert.equal(out.imported, 7);
  assert.deepEqual(out.problems, ["g/private: GitLab auth failed (401) — check the token.", "g/down: the core is not reachable right now"]);
  assert.deepEqual((await syncRepos(async () => ({ status: 401, body: {} }), cs.slice(0, 1))).problems, ["o/r: sign in again"]);
});

test("mergePaging joins rows, adds totals, and the most serious stop wins", () => {
  const a = { issues: [{ id: "1" }], total: 1, stop: "end", status: null } as never;
  const b = { issues: [{ id: "2" }], total: 2, stop: "error", status: 401 } as never;
  const m = mergePaging([a, b]);
  assert.deepEqual([m.issues.length, m.total, m.stop, m.status], [2, 3, "error", 401]);
  assert.equal(mergePaging([a, { ...(b as object), total: null } as never]).total, null, "an unknown total stays unknown");
  assert.equal(mergePaging([a]), a);
});
