import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";
import { makeFs, makeEditor, settle, tick, sha } from "./fakes.mjs";

const { ExplorerController, gitDecoFor } = await load("controller.ts");
const T = await load("tree-model.ts");

const memKv = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), m }; };

async function setup(files, opts = {}) {
  const fs = makeFs(files);
  const editor = makeEditor();
  const kv = opts.kv ?? memKv();
  const c = new ExplorerController({ fs, editor: () => editor, kv, pageSize: opts.pageSize ?? 3, settleMs: 0 });
  editor.mount(null, {
    onDirty: (p, d) => c.onEditorDirty(p, d), onSave: (p) => void c.save(p), onEvict: () => {},
  });
  await c.init("/proj", opts.treeBase);
  await settle();
  return { fs, editor, c, kv };
}
const rows = (c) => c.rowsFor(0, 1000).map((r) => (r.kind === "entry" ? r.entry.path : r.kind));

test("init lists the root and starts the watcher with root and .git", async () => {
  const { c, fs } = await setup({ "a.txt": "a", "src/main.rs": "m", ".hidden": "h" });
  assert.deepEqual(rows(c), ["src", "a.txt"]);
  assert.equal(c.getSnapshot().watchMode, "native");
  await settle();
  assert.deepEqual(fs.state.watched.sort(), ["", ".git"]);
});

test("the tree can be rooted at the project's code/ folder (the Mac's Explorer root)", async () => {
  const { c, fs } = await setup({ "code/src/main.rs": "m", "code/README.md": "r", "notes/a.md": "n", "system/x.txt": "x" }, { treeBase: "code" });
  assert.equal(c.getSnapshot().treeBase, "code");
  assert.deepEqual(rows(c), ["code/src", "code/README.md"], "only code/ is listed; notes/ and system/ are not");
  await settle();
  assert.deepEqual(fs.state.watched.sort(), ["", ".git", "code"]);
});

test("collapse all closes every folder except the tree base", async () => {
  const { c } = await setup({ "code/src/main.rs": "m", "code/src/lib.rs": "l", "code/a.txt": "a" }, { treeBase: "code" });
  await c.toggleDir("code/src", true);
  assert.ok(c.getSnapshot().tree.expanded.has("code/src"));
  c.collapseAll();
  assert.deepEqual([...c.getSnapshot().tree.expanded].sort(), ["code"]);
  assert.deepEqual(rows(c), ["code/src", "code/a.txt"], "children are no longer laid out");
});

test("a missing code/ folder falls back to the project root", async () => {
  const { c } = await setup({ "app/main.swift": "m", "README.md": "r" }, { treeBase: "code" });
  assert.equal(c.getSnapshot().treeBase, "");
  assert.deepEqual(rows(c), ["app", "README.md"]);
});

test("expanding loads the folder lazily; collapsing prunes its listing", async () => {
  const { c } = await setup({ "src/main.rs": "m", "src/lib.rs": "l", "a.txt": "a" });
  await c.toggleDir("src", true);
  assert.deepEqual(rows(c), ["src", "src/lib.rs", "src/main.rs", "a.txt"]);
  await c.toggleDir("src", false);
  assert.equal(c.getSnapshot().tree.dirs.has("src"), false);
  assert.deepEqual(rows(c), ["src", "a.txt"]);
});

