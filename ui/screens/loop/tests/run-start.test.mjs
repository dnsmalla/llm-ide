import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareLoopRun } from "../native/run-start.ts";
import { loopBranchSlug } from "../native/worktree-run.ts";
import { configWithSetup } from "../native/loop-setup.ts";
import { factoryLoop, initialProjectStore } from "../native/templates.ts";

const store = initialProjectStore("npm test");
const plain = store.loops.find((l) => l.defaultKey === "refactor");
const factory = factoryLoop("npm test");
const ROOT = "/p";
const slug = loopBranchSlug(plain.name, plain.id, []);
const infoFor = (runId) => ({ runId, project: ROOT, repo: "/p/code/app", worktree: `${ROOT}/system/loop-worktrees/${runId}`, branch: `loop/${runId}`, baseCommit: "0123456789abcdef" });
const MERGED = { url: "https://gitlab.com/g/r/-/merge_requests/7", since: "2026-01-01T00:00:00.000Z" };
const repoConfig = { saved: { github: [], gitlab: [{ id: "1", displayName: "r", url: "https://gitlab.com/g/r", clonePath: "/p/code/app", active: true }] } };

/** Fakes that record every call in order; `over` replaces any of them. */
function make(over = {}) {
  const calls = [];
  const state = { starting: false, unmounted: false, prepareArgs: null };
  const deps = {
    async host(command, args) {
      calls.push(`host:${command}`);
      if (over.host) { const r = await over.host(command, args, state); if (r !== undefined) return r; }
      if (command === "loop_worktree_list") return [];
      if (command === "loop_worktree_prepare") { state.prepareArgs = args; return infoFor(args.runId); }
      if (command === "loop_worktree_status") return { changedFiles: 0, localCommits: 0, pushed: false };
      return null;
    },
    async folderExists(path) { calls.push(`folder:${path}`); return over.folderExists ? over.folderExists(path) : true; },
    async approveLoop() { calls.push("approveLoop"); return over.approveLoop === undefined ? { token: "tok", expiresAtMs: 1, stageIds: [], faultCount: 0 } : over.approveLoop; },
    async approvalStatus() { calls.push("approvalStatus"); return over.approvalStatus ?? { approved: true, pending: 0, expiresAtMs: 1, token: "granted" }; },
    async refreshApproval() { calls.push("refreshApproval"); },
    async lastShip() { calls.push("lastShip"); return over.lastShip ?? null; },
    async post(path) { calls.push(`post:${path}`); return over.post ? over.post(path) : { status: 200, body: { results: [] } }; },
    readRepoConfig: () => repoConfig,
    newRunId: () => "20260101-000000-abcd",
    async setupNeeded(prefix, command) { calls.push("setupNeeded"); state.setupArgs = [prefix, command]; return over.setupNeeded ?? false; },
    isUnmounted: () => state.unmounted,
    beginStarting() { calls.push("begin"); if (state.starting) return false; state.starting = true; return true; },
    endStarting() { calls.push("end"); state.starting = false; },
    closePicker() { calls.push("closePicker"); },
    log(line) { calls.push(`log:${line}`); },
  };
  return { deps, calls, state };
}

const input = (over = {}) => ({ target: plain, scheduled: false, start: null, command: undefined, oneItem: false, useWorktree: true, projectRoot: ROOT, workRoot: ROOT, workRelative: "", ...over });
const hostCalls = (calls) => calls.filter((c) => c.startsWith("host:"));

test("a missing input folder refuses before any worktree call and releases the guard", async () => {
  const { deps, calls, state } = make({ folderExists: () => false });
  const r = await prepareLoopRun(deps, input({ target: { ...plain, inputPath: "tools" } }));
  assert.deepEqual(r, { ok: false, notice: "The input path “tools” does not exist in this repository, so the run did not start." });
  assert.deepEqual(hostCalls(calls), []);
  assert.equal(state.starting, false);
  assert.deepEqual(calls.slice(-3), ["closePicker", "folder:tools", "end"]);
});

