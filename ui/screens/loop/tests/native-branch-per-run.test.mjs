import { test } from "node:test";
import assert from "node:assert/strict";
import { idHex8, loopBranchSlug, nameSlug, runChanged, runEndAction, runRoot, runsInWorktree, stageHostArgs, worktreeBlockedStage } from "../native/worktree-run.ts";
import { copyStateBackIfMissed, copyStateIn, endWorktreeRun } from "../native/run-end.ts";
import { configWithSetup, isSetupStage, markSetupDone, setupNeeded, withSetupStage } from "../native/loop-setup.ts";
import { branchDiscardRefusal, isNewestRunOfLoop, lastShipUrl, providerSaysMerged } from "../native/loop-branch.ts";
import { cleanupPlan } from "../../factory/board-model.ts";
import { shipCopy } from "../native/ship-model.ts";
import { initialProjectStore, applyTemplate, BUILT_IN_TEMPLATES } from "../native/templates.ts";
import { decodeProjectStore, encodeProjectStore } from "../native/model.ts";
import { batchRollbackReason } from "../native/store.ts";
import { autoShipRun } from "../../factory/auto-ship.ts";
import { decodeRepoConfig } from "../../settings/repo-config.ts";

const base = { passed: true, cancelled: false, changed: true, humanReview: false, openMergeRequest: true };

test("every default loop runs on its own branch, Regression excepted because its fault check reads the working tree", () => {
  const store = initialProjectStore("npm test");
  const names = store.loops.map((l) => l.defaultKey);
  assert.ok(names.length >= 7, names.join());
  for (const l of store.loops) {
    assert.equal(l.config.alwaysUseWorktree, true, `${l.name} is isolated by default`);
    const regression = l.config.stages.some((s) => s.enabled && s.kind === "regressionSweep");
    assert.equal(runsInWorktree(l.config, l.defaultKey === "factory"), !regression || l.defaultKey === "factory", l.name);
  }
  const regression = store.loops.find((l) => l.defaultKey === "regression");
  assert.ok(worktreeBlockedStage(regression.config.stages), "the Regression loop has the stage that needs the working tree");
  assert.equal(runsInWorktree(regression.config, false), false);
});

test("a recipe made from a built-in template is isolated; a saved custom recipe keeps its own choice", () => {
  const builtIn = BUILT_IN_TEMPLATES.find((t) => t.id === "test-and-fix");
  assert.equal(applyTemplate(builtIn, "npm test").alwaysUseWorktree, true);
  const custom = { id: "mine", name: "Mine", summary: "", config: { ...structuredClone(builtIn.config), alwaysUseWorktree: false } };
  assert.equal(applyTemplate(custom, "npm test").alwaysUseWorktree, false);
});

test("a loop with the switch on runs in a worktree; with it off, or with a Regression step, it does not", () => {
  const stages = [{ kind: "shellCommand", enabled: true }];
  assert.equal(runsInWorktree({ alwaysUseWorktree: true, stages }, false), true);
  assert.equal(runsInWorktree({ alwaysUseWorktree: false, stages }, false), false);
  assert.equal(runsInWorktree({ alwaysUseWorktree: false, stages }, true), true, "the Factory always does");
  assert.equal(runsInWorktree({ alwaysUseWorktree: true, stages: [...stages, { kind: "regressionSweep", enabled: true }] }, false), false);
  assert.equal(runsInWorktree({ alwaysUseWorktree: true, stages: [...stages, { kind: "regressionSweep", enabled: false }] }, false), true, "an off Regression step does not block");
});

test("the refactor batch check accepts a loop that runs in a worktree and names the Regression reason otherwise", () => {
  const loop = initialProjectStore("npm test").loops.find((l) => l.defaultKey === "refactor");
  assert.equal(batchRollbackReason(loop), null);
  const onTree = { ...loop, config: { ...loop.config, alwaysUseWorktree: false } };
  assert.match(batchRollbackReason(onTree), /Always run in an isolated worktree/);
  const withRegression = { ...loop, config: { ...loop.config, stages: [...loop.config.stages, { ...loop.config.stages[0], kind: "regressionSweep", enabled: true }] } };
  assert.match(batchRollbackReason(withRegression), /Regression step/);
});

const ID_A = "1a2b3c4d-1111-4222-8333-444455556666";
const ID_B = "9f8e7d6c-1111-4222-8333-444455556666";
const SLUG_OK = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

