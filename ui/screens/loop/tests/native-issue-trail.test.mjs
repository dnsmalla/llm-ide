import { test } from "node:test";
import assert from "node:assert/strict";
import {
  issueNumberFromUrl, issueTrail, postIssueComment, runIssueBody, runSummaryBody, stepCommentBody, summarizeSteps, trailForRun,
} from "../native/issue-trail.ts";

function fakeCore({ allow = ["commentIssue", "createIssue"], createStatus = 200, createUrl = "https://github.com/o/r/issues/42" } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      allowed: (_provider, op) => allow.includes(op),
      async request(path, body) {
        calls.push({ path, body });
        if (path === "/kb/issues/create") return { status: createStatus, body: createStatus === 200 ? { ok: true, url: createUrl } : { error: { code: "TOKEN_FORBIDDEN" } } };
        return { status: 200, body: { ok: true } };
      },
    },
  };
}

test("a step comment names its own process, so any runner can use it", () => {
  const body = stepCommentBody({ process: "Refactoring", stageName: "Refactor Apply", ok: false, runId: "r1", mode: "loop", iteration: 2 });
  assert.match(body, /^\*\*Refactoring · `Refactor Apply`\*\* — failed/);
  assert.match(body, /Run `r1` \(loop\), attempt 2/);
  assert.doesNotMatch(stepCommentBody({ process: "**x`", stageName: "s", ok: true, runId: "r", mode: "m", iteration: 1 }), /\*\*\*|`x/, "a process name cannot break the bold heading");
});

test("the issue number is read from GitHub and GitLab issue URLs only", () => {
  assert.equal(issueNumberFromUrl("https://github.com/o/r/issues/42"), 42);
  assert.equal(issueNumberFromUrl("https://gitlab.com/g/sub/p/-/issues/7"), 7);
  assert.equal(issueNumberFromUrl("https://github.com/o/r/pull/42"), null);
  assert.equal(issueNumberFromUrl("https://github.com/o/r/issues/0"), null);
  assert.equal(issueNumberFromUrl(null), null);
});

test("summarizeSteps keeps first-run order, the last result and the attempt count", () => {
  const a = { id: "a", name: "Apply" }; const t = { id: "t", name: "Test" };
  assert.deepEqual(summarizeSteps([{ stage: a, ok: true }, { stage: t, ok: false }, { stage: t, ok: true }]), [
    { name: "Apply", ok: true, attempts: 1 }, { name: "Test", ok: true, attempts: 2 },
  ]);
});

test("the run summary says the outcome, every step, what changed, time, cost and the MR", () => {
  const body = runSummaryBody({
    process: "Refactoring", runId: "r1", statusCode: "success", statusSummary: "all stages passed",
    steps: [{ name: "Refactor Apply", ok: true, attempts: 1 }, { name: "Test", ok: true, attempts: 2 }],
    changedFiles: ["src/a.ts"], durationSeconds: 61.4, costUsd: 0.5, mergeRequest: { url: "https://github.com/o/r/pull/9" },
  });
  assert.match(body, /^\*\*Refactoring · run summary\*\* — passed/);
  assert.match(body, /Result: `all stages passed`/);
  assert.match(body, /\| `Test` \| passed \| 2 \|/);
  assert.match(body, /Changed files \(1\): `src\/a\.ts`/);
  assert.match(body, /time 61 s · cost \$0\.50/);
  assert.match(body, /Merge request: https:\/\/github\.com\/o\/r\/pull\/9/);
  const failed = runSummaryBody({ process: "Factory", runId: "r2", statusCode: "blocked.repair_out_of_scope", statusSummary: "", steps: [], changedFiles: [], costUsd: 0, mergeRequest: { notOpened: "Push is not allowed" } });
  assert.match(failed, /— blocked/);
  assert.match(failed, /Changed files: none/);
  assert.doesNotMatch(failed, /cost/, "a zero cost is not shown");
  assert.match(failed, /Merge request: not opened — Push is not allowed/);
});

test("a crafted step name or summary stays inert in the summary", () => {
  const body = runSummaryBody({ process: "Loop", runId: "r", statusCode: "failed", statusSummary: "@team see ![](https://x/p.png)", steps: [{ name: "a|b`@owner", ok: false, attempts: 1 }] });
  assert.match(body, /Result: `@team see !\[\]\(https:\/\/x\/p\.png\)`/);
  assert.match(body, /\| `a\\\|b'@owner` \| failed \| 1 \|/, "a pipe cannot split the table row");
});

test("comments post only when Settings allows commenting", async () => {
  const off = fakeCore({ allow: [] });
  assert.equal(await postIssueComment(off.deps, { provider: "github", repo: "o/r", number: 1 }, "hi"), false);
  assert.equal(off.calls.length, 0);
  const on = fakeCore();
  assert.equal(await postIssueComment(on.deps, { provider: "github", repo: "o/r", number: 1 }, "hi"), true);
  assert.deepEqual(on.calls[0], { path: "/kb/issues/comment", body: { provider: "github", repo: "o/r", number: 1, body: "hi" } });
});

test("a trail posts in call order even when an earlier comment is slow, and never throws", async () => {
  const core = fakeCore();
  const trail = issueTrail(core.deps, { provider: "github", repo: "o/r", number: 3 });
  trail.post(async () => { await new Promise((r) => setTimeout(r, 30)); return "first"; });
  trail.post("second");
  trail.post(async () => { throw new Error("lookup failed"); });
  trail.post(async () => null);
  trail.post("third");
  await trail.idle();
  assert.deepEqual(core.calls.map((c) => c.body.body), ["first", "second", "third"]);
});

test("a run from an issue comments there and opens nothing", async () => {
  const core = fakeCore();
  const trail = await trailForRun(core.deps, { item: { source: "issue", id: "7", repo: "o/r", provider: "github" }, open: true, repo: { provider: "github", slug: "o/r" }, process: "Factory", runId: "r1", goal: null, steps: [] });
  assert.deepEqual(trail.target, { provider: "github", repo: "o/r", number: 7 });
  assert.equal(core.calls.length, 0);
});

test("any other run opens one issue in its repository when asked, with a valid idempotency key", async () => {
  const core = fakeCore();
  const trail = await trailForRun(core.deps, { item: null, open: true, repo: { provider: "github", slug: "o/r" }, process: "Refactoring", runId: "20261113.r#1", goal: "Split big files", steps: ["Refactor Plan", "Refactor Apply"] });
  assert.deepEqual(trail.target, { provider: "github", repo: "o/r", number: 42 });
  const create = core.calls[0];
  assert.equal(create.path, "/kb/issues/create");
  assert.equal(create.body.title, "Refactoring run 20261113.r#1");
  assert.match(create.body.idem, /^[A-Za-z0-9_-]{16,64}$/);
  assert.match(create.body.body, /Goal: `Split big files`/);
  assert.match(create.body.body, /2\. `Refactor Apply`/);
});

test("no issue is opened when the loop did not ask, the repo is unknown, creating is not allowed, or the core refuses", async () => {
  const base = { item: null, process: "Loop", runId: "r1", goal: null, steps: [] };
  assert.equal(await trailForRun(fakeCore().deps, { ...base, open: false, repo: { provider: "github", slug: "o/r" } }), null);
  assert.equal(await trailForRun(fakeCore().deps, { ...base, open: true, repo: null }), null);
  const noCreate = fakeCore({ allow: ["commentIssue"] });
  assert.equal(await trailForRun(noCreate.deps, { ...base, open: true, repo: { provider: "github", slug: "o/r" } }), null);
  assert.equal(noCreate.calls.length, 0);
  assert.equal(await trailForRun(fakeCore({ createStatus: 403 }).deps, { ...base, open: true, repo: { provider: "github", slug: "o/r" } }), null);
});

test("the opened issue's body lists the steps and says where the comments go", () => {
  const body = runIssueBody({ process: "Refactoring", runId: "r1", goal: null, steps: ["A"] });
  assert.match(body, /\*\*Refactoring\*\* run `r1`, opened by LLM-IDE\./);
  assert.doesNotMatch(body, /Goal:/);
  assert.match(body, /The last comment is the run summary\./);
});

test("a step comment carries its own duration and cost", async () => {
  const body = (await import("../native/issue-trail.ts")).stepCommentBody({ process: "Refactoring", stageName: "Test", ok: true, runId: "r1", mode: "loop", iteration: 1, durationSeconds: 65, costUsd: 0.12 });
  assert.match(body, /time 65 s/);
  assert.match(body, /cost \$0\.12/);
});

test("a skipped runOnce stage says skipped, not passed", async () => {
  const body = (await import("../native/issue-trail.ts")).stepCommentBody({ process: "Test", stageName: "Test Structure", ok: true, skipped: true, runId: "r1", mode: "loop", iteration: 2 });
  assert.match(body, /— skipped/);
  assert.doesNotMatch(body, /— passed/);
});
