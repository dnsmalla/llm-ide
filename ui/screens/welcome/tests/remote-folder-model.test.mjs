// SSH server folder picker and recent folders: the model. Node-only; the io is a fake host.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../shell/tests/helpers.mjs";

let m;
before(async () => {
  m = await load("../remote-folder/model.ts");
});

const HOME = "/home/dev";
const ROOT_MISSING = "This folder is no longer on the server.";
const LOST = "The connection to the server was lost.";

/** A fake host. `listings` maps a path (or "~") to its answer; `fail` maps a command to the error it rejects with. */
function fakeIo(over = {}) {
  const calls = [];
  const listings = {
    "~": { path: HOME, entries: [
      { name: "projects", isLink: false, outsideHome: false },
      { name: "Archive", isLink: false, outsideHome: false },
      { name: "api", isLink: true, outsideHome: true },
      { name: "alpha", isLink: false, outsideHome: false },
    ] },
    [`${HOME}/projects`]: { path: `${HOME}/projects`, entries: [{ name: "llm", isLink: false, outsideHome: false }] },
    [HOME]: { path: HOME, entries: [{ name: "Notes", isLink: false, outsideHome: false }, { name: "projects", isLink: false, outsideHome: false }] },
  };
  const io = {
    calls,
    async listDirs(path, hidden) {
      calls.push(`list:${path}:${hidden}`);
      if (over.listFail) throw over.listFail;
      return listings[path] ?? { path, entries: [] };
    },
    async mkdir(path, name) {
      calls.push(`mkdir:${path}:${name}`);
      if (over.mkdirFail) throw over.mkdirFail;
      return { path: `${path}/${name}` };
    },
    async open(path) {
      calls.push(`open:${path}`);
      if (over.openFail) throw over.openFail;
      return { name: path.split("/").pop(), root: path };
    },
    async close() {
      calls.push("close");
    },
    async recent() {
      calls.push("recent");
      return over.recent ?? [];
    },
    async forget(path) {
      calls.push(`forget:${path}`);
    },
  };
  return io;
}

/** Open-flow dependencies that record the order of the steps. */
function deps(log, over = {}) {
  return {
    async register(root) {
      log.push(`register:${root}`);
      if (over.registerFail) throw over.registerFail;
    },
    async refresh() {
      log.push("refresh");
    },
    announce(text) {
      log.push(`announce:${text}`);
    },
  };
}

const err = (code, message = code) => ({ code, message });

test("decodeListing: strict; one malformed entry makes the answer unreadable", () => {
  assert.deepEqual(m.decodeListing({ path: HOME, entries: [{ name: "a", isLink: false, outsideHome: false }] }), { path: HOME, entries: [{ name: "a", isLink: false, outsideHome: false }] });
  assert.equal(m.decodeListing({ path: HOME, entries: [{ name: 3, isLink: false, outsideHome: false }] }), null);
  assert.equal(m.decodeListing({ path: HOME, entries: [{ name: "a", isLink: "no", outsideHome: false }] }), null);
  assert.equal(m.decodeListing({ entries: [] }), null);
  assert.equal(m.decodeListing(null), null);
});

test("decodeRemoteProject and decodeRecentPaths are strict", () => {
  assert.deepEqual(m.decodeRemoteProject({ name: "llm", root: `${HOME}/llm` }), { name: "llm", root: `${HOME}/llm` });
  assert.equal(m.decodeRemoteProject({ name: "llm" }), null);
  assert.deepEqual(m.decodeRecentPaths([`${HOME}/a`, `${HOME}/b`]), [`${HOME}/a`, `${HOME}/b`]);
  assert.equal(m.decodeRecentPaths([`${HOME}/a`, 4]), null);
  assert.equal(m.decodeRecentPaths("x"), null);
});

test("createWorkspaceIo sends the contract's command names and arguments", async () => {
  const sent = [];
  const invoke = async (cmd, args) => {
    sent.push([cmd, args ?? null]);
    if (cmd === "remote_ssh_workspace_list_dirs") return { path: HOME, entries: [] };
    if (cmd === "remote_ssh_workspace_mkdir") return { path: `${HOME}/N` };
    if (cmd === "remote_ssh_workspace_open") return { name: "llm", root: `${HOME}/llm` };
    if (cmd === "remote_ssh_workspace_recent") return [`${HOME}/llm`];
    return null;
  };
  const io = m.createWorkspaceIo(invoke);
  await io.listDirs("~", true);
  await io.mkdir(HOME, "N");
  await io.open(`${HOME}/llm`);
  await io.recent();
  await io.forget(`${HOME}/llm`);
  await io.close();
  assert.deepEqual(sent, [
    ["remote_ssh_workspace_list_dirs", { path: "~", hidden: true }],
    ["remote_ssh_workspace_mkdir", { path: HOME, name: "N" }],
    ["remote_ssh_workspace_open", { path: `${HOME}/llm` }],
    ["remote_ssh_workspace_recent", null],
    ["remote_ssh_workspace_forget", { path: `${HOME}/llm` }],
    ["remote_ssh_workspace_close", null],
  ]);
});

