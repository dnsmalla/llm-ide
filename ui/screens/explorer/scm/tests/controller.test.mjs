import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../tests/helpers.mjs";
import { entry, makeScm, ScmErr } from "./fakes.mjs";

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
