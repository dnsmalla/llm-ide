import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";
import { makeFs, makeEditor, settle } from "./fakes.mjs";

const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);

const { ExplorerController } = await load("controller.ts");
const { FileTree } = await load("FileTree.tsx");
const { ExplorerTabBar } = await load("TabBar.tsx");
const { ContextMenu } = await load("ContextMenu.tsx");
const { PromptDialog, ConfirmDialog, UnsavedDialog } = await load("Dialogs.tsx");
const { EditorPane } = await load("EditorPane.tsx");
const { ExplorerScreen } = await load("ExplorerScreen.tsx");
const { tabLabels, formatSize } = await load("labels.ts");

async function ctl(files, pageSize = 50) {
  const fs = makeFs(files);
  const editor = makeEditor();
  const c = new ExplorerController({ fs, editor: () => editor, kv: null, pageSize, settleMs: 0 });
  editor.mount(null, { onDirty: (p, d) => c.onEditorDirty(p, d), onSave: () => undefined, onEvict: () => undefined });
  await c.init("/proj");
  await settle();
  return { c, fs, editor };
}
const noop = () => undefined;

test("tree: ARIA tree semantics, levels, expanded state, labelled rows, no raw HTML from names", async () => {
  const { c } = await ctl({ "src/main.rs": "x", "src/<img src=x onerror=alert(1)>.ts": "x", "a.txt": "x" });
  await c.toggleDir("src", true);
  c.select("src", { shift: false, toggle: false });
  const out = html(h(FileTree, { controller: c, snap: c.getSnapshot(), active: true, onContextMenu: noop, onDropMove: noop }));
  assert.match(out, /role="tree"[^>]*aria-label="Project files"[^>]*aria-multiselectable="true"/);
  assert.match(out, /tabindex="0"/);
  assert.match(out, /role="treeitem"[^>]*aria-level="1"[^>]*aria-selected="true"[^>]*aria-expanded="true"[^>]*aria-label="src"/);
  assert.match(out, /aria-level="2"[^>]*aria-selected="false"[^>]*aria-label="main\.rs"/);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;\.ts/);
  assert.equal((out.match(/role="treeitem"/g) ?? []).length, 4);
});

test("tree: only the window is rendered for a huge folder", async () => {
  const files = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`f${String(i).padStart(5, "0")}.txt`, "x"]));
  const { c } = await ctl(files);
  c.requestPages(c.rowsFor(0, 3000));
  await settle();
  const snap = c.getSnapshot();
  assert.equal(snap.layout.count, 3000);
  const out = html(h(FileTree, { controller: c, snap, active: true, onContextMenu: noop, onDropMove: noop }));
  const rendered = (out.match(/role="treeitem"/g) ?? []).length;
  assert.ok(rendered > 0 && rendered < 80, `rendered ${rendered}`);
  assert.match(out, /data-pad="bottom"/);
});

test("tree: gap rows are not treeitems and are marked busy; loading/empty/error status rows are plain text", async () => {
  const files = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`f${String(i).padStart(3, "0")}.txt`, "x"]));
  const { c } = await ctl(files, 10);
  const out = html(h(FileTree, { controller: c, snap: c.getSnapshot(), active: false, onContextMenu: noop, onDropMove: noop }));
  assert.ok(out.includes('aria-busy="true"'), 'gap rows are marked busy');
  const empty = await ctl({ "d/x": "1" });
  await empty.fs.remove("d/x");
  await empty.c.toggleDir("d", true);
  await empty.c.refreshDir("d");
  assert.match(html(h(FileTree, { controller: empty.c, snap: empty.c.getSnapshot(), active: false, onContextMenu: noop, onDropMove: noop })), /Empty folder/);
});

