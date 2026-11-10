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
  assert.equal(m.shipBlockedReason(config, "gitlab"), null);
  assert.match(m.shipBlockedReason({ ...defaultRepoConfig(), operations: { github: ["push"], gitlab: [] } }, "github"), /Create PR/);
  assert.match(m.shipBlockedReason({ ...defaultRepoConfig(), gitlabBaseUrl: "https://git.example.com" }, "gitlab"), /gitlab\.com/);
});

test("shipState maps secret_detected to a secret message that contains no diff text", () => {
  const secret = { ok: false, code: "secret_detected", message: "+ const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'" };
  assert.equal(m.shipState(secret), "secret");
  const copy = m.shipCopy(secret);
  assert.doesNotMatch(copy, /ghp_|const token/);
  assert.match(copy, /Nothing was pushed/);
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
  assert.deepEqual(m.decodeWorktreeDiff({ text: "x", truncated: true, patch_id: "p1", files: ["a", 3] }), { text: "x", truncated: true, patchId: "p1", files: ["a"] });
  assert.equal(m.decodeWorktreeDiff({ patchId: "p2" }).patchId, "p2");
  assert.deepEqual(m.decodeWorktreeDiff(null), { text: "", truncated: false, patchId: "", files: [] });
  const text = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/new.md b/new.md\nnew file mode 100644\n+hi\n";
  const files = m.splitDiffByFile(text);
  assert.deepEqual(files.map((f) => f.path), ["src/a.ts", "new.md"]);
  assert.equal(files[0].lines.length, 6);
  assert.equal(files[1].lines.at(-1), "+hi");
  assert.deepEqual(["+++ b/x", "--- a/x", "+new", "-old", "@@ -1 +1 @@", " same"].map(m.diffLineKind), ["ctx", "ctx", "add", "del", "hunk", "ctx"]);
  assert.deepEqual(m.splitDiffByFile(""), []);
});
