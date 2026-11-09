import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../tests/helpers.mjs";
import { entry, fakeHash, makeScm, ScmErr } from "./fakes.mjs";

const { ScmController } = await load("scm/controller.ts");

async function ctl(init) {
  const api = makeScm(init);
  const c = new ScmController({ api });
  await c.init("/proj");
  return { c, api, snap: () => c.getSnapshot() };
}
const calls = (api, name) => api.calls.filter((x) => x[0] === name);

test("init loads status + identity and groups the entries", async () => {
  const { snap } = await ctl({ entries: [entry("a", ".", "M"), entry("b", "A", "."), entry("c", ".", "?", "untracked")] });
  const s = snap();
  assert.equal(s.phase, "ready");
  assert.deepEqual(s.counts, { staged: 1, changes: 1, untracked: 1, conflicts: 0 });
  assert.equal(s.identity.state, "ok");
  assert.equal(s.rows.length, 6);
});

test("no project: nothing is called", async () => {
  const api = makeScm();
  const c = new ScmController({ api });
  await c.init(null);
  assert.equal(api.calls.length, 0);
  assert.equal(c.getSnapshot().phase, "idle");
});

test("repo-level errors become one fatal explanation (untrusted config, not a repo)", async () => {
  for (const [code, title] of [["untrusted_repo_config", /not trusted/], ["not_a_repo", /Not a git repository/]]) {
    const api = makeScm();
    api.state.failNext = new ScmErr(code, "x");
    const c = new ScmController({ api });
    await c.init("/p");
    const s = c.getSnapshot();
    assert.equal(s.phase, "error");
    assert.match(s.fatal.title, title);
    assert.equal(s.rows.length, 0);
  }
});

test("stage selected chunks to the host's per-call cap and refreshes", async () => {
  const entries = Array.from({ length: 1200 }, (_, i) => entry(`f${String(i).padStart(4, "0")}`, ".", "M"));
  const { c, api, snap } = await ctl({ entries });
  c.select("changes:f0000", { shift: false, toggle: false });
  c.select("changes:f1199", { shift: true, toggle: false });
  assert.equal(snap().selection.keys.size, 1200);
  const before = calls(api, "status").length;
  await c.stageSelected();
  const st = calls(api, "stage");
  assert.deepEqual(st.map((x) => x[1].length), [500, 500, 200]);
  assert.ok(st.every((x) => x[2] === true));
  assert.equal(calls(api, "status").length, before + 1);
  assert.equal(snap().busy, null);
});

test("unstage and bulk actions", async () => {
  const { c, api } = await ctl({ entries: [entry("a", "M", ".")] });
  c.select("staged:a", { shift: false, toggle: false });
  await c.unstageSelected();
  assert.deepEqual(calls(api, "stage")[0].slice(1), [["a"], false]);
  await c.stageAll(true);
  assert.deepEqual(calls(api, "stageAll")[0], ["stageAll", true]);
});

test("discard: host path list only for changes/untracked, cap, cancel is info and keeps state", async () => {
  const entries = [entry("a", ".", "M"), entry("u", ".", "?", "untracked"), entry("s", "M", ".")];
  const { c, api, snap } = await ctl({ entries });
  let changed = 0;
  c.opts.onFilesChanged = () => changed++;
  for (const k of ["changes:a", "untracked:u", "staged:s"]) c.select(k, { shift: false, toggle: true });
  await c.discardSelected();
  assert.deepEqual(calls(api, "discard")[0][1], ["a", "u"]);
  assert.equal(changed, 1);
  assert.match(snap().notice.text, /Discarded 2/);
  api.state.failNext = null;
  // Cancelled in the native dialog: info, nothing reported as discarded.
  c.api.discard = async () => { throw new ScmErr("cancelled"); };
  await c.discard([snap().groups.changes[0]]);
  assert.equal(snap().notice.kind, "info");
  assert.equal(changed, 1);
  // Too many at once is refused before any host call.
  const many = Array.from({ length: 201 }, (_, i) => entry(`m${i}`, ".", "M"));
  const x = await ctl({ entries: many });
  await x.c.discard(x.snap().groups.changes);
  assert.equal(calls(x.api, "discard").length, 0);
  assert.equal(x.snap().notice.kind, "error");
});

test("hunks: open, toggle, apply sends sorted indexes + the diff id, then reloads", async () => {
  const { c, api, snap } = await ctl({ entries: [entry("a", ".", "M")] });
  await c.openHunks("a", false);
  assert.equal(snap().hunks.status, "ready");
  c.toggleHunkAt(1);
  c.toggleHunkAt(0);
  await c.applyHunks();
  assert.deepEqual(calls(api, "stageHunks")[0], ["stageHunks", "a", false, "id1", [0, 1]]);
  assert.equal(calls(api, "diffHunks").length, 2, "reloaded after applying");
  assert.equal(snap().hunks.selected.size, 0);
  assert.match(snap().notice.text, /2 hunk/);
});