test("a loop's branch slug is its name plus the first eight hex of its id, so it is unique and always valid", () => {
  assert.equal(loopBranchSlug("Refactoring", ID_A), "refactoring-1a2b3c4d");
  assert.equal(loopBranchSlug("日本語のループ", ID_A), "loop-1a2b3c4d", "a name with no usable character falls back to loop-<hex>");
  assert.notEqual(loopBranchSlug("Test!", ID_A), loopBranchSlug("test", ID_B), "alike names, different loops, different branches");
  assert.equal(loopBranchSlug("Test!", ID_A), "test-1a2b3c4d");
  assert.equal(nameSlug("x".repeat(40) + " tail").length <= 23, true);
  assert.equal(idHex8("l1"), idHex8("l1"), "an id with no hex still gives a stable eight digits");
  assert.match(idHex8("l1"), /^[0-9a-f]{8}$/);
  for (const n of ["Doc Optimization", "Main Loop", "a..b", "refs/heads/x", "Ünïcode name", "--x--", "x".repeat(60), "  ../../etc  ", ""]) {
    for (const id of [ID_A, "l1", "xyz"]) assert.match(loopBranchSlug(n, id), SLUG_OK, `${n} / ${id}`);
  }
});

test("a rename keeps the loop on its branch: an existing worktree carrying its id wins", () => {
  const before = loopBranchSlug("Regression", ID_A);
  assert.equal(loopBranchSlug("Regression checks", ID_A, ["other-9f8e7d6c", before, "20261120-101500-abc123"]), before);
  assert.notEqual(loopBranchSlug("Regression checks", ID_A), before, "with no worktree yet the new name is used");
  assert.notEqual(loopBranchSlug("Regression checks", ID_B, [before]), before, "another loop never takes it over");
});

test("end of run: pass with changes ships, no changes removes, failure keeps, doubt keeps", () => {
  assert.equal(runEndAction(base), "ship");
  assert.equal(runEndAction({ ...base, changed: false }), "discard");
  assert.equal(runEndAction({ ...base, passed: false }), "keep");
  assert.equal(runEndAction({ ...base, passed: false, changed: false }), "keep", "a failed run with no changes still keeps its branch");
  assert.equal(runEndAction({ ...base, cancelled: true }), "keep");
  assert.equal(runEndAction({ ...base, cancelled: true, changed: false }), "keep");
  assert.equal(runEndAction({ ...base, changed: null }), "keep", "an unreadable diff never deletes");
  assert.equal(runEndAction({ ...base, humanReview: true }), "hold");
  assert.equal(runEndAction({ ...base, humanReview: true, changed: false }), "discard", "nothing to review");
  assert.equal(runEndAction({ ...base, openMergeRequest: false }), "keep");
});

function world(over = {}) {
  const w = { calls: [], logs: [], removed: false };
  w.d = {
    syncStateBack: async () => { w.calls.push("sync"); },
    saveRecord: async () => { w.calls.push("record"); },
    removeIfEmpty: async () => { w.calls.push("remove"); return !w.keep; },
    ship: async () => { w.calls.push("ship"); return "Draft MR: https://github.com/o/r/pull/3"; },
    log: (l) => w.logs.push(l),
    ...over,
  };
  return w;
}
const run = { branch: "loop/refactoring", passed: true };

test("the end of a run is ordered: saved state back, then the record, then the removal or the MR", async () => {
  const gone = world();
  await endWorktreeRun(gone.d, "discard", run);
  assert.deepEqual(gone.calls, ["sync", "record", "remove"]);
  const shipped = world();
  const out = await endWorktreeRun(shipped.d, "ship", run);
  assert.deepEqual(shipped.calls, ["sync", "record", "ship"]);
  assert.deepEqual([out.line, out.panel], ["Draft MR: https://github.com/o/r/pull/3", false]);
  const failed = world();
  await endWorktreeRun(failed.d, "keep", { ...run, passed: false });
  assert.deepEqual(failed.calls, ["sync", "record"], "a failed run keeps everything and opens nothing");
  assert.match(failed.logs.join("\n"), /did not pass.*Branch loop\/refactoring is kept/);
});

test("a passed run whose branch has earlier commits keeps it and says so", async () => {
  const w = world();
  w.keep = true;
  const out = await endWorktreeRun(w.d, "discard", run);
  assert.equal(out.removed, false);
  assert.match(w.logs.at(-1), /Branch loop\/refactoring is kept: it has earlier commits/);
});

