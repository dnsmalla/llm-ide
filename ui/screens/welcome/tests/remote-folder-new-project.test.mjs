// SSH server folder picker: New project in the server folder picker. Node-only; the io is a fake host.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

let m;
before(async () => {
  m = await load("../remote-folder/model.ts");
});

const HOME = "/home/dev";
const EXISTS = "A project with that name already exists.";

/** A fake host with the listing of the home folder and the create command. */
function fakeIo(over = {}) {
  const calls = [];
  return {
    calls,
    async listDirs(path) {
      calls.push(`list:${path}`);
      // "~" is the home folder; any other path is listed as it was asked.
      return { path: path === "~" ? HOME : path, entries: [{ name: "projects", isLink: false, outsideHome: false }] };
    },
    async mkdir() {
      calls.push("mkdir");
      return { path: HOME };
    },
    async createProject(parent, name) {
      calls.push(`create:${parent}:${name}`);
      if (over.createFail) throw over.createFail;
      return { name, root: `${parent}/${name}` };
    },
    async open(path) {
      calls.push(`open:${path}`);
      return { name: path.split("/").pop(), root: path };
    },
    async close() {
      calls.push("close");
    },
    async recent() {
      return [];
    },
    async forget() {},
  };
}

/** Deps that record the order of the steps. `registerWarnings` is the warnings each registration returns, in turn. */
function deps(log, over = {}) {
  const warningRuns = [...(over.registerWarnings ?? [])];
  return {
    async register(root) {
      log.push(`register:${root}`);
    },
    async registerNew(project) {
      log.push(`registerNew:${project.root}`);
      if (over.registerNewFail) throw over.registerNewFail;
      return warningRuns.length > 0 ? warningRuns.shift() : [];
    },
    async refresh() {
      log.push("refresh");
    },
    announce(text) {
      log.push(`announce:${text}`);
    },
    ...(over.guard ? { guard: over.guard } : {}),
  };
}

async function pickerAt(io, d, path = `${HOME}/projects`) {
  const picker = new m.FolderPickerModel(io, d);
  await picker.start();
  if (path !== HOME) await picker.goTo(path);
  picker.startNewProject();
  return picker;
}

test("new_project_creates_registers_and_opens", async () => {
  const log = [];
  const io = fakeIo();
  const picker = await pickerAt(io, deps(log));
  picker.setNewProjectName("llm");
  const project = await picker.createProject();
  assert.deepEqual(project, { name: "llm", root: `${HOME}/projects/llm` });
  assert.deepEqual(io.calls.filter((c) => c.startsWith("create")), [`create:${HOME}/projects:llm`]);
  assert.deepEqual(log, [`registerNew:${HOME}/projects/llm`, "refresh"]);
  const s = picker.getState();
  assert.equal(s.creatingProject, false, "the name field closes");
  assert.equal(s.pending, null);
  assert.equal(s.busy, false);
});

test("new project is allowed in the server home: the new folder is created inside the listed folder", async () => {
  const io = fakeIo();
  const picker = await pickerAt(io, deps([]), HOME);
  picker.setNewProjectName("notes");
  const project = await picker.createProject();
  assert.equal(project?.root, `${HOME}/notes`);
  assert.ok(io.calls.includes(`create:${HOME}:notes`));
});

test("new_project_existing_name_shows_error_and_stays", async () => {
  const log = [];
  const io = fakeIo({ createFail: { code: "already_exists", message: EXISTS } });
  const picker = await pickerAt(io, deps(log));
  picker.setNewProjectName("llm");
  assert.equal(await picker.createProject(), null);
  const s = picker.getState();
  assert.equal(s.newProjectError, EXISTS, "the host's message is shown as it is");
  assert.equal(s.creatingProject, true, "the name field stays open for another name");
  assert.equal(s.newProjectName, "llm");
  assert.equal(s.busy, false);
  assert.deepEqual(log, [], "nothing is registered or refreshed");
});

test("a name that is not a single folder name is refused before the host is asked", async () => {
  const io = fakeIo();
  const picker = await pickerAt(io, deps([]));
  picker.setNewProjectName("a/b");
  assert.equal(await picker.createProject(), null);
  assert.equal(picker.getState().newProjectError, "A folder name cannot contain /.");
  assert.deepEqual(io.calls.filter((c) => c.startsWith("create")), []);
});

test("new_project_warnings_offer_try_again", async () => {
  const log = [];
  const warning = "It could not be registered with the core yet (core refused).";
  const picker = await pickerAt(fakeIo(), deps(log, { registerWarnings: [[warning]] }));
  picker.setNewProjectName("llm");
  assert.equal(await picker.createProject(), null, "the picker stays open while the warning is shown");
  const pending = picker.getState().pending;
  assert.deepEqual(pending.warnings, [warning]);
  assert.equal(pending.project.root, `${HOME}/projects/llm`);
  assert.deepEqual(log, [`registerNew:${HOME}/projects/llm`, "refresh"], "the project is opened and refreshed");
});

test("try_again_reruns_only_registration", async () => {
  const log = [];
  const io = fakeIo();
  const picker = await pickerAt(io, deps(log, { registerWarnings: [["first try failed"], []] }));
  picker.setNewProjectName("llm");
  await picker.createProject();
  log.length = 0;
  const callsBefore = io.calls.length;
  const project = await picker.retryRegistration();
  assert.deepEqual(project, { name: "llm", root: `${HOME}/projects/llm` }, "clean now: the project comes back");
  assert.deepEqual(log, [`registerNew:${HOME}/projects/llm`], "only the registration runs again");
  assert.equal(io.calls.length, callsBefore, "the host is not asked to create or open again");
  assert.equal(picker.getState().pending, null);
});