test("hunks: a stale diff (host says changed) reloads and tells the user", async () => {
  const { c, api, snap } = await ctl({ entries: [entry("a", ".", "M")] });
  await c.openHunks("a", false);
  c.toggleHunkAt(0);
  api.stageHunks = async () => { throw new ScmErr("changed"); };
  await c.applyHunks();
  assert.equal(snap().notice.info.code, "changed");
  assert.equal(calls(api, "diffHunks").length, 2);
  assert.equal(snap().hunks.selected.size, 0);
});

test("hunks: nothing selected or truncated diff never calls the host", async () => {
  const { c, api } = await ctl({ entries: [entry("a", ".", "M")], hunkDiff: { diff_id: "", truncated: true, hunks: [] } });
  await c.openHunks("a", false);
  await c.applyHunks();
  assert.equal(calls(api, "stageHunks").length, 0);
});

test("commit: validated first, sends the raw message, clears it, surfaces identity_missing", async () => {
  const { c, api, snap } = await ctl({ entries: [entry("a", "M", ".")] });
  c.setMessage("   ");
  await c.commit();
  assert.equal(calls(api, "commit").length, 0);
  assert.equal(snap().notice.kind, "error");
  c.setMessage("feat: x\n\nbody");
  await c.commit();
  assert.deepEqual(calls(api, "commit")[0], ["commit", "feat: x\n\nbody"]);
  assert.equal(snap().message, "");
  assert.match(snap().notice.text, /deadbee/);
  // identity missing at commit time
  const y = await ctl({ entries: [entry("a", "M", ".")], identity: null });
  assert.equal(y.snap().identity.state, "missing");
  y.api.state.identity = { name: "x", email: "y" };
  y.c.setMessage("m");
  y.api.commit = async () => { throw new ScmErr("identity_missing"); };
  await y.c.commit();
  assert.equal(y.snap().identity.state, "missing");
  assert.equal(y.snap().notice.info.steps.length, 2);
  assert.equal(y.snap().message, "m", "message kept for the retry");
});

test("commit is blocked with conflicts or nothing staged", async () => {
  const a = await ctl({ entries: [entry("a", ".", "M")] });
  a.c.setMessage("m");
  assert.equal(a.c.commitCheck().ok, false);
  const b = await ctl({ entries: [entry("a", "U", "U", "unmerged"), entry("b", "M", ".")] });
  b.c.setMessage("m");
  assert.match(b.c.commitCheck().reason, /conflict/i);
});

test("a stale status response never overwrites a newer one", async () => {
  const { c, api, snap } = await ctl({ entries: [entry("a", ".", "M")] });
  let release;
  api.state.gate = new Promise((r) => (release = r));
  const slow = c.refresh();
  api.state.entries = [entry("b", ".", "M"), entry("c", ".", "M")];
  api.state.gate = null;
  await c.refresh();
  release();
  await slow;
  assert.deepEqual(snap().groups.changes.map((i) => i.entry.path), ["b", "c"]);
});

test("selection and focus survive refresh only for files that still exist", async () => {
  const { c, api, snap } = await ctl({ entries: [entry("a", ".", "M"), entry("b", ".", "M")] });
  c.select("changes:a", { shift: false, toggle: false });
  c.select("changes:b", { shift: false, toggle: true });
  api.state.entries = [entry("b", ".", "M")];
  await c.refresh();
  assert.deepEqual([...snap().selection.keys], ["changes:b"]);
  assert.equal(c.moveFocus(1) !== null, true);
});

test("branches: invalid names never reach the host; checkout reloads", async () => {
  const { c, api, snap } = await ctl({ entries: [] });
  assert.equal(await c.createBranch("--force"), false);
  await c.checkout("a..b");
  assert.equal(calls(api, "createBranch").length + calls(api, "checkout").length, 0);
  assert.equal(snap().notice.kind, "error");
  assert.equal(await c.createBranch("feature/x"), true);
  await c.checkout("main");
  assert.deepEqual(calls(api, "checkout")[0], ["checkout", "main"]);
  assert.ok(calls(api, "branches").length >= 2);
  // a refused switch is reported, not thrown
  api.checkout = async () => { throw new ScmErr("dirty_conflict"); };
  await c.checkout("other");
  assert.equal(snap().notice.info.code, "dirty_conflict");
});

