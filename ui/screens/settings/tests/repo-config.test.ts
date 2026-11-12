import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_REPO_OPS,
  addSavedRepo,
  decodeRepoConfig,
  defaultRepoConfig,
  normalizeBase,
  readRepoConfig,
  removeSavedRepo,
  repoPathOf,
  repoSlugOf,
  shouldProvision,
  repoTitle,
  setActiveRepo,
  setAllowedOps,
  setPrimary,
  toggleAllowedOp,
  updateSavedRepo,
  validateRepoUrl,
  writeRepoConfig,
} from "../repo-config.ts";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };

test("defaults: every operation allowed, no repos, gitlab.com, no primary", () => {
  const d = defaultRepoConfig();
  assert.deepEqual(d.operations.gitlab, [...ALL_REPO_OPS]);
  assert.deepEqual(d.saved, { gitlab: [], github: [] });
  assert.equal(d.gitlabBaseUrl, "https://gitlab.com");
  assert.equal(d.primary, null);
});

test("decode is defensive: malformed blobs and unknown operations fall back", () => {
  assert.deepEqual(decodeRepoConfig(null), defaultRepoConfig());
  const c = decodeRepoConfig({
    primary: "bitbucket",
    gitlabBaseUrl: " https://git.example.com/gitlab/// ",
    operations: { github: ["sync", "evil", "sync"], gitlab: [] },
    saved: { github: [{ id: "x", url: "https://github.com/o/r", active: true }, { url: "bad", active: true }] },
  });
  assert.equal(c.primary, null);
  assert.equal(c.gitlabBaseUrl, "https://git.example.com/gitlab");
  assert.deepEqual(c.operations.github, ["sync"]);
  assert.deepEqual(c.operations.gitlab, [], "an explicit empty allow-list is a real choice");
  assert.equal(c.saved.github.length, 2);
  assert.equal(c.saved.github[0]!.active, true);
  assert.equal(c.saved.github[1]!.active, false, "at most one active row");
});

test("saved repos: add makes the first active, remove re-activates the first, updates are bounded", () => {
  let c = addSavedRepo(defaultRepoConfig(), "github");
  assert.equal(c.saved.github.length, 1);
  assert.equal(c.saved.github[0]!.active, true);
  const id = c.saved.github[0]!.id;
  c = updateSavedRepo(c, "github", id, { displayName: "Mine", url: "owner/repo", clonePath: "/x" });
  assert.equal(c.saved.github[0]!.url, "owner/repo");
  c = addSavedRepo(c, "github");
  const second = c.saved.github[1]!.id;
  c = setActiveRepo(c, "github", second);
  assert.deepEqual(c.saved.github.map((r) => r.active), [false, true]);
  c = removeSavedRepo(c, "github", second);
  assert.equal(c.saved.github.length, 1);
  assert.equal(c.saved.github[0]!.active, true, "removing the active row hands over to the first");
  c = updateSavedRepo(c, "github", id, { displayName: "x".repeat(500) });
  assert.equal(c.saved.github[0]!.displayName.length, 120);
  assert.equal(removeSavedRepo(c, "github", "nope"), c);
});

test("primary provider and automation switches round-trip per provider", () => {
  let c = setPrimary(defaultRepoConfig(), "gitlab");
  assert.equal(c.primary, "gitlab");
  c = setAllowedOps(c, "gitlab", ["sync", "createPR"]);
  assert.deepEqual(c.operations.gitlab, ["sync", "createPR"]);
  c = toggleAllowedOp(c, "gitlab", "push", true);
  assert.deepEqual(c.operations.gitlab, ["sync", "push", "createPR"], "canonical order");
  assert.deepEqual(c.operations.github, [...ALL_REPO_OPS], "the other provider is untouched");
  c = toggleAllowedOp(c, "gitlab", "sync", false);
  assert.ok(!c.operations.gitlab.includes("sync"));
});

