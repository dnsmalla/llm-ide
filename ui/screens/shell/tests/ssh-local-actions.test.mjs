// SSH server mode: the status bar's project switcher and the no-project card offer no local project actions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { projectSwitcherItems } = await load("StatusBar.tsx");
const { noProjectActionsFor, defaultNoProjectActions } = await load("NoProjectCard.tsx");
const { setHostBridge, setSshModeProvider, setRemoteModeProvider, host, inSshMode } = await load("host.ts");

const project = { name: "proj", root: "/Users/me/proj" };
const recent = [{ name: "other", root: "/Users/me/other" }];
const actions = () => ({ openRecent() {}, openFolder() {}, closeProject() {}, reveal() {} });
const ids = (items) => items.map((m) => m.id);

test("switcher, local mode: New, Open Folder, Reveal, recents and Close, as before", () => {
  assert.deepEqual(ids(projectSwitcherItems(project, recent, actions())), ["recent-0", "new", "open", "reveal", "close"]);
  assert.deepEqual(ids(projectSwitcherItems(null, [], actions())), ["new", "open", "close"]);
});

test("switcher, ssh mode without a server folder picker: Copy server path and Close, and no local recents", () => {
  const items = projectSwitcherItems(project, recent, actions(), { ssh: true });
  assert.deepEqual(ids(items), ["copy-path", "close"]);
  assert.equal(items[0].label, "Copy server path", "Reveal in Finder becomes Copy server path for the server root");
  assert.deepEqual(ids(projectSwitcherItems(project, recent, actions(), { ssh: true, openServerFolder: null })), ["copy-path", "close"]);
  assert.deepEqual(ids(projectSwitcherItems(null, [], actions(), { ssh: true })), ["close"], "no project, nothing to copy");
});

test("switcher, ssh mode with a picker: Open server folder… calls the picker; no New, Reveal or recents", () => {
  let opened = 0;
  const items = projectSwitcherItems(project, recent, actions(), { ssh: true, openServerFolder: () => { opened += 1; } });
  assert.deepEqual(ids(items), ["open", "copy-path", "close"]);
  assert.equal(items[0].label, "Open server folder…");
  items[0].onSelect();
  assert.equal(opened, 1);
});

test("no-project card: local mode keeps New project and the native folder dialog", () => {
  const local = noProjectActionsFor(false, null);
  assert.equal(local.newProject, defaultNoProjectActions.newProject);
  assert.equal(local.openProject, defaultNoProjectActions.openProject);
  assert.equal(local.openLabel, undefined);
});

test("no-project card: ssh mode offers only the server folder picker, and nothing without one", () => {
  assert.deepEqual(noProjectActionsFor(true, null), {});
  let opened = 0;
  const picker = noProjectActionsFor(true, () => { opened += 1; });
  assert.equal(picker.newProject, undefined);
  assert.equal(picker.openLabel, "Open server folder…");
  picker.openProject();
  assert.equal(opened, 1);
});

test("project recents: empty in ssh mode without calling the host (the local list is refused there)", async () => {
  const calls = [];
  setHostBridge({ async invoke(cmd) { calls.push(cmd); return { entries: [{ name: "x", root: "/x", status: "ok", reason: null, open_index: 0, stored_index: 0 }], reset: false }; } });
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    assert.equal(inSshMode(), true);
    assert.deepEqual(await host.projectRecent(), []);
    assert.deepEqual(await host.projectRecentAll(), { entries: [], reset: false });
    assert.deepEqual(calls, [], "no recent-list command was sent");
  } finally {
    setRemoteModeProvider(() => false);
    setSshModeProvider(() => false);
    setHostBridge(null);
  }
});

test("project recents: local mode still reads the host list", async () => {
  const calls = [];
  setHostBridge({ async invoke(cmd) { calls.push(cmd); return cmd === "project_recent" ? [{ name: "x", root: "/x" }] : { entries: [], reset: false }; } });
  try {
    assert.equal(inSshMode(), false);
    assert.deepEqual(await host.projectRecent(), [{ name: "x", root: "/x" }]);
    assert.deepEqual(calls, ["project_recent"]);
  } finally {
    setHostBridge(null);
  }
});