test("a refused checkout keeps the open hunks; a successful one clears them", async () => {
  const { c, api, snap } = await ctl({ entries: [entry("a", ".", "M")] });
  await c.openHunks("a", false);
  const open = snap().hunks;
  assert.equal(open.status, "ready");
  api.checkout = async () => { throw new ScmErr("dirty_conflict"); };
  await c.checkout("other");
  assert.equal(snap().hunks, open, "a refused switch does not touch the hunks");
  api.checkout = async () => {};
  await c.checkout("other");
  assert.equal(snap().hunks, null, "a switch that happened clears them");
});

test("history pages and lazy commit detail with sanitized diff", async () => {
  const log = Array.from({ length: 250 }, (_, i) => ({ hash: "h".repeat(40) + i, short: "abc" + i, author: "A", time: 1, subject: `s${i}`, parents: 1 }));
  const { c, api, snap } = await ctl({ entries: [], log });
  c.setTab("history");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(snap().history.entries.length, 100);
  assert.equal(snap().history.hasMore, true);
  await c.loadLog(false);
  assert.equal(snap().history.entries.length, 200);
  assert.deepEqual(calls(api, "log").map((x) => x[1]), [0, 100]);
  await c.openCommit(log[0].hash);
  assert.equal(snap().history.open.detail.files[0].path, "a.txt");
  await c.openCommitFile("a.txt");
  const d = snap().history.open.diff;
  assert.ok(!d.text.includes("‮"), "bidi stripped");
  assert.ok(d.text.includes("+b"));
  c.closeCommit();
  assert.equal(snap().history.open, null);
});

test("switching project resets everything", async () => {
  const { c, snap } = await ctl({ entries: [entry("a", ".", "M")] });
  c.setMessage("draft");
  await c.init("/other");
  assert.equal(snap().message, "");
  assert.equal(snap().root, "/other");
});

test("tags: loaded on the branches tab, read-only, and a tag failure never blocks branches", async () => {
  const { c, api, snap } = await ctl({ entries: [], tags: [{ name: "v1.0", target: "abc1234", annotated: true }, { name: "rc", target: "def5678", annotated: false }], tagsTruncated: true });
  assert.equal(snap().tags.list.length, 0, "not loaded until the tab is opened");
  c.setTab("branches");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(snap().tags.list.map((t) => [t.name, t.annotated]), [["v1.0", true], ["rc", false]]);
  assert.equal(snap().tags.truncated, true);
  assert.equal(calls(api, "tags").length, 1);
  // The only write path is the list call: no tag command beyond `tags`.
  assert.ok(!api.calls.some((x) => /tag/i.test(x[0]) && x[0] !== "tags"));
  // A failing tag listing is reported on its own; the branch list still loads.
  const bad = await ctl({ entries: [], tagsError: new ScmErr("io", "boom") });
  bad.c.setTab("branches");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bad.snap().tags.error.title !== undefined, true);
  assert.equal(bad.snap().branches.list.length, 1);
  assert.equal(bad.snap().branches.error, null);
});

// ---- branch delete, tag create, stash (desktop host commands) ---------------------------------------

test("branch delete: a merged branch is deleted (the host asks natively) and the list reloads", async () => {
  const { c, api, snap } = await ctl({ entries: [], branches: [{ name: "main", current: true, hash: "abc1234", upstream: null }, { name: "dev", current: false, hash: "def5678", upstream: null }] });
  await c.loadBranches();
  await c.deleteBranch("dev");
  assert.deepEqual(calls(api, "branchDelete").map((x) => [x[1], x[2]]), [["dev", false]]);
  assert.deepEqual(snap().branches.list.map((b) => b.name), ["main"]);
  assert.equal(snap().notice.kind, "info");
  assert.equal(snap().pendingBranchDelete, null);
});

test("branch delete: not merged keeps the branch, names the commits, and only the explicit second step forces it", async () => {
  const { c, api, snap } = await ctl({ entries: [], branches: [{ name: "main", current: true, hash: "abc1234", upstream: null }, { name: "feat", current: false, hash: "def5678", upstream: null }], unmerged: ["feat"] });
  await c.loadBranches();
  await c.deleteBranch("feat");
  assert.deepEqual(snap().pendingBranchDelete, { name: "feat", tip: "def5678", unique: 2 });
  assert.equal(snap().branches.list.length, 2, "nothing is removed by the refusal");
  c.cancelBranchDelete();
  assert.equal(snap().pendingBranchDelete, null);
  await c.deleteBranch("feat");
  await c.forceDeleteBranch();
  assert.deepEqual(calls(api, "branchDelete").map((x) => x[2]), [false, false, true]);
  assert.deepEqual(snap().branches.list.map((b) => b.name), ["main"]);
});