test("URL validation accepts owner/repo and http(s), rejects spaces and empty paths", () => {
  for (const ok of ["owner/repo", "https://github.com/owner/repo", "https://gitlab.com/g/owner/repo", "git.example.com/o/r".replace("git.example.com/", "https://git.example.com/")]) assert.equal(validateRepoUrl(ok), null, ok);
  for (const bad of ["", "   ", "no slash", "https://github.com/", "https://github.com/o/r extra"]) assert.notEqual(validateRepoUrl(bad), null, bad);
});

test("the stored blob round-trips through localStorage and a broken blob is ignored", () => {
  const s = mem();
  assert.equal(readRepoConfig(s as unknown as Storage).saved.github.length, 0);
  let c = addSavedRepo(defaultRepoConfig(), "gitlab");
  c = updateSavedRepo(c, "gitlab", c.saved.gitlab[0]!.id, { url: "o/r" });
  writeRepoConfig(c, s as unknown as Storage);
  const back = readRepoConfig(s as unknown as Storage);
  assert.equal(back.saved.gitlab[0]!.url, "o/r");
  s.setItem("llmide.repos.config", "{not json");
  assert.deepEqual(readRepoConfig(s as unknown as Storage), defaultRepoConfig());
});

test("repo title: display name, else owner/repo from the URL, else a placeholder", () => {
  const base = { id: "1", displayName: "", url: "", clonePath: "", active: true };
  assert.equal(repoTitle(base), "Untitled repository");
  assert.equal(repoTitle({ ...base, url: "https://github.com/owner/repo.git" }), "owner/repo");
  assert.equal(repoTitle({ ...base, displayName: "Mine", url: "o/r" }), "Mine");
});

test("normalizeBase keeps a GitLab subpath and drops trailing slashes", () => {
  assert.equal(normalizeBase("https://host/gitlab///"), "https://host/gitlab");
  assert.equal(normalizeBase("  "), "https://gitlab.com");
});

test("repoSlugOf reads owner/repo from a URL, a .git URL or a slug, and never from a bare owner", () => {
  assert.equal(repoSlugOf("https://github.com/owner/repo"), "owner/repo");
  assert.equal(repoSlugOf("https://github.com/owner/repo.git/"), "owner/repo");
  assert.equal(repoSlugOf("owner/repo"), "owner/repo");
  assert.equal(repoSlugOf("https://github.com/owner"), null);
  assert.equal(repoSlugOf("owner"), null);
  assert.equal(repoSlugOf(""), null);
});

test("shouldProvision: only a finished, valid, not-yet-cloned repository is provisioned on blur", () => {
  const fresh = { url: "https://github.com/owner/repo", clonePath: "" };
  assert.equal(shouldProvision(fresh), true);
  assert.equal(shouldProvision({ url: "owner/repo", clonePath: "" }), true);
  assert.equal(shouldProvision({ url: "https://github.com/owner/repo", clonePath: "/code/repo" }), false, "an already-cloned repository is never re-attempted");
  assert.equal(shouldProvision({ url: "owner/re", clonePath: "" }), true, "a valid slug is provisioned; the caller only blurs a finished field");
  assert.equal(shouldProvision({ url: "https://github.com/owner", clonePath: "" }), false, "a bare owner has no repository to clone");
  assert.equal(shouldProvision({ url: "owner/has space", clonePath: "" }), false);
  assert.equal(shouldProvision({ url: "", clonePath: "" }), false);
});

test("GitLab nested groups: shorthand and URLs validate, provision on blur, and keep their full path", () => {
  for (const ok of ["group/sub/project", "https://gitlab.com/group/sub/project", "https://gitlab.com/group/sub/project.git/"]) assert.equal(validateRepoUrl(ok), null, ok);
  assert.equal(repoPathOf("https://gitlab.com/group/sub/project.git/"), "group/sub/project");
  assert.equal(repoPathOf("group/sub/project"), "group/sub/project");
  assert.equal(repoPathOf("https://gitlab.com/group"), null, "a bare group has no project");
  assert.equal(repoPathOf("a//b"), null, "an empty segment is not a path");
  assert.equal(shouldProvision({ url: "https://gitlab.com/group/sub/project", clonePath: "" }), true, "a nested GitLab project is cloned on blur");
  assert.equal(repoSlugOf("https://gitlab.com/group/sub/project"), null, "the GitHub issue import still reads owner/repo only");
});
