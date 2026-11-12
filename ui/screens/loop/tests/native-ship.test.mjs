import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../native/ship-model.ts";
import { decodeRepoConfig, defaultRepoConfig } from "../../settings/repo-config.ts";

const info = { runId: "20261109-100000-abc123", project: "/p", repo: "/p/code/web", worktree: "/p/system/loop-worktrees/20261109-100000-abc123", branch: "factory/20261109-100000-abc123", baseCommit: "0123456789abcdef0123" };
const issue = { source: "issue", id: "12", title: "  Fix login\n", body: "The login breaks.", repo: "acme/web" };
const PATCH = "a".repeat(64);

test("shipRequest uses the item title and links the issue", () => {
  const body = m.shipRequest(info, issue, { provider: "github", slug: "acme/web", base: "main" }, "## Findings\nNone.\nVerdict: approve\n", PATCH);
  assert.equal(body.title, "Fix login");
  assert.equal(body.worktree, info.worktree);
  assert.equal(body.branch, info.branch);
  assert.equal(body.provider, "github");
  assert.equal(body.repo, "acme/web");
  assert.equal(body.base, "main");
  assert.match(body.body, /^Refs #12$/m);
  assert.match(body.body, /Verdict: approve/);
  assert.match(body.body, /0123456789ab/);
  assert.equal(body.patchId, PATCH);
  const cross = m.shipRequest(info, { ...issue, repo: "acme/api" }, { provider: "github", slug: "acme/web", base: "main" }, "", PATCH);
  assert.match(cross.body, /^Refs acme\/api#12$/m);
  assert.match(cross.body, /\(no review report\)/);
  const text = m.shipRequest(info, { source: "text", id: null, title: "", body: "x", repo: null }, { provider: "github", slug: "acme/web", base: "main" }, "", PATCH);
  assert.equal(text.title, `Factory run ${info.runId}`);
  assert.doesNotMatch(text.body, /Refs/);
});

test("shipRequest picks gitlab for a gitlab saved repo", () => {
  const config = decodeRepoConfig({ saved: {
    github: [{ id: "h", url: "https://github.com/acme/other", clonePath: "/p/code/other", active: true }],
    gitlab: [{ id: "g", url: "https://gitlab.com/grp/web", clonePath: "/p/code/web/", active: true }],
  } });
  const target = m.shipTarget(info, config);
  assert.deepEqual(target, { provider: "gitlab", slug: "grp/web" });
  const body = m.shipRequest(info, issue, { ...target, base: "develop" }, "", PATCH);
  assert.equal(body.provider, "gitlab");
  assert.equal(body.repo, "grp/web");
  assert.equal(body.base, "develop");
  assert.equal(m.shipTarget({ ...info, repo: "/p/code/unknown" }, config), null);
  // A nested GitLab group keeps its full path: the MR is opened on that project, not on its last two segments.
  const nested = decodeRepoConfig({ saved: { gitlab: [{ id: "n", url: "https://gitlab.com/grid-devs/personal/dinesh/smart-input", clonePath: "/p/code/smart-input", active: true }] } });
  assert.deepEqual(m.shipTarget({ ...info, repo: "/p/code/smart-input" }, nested), { provider: "gitlab", slug: "grid-devs/personal/dinesh/smart-input" });
  assert.equal(m.shipBlockedReason(config, "gitlab"), null);
  assert.match(m.shipBlockedReason({ ...defaultRepoConfig(), operations: { github: ["push"], gitlab: [] } }, "github"), /Create PR/);
  assert.match(m.shipBlockedReason({ ...defaultRepoConfig(), gitlabBaseUrl: "https://git.example.com" }, "gitlab"), /gitlab\.com/);
});

test("autoShipBlock opens an MR only for a diff a person can fully review that touches no CI or hook file", () => {
  const diff = (over = {}) => ({ text: "x", truncated: false, patchId: "a".repeat(64), files: ["src/app.ts"], additions: 1, deletions: 0, ...over });
  assert.equal(m.autoShipBlock(diff()), null);
  assert.match(m.autoShipBlock(null), /could not be read/);
  assert.match(m.autoShipBlock(diff({ files: [] })), /changed nothing/);
  assert.match(m.autoShipBlock(diff({ patchId: "" })), /changed nothing/);
  assert.match(m.autoShipBlock(diff({ truncated: true })), /too large/);
  assert.match(m.autoShipBlock(diff({ files: Array.from({ length: 1000 }, (_, i) => `f${i}.ts`) })), /too large/, "a file list at the host cap may hide paths");
  assert.match(m.autoShipBlock(diff({ files: ["src/a.ts", ".github/workflows/ci.yml"] })), /\.github\/workflows\/ci\.yml/);
});

test("autoShipKind: every finished run reaches its MR, labelled by how it ended; stops and refusals do not", () => {
  const r = (over = {}) => ({ mode: "full", statusCode: "success", needsDecision: false, failedRole: null, ...over });
  assert.equal(m.autoShipKind(r()), "passed");
  assert.equal(m.autoShipKind(r({ statusCode: "failed", failedRole: "verify" })), "testsFailing");
  assert.equal(m.autoShipKind(r({ statusCode: "failed", failedRole: "review" })), "reviewRejected");
  assert.equal(m.autoShipKind(r({ statusCode: "failed", failedRole: "reviewGate" })), "reviewRejected");
  assert.equal(m.autoShipKind(r({ statusCode: "failed", failedRole: "implement" })), "incomplete");
  assert.equal(m.autoShipKind(r({ statusCode: "failed", failedRole: null })), "incomplete", "budget reached");
  for (const stop of ["aborted", "error", "blocked.repair_out_of_scope"]) assert.equal(m.autoShipKind(r({ statusCode: stop })), null, stop);
  assert.equal(m.autoShipKind(r({ mode: "intakeOnly" })), null);
  assert.equal(m.autoShipKind(r({ statusCode: "failed", needsDecision: true })), null, "the intake gate asks a person first");
  assert.equal(m.autoShipTitle("Fix login", "passed"), "Fix login");
  assert.equal(m.autoShipTitle("Fix login", "testsFailing"), "[Tests failing] Fix login");
  assert.equal(m.autoShipTitle("Fix login", "reviewRejected"), "[Review: changes requested] Fix login");
  assert.equal(m.autoShipTitle("x".repeat(250), "incomplete").length, 200);
  assert.match(m.autoShipNote("testsFailing", "Verify"), /tests failed/i);
  assert.equal(m.autoShipNote("passed", null), "");
});

test("shipState maps secret_detected to a secret message that contains no diff text", () => {
  const secret = { ok: false, code: "secret_detected", message: "+ const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'" };
  assert.equal(m.shipState(secret), "secret");
  const copy = m.shipCopy(secret);
  assert.doesNotMatch(copy, /ghp_|const token/);
  assert.match(copy, /Nothing was pushed/);
  assert.match(copy, /title or description/, "a hit with no rule is in the request text");
  assert.match(m.shipCopy({ ...secret, rule: "GitHub token", file: "src/a.ts", line: 2 }), /GitHub token at src\/a\.ts:2/);
  assert.doesNotMatch(m.shipCopy({ ...secret, rule: "x", file: "/etc/passwd" }), /\/etc\/passwd/, "an absolute path is not echoed");
  assert.equal(m.shipState({ ok: false, code: "push_rejected" }), "rejected");
  assert.match(m.shipCopy({ ok: false, code: "push_rejected", message: "remote: secret hook said no" }), /No pull request or merge request was opened/);
  assert.equal(m.shipState({ ok: false, code: "provider_error" }), "error");
  assert.equal(m.shipState({ ok: false, code: "invalid_worktree" }), "error");
  assert.equal(m.shipState({ ok: false, code: "diff_changed" }), "changed");
  assert.equal(m.shipCopy({ ok: false, code: "diff_changed", message: "+new line" }), "The changes changed since you opened this review. Read the new diff, then ship again.");
  assert.doesNotMatch(m.shipCopy({ ok: false, code: "provider_error", message: "token glpat-123 rejected" }), /glpat/);
  assert.match(m.shipCopy({ ok: false, code: "<script>" }), /\(error\)/, "an odd code is not echoed");
  const ok = { ok: true, url: "https://github.com/acme/web/pull/3", commit: "abcdef1234", reused: false };
  assert.equal(m.shipState(ok), "shipped");
  assert.match(m.shipCopy(ok), /pull\/3/);
  assert.match(m.shipCopy({ ...ok, reused: true }), /abcdef1/);
});

test("the worktree diff is decoded and split per file", () => {
  assert.deepEqual(m.decodeWorktreeDiff({ text: "x", truncated: true, patch_id: "p1", files: ["a", 3] }), { text: "x", truncated: true, patchId: "p1", files: ["a"], additions: 0, deletions: 0 });
  assert.equal(m.decodeWorktreeDiff({ patchId: "p2" }).patchId, "p2");
  assert.deepEqual(m.decodeWorktreeDiff(null), { text: "", truncated: false, patchId: "", files: [], additions: 0, deletions: 0 });
  const text = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/new.md b/new.md\nnew file mode 100644\n+hi\n";
  const files = m.splitDiffByFile(text);
  assert.deepEqual(files.map((f) => f.path), ["src/a.ts", "new.md"]);
  assert.equal(files[0].lines.length, 6);
  assert.equal(files[1].lines.at(-1), "+hi");
  assert.deepEqual(["+++ b/x", "--- a/x", "+new", "-old", "@@ -1 +1 @@", " same"].map(m.diffLineKind), ["ctx", "ctx", "add", "del", "hunk", "ctx"]);
  assert.deepEqual(m.splitDiffByFile(""), []);
});

test("A7: Discard states the exact counts and what happens to an open PR/MR", () => {
  assert.deepEqual(m.decodeWorktreeStatus({ changedFiles: 3, localCommits: 1, pushed: false }), { changedFiles: 3, localCommits: 1, pushed: false });
  assert.equal(m.decodeWorktreeStatus({ changedFiles: -1, localCommits: 1, pushed: false }), null);
  assert.equal(m.decodeWorktreeStatus({ changedFiles: 3, localCommits: 1 }), null);
  assert.equal(m.discardWarning({ changedFiles: 3, localCommits: 1, pushed: false }), "3 changed files and 1 commit that was never pushed will be deleted.");
  assert.equal(m.discardWarning({ changedFiles: 1, localCommits: 0, pushed: false }), "1 changed file will be deleted.");
  assert.equal(m.discardWarning({ changedFiles: 0, localCommits: 2, pushed: false }), "2 commits that were never pushed will be deleted.");
  assert.equal(m.discardWarning({ changedFiles: 0, localCommits: 0, pushed: true }, null), "Nothing unpushed will be lost.");
  assert.equal(m.discardWarning({ changedFiles: 2, localCommits: 0, pushed: true }, { provider: "github" }), "2 changed files will be deleted. The remote branch and the open pull request stay.");
  assert.equal(m.discardWarning({ changedFiles: 0, localCommits: 0, pushed: true }, { provider: "gitlab" }), "Nothing unpushed will be lost. The remote branch and the open merge request stay.");
  assert.match(m.discardWarning(null), /Every change/);
});

test("A4: the recorded review patch id warns and blocks Ship when the diff changed", () => {
  const reviewed = "a".repeat(64);
  assert.equal(m.reviewedPatchIdWarning(reviewed, reviewed), null);
  assert.equal(m.reviewedPatchIdWarning(reviewed, "b".repeat(64)), "The changes changed since Review passed. Re-run Review (send the run back or continue it), read the new verdict, then ship.");
  assert.equal(m.reviewedPatchIdWarning(null, "b".repeat(64)), null, "an older record has no id to compare");
  assert.equal(m.reviewedPatchIdWarning(reviewed, ""), null, "a diff still loading is not a mismatch");
  assert.equal(m.reviewedPatchIdWarning("not-a-patch-id", "b".repeat(64)), null, "a malformed recorded value is ignored");
});