test("when the saved state cannot be copied back nothing is removed, because the worktree holds the only copy", async () => {
  const w = world({ syncStateBack: async () => { throw new Error("disk full"); } });
  const out = await endWorktreeRun(w.d, "discard", run);
  assert.equal(out.stateSaved, false);
  assert.ok(!w.calls.includes("remove"));
  assert.ok(w.calls.includes("record"), "the run is still recorded");
  assert.match(w.logs.join("\n"), /saved state could not be copied back.*disk full/);
});

test("a removal that fails keeps the branch and says so", async () => {
  const w = world({ removeIfEmpty: async () => { throw new Error("busy"); } });
  await endWorktreeRun(w.d, "discard", run);
  assert.match(w.logs.at(-1), /could not be removed: busy.*is kept/);
});

test("a blocked ship records why, keeps the branch and hands the run to a person", async () => {
  const w = world({ ship: async () => "MR not opened: CI or hook files changed (.gitlab-ci.yml), so it is not shipped automatically." });
  const out = await endWorktreeRun(w.d, "ship", run);
  assert.equal(out.panel, true);
  assert.match(out.line, /^MR not opened: CI or hook files/);
  assert.match(w.logs.at(-1), /Branch loop\/refactoring is kept/);
  const thrown = world({ ship: async () => { throw new Error("offline"); } });
  const t = await endWorktreeRun(thrown.d, "ship", run);
  assert.deepEqual([t.line, t.panel], ["MR not opened: offline", true]);
});

test("human review holds a passed run: nothing ships and the Ship panel opens", async () => {
  const w = world();
  const out = await endWorktreeRun(w.d, "hold", run);
  assert.deepEqual([out.line, out.panel], [null, true]);
  assert.ok(!w.calls.includes("ship"));
});

test("whether the branch changed comes from the run-end diff, and an unreadable diff is never read as empty", () => {
  assert.equal(runChanged({ files: ["a.ts"], truncated: false }), true);
  assert.equal(runChanged({ files: [], truncated: true }), true, "a cut list may hide files");
  assert.equal(runChanged({ files: [], truncated: false }), false);
  assert.equal(runChanged(null), null);
});

test("the app writes only its own reports to the main tree: run.md under llm-doc/loop/runs/, never the agent's edits", async () => {
  const { archiveDir } = await import("../native/summary.ts");
  const dir = archiveDir({ name: "Test" }, new Date("2026-11-02T01:30:00Z"));
  assert.ok(dir.startsWith("llm-doc/loop/runs/"), "reports go to the main project's llm-doc/loop/runs");
  assert.equal(dir.startsWith("system/loop-worktrees/"), false, "never the worktree");
});

test("a worktree run never works in the main tree: every stage and file read goes to the run's worktree", () => {
  const info = { runId: "regression", worktree: "/p/system/loop-worktrees/regression" };
  assert.equal(runRoot("/p", info, "/p/code/app"), "/p/system/loop-worktrees/regression");
  assert.equal(runRoot("/p", null, "/p/code/app"), "/p/code/app");
  assert.deepEqual(stageHostArgs("regression"), { runId: "regression" });
  assert.deepEqual(stageHostArgs(null), {});
});

test("the Set up stage reuses the Factory's install step and goes in only for a loop that tests in a worktree", () => {
  const store = initialProjectStore("npm test");
  const test = store.loops.find((l) => l.defaultKey === "test");
  const first = [...test.config.stages].sort((a, b) => a.order - b.order)[0];
  assert.deepEqual([first.name, first.command, first.kind, first.runOnce, isSetupStage(first)], ["Set up", "npm ci", "shellCommand", true, true]);
  assert.equal(test.config.stages.filter(isSetupStage).length, 1);
  assert.equal(withSetupStage(test, "npm test"), test, "it is added once");
  assert.equal(store.loops.find((l) => l.defaultKey === "factory").config.stages.some(isSetupStage), false, "the Factory has its own Set up stage");
  const regression = store.loops.find((l) => l.defaultKey === "regression");
  assert.equal(regression.config.stages.some(isSetupStage), false, "a loop on the working tree never installs there");
  const plain = initialProjectStore(null).loops.find((l) => l.defaultKey === "test");
  assert.equal(plain.config.stages.some(isSetupStage), false, "no test command, no install");
  const off = { ...test, config: { ...test.config, alwaysUseWorktree: false, stages: test.config.stages.filter((s) => !isSetupStage(s)) } };
  assert.equal(withSetupStage(off, "npm test"), off);
  assert.equal(configWithSetup(test.config, false).stages.find(isSetupStage).enabled, false);
  assert.equal(configWithSetup(test.config, true).stages.find(isSetupStage).enabled, true);
});