test("a registration that still warns keeps the pending project with the new warnings", async () => {
  const picker = await pickerAt(fakeIo(), deps([], { registerWarnings: [["one"], ["two"]] }));
  picker.setNewProjectName("llm");
  await picker.createProject();
  assert.equal(await picker.retryRegistration(), null);
  assert.deepEqual(picker.getState().pending.warnings, ["two"]);
});

test("while a pending project waits, the other actions do not run", async () => {
  const io = fakeIo();
  const picker = await pickerAt(io, deps([], { registerWarnings: [["warn"]] }));
  picker.setNewProjectName("llm");
  await picker.createProject();
  assert.equal(await picker.openCurrent(), null);
  picker.startNewProject();
  picker.setNewProjectName("other");
  assert.equal(await picker.createProject(), null);
  assert.deepEqual(io.calls.filter((c) => c.startsWith("create") || c.startsWith("open")), [`create:${HOME}/projects:llm`]);
});

test("continue keeps the open project and clears the warnings", async () => {
  const picker = await pickerAt(fakeIo(), deps([], { registerWarnings: [["warn"]] }));
  picker.setNewProjectName("llm");
  await picker.createProject();
  const project = picker.keepPendingProject();
  assert.deepEqual(project, { name: "llm", root: `${HOME}/projects/llm` });
  assert.equal(picker.getState().pending, null);
});

test("new_project_asks_about_unsaved_work", async () => {
  const log = [];
  const asked = [];
  // The user stays: the guard answers with the cancelled value and the action never runs.
  const stay = deps(log, { guard: async (cancelled) => { asked.push("asked"); return cancelled; } });
  const io = fakeIo();
  const picker = await pickerAt(io, stay);
  picker.setNewProjectName("llm");
  assert.equal(await picker.createProject(), null);
  assert.deepEqual(asked, ["asked"]);
  assert.deepEqual(io.calls.filter((c) => c.startsWith("create")), [], "staying creates nothing");
  assert.deepEqual(log, []);

  // The user leaves: the action runs, and the create, registration and refresh happen in that order.
  const leaveLog = [];
  const picker2 = await pickerAt(fakeIo(), deps(leaveLog, { guard: async (_cancelled, action) => action() }));
  picker2.setNewProjectName("llm");
  assert.ok(await picker2.createProject());
  assert.deepEqual(leaveLog, [`registerNew:${HOME}/projects/llm`, "refresh"]);
});

test("a create refused by the host leaves the picker usable and shows the host's sentence", async () => {
  const io = fakeIo({ createFail: { code: "outside_home", message: "outside" } });
  const picker = await pickerAt(io, deps([]));
  picker.setNewProjectName("llm");
  assert.equal(await picker.createProject(), null);
  assert.equal(picker.getState().busy, false);
  assert.equal(picker.getState().newProjectError, "That folder is outside your home folder.");
});

test("createServerProject: a thrown registration becomes one warning; the project is still returned", async () => {
  const out = await m.createServerProject(fakeIo(), HOME, "llm", deps([], { registerNewFail: new Error("boom") }));
  assert.equal(out.project.root, `${HOME}/llm`);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /boom/);
});

test("the host's create command and its answer are the contract's", async () => {
  const sent = [];
  const io = m.createWorkspaceIo(async (cmd, args) => {
    sent.push([cmd, args ?? null]);
    return { name: "llm", root: `${HOME}/llm` };
  });
  assert.deepEqual(await io.createProject(HOME, "llm"), { name: "llm", root: `${HOME}/llm` });
  assert.deepEqual(sent, [["remote_ssh_project_create", { parent: HOME, name: "llm" }]]);
  const bad = m.createWorkspaceIo(async () => ({ name: "llm" }));
  await assert.rejects(bad.createProject(HOME, "llm"));
});

test("the picker shows New project beside New folder; a pending project shows Try again and Continue", async () => {
  const view = await load("../remote-folder/FolderPicker.tsx");
  const h = React.createElement;
  const base = { home: HOME, path: `${HOME}/projects`, entries: [], showHidden: false, selected: null, loading: false, error: null, busy: false, creating: false, newName: "", newNameError: null, creatingProject: false, newProjectName: "", newProjectError: null, pending: null };
  const handlers = Object.fromEntries(["onGo", "onEnter", "onSelect", "onToggleHidden", "onStartNew", "onCancelNew", "onNewName", "onCreate", "onStartNewProject", "onCancelNewProject", "onNewProjectName", "onCreateProject", "onRetryRegistration", "onKeepPending", "onOpenSelected", "onOpenCurrent", "onClose"].map((n) => [n, () => {}]));
  const plain = renderToStaticMarkup(h(view.FolderPickerView, { state: base, ...handlers }));
  assert.match(plain, />New project…</);
  assert.doesNotMatch(plain, /Try again/);

  const pending = { ...base, pending: { project: { name: "llm", root: `${HOME}/projects/llm` }, warnings: ["It could not be registered with the core yet."] } };
  const html = renderToStaticMarkup(h(view.FolderPickerView, { state: pending, ...handlers }));
  assert.match(html, />Try again</);
  assert.match(html, />Continue</);
  assert.match(html, /It could not be registered with the core yet\./);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Open this folder</, "the other actions wait");
});