test("tabs: tablist, selected state, dirty marker, preview and pinned flags, labelled close buttons", async () => {
  const { c, editor } = await ctl({ "a/index.ts": "1", "b/index.ts": "2", "c.md": "3" });
  await c.openFile("a/index.ts", false);
  await c.openFile("b/index.ts", false);
  await c.openFile("c.md", true);
  editor.type("a/index.ts", "dirty");
  c.pinTab("b/index.ts", true);
  const out = html(h(ExplorerTabBar, { tabs: c.getSnapshot().tabs, onSelect: noop, onClose: noop, onPromote: noop, onMove: noop, onContextMenu: noop }));
  assert.match(out, /role="tablist"[^>]*aria-label="Open files"/);
  assert.equal((out.match(/role="tab"/g) ?? []).length, 3);
  assert.match(out, /aria-selected="true"/);
  assert.match(out, /data-preview="true"/);
  assert.match(out, /data-pinned="true"/);
  assert.match(out, /aria-label="Unsaved changes"/);
  assert.match(out, /aria-label="Close c\.md"/);
  // Identical names are told apart by their folder.
  assert.match(out, /class="ex-tab-hint">a</);
  assert.match(out, /class="ex-tab-hint">b</);
});

test("tab labels and sizes", () => {
  const l = tabLabels(["a/x/index.ts", "b/x/index.ts", "c/y/index.ts", "main.rs", "d/main.rs"]);
  assert.equal(l.get("a/x/index.ts").hint, "a/x");
  assert.equal(l.get("c/y/index.ts").hint, "y");
  assert.deepEqual(l.get("main.rs"), { label: "main.rs", hint: null });
  assert.equal(l.get("d/main.rs").hint, "d");
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatSize(-1), "");
});

test("context menu: menu semantics, disabled and danger items, active descendant", () => {
  const out = html(h(ContextMenu, { x: 10, y: 10, label: "File actions", onPick: noop, onClose: noop, items: [{ id: "open", label: "Open" }, { id: "delete", label: "Move to Trash", danger: true, separator: true }, { id: "rename", label: "Rename…", disabled: true }] }));
  assert.match(out, /role="menu"[^>]*aria-label="File actions"/);
  assert.match(out, /aria-activedescendant="ex-menu-open"/);
  assert.match(out, /role="separator"/);
  assert.match(out, /data-danger="true"/);
  assert.match(out, /aria-disabled="true"/);
  assert.equal((out.match(/role="menuitem"/g) ?? []).length, 3);
});

