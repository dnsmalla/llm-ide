import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../tests/helpers.mjs";
import { entry, makeScm } from "./fakes.mjs";

const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const { ScmController } = await load("scm/controller.ts");
const { ChangesView } = await load("scm/ChangesView.tsx");
const { HunkPane } = await load("scm/HunkPane.tsx");
const { HistoryView } = await load("scm/HistoryView.tsx");
const { BranchesView } = await load("scm/BranchesView.tsx");
const { ScmPanel } = await load("scm/ScmPanel.tsx");

async function ctl(init) {
  const api = makeScm(init);
  const c = new ScmController({ api });
  await c.init("/p");
  return { c, api };
}
const noop = () => undefined;
const changes = (c) => html(h(ChangesView, { controller: c, snap: c.getSnapshot(), onOpenFile: noop, onOpenDiff: noop }));

test("changes: tree semantics, grouped, positions, labelled rows and buttons", async () => {
  const { c } = await ctl({ entries: [entry("src/a.ts", ".", "M"), entry("b.ts", "A", "."), entry("n.txt", ".", "?", "untracked"), entry("x.txt", "U", "U", "unmerged")] });
  c.select("changes:src/a.ts", { shift: false, toggle: false });
  const out = changes(c);
  assert.match(out, /role="tree"[^>]*aria-label="Changes"[^>]*aria-multiselectable="true"/);
  assert.match(out, /role="treeitem"[^>]*aria-level="1"[^>]*aria-expanded="true"[^>]*aria-label="Merge conflicts, 1 file"/);
  assert.match(out, /aria-level="2"[^>]*aria-selected="true"[^>]*aria-label="a\.ts, modified, Changes"/);
  assert.match(out, /aria-posinset="2"[^>]*aria-setsize="8"/);
  assert.equal((out.match(/role="treeitem"/g) ?? []).length, 8);
  for (const label of ["Stage a.ts", "Unstage b.ts", "Discard changes to a.ts", "Discard changes to n.txt", "Mark resolved x.txt", "Select hunks of a.ts", "Open x.txt"]) {
    assert.ok(out.includes(`aria-label="${label}"`), label);
  }
  assert.ok(!out.includes('aria-label="Discard changes to b.ts"'), "staged files have no discard button");
  assert.match(out, /Resolve by editing the file, then stage it/);
});

test("changes: only the window of a 20,000 file list is rendered", async () => {
  const entries = Array.from({ length: 20_000 }, (_, i) => entry(`d/f${String(i).padStart(5, "0")}.txt`, ".", "M"));
  const { c } = await ctl({ entries });
  const out = changes(c);
  const n = (out.match(/role="treeitem"/g) ?? []).length;
  assert.ok(n > 0 && n < 80, `rendered ${n}`);
  assert.match(out, /data-pad="bottom"/);
  assert.match(out, /aria-setsize="20001"/);
  assert.match(out, /20,000 changes/);
});

test("changes: too-many notice, clean tree, loading status", async () => {
  const { c, api } = await ctl({ entries: [] });
  assert.match(changes(c), /Working tree clean/);
  api.state.truncated = true;
  await c.refresh();
  assert.match(changes(c), /Too many changes to list/);
});

test("changes: hostile names render as plain text with no bidi/control characters", async () => {
  const evil = "<img src=x onerror=alert(1)>‮fdp.txt";
  const { c } = await ctl({ entries: [entry(evil, ".", "M")] });
  const out = changes(c);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;fdp\.txt/);
  assert.ok(!out.includes("‮"));
});

test("commit box: disabled with the reason, hooks note always shown, identity commands when missing", async () => {
  const { c } = await ctl({ entries: [entry("a", "M", ".")], identity: null });
  let out = changes(c);
  assert.match(out, /<form[^>]*aria-label="Commit"/);
  assert.match(out, /<textarea[^>]*aria-label="Commit message"[^>]*aria-describedby="scm-commit-help"/);
  assert.match(out, /<button[^>]*disabled=""[^>]*aria-describedby="scm-commit-help"[^>]*>Commit \(1\)/);
  assert.match(out, /Write a commit message\. Hooks do not run in LLM-IDE\./);
  assert.match(out, /role="alert"/);
  assert.match(out, /git config --global user\.name &quot;Your Name&quot;/);
  assert.match(out, /never writes your git config/);
  c.setMessage("feat: x");
  out = changes(c);
  assert.doesNotMatch(out, /<button[^>]*disabled=""[^>]*>Commit \(1\)/);
});

test("commit box: identity shown when known", async () => {
  const { c } = await ctl({ entries: [entry("a", "M", ".")] });
  assert.match(changes(c), /Committing as Ada &lt;ada@example\.com&gt;/);
});