test("the input folder is resolved against the picked work item's repo, else the work root", async () => {
  const a = make();
  await prepareLoopRun(a.deps, input({ target: { ...plain, inputPath: "tools" }, workRelative: "code/app" }));
  assert.ok(a.calls.includes("folder:code/app/tools"));
  const b = make();
  await prepareLoopRun(b.deps, input({ target: { ...factory, inputPath: "tools" }, start: { repoRel: "code/x", task: "t", item: { source: "text", id: null, title: "t", body: "", repo: null } } }));
  assert.ok(b.calls.includes("folder:code/x/tools"));
});

test("approval denied refuses without taking the guard", async () => {
  const { deps, calls } = make({ approveLoop: null });
  const r = await prepareLoopRun(deps, input());
  assert.deepEqual(r, { ok: false, notice: "The Loop commands were not approved; the run did not start." });
  assert.deepEqual(calls, ["approveLoop"]);
});

test("a scheduled run reuses a grant and never opens the dialog; without one it skips", async () => {
  const ok = make();
  const r = await prepareLoopRun(ok.deps, input({ scheduled: true }));
  assert.equal(r.ok, true);
  assert.equal(r.approvalToken, "granted");
  assert.equal(ok.calls.includes("approveLoop"), false);
  const none = make({ approvalStatus: { approved: false, pending: 1, expiresAtMs: null, token: null } });
  const s = await prepareLoopRun(none.deps, input({ scheduled: true }));
  assert.match(s.notice, /needs a native host approval for its exact shell commands before a scheduled run/);
  assert.equal(none.calls.includes("begin"), false);
});

test("an approval error becomes the notice", async () => {
  const { deps } = make();
  deps.approveLoop = async () => { throw new Error("dialog crashed"); };
  assert.deepEqual(await prepareLoopRun(deps, input()), { ok: false, notice: "dialog crashed" });
});

test("a leave during the approval dialog and a second start in flight both refuse silently", async () => {
  const gone = make();
  gone.state.unmounted = true;
  assert.deepEqual(await prepareLoopRun(gone.deps, input()), { ok: false, notice: null });
  assert.equal(gone.calls.includes("begin"), false);
  const busy = make();
  busy.state.starting = true;
  assert.deepEqual(await prepareLoopRun(busy.deps, input()), { ok: false, notice: null });
  assert.equal(busy.state.starting, true, "the first start's guard is left alone");
});

test("an unresolved repository refuses before any worktree call", async () => {
  const { deps, calls, state } = make();
  const r = await prepareLoopRun(deps, input({ projectRoot: null }));
  assert.match(r.notice, /^The repository for this run could not be resolved/);
  assert.deepEqual(hostCalls(calls), []);
  assert.equal(state.starting, false);
});

test("non-Factory loop with no worktree: list, prepare with the slug as run id, status, state copy-in, header", async () => {
  const { deps, calls, state } = make();
  const r = await prepareLoopRun(deps, input());
  assert.equal(r.ok, true);
  assert.deepEqual(hostCalls(calls), ["host:loop_worktree_list", "host:loop_worktree_prepare", "host:loop_worktree_status", "host:loop_worktree_state_sync"]);
  assert.deepEqual(state.prepareArgs, { repoRel: "", runId: slug, base: null, task: `# ${plain.name}\n\nLoop run in an isolated worktree. No work item was picked; the loop's goal applies.\n`, loopSlug: slug, fresh: false });
  assert.equal(r.reusedWorktree, false);
  assert.equal(r.mergedMr, null);
  assert.equal(r.leftoverFiles, 0);
  assert.equal(r.notice, null);
  assert.equal(r.approvalToken, "tok");
  assert.equal(state.starting, true, "the guard stays held for the screen to clear");
  assert.deepEqual(r.logLines, [`▶ ${plain.name}`, `⎇ isolated worktree system/loop-worktrees/${slug} on loop/${slug}, started from 0123456`, ""]);
});

test("the non-Factory happy path makes exactly this call sequence", async () => {
  const { deps, calls } = make();
  await prepareLoopRun(deps, input());
  assert.deepEqual(calls, ["approveLoop", "refreshApproval", "begin", "closePicker", "host:loop_worktree_list", "lastShip", "host:loop_worktree_prepare", "host:loop_worktree_status", "host:loop_worktree_state_sync", "setupNeeded"]);
});

test("a scheduled grant refreshes the approval state after reading it", async () => {
  const { deps, calls } = make();
  await prepareLoopRun(deps, input({ scheduled: true }));
  assert.deepEqual(calls.slice(0, 3), ["approvalStatus", "refreshApproval", "begin"]);
});