test("errors: the host codes read as the brief's sentences; an unknown code keeps the host message", () => {
  assert.equal(m.workspaceErrorText(err("root_missing")), ROOT_MISSING);
  assert.equal(m.workspaceErrorText(err("lost_connection")), LOST);
  assert.equal(m.workspaceErrorText(err("outside_home")), "That folder is outside your home folder.");
  assert.equal(m.workspaceErrorText(err("weird", "Something the host said")), "Something the host said");
  assert.equal(m.workspaceErrorCode(err("not_found")), "not_found");
  assert.equal(m.workspaceErrorCode(new Error("plain")), "");
});

test("folder names: empty, slash, NUL, line break, dot and dot-dot are refused", () => {
  for (const bad of ["", "   ", "a/b", "a\0b", "a\nb", "a\rb", ".", ".."]) {
    assert.equal(typeof m.folderNameError(bad), "string", JSON.stringify(bad));
  }
  assert.equal(m.folderNameError("Notes"), null);
  assert.equal(m.folderNameError(".hidden"), null);
});

test("entries sort case-insensitively; joins and breadcrumbs follow the home folder", () => {
  const names = m.sortEntries([{ name: "projects" }, { name: "Archive" }, { name: "alpha" }, { name: "api" }]).map((e) => e.name);
  assert.deepEqual(names, ["alpha", "api", "Archive", "projects"]);
  assert.equal(m.joinPath(HOME, "x"), `${HOME}/x`);
  assert.equal(m.joinPath("/", "x"), "/x");
  assert.deepEqual(m.breadcrumbsFor(`${HOME}/projects/llm`, HOME), [
    { label: "~", path: HOME },
    { label: "projects", path: `${HOME}/projects` },
    { label: "llm", path: `${HOME}/projects/llm` },
  ]);
  assert.deepEqual(m.breadcrumbsFor(HOME, HOME), [{ label: "~", path: HOME }]);
});

test("start lists the home folder, remembers it, and sorts the entries", async () => {
  const io = fakeIo();
  const picker = new m.FolderPickerModel(io, deps([]));
  await picker.start();
  const s = picker.getState();
  assert.equal(s.path, HOME);
  assert.equal(s.home, HOME);
  assert.deepEqual(s.entries.map((e) => e.name), ["alpha", "api", "Archive", "projects"]);
  assert.deepEqual(io.calls, ["list:~:false"]);
});

test("outside-home entries cannot be entered or selected", async () => {
  const io = fakeIo();
  const picker = new m.FolderPickerModel(io, deps([]));
  await picker.start();
  picker.enter("api");
  picker.select("api");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(io.calls, ["list:~:false"], "no listing was asked for");
  assert.equal(picker.getState().selected, null);
});

test("enter lists the child; toggling hidden lists the current folder with hidden entries", async () => {
  const io = fakeIo();
  const picker = new m.FolderPickerModel(io, deps([]));
  await picker.start();
  await picker.enter("projects");
  assert.equal(picker.getState().path, `${HOME}/projects`);
  await picker.toggleHidden();
  assert.equal(picker.getState().showHidden, true);
  assert.equal(io.calls.at(-1), `list:${HOME}/projects:true`);
});

test("New folder: refuses a bad name without calling the host, then creates and selects the new folder", async () => {
  const io = fakeIo();
  const picker = new m.FolderPickerModel(io, deps([]));
  await picker.start();
  picker.startNewFolder();
  picker.setNewName("a/b");
  await picker.createFolder();
  assert.equal(typeof picker.getState().newNameError, "string");
  assert.equal(io.calls.some((c) => c.startsWith("mkdir")), false);
  picker.setNewName("Notes");
  await picker.createFolder();
  assert.ok(io.calls.includes(`mkdir:${HOME}:Notes`));
  assert.equal(picker.getState().creating, false);
  assert.equal(picker.getState().selected, "Notes");
});

test("New folder: a hidden name turns on Show hidden so the new folder can be seen and selected", async () => {
  const io = fakeIo({ listings: undefined });
  const picker = new m.FolderPickerModel(io, deps([]));
  await picker.start();
  picker.startNewFolder();
  picker.setNewName(".cache");
  await picker.createFolder();
  assert.equal(picker.getState().showHidden, true);
});

test("New folder: a host refusal shows inline on the name field", async () => {
  const io = fakeIo({ mkdirFail: err("exists", "A folder with that name already exists.") });
  const picker = new m.FolderPickerModel(io, deps([]));
  await picker.start();
  picker.startNewFolder();
  picker.setNewName("Notes");
  await picker.createFolder();
  assert.equal(picker.getState().newNameError, "A folder with that name already exists.");
  assert.equal(picker.getState().creating, true);
});

