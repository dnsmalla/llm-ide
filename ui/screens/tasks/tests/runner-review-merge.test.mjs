import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../runner.ts";
import { selectPendingRun } from "../ship-review.ts";
import { TASK_BY_ID as REGISTRY } from "../registry.generated.ts";

const baseCtx = (overrides) => ({
  projectRoot: "/p",
  core: { request: async (path) => { throw new Error(`unexpected core call ${path}`); } },
  host: async () => null, fs: {}, log: () => {}, approvalToken: async () => null,
  changedPaths: async () => [], revert: async () => {},
  ...overrides,
});

test("Review & Merge opens the pending Factory run and never ships", async () => {
  const shipCalls = [];
  let reviewed = null;
  const out = await runTask("reviewMerge", {
    projectRoot: "/p",
    core: { request: async (path) => { if (path === "/kb/loop/ship") shipCalls.push(path); return { text: "diff", truncated: false, patchId: "a".repeat(64), files: ["x"] }; } },
    host: async () => null, fs: {}, log: () => {}, approvalToken: async () => null,
    changedPaths: async () => [], revert: async () => {},
    actions: { reviewPendingMerge: async (root, runId) => { reviewed = runId; return { runId: runId ?? "r1", reviewed: true }; } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.taskId, "review.merge");
  assert.equal(out.runner, "desktop-action");
  assert.deepEqual(shipCalls, []);
  assert.equal(reviewed, null); // null = the pending run; the action resolves it
  assert.equal(out.output, "r1");
  assert.equal(out.summary, "Opened the Factory run r1 for review. Ship is a separate click.");
});

test("Review & Merge with no pending run says so and does not fail the core", async () => {
  const out = await runTask("reviewMerge", baseCtx({ actions: { reviewPendingMerge: async () => null } }));
  assert.equal(out.ok, false);
  assert.equal(out.code, "NO_PENDING_RUN");
  assert.equal(out.summary, "No Factory run is waiting for review.");
});

test("Review & Merge is never scheduled (D17)", () => {
  assert.equal(REGISTRY["review.merge"].schedule.schedulable, false);
  assert.equal(REGISTRY["review.merge"].schedule.backend, "none");
  assert.equal(REGISTRY["review.merge"].readOnly, true);
});

const worktree = (runId) => ({ runId, project: "p", repo: "r", worktree: `/w/${runId}`, branch: `b-${runId}`, baseCommit: "c" });
const item = (key, runIds) => ({ key, source: "issue", id: key, title: key, body: "", repo: "o/r", provider: "github", addedAt: "2026-11-10T00:00:00Z", runIds });
const record = (runId, startedAt, over = {}) => ({
  runId, mode: "full", statusCode: "success", needsDecision: null, ship: null, costUsd: null, durationSeconds: null,
  verdict: null, changed: null, test: null, failingStage: null, readiness: null, reviewedPatchId: null, endedAt: null,
  entry: { id: `id-${runId}`, startedAt }, ...over,
});

test("selectPendingRun takes the newest passed unshipped run with a worktree on a card", () => {
  const worktrees = new Map(["a", "b", "c"].map((r) => [r, worktree(r)]));
  const records = new Map([
    ["a", record("a", "2026-11-01T00:00:00Z")],
    ["b", record("b", "2026-11-05T00:00:00Z")],
  ]);
  const items = [item("k-a", ["a"]), item("k-b", ["b"])];
  assert.deepEqual(selectPendingRun(worktrees, records, items), { runId: "b", itemKey: "k-b" });
});

test("selectPendingRun skips shipped, failed, worktree-less and card-less runs, and is null when none is left", () => {
  const worktrees = new Map([["live", worktree("live")], ["shipped", worktree("shipped")], ["failed", worktree("failed")]]);
  const records = new Map([
    ["shipped", record("shipped", "2026-11-09T00:00:00Z", { ship: { provider: "github", url: "https://github.com/o/r/pull/1" } })],
    ["failed", record("failed", "2026-11-08T00:00:00Z", { statusCode: "failed" })],
    ["gone", record("gone", "2026-11-07T00:00:00Z")],
    ["orphan", record("orphan", "2026-11-10T00:00:00Z")],
  ]);
  const items = [item("k-shipped", ["shipped"]), item("k-failed", ["failed"]), item("k-gone", ["gone"])];
  assert.equal(selectPendingRun(worktrees, records, items), null);
  // Add the live one: it is the only candidate. The card-less "orphan" run stays out even though it is newest.
  records.set("live", record("live", "2026-11-02T00:00:00Z"));
  items.push(item("k-live", ["live"]));
  assert.deepEqual(selectPendingRun(worktrees, records, items), { runId: "live", itemKey: "k-live" });
  assert.equal(selectPendingRun(new Map(), records, items), null);
});
