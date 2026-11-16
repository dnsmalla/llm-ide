// Opening a server folder asks the same unsaved-work question as a local open. Staying changes nothing on the host.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

let store;
let model;
let hostCalls;
before(async () => {
  store = await load("project-store.ts");
  model = await load("../remote-folder/model.ts");
});

/** A project host whose active project is `root`; every other call is recorded. */
function makeHost(root) {
  return {
    async projectActive() { return root ? { name: "p", root } : null; },
    async projectRecent() { return []; },
    async projectOpen() { return null; },
    async projectOpenRecent() { throw new Error("not used"); },
    async projectRecentAll() { return { entries: [], reset: false }; },
  };
}

/** A workspace io that records the host open; the open answers `path` as the new root. */
function workspaceIo() {
  hostCalls = [];
  return {
    async listDirs() { throw new Error("not used"); },
    async mkdir() { throw new Error("not used"); },
    async open(path) { hostCalls.push(path); return { name: "next", root: path }; },
    async close() {},
    async recent() { return []; },
    async forget() {},
  };
}

const noDeps = (over = {}) => ({ register: async () => {}, refresh: async () => {}, announce() {}, ...over });

test("a server folder open with unsaved work waits for the answer; Stay opens nothing", async () => {
  const ps = store.createProjectStore(makeHost("/home/dev/old"), () => ["notes.md (unsaved)"]);
  await ps.refresh();
  const io = workspaceIo();
  const deps = noDeps({ guard: (cancelled, action) => ps.guardLeave(cancelled, action) });
  const pending = model.openServerFolder(io, "/home/dev/new", deps);
  assert.deepEqual(ps.getSnapshot().leave, { labels: ["notes.md (unsaved)"] }, "the question is asked first");
  assert.deepEqual(hostCalls, [], "the host is not called while the question is open");
  ps.cancelLeave();
  assert.equal(await pending, null, "Stay resolves with no project");
  assert.deepEqual(hostCalls, [], "Stay never calls the host open");
});

test("Discard and leave: the host opens the folder, then the core registers it and the store refreshes", async () => {
  const ps = store.createProjectStore(makeHost("/home/dev/old"), () => ["notes.md (unsaved)"]);
  await ps.refresh();
  const io = workspaceIo();
  const order = [];
  const deps = {
    guard: (cancelled, action) => ps.guardLeave(cancelled, action),
    register: async (root) => { order.push(`register ${root}`); },
    refresh: async () => { order.push("refresh"); },
    announce() {},
  };
  const pending = model.openServerFolder(io, "/home/dev/new", deps);
  ps.confirmLeave();
  const project = await pending;
  assert.equal(project?.root, "/home/dev/new");
  assert.deepEqual(hostCalls, ["/home/dev/new"]);
  assert.deepEqual(order, ["register /home/dev/new", "refresh"]);
});

test("nothing unsaved: the open runs at once, with no question", async () => {
  const ps = store.createProjectStore(makeHost(null), () => []);
  await ps.refresh();
  const io = workspaceIo();
  const project = await model.openServerFolder(io, "/home/dev/new", noDeps({ guard: (cancelled, action) => ps.guardLeave(cancelled, action) }));
  assert.equal(project?.root, "/home/dev/new");
  assert.equal(ps.getSnapshot().leave, null);
});

test("without a guard (no shell) the open runs as before", async () => {
  const io = workspaceIo();
  const project = await model.openServerFolder(io, "/home/dev/x", noDeps());
  assert.equal(project?.root, "/home/dev/x");
});
