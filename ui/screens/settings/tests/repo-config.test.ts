import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_REPO_OPS,
  credentialHostOf,
  gitCredentialStatus,
  addSavedRepo,
  decodeRepoConfig,
  defaultRepoConfig,
  normalizeBase,
  readRepoConfig,
  removeSavedRepo,
  repoPathOf,
  repoSlugOf,
  resolveCloneGrant,
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

test("resolveCloneGrant: a typed or remembered token skips the grant call", async () => {
  let asked = 0;
  const grant = await resolveCloneGrant({ ssh: true, token: "ghp_typed", provider: "github" }, async () => {
    asked += 1;
    return { grant: "ab12" };
  });
  assert.equal(grant, null);
  assert.equal(asked, 0, "a typed token never reaches the core");
});

test("resolveCloneGrant: ssh with no token asks for the provider's grant and returns it", async () => {
  const asked: string[] = [];
  const grant = await resolveCloneGrant({ ssh: true, token: "  ", provider: "gitlab" }, async (provider) => {
    asked.push(provider);
    return { grant: "cd34" };
  });
  assert.equal(grant, "cd34");
  assert.deepEqual(asked, ["gitlab"]);
});

test("resolveCloneGrant: a null grant (no saved token) clones plainly", async () => {
  const grant = await resolveCloneGrant({ ssh: true, token: "", provider: "github" }, async () => ({ grant: null }));
  assert.equal(grant, null);
});

test("resolveCloneGrant: a failed grant call falls back to a plain clone", async () => {
  const grant = await resolveCloneGrant({ ssh: true, token: "", provider: "github" }, async () => {
    throw new Error("UNREACHABLE");
  });
  assert.equal(grant, null);
});

test("resolveCloneGrant: local mode never asks the core", async () => {
  let asked = 0;
  const grant = await resolveCloneGrant({ ssh: false, token: "", provider: "github" }, async () => {
    asked += 1;
    return { grant: "ab12" };
  });
  assert.equal(grant, null);
  assert.equal(asked, 0, "local clones keep using the Mac's own git credentials");
});

test("resolveCloneGrant: a self-hosted GitLab base never gets a grant, so its token stays off gitlab.com", async () => {
  let asked = 0;
  const grant = await resolveCloneGrant(
    { ssh: true, token: "", provider: "gitlab", gitlabBaseUrl: "https://git.example.corp/" },
    async () => {
      asked += 1;
      return { grant: "ab12" };
    },
  );
  assert.equal(grant, null);
  assert.equal(asked, 0, "the clone targets gitlab.com, so a self-hosted token must not be granted");
});

test("resolveCloneGrant: gitlab.com (with a trailing slash) still gets a grant", async () => {
  const grant = await resolveCloneGrant(
    { ssh: true, token: "", provider: "gitlab", gitlabBaseUrl: "https://gitlab.com/" },
    async () => ({ grant: "ab12" }),
  );
  assert.equal(grant, "ab12");
});

test("resolveCloneGrant: a non-gitlab.com base or a malformed one does not block GitHub, and a malformed GitLab base gets none", async () => {
  const github = await resolveCloneGrant(
    { ssh: true, token: "", provider: "github", gitlabBaseUrl: "https://git.example.corp" },
    async () => ({ grant: "gh01" }),
  );
  assert.equal(github, "gh01", "the GitLab base does not apply to GitHub");
  let asked = 0;
  const broken = await resolveCloneGrant(
    { ssh: true, token: "", provider: "gitlab", gitlabBaseUrl: "not a url" },
    async () => {
      asked += 1;
      return { grant: "ab12" };
    },
  );
  assert.equal(broken, null);
  assert.equal(asked, 0);
});

test("gitCredentialStatus words each save outcome", () => {
  assert.equal(gitCredentialStatus(true, { stored: true }, "gitlab", "gitlab.com"), "Token saved. Git clone, pull and push will use it for gitlab.com.");
  assert.match(gitCredentialStatus(true, { stored: false, reason: "not_stored" }, "gitlab", "gitlab.com"), /no working credential helper/);
  assert.equal(gitCredentialStatus(true, new Error("boom"), "gitlab", "gitlab.com"), "Token saved for the GitLab API, but git could not store it: boom.");
  assert.match(gitCredentialStatus(true, { stored: false, reason: "git_missing" }, "github", "github.com"), /Git was not found/);
  assert.equal(gitCredentialStatus(true, null, "github", "github.com"), "Token saved.");
});

test("gitCredentialStatus words each clear outcome", () => {
  assert.equal(gitCredentialStatus("cleared", { stored: true }, "gitlab", "gitlab.com"), "Token cleared from LLM-IDE and from git.");
  assert.equal(gitCredentialStatus("cleared", null, "gitlab", "gitlab.com"), "Token cleared. Saved repositories kept.");
  assert.match(gitCredentialStatus("cleared", new Error("x"), "gitlab", "gitlab.com"), /git could not remove it: x/);
});

test("gitCredentialStatus warns about a replaced or untouched git login", () => {
  assert.match(gitCredentialStatus(true, { stored: true, reason: "replaced_existing" }, "gitlab", "gitlab.com"), /existing git login for gitlab\.com was replaced/);
  assert.match(gitCredentialStatus("cleared", { stored: false, reason: "left_in_place" }, "gitlab", "gitlab.com"), /no record of saving the git login for gitlab\.com .*left in place\. Remove it with your git credential helper/);
  assert.match(gitCredentialStatus("cleared", { stored: false, reason: "read_failed" }, "gitlab", "gitlab.com"), /Could not read git's stored login for gitlab\.com; nothing was removed/);
  assert.match(gitCredentialStatus(true, { stored: true, reason: "not_recorded" }, "gitlab", "gitlab.com"), /could not record it, so Clear token will leave it in git/);
});

test("gitCredentialStatus skips quietly in remote mode and trims a doubled period", () => {
  assert.equal(gitCredentialStatus(true, { stored: false, reason: "remote" }, "gitlab", "gitlab.com"), "Token saved.");
  assert.equal(gitCredentialStatus(true, { stored: false, reason: "ssh" }, "gitlab", "gitlab.com"), "Token saved.");
  assert.equal(gitCredentialStatus("cleared", { stored: false, reason: "remote" }, "gitlab", "gitlab.com"), "Token cleared. Saved repositories kept.");
  assert.equal(gitCredentialStatus(true, new Error("boom."), "gitlab", "gitlab.com"), "Token saved for the GitLab API, but git could not store it: boom.");
  assert.match(gitCredentialStatus("cleared", { stored: false, reason: "not_removed" }, "gitlab", "git.example.com"), /still holds a login for git\.example\.com/);
});

test("credentialHostOf follows git's remote host rules", () => {
  assert.equal(credentialHostOf("HTTPS://GitLab.Example.COM/g"), "gitlab.example.com");
  assert.equal(credentialHostOf("https://gitlab.com:443"), "gitlab.com");
  assert.equal(credentialHostOf("https://gitlab.com:8443/x"), "gitlab.com:8443");
  for (const bad of ["http://gitlab.com", "https://gitlab.com.", "https://gitlab.com:0", "https://gitlab.com:70000", "https://u@gitlab.com", "https://gitlab.com:", "https://"]) {
    assert.equal(credentialHostOf(bad), null, bad);
  }
});