test("a setup stage that is needed stays enabled; setupNeeded gets the worktree prefix and the stage command", async () => {
  const setupStage = { id: "loop/setup-install", name: "Setup", kind: "shell", enabled: true, command: "npm ci", severity: "required" };
  const loop = { ...plain, config: { ...plain.config, stages: [...plain.config.stages, setupStage] } };
  const need = make({ setupNeeded: true });
  const a = await prepareLoopRun(need.deps, input({ target: loop }));
  assert.deepEqual(need.state.setupArgs, [`system/loop-worktrees/${slug}`, "npm ci"]);
  assert.deepEqual(a.runConfig, configWithSetup(loop.config, true));
  const skip = make({ setupNeeded: false });
  const b = await prepareLoopRun(skip.deps, input({ target: loop }));
  assert.deepEqual(b.runConfig, configWithSetup(loop.config, false));
});

test("a throw after the guard was taken releases it and rethrows", async () => {
  const setupStage = { id: "loop/setup-install", name: "Setup", kind: "shell", enabled: true, command: "npm ci", severity: "required" };
  const loop = { ...plain, config: { ...plain.config, stages: [...plain.config.stages, setupStage] } };
  const a = make();
  a.deps.setupNeeded = async () => { throw new Error("probe failed"); };
  await assert.rejects(prepareLoopRun(a.deps, input({ target: loop })), /probe failed/);
  assert.equal(a.state.starting, false);
  const b = make();
  b.deps.folderExists = async () => { throw new Error("fs gone"); };
  await assert.rejects(prepareLoopRun(b.deps, input({ target: { ...plain, inputPath: "tools" } })), /fs gone/);
  assert.equal(b.state.starting, false);
});

test("an existing worktree of the loop is reused", async () => {
  const { deps, state } = make({ host: (cmd) => (cmd === "loop_worktree_list" ? [infoFor(slug)] : undefined) });
  const r = await prepareLoopRun(deps, input());
  assert.equal(r.reusedWorktree, true);
  assert.equal(state.prepareArgs.fresh, false);
  assert.equal(state.prepareArgs.runId, slug);
});

test("a merged previous MR restarts on a fresh branch cut from the fetched base", async () => {
  const { deps, calls, state } = make({
    lastShip: MERGED,
    host: (cmd) => (cmd === "loop_worktree_list" ? [infoFor(slug)] : cmd === "loop_repo_branch" ? "main" : undefined),
    post: (path) => (path === "/kb/loop/ship-status" ? { status: 200, body: { results: [{ url: MERGED.url, state: "merged", ci: "success", comments: [] }] } } : { status: 200, body: {} }),
  });
  const r = await prepareLoopRun(deps, input());
  assert.equal(r.mergedMr, MERGED.url);
  assert.equal(r.reusedWorktree, false);
  assert.equal(state.prepareArgs.fresh, true);
  assert.equal(state.prepareArgs.base, "origin/main");
  assert.deepEqual(hostCalls(calls).slice(0, 3), ["host:loop_worktree_list", "host:loop_repo_branch", "host:loop_worktree_prepare"]);
  assert.ok(calls.indexOf("post:/kb/loop/ship-status") < calls.indexOf("post:/kb/loop/sync-base"));
});

test("a failed base fetch is logged and the branch is cut from the local base", async () => {
  const { deps, calls, state } = make({
    lastShip: MERGED,
    host: (cmd) => (cmd === "loop_worktree_list" ? [infoFor(slug)] : cmd === "loop_repo_branch" ? "main" : undefined),
    post: (path) => (path === "/kb/loop/ship-status" ? { status: 200, body: { results: [{ url: MERGED.url, state: "merged", ci: "success", comments: [] }] } } : { status: 500, body: {} }),
  });
  const r = await prepareLoopRun(deps, input());
  assert.equal(r.ok, true);
  assert.equal(state.prepareArgs.base, null);
  assert.ok(calls.includes("log:The base branch could not be fetched, so the restarted branch is cut from your local copy of it."));
});