test("branch delete: the current branch and bad names never reach the host", async () => {
  const { c, api, snap } = await ctl({ entries: [] });
  await c.deleteBranch("main");
  await c.deleteBranch("-x");
  await c.deleteBranch("a..b");
  assert.equal(calls(api, "branchDelete").length, 0);
  assert.equal(snap().notice.kind, "error");
});

test("tags: a new tag is validated first, sends an empty message as none, and reloads the list", async () => {
  const { c, api, snap } = await ctl({ entries: [], tags: [] });
  assert.equal(await c.createTag("bad name", ""), false);
  assert.equal(calls(api, "tagCreate").length, 0, "an invalid name never reaches the host");
  assert.equal(await c.createTag("v1.0", "   "), true);
  assert.deepEqual(calls(api, "tagCreate")[0].slice(1), ["v1.0", undefined, undefined]);
  assert.equal(snap().notice.text, "Created tag v1.0.");
  assert.deepEqual(snap().tags.list.map((t) => t.name), ["v1.0"]);
});

test("tags: an oversized message is refused before the host; a host refusal is a plain sentence", async () => {
  const { c, api, snap } = await ctl({ entries: [], tags: [] });
  assert.equal(await c.createTag("big", "x".repeat(2049)), false);
  assert.equal(calls(api, "tagCreate").length, 0);
  assert.equal(await c.createTag("v1.0", "notes"), true);
  assert.equal(await c.createTag("v1.0", "notes"), false);
  assert.equal(snap().notice.kind, "error");
  assert.match(snap().notice.info.detail, /already exists/);
});

test("stash: the list loads with the branches tab and is newest first", async () => {
  const { c, api, snap } = await ctl({ entries: [], stashes: ["WIP on main: newest", "older"] });
  c.setTab("branches");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls(api, "stashList").length, 1);
  assert.deepEqual(snap().stashes.list.map((s) => [s.index, s.message]), [[0, "WIP on main: newest"], [1, "older"]]);
});

test("stash: stash changes sends the message and the include flag, then reloads", async () => {
  const { c, api, snap } = await ctl({ entries: [{ path: "a.txt", orig_path: null, index: ".", worktree: "M", kind: "changed", submodule: false }], stashes: [] });
  assert.equal(await c.stashChanges("wip", true), true);
  assert.deepEqual(calls(api, "stashPush")[0].slice(1), ["wip", true]);
  assert.deepEqual(snap().stashes.list.map((s) => s.message), ["wip"]);
  assert.equal(await c.stashChanges("x".repeat(2049), false), false);
  assert.equal(calls(api, "stashPush").length, 1, "an oversized message is refused before the host");
});

test("stash: apply keeps the stash; pop removes it; a conflict is an error and the stash stays", async () => {
  const { c, api, snap } = await ctl({ entries: [], stashes: ["one", "two"] });
  c.setTab("branches");
  await new Promise((r) => setTimeout(r, 0));
  await c.applyStash(snap().stashes.list[1]);
  assert.equal(snap().stashes.list.length, 2);
  await c.popStash(snap().stashes.list[0]);
  assert.deepEqual(snap().stashes.list.map((s) => s.message), ["two"]);
  api.state.failNext = new ScmErr("conflicts", "The stash did not apply cleanly.");
  await c.popStash(snap().stashes.list[0]);
  assert.equal(snap().notice.kind, "error");
  assert.equal(snap().stashes.list.length, 1, "a conflicted pop leaves the list as git left it");
  assert.deepEqual(calls(api, "stashPop").map((x) => x[1]), [0, 0]);
});

test("stash: drop waits for the in-page confirmation, names the message, then drops", async () => {
  const { c, api, snap } = await ctl({ entries: [], stashes: ["keep me"] });
  c.setTab("branches");
  await new Promise((r) => setTimeout(r, 0));
  c.askDropStash(snap().stashes.list[0]);
  assert.deepEqual(snap().pendingStashDrop, { index: 0, hash: fakeHash("keep me"), message: "keep me" });
  assert.equal(calls(api, "stashDrop").length, 0, "nothing is dropped by asking");
  c.cancelDropStash();
  assert.equal(snap().pendingStashDrop, null);
  c.askDropStash(snap().stashes.list[0]);
  await c.dropStash();
  assert.equal(calls(api, "stashDrop").length, 1);
  assert.equal(snap().stashes.list.length, 0);
  assert.equal(snap().pendingStashDrop, null);
});