test("hunk pane: checkboxes labelled, bulk buttons, plain-text lines", async () => {
  const { c } = await ctl({ entries: [entry("a.txt", ".", "M")] });
  await c.openHunks("a.txt", false);
  c.toggleHunkAt(0);
  const out = html(h(HunkPane, { controller: c, snap: c.getSnapshot() }));
  assert.match(out, /<section[^>]*aria-label="Hunks of a\.txt"/);
  assert.match(out, /<input type="checkbox"[^>]*checked=""/);
  assert.match(out, /aria-label="Hunk 1: @@ -1,3 \+1,3 @@, 1 added, 1 removed"/);
  assert.match(out, />Stage 1 hunk</);
  assert.match(out, /role="toolbar"[^>]*aria-label="Hunk actions"/);
  assert.match(out, /data-kind="add"/);
  assert.match(out, /aria-label="Close hunk list"/);
});

test("hunk pane: staged side says Unstage; empty and truncated explain themselves", async () => {
  const { c } = await ctl({ entries: [entry("a.txt", "M", ".")] });
  await c.openHunks("a.txt", true);
  c.selectAllHunksNow();
  assert.match(html(h(HunkPane, { controller: c, snap: c.getSnapshot() })), />Unstage 2 hunks</);
  const e = await ctl({ entries: [entry("a.txt", ".", "M")], hunkDiff: { diff_id: "x", truncated: false, hunks: [] } });
  await e.c.openHunks("a.txt", false);
  assert.match(html(h(HunkPane, { controller: e.c, snap: e.c.getSnapshot() })), /Stage the whole file/);
  const t = await ctl({ entries: [entry("a.txt", ".", "M")], hunkDiff: { diff_id: "", truncated: true, hunks: [] } });
  await t.c.openHunks("a.txt", false);
  assert.match(html(h(HunkPane, { controller: t.c, snap: t.c.getSnapshot() })), /too large to stage by hunk/);
});