test("setup runs only when nothing is installed or the lockfile changed", async () => {
  const files = new Map();
  const fs = {
    read: async (p) => (files.has(p) ? { status: "ok", text: files.get(p).text, hash: files.get(p).hash } : { status: "missing", text: null, hash: null }),
    write: async (p, text) => { files.set(p, { text, hash: "w" }); },
  };
  const prefix = "system/loop-worktrees/test";
  files.set(`${prefix}/package-lock.json`, { text: "{}", hash: "lock-1" });
  assert.equal(await setupNeeded(fs, prefix, "npm ci"), true, "nothing installed yet");
  await markSetupDone(fs, prefix, "npm ci");
  assert.equal(await setupNeeded(fs, prefix, "npm ci"), false, "installed from this lockfile");
  files.set(`${prefix}/package-lock.json`, { text: "{ }", hash: "lock-2" });
  assert.equal(await setupNeeded(fs, prefix, "npm ci"), true, "the lockfile changed");
});

test("Clean up never offers a loop's own branch, a running loop or a branch with its MR", () => {
  const worktrees = new Map([
    ["regression", { branch: "loop/regression" }],
    ["test", { branch: "loop/test" }],
    ["r1", { branch: "factory/r1" }],
  ]);
  const idle = new Map([["regression", { changedFiles: 0, localCommits: 0 }], ["test", { changedFiles: 0, localCommits: 0 }], ["r1", { changedFiles: 0, localCommits: 0 }]]);
  const plan = cleanupPlan([], worktrees, [{ runId: "test" }], new Set(), new Set(["regression"]), idle);
  assert.deepEqual(plan.remove, ["r1"], "even a merged or empty loop worktree is not removed from the board");
  assert.deepEqual(plan.keep.map((k) => k.runId).sort(), ["regression", "test"]);
  assert.match(plan.keep[0].reason, /loop's own branch/);
});

test("a squash-merged MR is found through the provider, and any doubt is not a merge", async () => {
  const files = { "x/e1": { ship: { provider: "github", url: "https://github.com/o/r/pull/3", commit: "abc" } } };
  const fs = { read: async (p) => { const key = Object.keys(files).find((k) => p.includes(k.split("/")[1])); return key ? { status: "ok", text: JSON.stringify(files[key]), hash: "h" } : { status: "missing", text: null, hash: null }; } };
  const runs = [{ id: "e1", loopId: "L", startedAt: "2026-11-20T10:00:00.000Z" }, { id: "e0", loopId: "other", startedAt: "2026-11-20T11:00:00.000Z" }];
  const last = await lastShipUrl(fs, runs, "L");
  assert.equal(last?.url, "https://github.com/o/r/pull/3");
  assert.equal(await lastShipUrl(fs, runs, "nobody"), null);
  const merged = async () => ({ status: 200, body: { results: [{ url: last.url, state: "merged", ci: "success", comments: [] }] } });
  assert.equal(await providerSaysMerged(merged, last), true);
  const open = async () => ({ status: 200, body: { results: [{ url: last.url, state: "open", ci: "none", comments: [] }] } });
  assert.equal(await providerSaysMerged(open, last), false);
  assert.equal(await providerSaysMerged(async () => ({ status: 429, body: {} }), last), false);
  assert.equal(await providerSaysMerged(async () => { throw new Error("offline"); }, last), false);
  assert.equal(await providerSaysMerged(merged, null), false);
});

// The shipper itself is the Factory's: a loop's MR goes through the same blocks.
const info = { runId: "r1", project: "/p", repo: "/p/code/app", worktree: "/p/system/loop-worktrees/r1", branch: "loop/refactoring", baseCommit: "0123456789abcdef0123" };
const config = decodeRepoConfig({ saved: { github: [{ id: "g", url: "https://github.com/o/app", clonePath: "/p/code/app", active: true }] } });
const diff = (over = {}) => ({ text: "+x", truncated: false, patchId: "a".repeat(64), files: ["src/a.ts"], additions: 1, deletions: 0, ...over });
const shipWorld = (over = {}) => {
  const w = { bodies: [], saved: [], blocked: [] };
  w.d = {
    repoConfig: () => config, diff: async () => diff(), repoBranch: async () => "main", readText: async () => null,
    ship: async (b) => { w.bodies.push(b); return { ok: true, url: "https://github.com/o/app/pull/3", commit: "abc1234", reused: false }; },
    saveShip: async (e, s) => { w.saved.push(s); return true; }, saveBlocked: async (e, r) => { w.blocked.push(r); return true; },
    comment: async () => {}, now: () => new Date(0), ...over,
  };
  return w;
};
const ctx = { info, item: { source: "text", id: null, title: "Refactoring run r1", body: "", repo: null }, entry: { id: "e", startedAt: "2026-11-20T00:00:00.000Z" }, kind: "passed", failedStage: null, runPrefix: "system/loop-worktrees/r1", processName: "Refactoring" };

test("a loop's MR is a draft on its own branch, named for the loop, with the link recorded", async () => {
  const w = shipWorld();
  const out = await autoShipRun(w.d, ctx);
  assert.deepEqual(out, { shipped: "https://github.com/o/app/pull/3" });
  assert.equal(w.bodies.length, 1);
  assert.equal(w.bodies[0].branch, "loop/refactoring");
  assert.match(w.bodies[0].body, /Opened as a draft by the LLM-IDE Refactoring loop/);
  assert.doesNotMatch(w.bodies[0].body, /Factory/);
  assert.equal(w.saved[0].url, out.shipped);
});

test("the Factory's blocks hold for a loop too: CI files, a too-large diff and a missing repository never reach the core", async () => {
  for (const [over, why] of [
    [{ diff: async () => diff({ files: [".github/workflows/ci.yml"] }) }, /CI or hook files/],
    [{ diff: async () => diff({ truncated: true }) }, /too large/],
    [{ repoConfig: () => decodeRepoConfig({}) }, /not in Settings → Repositories/],
  ]) {
    const w = shipWorld(over);
    const out = await autoShipRun(w.d, ctx);
    assert.match(out.blocked, why);
    assert.equal(w.bodies.length, 0, "nothing was sent to the core");
    assert.match(w.blocked[0], why, "and the reason is recorded on the run");
  }
});

test("a loop.json saved before the default moves to its own branch once; an opt-out saved after sticks", () => {
  const old = { schemaVersion: 2, loops: [{ id: "l1", name: "Mine", isPrimary: true, scopeGlobs: [], defaultKey: null, runsOnSchedule: false, config: { stages: [], alwaysUseWorktree: false, maxIterations: 3 } }] };
  const moved = decodeProjectStore(old);
  assert.equal(moved.loops[0].config.alwaysUseWorktree, true, "an old file is migrated");
  const saved = JSON.parse(encodeProjectStore(moved));
  assert.equal(saved.loops[0].config.isolationDefault, true, "the move is recorded");
  moved.loops[0].config.alwaysUseWorktree = false; // the user opts out afterwards
  const optedOut = decodeProjectStore(JSON.parse(encodeProjectStore(moved)));
  assert.equal(optedOut.loops[0].config.alwaysUseWorktree, false, "a later opt-out sticks across a reload");
  assert.equal(decodeProjectStore(JSON.parse(encodeProjectStore(decodeProjectStore(saved)))).loops[0].config.alwaysUseWorktree, true, "a saved on stays on");
});

test("leftover uncommitted files from an earlier run hold the run for review instead of opening an MR", () => {
  assert.equal(runEndAction({ ...base, leftoverFiles: 3 }), "hold");
  assert.equal(runEndAction({ ...base, leftoverFiles: 0 }), "ship");
  assert.equal(runEndAction({ ...base, leftoverFiles: 3, changed: false }), "discard", "nothing to ship is still nothing");
  assert.equal(runEndAction({ ...base, leftoverFiles: 3, passed: false }), "keep");
});

test("the start copy-in refuses the run on failure and the finally fallback copies back only when the run never did", async () => {
  assert.deepEqual(await copyStateIn({ syncStateIn: async () => {} }, "loop/a-1"), { ok: true });
  const refused = await copyStateIn({ syncStateIn: async () => { throw new Error("too large"); } }, "loop/a-1");
  assert.equal(refused.ok, false);
  assert.match(refused.message, /too large.*did not start.*loop\/a-1 is kept/);
  let calls = 0;
  const d = { syncStateBack: async () => { calls += 1; } };
  assert.equal(await copyStateBackIfMissed(d, true), false);
  assert.equal(calls, 0, "already copied back");
  assert.equal(await copyStateBackIfMissed(d, false), true);
  assert.equal(calls, 1, "the run threw first: copied back now");
  assert.equal(await copyStateBackIfMissed({ syncStateBack: async () => { throw new Error("x"); } }, false), false, "never throws");
});

test("Discard belongs to a loop's newest run only", () => {
  const runs = [{ id: "a", loopId: "L", startedAt: "2026-11-20T10:00:00Z" }, { id: "b", loopId: "L", startedAt: "2026-11-20T12:00:00Z" }, { id: "c", loopId: "M", startedAt: "2026-11-20T13:00:00Z" }];
  assert.equal(isNewestRunOfLoop(runs, runs[1]), true);
  assert.equal(isNewestRunOfLoop(runs, runs[0]), false, "an older run of the same loop");
  assert.equal(isNewestRunOfLoop(runs, runs[2]), true, "another loop's newest is its own");
});

test("the setup marker is replaced when the lockfile changes, not only created", async () => {
  const files = new Map([["p/package-lock.json", { text: "{}", hash: "lock-1" }]]);
  const writes = [];
  const fs = {
    read: async (path) => (files.has(path) ? { status: "ok", text: files.get(path).text, hash: files.get(path).hash } : { status: "missing", text: null, hash: null }),
    write: async (path, text, opts) => {
      const have = files.get(path);
      if ((have?.hash ?? null) !== opts.expected_hash) throw new Error("hash mismatch");
      writes.push(text);
      files.set(path, { text, hash: `h${writes.length}` });
    },
  };
  await markSetupDone(fs, "p", "npm ci");
  files.set("p/package-lock.json", { text: "{ }", hash: "lock-2" });
  await markSetupDone(fs, "p", "npm ci");
  assert.deepEqual(writes, ["lock-1\n", "lock-2\n"]);
  assert.equal(await setupNeeded(fs, "p", "npm ci"), false);
});

test("a loop's branch is discarded only from its newest run and never while it runs; a Factory run is not held to that", () => {
  const runs = [{ id: "a", loopId: "L", startedAt: "2026-11-20T10:00:00Z" }, { id: "b", loopId: "L", startedAt: "2026-11-20T12:00:00Z" }];
  const loop = { branch: "loop/regression-1a2b3c4d" };
  assert.equal(branchDiscardRefusal(loop, runs, runs[1], null), null, "the newest run of an idle loop");
  assert.match(branchDiscardRefusal(loop, runs, runs[0], null), /newest run/, "an older run");
  assert.match(branchDiscardRefusal(loop, runs, runs[1], "L"), /running now/, "the loop is running");
  assert.equal(branchDiscardRefusal(loop, runs, runs[1], "other"), null, "another loop running is fine");
  // The rule follows the branch, not whether the run had a work item: a loop run without a work item is still a loop branch.
  assert.match(branchDiscardRefusal({ branch: "loop/x-12345678" }, runs, runs[0], null), /newest run/);
  assert.equal(branchDiscardRefusal({ branch: "factory/r1" }, runs, runs[0], "L"), null, "a Factory run has its own branch");
});

test("a worktree whose state cannot be read holds the run for review, like leftovers", () => {
  assert.equal(runEndAction({ ...base, leftoverFiles: null }), "hold");
  assert.equal(runEndAction({ ...base, leftoverFiles: null, changed: false }), "discard");
  assert.equal(runEndAction({ ...base, leftoverFiles: null, passed: false }), "keep");
});

test("a rejected lease says which provider and that nothing was overwritten, and nothing else from the server is echoed", () => {
  const msg = "The branch on GitLab has commits that are not from the merged MR; nothing was overwritten.";
  assert.equal(shipCopy({ ok: false, code: "lease_rejected", message: msg }), msg);
  assert.equal(shipCopy({ ok: false, code: "lease_rejected", message: "git said: token ghp_secret" }), "The branch on the provider has commits that are not from the merged MR; nothing was overwritten.");
});