test("dialogs: modal semantics and labelled controls; names are escaped", () => {
  const p = html(h(PromptDialog, { title: "Rename", label: "New name", initial: "a.txt", confirmLabel: "Rename", onSubmit: noop, onCancel: noop }));
  assert.match(p, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="ex-prompt-title"/);
  assert.match(p, /<h2 id="ex-prompt-title"/);
  assert.match(p, /<label class="ex-field"><span class="ex-field-label">New name<\/span><input/);
  const c = html(h(ConfirmDialog, { title: "Move to Trash", message: "Sure?", items: ["<b>x</b>", "b", "c", "d", "e", "f", "g", "h"], confirmLabel: "Move to Trash", danger: true, onConfirm: noop, onCancel: noop }));
  assert.match(c, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(c, /<b>/);
  assert.match(c, /and 2 more/);
  assert.match(c, /ex-btn-danger/);
  const u = html(h(UnsavedDialog, { name: "a.ts", onSave: noop, onDiscard: noop, onCancel: noop }));
  assert.match(u, /Save the changes to &quot;a\.ts&quot; before closing\?/);
  for (const b of ["Cancel", "Don&#x27;t Save", "Save"]) assert.match(u, new RegExp(`>${b}<`));
});

async function paneFor(files, open, mutate) {
  const { c, fs, editor } = await ctl(files);
  for (const o of open) await c.openFile(o, false);
  if (mutate) await mutate(c, fs, editor);
  const ref = { current: null };
  const out = html(h(EditorPane, { controller: c, snap: c.getSnapshot(), loadEditor: () => Promise.reject(new Error("no editor in tests")), editorRef: ref, onCloseTab: noop }));
  return { out, c };
}

test("editor pane: empty, binary, too-large and error placeholders", async () => {
  assert.match((await paneFor({ "a.txt": "x" }, [])).out, /No file open/);
  assert.match((await paneFor({ "i.bin": "BIN:xx" }, ["i.bin"])).out, /Binary file/);
  const big = await paneFor({ "big.log": "x".repeat(6000) }, ["big.log"]);
  assert.match(big.out, /File too large to open/);
  assert.match(big.out, /Open first 1 MB read-only/);
  const gone = await paneFor({ "a.txt": "x" }, ["a.txt"], async (c, fs) => { fs.files.delete("a.txt"); await c.activateTab("a.txt"); });
  assert.doesNotMatch(gone.out, /Cannot open/); // a live model keeps the tab usable
});

test("editor pane: conflict banner offers reload / keep mine; deleted offers recreate; toolbar buttons are labelled", async () => {
  const changed = await paneFor({ "a.txt": "one" }, ["a.txt"], async (c, fs, ed) => {
    ed.type("a.txt", "mine");
    fs.files.set("a.txt", "theirs");
    await c.save("a.txt");
  });
  assert.match(changed.out, /role="status"[^>]*>[\s\S]*changed on disk/);
  assert.match(changed.out, />Reload from disk</);
  assert.match(changed.out, />Keep mine</);
  assert.match(changed.out, /role="toolbar"[^>]*aria-label="File actions"/);
  assert.match(changed.out, /aria-label="Find in file"/);
  const deleted = await paneFor({ "a.txt": "one" }, ["a.txt"], async (c, fs) => {
    fs.files.delete("a.txt");
    c.onBatch({ dirs: [""], files: ["a.txt"], overflow: false });
    await settle();
  });
  assert.match(deleted.out, /deleted on disk/);
  assert.match(deleted.out, />Save to recreate</);
});

test("editor pane: read-only notice for files that are not UTF-8", async () => {
  const fs = makeFs({ "l.txt": "x" });
  const orig = fs.read;
  fs.read = async (p) => ({ ...(await orig(p)), encoding: "unknown", read_only: true });
  const editor = makeEditor();
  const c = new ExplorerController({ fs, editor: () => editor, kv: null, pageSize: 50, settleMs: 0 });
  await c.init("/p");
  await c.openFile("l.txt", false);
  const out = html(h(EditorPane, { controller: c, snap: c.getSnapshot(), loadEditor: () => Promise.reject(new Error("x")), editorRef: { current: null }, onCloseTab: noop }));
  assert.match(out, /not valid UTF-8/);
  assert.match(out, /disabled/); // Save is disabled
});

test("screen: no project shows a message; with a project it has landmarks, labelled actions and an accessible divider", () => {
  const none = html(h(ExplorerScreen, { active: true, projectRoot: null }));
  assert.match(none, /No project open/);
  const fs = makeFs({});
  const out = html(h(ExplorerScreen, { active: true, projectRoot: "/Users/me/proj", deps: { fs, kv: null, loadEditor: () => Promise.reject(new Error("x")) } }));
  assert.match(out, /<aside[^>]*aria-label="Explorer"/);
  assert.match(out, /class="ex-project"[^>]*title="\/Users\/me\/proj">proj</);
  for (const label of ["New file", "New folder", "Refresh", "Show hidden files", "Hide ignored files"]) assert.match(out, new RegExp(`aria-label="${label}"`));
  assert.match(out, /aria-pressed="false"/);
  assert.match(out, /role="separator"/);
  assert.match(out, /role="tree"/);
  assert.match(out, /role="tablist"/);
  assert.match(out, /<section[^>]*aria-label="Editor"/);
});

test("security: no raw HTML sinks, remote resources or eval in the screen sources", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = readdirSync(dir).filter((f) => /\.(tsx?|css)$/.test(f));
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
    assert.doesNotMatch(src, /<img\b|<iframe\b|<script\b|url\(\s*["']?https?:|@import/, f);
    assert.doesNotMatch(src, /@tauri-apps/, `${f}: screens go through the shell bridge`);
  }
});
