// SSH server mode: the Explorer browses a folder on the server, so the actions that only work on this computer
// (Reveal in Finder, Open in Preview, local project folders, the native folder dialogs) are not offered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";
import { makeFs, makeEditor, settle } from "./fakes.mjs";

const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const noop = () => undefined;

const { ExplorerController } = await load("controller.ts");
const { EditorPane } = await load("EditorPane.tsx");
const { ExplorerScreen } = await load("ExplorerScreen.tsx");
const { treeMenuItems } = await load("menus.ts");
const { changeMenu } = await load("scm/ChangesView.tsx");

async function ctl(files) {
  const fs = makeFs(files);
  const editor = makeEditor();
  const c = new ExplorerController({ fs, editor: () => editor, kv: null, pageSize: 50, settleMs: 0 });
  editor.mount(null, { onDirty: (p, d) => c.onEditorDirty(p, d), onSave: () => undefined, onEvict: () => undefined });
  await c.init("/proj");
  await settle();
  return { c, fs };
}

const ids = (items) => items.map((m) => m.id);

test("tree menu: Reveal in Finder is offered on this computer and hidden for a server folder", async () => {
  const { c } = await ctl({ "a.txt": "x" });
  c.select("a.txt", { shift: false, toggle: false });
  const snap = c.getSnapshot();
  const local = { projectRoot: "/proj", clipboardSet: false, serverFiles: false };
  assert.ok(ids(treeMenuItems(snap, "a.txt", local)).includes("reveal"));
  assert.equal(ids(treeMenuItems(snap, "a.txt", { ...local, serverFiles: true })).includes("reveal"), false);
  // The other items keep their place: only the local-only one goes.
  assert.deepEqual(
    ids(treeMenuItems(snap, "a.txt", { ...local, serverFiles: true })),
    ids(treeMenuItems(snap, "a.txt", local)).filter((id) => id !== "reveal"),
  );
});

test("Changes menu: Reveal in Finder is hidden for a server folder and kept locally", () => {
  const item = { group: "changes", entry: { path: "src/a.ts", index: ".", worktree: "M", kind: "changed", orig_path: null, submodule: false } };
  assert.ok(changeMenu(item).some((m) => m.id === "reveal"));
  assert.equal(changeMenu(item, true).some((m) => m.id === "reveal"), false);
  assert.ok(changeMenu(item, true).some((m) => m.id === "copy"), "copy path still works for a server folder");
});

test("PDF in the editor: Open in Preview is hidden for a server folder", async () => {
  const { c } = await ctl({});
  const snap = {
    ...c.getSnapshot(),
    tabs: { tabs: [{ id: "doc.pdf", preview: false, pinned: false, dirty: false }], activeId: "doc.pdf" },
    docs: new Map([["doc.pdf", { status: "binary" }]]),
  };
  const base = { controller: c, snap, loadEditor: () => Promise.reject(new Error("x")), editorRef: { current: null }, onCloseTab: noop };
  assert.match(html(h(EditorPane, base)), /Open in Preview/);
  assert.doesNotMatch(html(h(EditorPane, { ...base, serverFiles: true })), /Open in Preview/);
});

test("no project, ssh mode: the card offers the server folder picker and no local dialogs", () => {
  const out = html(h(ExplorerScreen, { active: true, projectRoot: null, mode: "ssh", onOpenServerFolder: noop }));
  assert.match(out, /Open a server folder to browse files/);
  assert.match(out, /Open server folder…/);
  assert.doesNotMatch(out, /New project…/);
  assert.doesNotMatch(out, /Open existing project…/);
});

test("no project, ssh mode without a picker: no action is offered at all", () => {
  const out = html(h(ExplorerScreen, { active: true, projectRoot: null, mode: "ssh" }));
  assert.match(out, /Open a server folder to browse files/);
  assert.doesNotMatch(out, /<button/);
});

test("no project, local mode: the local card keeps its two actions", () => {
  const out = html(h(ExplorerScreen, { active: true, projectRoot: null, mode: "local" }));
  assert.match(out, /Open or create a project to browse files/);
  assert.match(out, /New project…/);
  assert.match(out, /Open existing project…/);
  assert.doesNotMatch(out, /Open server folder…/);
});

// The "Project folders" button also needs the desktop host bridge, which the test bundle cannot share with the screen,
// so only the absence is asserted here; the local presence is covered by the desktop build.
test("project folders button: hidden for a server folder (it lists this computer's project folders)", () => {
  const deps = { fs: makeFs({}), kv: null, loadEditor: () => Promise.reject(new Error("x")) };
  const ssh = html(h(ExplorerScreen, { active: true, projectRoot: "/home/me/proj", mode: "ssh", deps }));
  assert.doesNotMatch(ssh, /aria-label="Project folders"/);
  assert.match(ssh, /aria-label="New file"/, "the rest of the toolbar is unchanged");
});

// Move to Trash on a server folder names the server's Trash: the menu, the confirmation and the path it goes to.
test("Move to Trash names the server's Trash for a server folder, and this computer's Trash otherwise", async () => {
  const menus = await load("menus.ts");
  assert.equal(menus.deleteLabel(1, true), "Move to Server Trash");
  assert.equal(menus.deleteLabel(3, true), "Move 3 Items to Server Trash");
  assert.equal(menus.deleteLabel(1, false), "Move to Trash");
  assert.equal(menus.deleteLabel(2, false), "Move 2 Items to Trash");
  assert.equal(menus.deleteQuestion(1, true), "Move this item to the Trash on the server (~/.local/share/Trash)?");
  assert.equal(menus.deleteQuestion(2, true), "Move these 2 items to the Trash on the server (~/.local/share/Trash)?");
  assert.equal(menus.deleteQuestion(1, false), "Move this item to the system trash?");
  assert.equal(menus.deleteQuestion(2, false), "Move these 2 items to the system trash?");
});