test("a long folder is paged: gaps load on request", async () => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.txt`, "x"]));
  const { c, fs } = await setup(files);
  const snap = c.getSnapshot();
  assert.equal(snap.layout.count, 10);
  assert.deepEqual(c.rowsFor(0, 10).map((r) => r.kind), ["entry", "entry", "entry", "gap", "gap", "gap", "gap", "gap", "gap", "gap"]);
  c.requestPages(c.rowsFor(0, 10));
  await settle();
  assert.equal(c.rowsFor(0, 10).every((r) => r.kind === "entry"), true);
  assert.equal(fs.calls.filter((x) => x[0] === "list" && x[1] === "").length, 4);
});

test("single click opens a preview tab, a second preview replaces it, double click keeps it", async () => {
  const { c, editor } = await setup({ "a.txt": "A", "b.txt": "B", "c.txt": "C" });
  await c.openFile("a.txt");
  await c.openFile("b.txt");
  assert.deepEqual(c.getSnapshot().tabs.tabs.map((t) => t.id), ["b.txt"]);
  await c.openFile("b.txt", false);
  await c.openFile("c.txt");
  assert.deepEqual(c.getSnapshot().tabs.tabs.map((t) => t.id), ["b.txt", "c.txt"]);
  assert.equal(editor.current, "c.txt");
  assert.equal(c.getSnapshot().docs.get("c.txt").status, "ready");
});

test("editing marks dirty, save writes with the expected hash and clears dirty", async () => {
  const { c, editor, fs } = await setup({ "a.txt": "one" });
  await c.openFile("a.txt", false);
  editor.type("a.txt", "two");
  assert.equal(c.getSnapshot().tabs.tabs[0].dirty, true);
  assert.equal(c.getSnapshot().docs.get("a.txt").state.dirty, true);
  assert.equal(await c.save("a.txt"), true);
  assert.equal(fs.files.get("a.txt"), "two");
  assert.deepEqual(fs.calls.find((x) => x[0] === "write"), ["write", "a.txt", sha("one")]);
  assert.equal(c.getSnapshot().tabs.tabs[0].dirty, false);
  assert.equal(c.getSnapshot().docs.get("a.txt").state.diskHash, sha("two"));
  // Typing back to the saved text is clean again (editor reports it).
  editor.type("a.txt", "three");
  editor.type("a.txt", "two");
  assert.equal(c.getSnapshot().tabs.tabs[0].dirty, false);
});

test("external edit while dirty: save conflicts, buffer is kept, keep-mine overwrites, reload discards", async () => {
  const { c, editor, fs } = await setup({ "a.txt": "one" });
  await c.openFile("a.txt", false);
  editor.type("a.txt", "mine");
  fs.files.set("a.txt", "theirs");
  assert.equal(await c.save("a.txt"), false);
  assert.equal(fs.files.get("a.txt"), "theirs");
  assert.equal(c.getSnapshot().docs.get("a.txt").state.external, "changed");
  assert.equal(editor.getText("a.txt"), "mine");
  assert.equal(await c.keepMineAndSave("a.txt"), true);
  assert.equal(fs.files.get("a.txt"), "mine");
  assert.equal(c.getSnapshot().docs.get("a.txt").state.external, "none");

  fs.files.set("a.txt", "theirs2");
  editor.type("a.txt", "mine2");
  c.onBatch({ dirs: [""], files: ["a.txt"], overflow: false });
  await settle();
  assert.equal(c.getSnapshot().docs.get("a.txt").state.external, "changed");
  await c.reloadFromDisk("a.txt");
  assert.equal(editor.getText("a.txt"), "theirs2");
  assert.equal(c.getSnapshot().docs.get("a.txt").state.dirty, false);
  assert.equal(c.getSnapshot().docs.get("a.txt").state.external, "none");
});

test("external edit of a clean buffer reloads silently; our own save echo does nothing", async () => {
  const { c, editor, fs } = await setup({ "a.txt": "one" });
  await c.openFile("a.txt", false);
  fs.files.set("a.txt", "external");
  c.onBatch({ dirs: [""], files: ["a.txt"], overflow: false });
  await settle();
  assert.equal(editor.getText("a.txt"), "external");
  editor.type("a.txt", "mine");
  await c.save("a.txt");
  const reads = fs.calls.filter((x) => x[0] === "read").length;
  c.onBatch({ dirs: [""], files: ["a.txt"], overflow: false });
  await settle();
  assert.equal(editor.getText("a.txt"), "mine");
  assert.equal(c.getSnapshot().docs.get("a.txt").state.external, "none");
  assert.equal(fs.calls.filter((x) => x[0] === "read").length, reads + 1);
});

test("file deleted on disk: clean tab gets the deleted state, buffer stays", async () => {
  const { c, editor, fs } = await setup({ "a.txt": "one" });
  await c.openFile("a.txt", false);
  fs.files.delete("a.txt");
  c.onBatch({ dirs: [""], files: ["a.txt"], overflow: false });
  await settle();
  assert.equal(c.getSnapshot().docs.get("a.txt").state.external, "deleted");
  assert.equal(editor.getText("a.txt"), "one");
});

test("closing a dirty tab asks first; discard closes and disposes the model", async () => {
  const { c, editor } = await setup({ "a.txt": "one", "b.txt": "two" });
  await c.openFile("a.txt", false);
  await c.openFile("b.txt", false);
  editor.type("a.txt", "x");
  assert.equal(c.requestClose("a.txt"), "prompt");
  assert.equal(editor.has("a.txt"), true);
  c.discardAndClose("a.txt");
  assert.equal(editor.has("a.txt"), false);
  assert.deepEqual(c.getSnapshot().tabs.tabs.map((t) => t.id), ["b.txt"]);
  assert.equal(c.requestClose("b.txt"), "close");
  assert.equal(c.getSnapshot().tabs.activeId, null);
  assert.equal(editor.modelCount(), 0);
});

test("save-and-close saves first", async () => {
  const { c, editor, fs } = await setup({ "a.txt": "one" });
  await c.openFile("a.txt", false);
  editor.type("a.txt", "x");
  assert.equal(await c.saveAndClose("a.txt"), true);
  assert.equal(fs.files.get("a.txt"), "x");
  assert.equal(c.getSnapshot().tabs.tabs.length, 0);
});

test("a model evicted for memory is re-read when its tab is activated", async () => {
  const { c, editor, fs } = await setup({ "a.txt": "one", "b.txt": "two" });
  await c.openFile("a.txt", false);
  await c.openFile("b.txt", false);
  editor.evict("a.txt");
  fs.files.set("a.txt", "changed while evicted");
  await c.activateTab("a.txt");
  await settle();
  assert.equal(editor.getText("a.txt"), "changed while evicted");
  assert.equal(editor.current, "a.txt");
});

test("rename updates tabs, models, docs and expanded folders", async () => {
  const { c, editor, fs } = await setup({ "src/a.ts": "A", "src/b.ts": "B" });
  await c.toggleDir("src", true);
  await c.openFile("src/a.ts", false);
  editor.type("src/a.ts", "A2");
  assert.equal(await c.renameEntry("src", "lib"), "lib");
  assert.deepEqual(c.getSnapshot().tabs.tabs.map((t) => t.id), ["lib/a.ts"]);
  assert.equal(editor.getText("lib/a.ts"), "A2");
  assert.ok(c.getSnapshot().docs.has("lib/a.ts"));
  assert.equal(c.getSnapshot().tree.expanded.has("lib"), true);
  assert.equal(c.getSnapshot().tree.expanded.has("src"), false);
  await settle();
  assert.ok(rows(c).includes("lib"));
  assert.ok(fs.files.has("lib/a.ts"));
});

test("rename rejects bad names without calling the host", async () => {
  const { c, fs } = await setup({ "a.txt": "a" });
  for (const bad of ["", "  ", "a/b", "..", "x\\y"]) assert.equal(await c.renameEntry("a.txt", bad), null);
  assert.equal(fs.calls.some((x) => x[0] === "rename"), false);
  assert.equal(c.getSnapshot().notice.severity, "warning");
  assert.equal(await c.createEntry("", "a.txt", "file"), null);
  assert.match(c.getSnapshot().notice.message, /already exists/);
});

test("create file opens it; create folder expands the parent", async () => {
  const { c } = await setup({ "src/x.ts": "x" });
  assert.equal(await c.createEntry("src", "new.ts", "file"), "src/new.ts");
  assert.equal(c.getSnapshot().tabs.activeId, "src/new.ts");
  assert.ok(rows(c).includes("src/new.ts"));
  assert.equal(await c.createEntry("", "docs", "dir"), "docs");
  assert.ok(rows(c).includes("docs"));
});

test("delete goes to trash, closes clean tabs, keeps dirty tabs flagged deleted, reports trash failure", async () => {
  const { c, editor, fs } = await setup({ "src/a.ts": "A", "src/b.ts": "B", "keep.txt": "k" });
  await c.toggleDir("src", true);
  await c.openFile("src/a.ts", false);
  await c.openFile("src/b.ts", false);
  editor.type("src/b.ts", "dirty");
  await c.deleteEntries(["src"]);
  assert.deepEqual(c.getSnapshot().tabs.tabs.map((t) => t.id), ["src/b.ts"]);
  assert.equal(c.getSnapshot().docs.get("src/b.ts").state.external, "deleted");
  assert.equal(fs.files.has("src/a.ts"), false);
  fs.state.trashFails = true;
  await c.deleteEntries(["keep.txt"]);
  assert.equal(fs.files.has("keep.txt"), true);
  assert.match(c.getSnapshot().notice.message, /trash/);
});

test("moveInto skips drops onto itself or a descendant and moves folders with their contents", async () => {
  const { c, fs } = await setup({ "a/x.txt": "x", "b/y.txt": "y" });
  await c.moveInto(["a"], "a");
  await c.moveInto(["a"], "b");
  assert.ok(fs.files.has("b/a/x.txt"));
  assert.equal(fs.calls.filter((x) => x[0] === "rename").length, 1);
});

test("binary and too-large files get a placeholder doc, not a model; open anyway reads a bounded range", async () => {
  const big = "x".repeat(6000);
  const { c, editor } = await setup({ "img.bin": "BIN:abc", "big.log": big });
  await c.openFile("img.bin", false);
  assert.equal(c.getSnapshot().docs.get("img.bin").status, "binary");
  assert.equal(editor.has("img.bin"), false);
  await c.openFile("big.log", false);
  assert.equal(c.getSnapshot().docs.get("big.log").status, "too_large");
  await c.openAnyway("big.log");
  assert.equal(c.getSnapshot().docs.get("big.log").status, "range");
  assert.equal(c.getSnapshot().docs.get("big.log").readOnly, true);
  assert.equal(editor.models.get("big.log").text.length, 6000);
  assert.equal(c.getSnapshot().docs.get("big.log").rangeNext, null);
  assert.equal(await c.save("big.log"), false);
});

test("git status decorates files and their ancestor folders; not a repo is silent", async () => {
  const { c, fs } = await setup({ "src/a.ts": "A" });
  fs.state.gitEntries = [
    { path: "src/a.ts", orig_path: null, index: ".", worktree: "M", kind: "changed" },
    { path: "new.txt", orig_path: null, index: ".", worktree: "?", kind: "untracked" },
  ];
  await c.refreshGit();
  const g = c.getSnapshot().git;
  assert.equal(g.deco.get("src/a.ts"), "modified");
  assert.equal(g.deco.get("new.txt"), "untracked");
  assert.ok(g.dirs.has("src"));
  assert.equal(g.branch, "main");
  fs.state.gitError = "not_a_repo";
  await c.refreshGit();
  assert.equal(c.getSnapshot().git, null);
  assert.equal(gitDecoFor("U", "U", "unmerged"), "conflicted");
  assert.equal(gitDecoFor("A", ".", "changed"), "added");
  assert.equal(gitDecoFor(".", "D", "changed"), "deleted");
});

test("watch batches refresh only loaded folders; overflow refreshes everything", async () => {
  const { c, fs } = await setup({ "src/a.ts": "A", "a.txt": "x" });
  await c.toggleDir("src", true);
  fs.calls.length = 0;
  fs.files.set("src/new.ts", "n");
  c.onBatch({ dirs: ["src", "not-loaded"], files: ["src/new.ts"], overflow: false });
  await settle();
  assert.deepEqual([...new Set(fs.calls.filter((x) => x[0] === "list").map((x) => x[1]))], ["src"]);
  assert.ok(rows(c).includes("src/new.ts"));
  fs.calls.length = 0;
  c.onBatch({ dirs: [], files: [], overflow: true });
  await settle();
  assert.deepEqual([...new Set(fs.calls.filter((x) => x[0] === "list").map((x) => x[1]))].sort(), ["", "src"]);
});

test("session: tabs and expanded folders restore for the same project only", async () => {
  const kv = memKv();
  const a = await setup({ "src/a.ts": "A", "b.txt": "B" }, { kv });
  await a.c.toggleDir("src", true);
  await a.c.openFile("src/a.ts", false);
  await a.c.openFile("b.txt", false);
  a.c.flushSession();
  const b = await setup({ "src/a.ts": "A", "b.txt": "B" }, { kv });
  assert.deepEqual(b.c.getSnapshot().tabs.tabs.map((t) => t.id), ["src/a.ts", "b.txt"]);
  assert.equal(b.c.getSnapshot().tabs.activeId, "b.txt");
  assert.equal(b.editor.has("b.txt"), true);
  assert.ok(rows(b.c).includes("src/a.ts"));
  // Another project root starts clean.
  const other = makeFs({ "z.txt": "z" });
  const c2 = new ExplorerController({ fs: other, editor: () => null, kv, pageSize: 3, settleMs: 0 });
  await c2.init("/other");
  assert.equal(c2.getSnapshot().tabs.tabs.length, 0);
});

test("switching project drops stale async results", async () => {
  const slow = makeFs({ "old.txt": "o" });
  const fast = makeFs({ "new.txt": "n" });
  let release;
  const gate = new Promise((r) => (release = r));
  const origList = slow.list;
  slow.list = async (...a) => { await gate; return origList(...a); };
  let current = slow;
  const proxy = new Proxy({}, { get: (_, k) => (...a) => current[k](...a) });
  const c = new ExplorerController({ fs: proxy, editor: () => null, kv: null, pageSize: 3, settleMs: 0 });
  const first = c.init("/one");
  await tick(1);
  current = fast;
  await c.init("/two");
  release();
  await first;
  await settle();
  assert.deepEqual(rows(c), ["new.txt"]);
  assert.equal(c.getSnapshot().root, "/two");
});

test("no project: nothing is requested from the host", async () => {
  const fs = makeFs({});
  const c = new ExplorerController({ fs, editor: () => null, kv: null, settleMs: 0 });
  await c.init(null);
  assert.deepEqual(fs.calls, []);
  assert.equal(c.getSnapshot().layout.count, 0);
});

test("diff toggles on and off through the editor host", async () => {
  const { c, editor } = await setup({ "a.txt": "A" });
  await c.openFile("a.txt", false);
  await c.toggleDiff("a.txt");
  assert.deepEqual(editor.diff, ["a.txt", "HEAD:a.txt"]);
  assert.equal(c.getSnapshot().diffPath, "a.txt");
  await c.toggleDiff("a.txt");
  assert.equal(editor.diff, null);
});

test("typing during a save keeps the buffer dirty (H5)", async () => {
  const { c, editor, fs } = await setup({ "a.txt": "one" });
  await c.openFile("a.txt", false);
  editor.type("a.txt", "two");
  const realWrite = fs.write;
  fs.write = async (...a) => { const r = await realWrite(...a); editor.type("a.txt", "two+more"); return r; };
  assert.equal(await c.save("a.txt"), true);
  assert.equal(fs.files.get("a.txt"), "two");
  assert.equal(c.getSnapshot().tabs.tabs[0].dirty, true);
  assert.equal(c.getSnapshot().docs.get("a.txt").state.dirty, true);
  assert.equal(editor.models.get("a.txt").text, "two+more");
  assert.equal(editor.models.get("a.txt").saved, "two");
});

test("reloadFromDisk never overwrites keystrokes typed during the read (M5)", async () => {
  const { c, editor, fs } = await setup({ "a.txt": "one" });
  await c.openFile("a.txt", false);
  editor.type("a.txt", "mine");
  fs.files.set("a.txt", "theirs");
  const realRead = fs.read;
  fs.read = async (p) => { const r = await realRead(p); editor.type("a.txt", "mine!!"); return r; };
  await c.reloadFromDisk("a.txt");
  assert.equal(editor.models.get("a.txt").text, "mine!!");
  assert.equal(c.getSnapshot().docs.get("a.txt").state.external, "changed");
});

test("rename to the same name is a no-op; a name with a line break is refused before the host", async () => {
  const { c, fs } = await setup({ "a.txt": "a" });
  assert.equal(await c.renameEntry("a.txt", "a.txt"), "a.txt");
  assert.equal(fs.calls.some((x) => x[0] === "rename"), false);
  assert.equal(await c.renameEntry("a.txt", "x\ny.txt"), null);
  assert.equal(await c.createEntry("", "p\r\nq", "file"), null);
  assert.match(c.getSnapshot().notice.message, /line breaks/);
  assert.equal(fs.calls.some((x) => x[0] === "create" || x[0] === "rename"), false);
});

test("paste copy takes a Finder-style free name, also when pasting into the same folder", async () => {
  const { c, fs } = await setup({ "a.txt": "a", "src/b.ts": "b", "src/b copy.ts": "old" });
  c.select("a.txt", { shift: false, toggle: false });
  c.setClipboard("copy");
  await c.paste("");
  assert.equal(fs.files.get("a copy.txt"), "a");
  c.select("src/b.ts", { shift: false, toggle: false });
  c.setClipboard("copy");
  await c.paste("src");
  assert.equal(fs.files.get("src/b copy 2.ts"), "b");
  assert.equal(fs.files.get("src/b copy.ts"), "old", "an existing copy is never overwritten");
  assert.ok(c.getClipboard(), "a copy stays on the clipboard for another paste");
});

test("cut pasted into the folder it already lives in is a no-op and is consumed", async () => {
  const { c, fs } = await setup({ "src/a.txt": "a" });
  c.select("src/a.txt", { shift: false, toggle: false });
  c.setClipboard("cut");
  await c.paste("src");
  assert.equal(fs.calls.some((x) => x[0] === "rename"), false);
  assert.equal(fs.files.get("src/a.txt"), "a");
  assert.equal(c.getClipboard(), null);
});

test("a cut blocked by a collision stays armed; a source that vanished is reported and not kept armed", async () => {
  const { c, fs } = await setup({ "a.txt": "a", "b.txt": "b", "d/a.txt": "other" });
  c.select("a.txt", { shift: false, toggle: false });
  c.select("b.txt", { shift: false, toggle: true });
  c.setClipboard("cut");
  fs.files.delete("b.txt");
  await c.paste("d");
  assert.equal(fs.files.get("d/a.txt"), "other", "the collision is never overwritten");
  assert.ok(fs.files.has("a.txt"));
  assert.ok(c.getClipboard(), "a real collision keeps the cut armed for a retry");
  assert.equal(c.getSnapshot().notice.severity, "warning");
  assert.match(c.getSnapshot().notice.message, /no longer exist/);
});

test("copyInto (alt-drag) copies files and folders beside the originals under free names", async () => {
  const { c, fs } = await setup({ "a.txt": "a", "d/x.txt": "x" });
  await c.copyInto(["a.txt", "d"], "");
  assert.equal(fs.files.get("a copy.txt"), "a");
  assert.ok(fs.calls.some((x) => x[0] === "copy" && x[2] === "d copy"));
  assert.ok(fs.files.has("a.txt") && fs.files.has("d/x.txt"), "the originals stay put");
});

test("paste copy into another folder keeps the plain name when it is free (Mac uniqueDestination)", async () => {
  const { c, fs } = await setup({ "a.txt": "a", "d/keep.txt": "k" });
  c.select("a.txt", { shift: false, toggle: false });
  c.setClipboard("copy");
  await c.paste("d");
  assert.equal(fs.files.get("d/a.txt"), "a");
  assert.equal(fs.files.has("d/a copy.txt"), false);
});

test("copyInto (alt-drag) never copies a folder into itself or its own descendant", async () => {
  const { c, fs } = await setup({ "d/sub/x.txt": "x" });
  await c.copyInto(["d"], "d");
  await c.copyInto(["d"], "d/sub");
  assert.equal(fs.calls.some((x) => x[0] === "copy"), false, "refused before the host");
  assert.equal(c.getSnapshot().notice.severity, "warning");
  assert.deepEqual([...fs.files.keys()].sort(), ["d/sub/x.txt"]);
});

test("a superseded init whose folder check resolves late does not overwrite the newer project", async () => {
  const { fs, c } = await setup({ "code/a.txt": "a", "b.txt": "b" });
  let release;
  const gate = new Promise((r) => { release = r; });
  const list = fs.list;
  fs.list = async (path, o) => { if (path === "code") await gate; return list(path, o); };
  const first = c.init("/one", "code");
  await c.init("/two");
  release();
  await first;
  await settle();
  assert.equal(c.getSnapshot().root, "/two");
  assert.deepEqual(rows(c), ["code", "b.txt"]);
});

test("a pending session save is written before a project switch", async () => {
  const { c, kv } = await setup({ "src/main.rs": "m", "a.txt": "a" });
  await c.toggleDir("src", true);
  await c.init("/two");
  assert.match([...kv.m.values()].join(" "), /src/);
});