test("history list and commit detail", async () => {
  const log = [{ hash: "a".repeat(40), short: "aaaaaaa", author: "Ada‮", time: 1_700_000_000, subject: "feat: <b>x</b>", parents: 2 }];
  const { c } = await ctl({ entries: [], log });
  c.setTab("history");
  await new Promise((r) => setTimeout(r, 0));
  let out = html(h(HistoryView, { controller: c, snap: c.getSnapshot(), now: 1_700_000_600_000 }));
  assert.match(out, /<ul[^>]*aria-label="Commit history"/);
  assert.match(out, /feat: &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(out, /aaaaaaa · Ada · 10 min ago · merge/);
  assert.ok(!out.includes("‮"));
  await c.openCommit(log[0].hash);
  await c.openCommitFile("a.txt");
  out = html(h(HistoryView, { controller: c, snap: c.getSnapshot() }));
  assert.match(out, /aria-label="Changed files"/);
  assert.match(out, /aria-pressed="true"/);
  assert.match(out, /aria-label="Diff of a\.txt"/);
  assert.match(out, /Back/);
});

test("commit detail: Files (N) header counts the changed files", async () => {
  const log = [{ hash: "b".repeat(40), short: "bbbbbbb", author: "Ada", time: 1_700_000_000, subject: "two files", parents: 1 }];
  const { c, api } = await ctl({ entries: [], log });
  c.setTab("history");
  await new Promise((r) => setTimeout(r, 0));
  const orig = api.commitFiles;
  api.commitFiles = async (hash) => ({ ...(await orig(hash)), files: [{ status: "M", path: "a.txt" }, { status: "A", path: "b.txt" }] });
  await c.openCommit(log[0].hash);
  const out = html(h(HistoryView, { controller: c, snap: c.getSnapshot() }));
  assert.match(out, /Files \(2\)/);
  assert.match(out, /aria-label="Changed files"/);
  assert.ok(!out.includes("No files in this commit"));
});

test("commit detail: a commit with no changed files shows the empty state", async () => {
  const log = [{ hash: "c".repeat(40), short: "ccccccc", author: "Ada", time: 1_700_000_000, subject: "empty", parents: 1 }];
  const { c, api } = await ctl({ entries: [], log });
  c.setTab("history");
  await new Promise((r) => setTimeout(r, 0));
  const orig = api.commitFiles;
  api.commitFiles = async (hash) => ({ ...(await orig(hash)), files: [] });
  await c.openCommit(log[0].hash);
  const out = html(h(HistoryView, { controller: c, snap: c.getSnapshot() }));
  assert.match(out, /Files \(0\)/);
  assert.match(out, /No files in this commit/);
  assert.ok(!out.includes('aria-label="Changed files"'));
});

test("branches: current is marked and disabled, create form validates", async () => {
  const { c } = await ctl({ entries: [], branches: [{ name: "main", current: true, hash: "abc1234", upstream: "origin/main" }, { name: "dev", current: false, hash: "def5678", upstream: null }] });
  await c.loadBranches();
  const out = html(h(BranchesView, { controller: c, snap: c.getSnapshot() }));
  assert.match(out, /aria-current="true"[^>]*aria-label="main, current branch"[^>]*disabled=""/);
  assert.match(out, /aria-label="dev"/);
  assert.match(out, /<form[^>]*aria-label="Create branch"/);
  assert.match(out, /aria-label="New branch name"/);
  assert.match(out, /abc1234 · origin\/main/);
});

test("panel: tabs, fatal states, empty project", async () => {
  const { c } = await ctl({ entries: [entry("a", ".", "M")] });
  const out = html(h(ScmPanel, { projectRoot: "/p", onOpenFile: noop, onOpenDiff: noop, controller: c }));
  assert.match(out, /<section[^>]*aria-label="Source Control"/);
  assert.match(out, /role="tablist"[^>]*aria-label="Source Control views"/);
  assert.match(out, /role="tab"[^>]*id="scm-tab-changes"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  assert.match(out, /role="tab"[^>]*id="scm-tab-history"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
  assert.match(out, /role="tabpanel"[^>]*aria-labelledby="scm-tab-changes"/);
  assert.match(out, /main/);
  assert.match(out, /Hooks do not run/);
  const none = html(h(ScmPanel, { projectRoot: null, onOpenFile: noop, onOpenDiff: noop, api: makeScm() }));
  assert.match(none, /Open a project to see its changes/);
  const api = makeScm();
  api.state.failNext = Object.assign(new Error("x"), { code: "untrusted_repo_config", message: "runs programs (filter driver)" });
  const bad = new ScmController({ api });
  await bad.init("/p");
  const fatal = html(h(ScmPanel, { projectRoot: "/p", onOpenFile: noop, onOpenDiff: noop, controller: bad }));
  assert.match(fatal, /role="alert"/);
  assert.match(fatal, /not trusted/);
  assert.match(fatal, /filter driver/);
  assert.doesNotMatch(fatal, /role="tablist"/);
});

test("changes menu: stage or unstage for every row; discard only for working-tree and untracked files; copy and reveal always", async () => {
  const { changeMenu } = await load("scm/ChangesView.tsx");
  const item = (group, entry) => ({ key: `${group}:${entry.path}`, group, entry, letter: "M" });
  const e = (path, extra = {}) => ({ path, orig_path: null, index: "M", worktree: "M", kind: "changed", ...extra });
  const labels = (it) => changeMenu(it).map((m) => m.id);
  assert.deepEqual(labels(item("changes", e("a.ts"))), ["stage", "discard", "copy", "reveal"]);
  assert.deepEqual(labels(item("untracked", e("n.ts", { kind: "untracked" }))), ["stage", "discard", "copy", "reveal"]);
  assert.deepEqual(labels(item("staged", e("s.ts"))), ["unstage", "copy", "reveal"]);
  assert.deepEqual(labels(item("conflicts", e("c.ts", { kind: "unmerged" }))), ["stage", "copy", "reveal"]);
  assert.equal(changeMenu(item("changes", e("a.ts")))[0].label, "Stage");
  assert.equal(changeMenu(item("conflicts", e("c.ts", { kind: "unmerged" })))[0].label, "Mark resolved (stage)");
  assert.deepEqual(labels(item("changes", e("sub", { submodule: true }))), ["stage", "copy", "reveal"], "a submodule cannot be discarded from here");
});

test("tags: read-only list names the commit and the annotated or lightweight kind", async () => {
  const { c } = await ctl({ entries: [], tags: [{ name: "v1.0/rc", target: "abc1234", annotated: true }, { name: "light", target: "def5678", annotated: false }] });
  c.setTab("branches");
  await new Promise((r) => setTimeout(r, 0));
  const out = html(h(BranchesView, { controller: c, snap: c.getSnapshot() }));
  assert.match(out, /aria-labelledby="scm-tags-title"[\s\S]*>Tags</);
  assert.match(out, /aria-label="Local tags"/);
  assert.match(out, /v1\.0\/rc[\s\S]*abc1234 · annotated/);
  assert.match(out, /light[\s\S]*def5678 · lightweight/);
  assert.doesNotMatch(out, /<button[^>]*>[^<]*tag/i, "no tag action is offered");
});

test("tags: an empty listing says so", async () => {
  const { c } = await ctl({ entries: [], tags: [] });
  c.setTab("branches");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(html(h(BranchesView, { controller: c, snap: c.getSnapshot() })), /No tags yet\./);
});