test("stash: apply, pop and drop send the hash the user saw; a list that moved is refused and nothing changes", async () => {
  const { c, api, snap } = await ctl({ entries: [], stashes: ["seen"] });
  c.setTab("branches");
  await new Promise((r) => setTimeout(r, 0));
  const seen = snap().stashes.list[0];
  c.askDropStash(seen);
  api.state.stashes = ["pushed elsewhere", "seen"]; // another tool stashed meanwhile: index 0 is now a different entry
  await c.dropStash();
  assert.deepEqual(calls(api, "stashDrop")[0].slice(1), [0, fakeHash("seen")]);
  assert.equal(snap().notice.kind, "error");
  assert.deepEqual(api.state.stashes, ["pushed elsewhere", "seen"], "the other stash was not dropped");
  assert.deepEqual(snap().stashes.list.map((s) => s.message), ["pushed elsewhere", "seen"], "the list reloads");
});

test("merge: a clean merge asks once with the fast-forward mode and reports the new hash", async () => {
  const { c, api, snap } = await ctl({ branches: [{ name: "main", current: true, hash: "a", upstream: null }, { name: "feat", current: false, hash: "b", upstream: null }] });
  await c.mergeBranch("feat");
  assert.deepEqual(calls(api, "merge")[0], ["merge", "feat", "ff"]);
  assert.match(snap().notice.text, /Fast-forwarded to abc1234/);
  assert.equal(snap().busy, null);
});

test("merge: conflicts are reported by file name, plainly, and the merge stays for abort", async () => {
  const { c, api, snap } = await ctl({ mergeOutcome: { status: "conflicts", paths: ["a.txt", "src/<b>.ts"], truncated: false } });
  await c.mergeBranch("feat");
  assert.match(snap().notice.text, /conflicts in 2 file\(s\): a\.txt, src\/<b>\.ts/);
  assert.equal(api.state.merging, true);
  assert.equal(snap().status.merging, true);
  await c.abortMerge();
  assert.deepEqual(calls(api, "mergeAbort").length, 1);
  assert.equal(api.state.merging, false);
});

test("merge: an invalid branch name never reaches the host", async () => {
  const { c, api, snap } = await ctl();
  await c.mergeBranch("-x");
  assert.equal(calls(api, "merge").length, 0);
  assert.equal(snap().notice.kind, "error");
});

test("amend: the staged files and the optional message go to the host; success clears the message", async () => {
  const { c, api, snap } = await ctl({ entries: [entry("a.txt", "M", ".")] });
  c.setMessage("New subject");
  assert.equal(await c.amend("New subject"), true);
  assert.deepEqual(calls(api, "commitAmend")[0], ["commitAmend", "New subject", false]);
  assert.equal(snap().message, "");
  assert.match(snap().notice.text, /now fed9876/);
});

test("amend: nothing staged and no message is refused before the host", async () => {
  const { c, api, snap } = await ctl({ entries: [] });
  assert.equal(await c.amend("   "), false);
  assert.equal(calls(api, "commitAmend").length, 0);
  assert.equal(snap().notice.kind, "error");
});

test("amend: an already-pushed commit waits for the in-page step, and only then sends force", async () => {
  const { c, api, snap } = await ctl({ entries: [entry("a.txt", "M", ".")], amendPublished: true });
  assert.equal(await c.amend("msg"), false);
  assert.deepEqual(snap().pendingAmend, { message: "msg" });
  assert.equal(calls(api, "commitAmend")[0][2], false, "the first call never forces");
  await c.amendAnyway();
  assert.deepEqual(calls(api, "commitAmend")[1], ["commitAmend", "msg", true]);
  assert.equal(snap().pendingAmend, null);
});

test("amend: the second step can be cancelled without any host call", async () => {
  const { c, api, snap } = await ctl({ entries: [entry("a.txt", "M", ".")], amendPublished: true });
  await c.amend("msg");
  c.cancelAmendAnyway();
  assert.equal(snap().pendingAmend, null);
  assert.equal(calls(api, "commitAmend").length, 1);
});

test("discard all: the Trash choice goes to the host and the result is reported with what was left", async () => {
  let changed = 0;
  const { c, api, snap } = await ctl({ entries: [entry("a.txt", "M", "."), entry("n.txt", ".", "?", "untracked")] });
  c.opts.onFilesChanged = () => changed++;
  await c.discardAll(false);
  assert.deepEqual(calls(api, "discardAll")[0], ["discardAll", false]);
  assert.match(snap().notice.text, /Restored 1 changed file\(s\) to HEAD\./);
  await c.discardAll(true);
  assert.match(snap().notice.text, /Moved 1 untracked item\(s\) to the Trash/);
  assert.equal(changed, 2);
});