test("leftover files are counted, noticed and logged; an unreadable status counts as leftovers", async () => {
  const some = make({ host: (cmd) => (cmd === "loop_worktree_status" ? { changedFiles: 1, localCommits: 0, pushed: false } : undefined) });
  const a = await prepareLoopRun(some.deps, input());
  assert.equal(a.leftoverFiles, 1);
  assert.equal(a.notice, "1 uncommitted file from an earlier run on this loop's branch. This run's changes will wait for your review instead of opening a merge request.");
  assert.ok(a.logLines.includes("1 uncommitted file(s) from an earlier run are in this worktree; the end of this run waits for your review."));
  const unreadable = make({ host: (cmd) => { if (cmd === "loop_worktree_status") throw new Error("boom"); } });
  const b = await prepareLoopRun(unreadable.deps, input());
  assert.equal(b.leftoverFiles, null);
  assert.match(b.notice, /^The worktree's state could not be read/);
  assert.ok(b.logLines.includes("The worktree's state could not be read; the end of this run waits for your review."));
});

test("a worktree prepare failure, or one outside system/loop-worktrees, refuses and releases the guard", async () => {
  const fail = make({ host: (cmd) => { if (cmd === "loop_worktree_prepare") throw new Error("disk full"); } });
  const a = await prepareLoopRun(fail.deps, input());
  assert.deepEqual(a, { ok: false, notice: "The isolated worktree could not be created: disk full. The run did not start." });
  assert.equal(fail.state.starting, false);
  const odd = make({ host: (cmd) => (cmd === "loop_worktree_prepare" ? { ...infoFor("x"), worktree: "/elsewhere/x" } : undefined) });
  const b = await prepareLoopRun(odd.deps, input());
  assert.match(b.notice, /is not under this project's system\/loop-worktrees\/ folder, so the run did not start\. The worktree was kept\.$/);
  assert.equal(odd.state.starting, false);
});

test("a leave while the worktree was prepared refuses silently", async () => {
  const { deps, state } = make({ host: (cmd, _a, st) => { if (cmd === "loop_worktree_prepare") st.unmounted = true; } });
  assert.deepEqual(await prepareLoopRun(deps, input()), { ok: false, notice: null });
  assert.equal(state.starting, false);
});

test("a failed state copy-in refuses with the branch kept", async () => {
  const { deps, state } = make({ host: (cmd) => { if (cmd === "loop_worktree_state_sync") throw new Error("copy failed"); } });
  const r = await prepareLoopRun(deps, input());
  assert.equal(r.ok, false);
  assert.match(r.notice, /^The Loop's saved state could not be copied into the worktree: copy failed\. The run did not start; branch loop\//);
  assert.equal(state.starting, false);
});

test("Factory loop: no list, no shared slug, fresh generated run id, no status read, no copy-in", async () => {
  const start = { repoRel: "code/app", task: "# Task", item: { source: "text", id: null, title: "t", body: "", repo: null } };
  const { deps, calls, state } = make();
  const r = await prepareLoopRun(deps, input({ target: factory, start }));
  assert.equal(r.ok, true);
  assert.deepEqual(hostCalls(calls), ["host:loop_worktree_prepare"]);
  assert.deepEqual(state.prepareArgs, { repoRel: "code/app", runId: "20260101-000000-abcd", base: null, task: "# Task", loopSlug: null, fresh: false });
  assert.equal(r.leftoverFiles, 0);
  assert.equal(r.reusedWorktree, false);
  assert.equal(r.mergedMr, null);
  assert.equal(r.runConfig, factory.config, "the page fills Verify for a Factory run itself");
  assert.equal(r.logLines[0], `▶ ${factory.name}`);
});

test("a one-item run puts its task in the log header", async () => {
  const { deps } = make();
  const r = await prepareLoopRun(deps, input({ oneItem: true, command: "  fix the bug " }));
  assert.deepEqual(r.logLines.slice(0, 2), [`▶ ${plain.name}`, "Task: fix the bug"]);
});

test("a loop without a worktree takes no host call and keeps the guard", async () => {
  const { deps, calls } = make();
  const r = await prepareLoopRun(deps, input({ useWorktree: false }));
  assert.equal(r.ok, true);
  assert.equal(r.info, null);
  assert.deepEqual(hostCalls(calls), []);
  assert.deepEqual(r.logLines, [`▶ ${plain.name}`, ""]);
});