test("open flow order: open, then register, then refresh; the project is returned", async () => {
  const log = [];
  const io = fakeIo();
  const picker = new m.FolderPickerModel(io, deps(log));
  await picker.start();
  const project = await picker.openCurrent();
  assert.deepEqual(project, { name: "dev", root: HOME });
  assert.deepEqual(log, [`register:${HOME}`, "refresh"]);
  assert.deepEqual(io.calls.slice(1), [`open:${HOME}`]);
});

test("a registration failure keeps the open and shows the non-blocking notice", async () => {
  const log = [];
  const io = fakeIo();
  const picker = new m.FolderPickerModel(io, deps(log, { registerFail: new Error("core refused") }));
  await picker.start();
  const project = await picker.openCurrent();
  assert.ok(project, "the folder is still open");
  assert.deepEqual(log, [`register:${HOME}`, "announce:Opened, but the server did not register the project: core refused", "refresh"]);
  assert.equal(picker.getState().error, null);
});

test("open refused with root_missing: no registration, the sentence shows inline", async () => {
  const log = [];
  const io = fakeIo({ openFail: err("root_missing", ROOT_MISSING) });
  const picker = new m.FolderPickerModel(io, deps(log));
  await picker.start();
  assert.equal(await picker.openCurrent(), null);
  assert.equal(picker.getState().error, ROOT_MISSING);
  assert.deepEqual(log, []);
});

test("a dropped connection while listing shows the lost-connection sentence", async () => {
  const io = fakeIo({ listFail: err("lost_connection", LOST) });
  const picker = new m.FolderPickerModel(io, deps([]));
  await picker.start();
  assert.equal(picker.getState().error, LOST);
});

test("leaving the open folder: close the server folder, announce the message, refresh; concurrent calls act once", async () => {
  const log = [];
  const io = fakeIo();
  const leave = { io, announce: (t) => log.push(`announce:${t}`), refresh: async () => { log.push("refresh"); } };
  await Promise.all([m.leaveRemoteFolder(leave, ROOT_MISSING), m.leaveRemoteFolder(leave, ROOT_MISSING)]);
  assert.deepEqual(io.calls, ["close"]);
  assert.deepEqual(log, [`announce:${ROOT_MISSING}`, "refresh"]);
});

test("recent folders: rows come from the host; a row that cannot open is marked missing; Remove forgets it", async () => {
  const io = fakeIo({ recent: [`${HOME}/projects/llm`, `${HOME}/gone`] });
  const log = [];
  const recent = new m.ServerRecentModel(io, deps(log));
  await recent.load();
  assert.deepEqual(recent.getState().paths, [`${HOME}/projects/llm`, `${HOME}/gone`]);
  // Opening a folder that the server no longer has.
  io.calls.length = 0;
  const failing = fakeIo({ openFail: err("not_found", "x"), recent: [`${HOME}/gone`] });
  const second = new m.ServerRecentModel(failing, deps([]));
  await second.load();
  assert.equal(await second.open(`${HOME}/gone`), null);
  assert.deepEqual(second.getState().missing, [`${HOME}/gone`]);
  await second.forget(`${HOME}/gone`);
  assert.ok(failing.calls.includes(`forget:${HOME}/gone`));
});

test("recent folders: opening a working row runs open, register, refresh", async () => {
  const log = [];
  const io = fakeIo({ recent: [`${HOME}/projects/llm`] });
  const recent = new m.ServerRecentModel(io, deps(log));
  await recent.load();
  const project = await recent.open(`${HOME}/projects/llm`);
  assert.deepEqual(project, { name: "llm", root: `${HOME}/projects/llm` });
  assert.deepEqual(log, [`register:${HOME}/projects/llm`, "refresh"]);
  assert.deepEqual(recent.getState().missing, []);
});

test("Open opens the selected entry through the open flow; no selection opens nothing", async () => {
  const log = [];
  const io = fakeIo();
  const picker = new m.FolderPickerModel(io, deps(log));
  await picker.start();
  assert.equal(await picker.openSelected(), null, "no selection: nothing opens");
  assert.equal(io.calls.some((c) => c.startsWith("open:")), false);
  picker.select("projects");
  const project = await picker.openSelected();
  assert.deepEqual(project, { name: "projects", root: `${HOME}/projects` });
  assert.ok(io.calls.includes(`open:${HOME}/projects`));
  assert.deepEqual(log, [`register:${HOME}/projects`, "refresh"]);
  assert.equal(io.calls.some((c) => c === `list:${HOME}/projects:false`), false, "Open does not navigate");
});

test("decodeListing refuses '.' and '..' entry names and a relative listing path", () => {
  assert.equal(m.decodeListing({ path: HOME, entries: [{ name: ".", isLink: false, outsideHome: false }] }), null);
  assert.equal(m.decodeListing({ path: HOME, entries: [{ name: "..", isLink: false, outsideHome: false }] }), null);
  assert.equal(m.decodeListing({ path: "home/dev", entries: [] }), null);
  assert.deepEqual(m.decodeListing({ path: "/", entries: [] }), { path: "/", entries: [] });
});
