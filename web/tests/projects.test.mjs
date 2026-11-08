import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createProjectsController, projectRefusal } from "../src/projects/controller.ts";
import { projectStoreFor } from "../src/host-api/storage.ts";
import { createChatController } from "../src/chat/controller.ts";
import { createComposeController } from "../src/chat/compose.ts";
import { loadUi, h, html } from "./helpers.mjs";

let UI;
before(async () => { UI = await loadUi(); });
const noop = () => {};
const tick = () => new Promise((r) => setTimeout(r, 0));

const proj = (id, name, role) => ({ id, name, role, maxMode: "execute", usdCapMonth: 0, permissions: ["self.read"] });
const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};
const store = () => projectStoreFor("ws://127.0.0.1:3016/host-api/v1", memory());

function fakeLink(results = {}, caps = ["host", "chat", "approvals", "compose", "tool_approvals"]) {
  const ls = { event: new Set(), resync: new Set(), state: new Set() };
  const calls = [];
  let n = 0;
  return {
    capabilities: new Set(caps),
    calls,
    send(command, payload) {
      const id = `c-${++n}`;
      calls.push({ id, command, payload });
      const r = results[command];
      const done = r instanceof Error ? Promise.reject(r) : Promise.resolve(typeof r === "function" ? r(payload) : r ?? {});
      done.catch(() => {});
      return { id, done };
    },
    onEvent: (fn) => (ls.event.add(fn), () => ls.event.delete(fn)),
    onResync: (fn) => (ls.resync.add(fn), () => ls.resync.delete(fn)),
    onState: (fn) => (ls.state.add(fn), () => ls.state.delete(fn)),
    emit: (e) => ls.event.forEach((fn) => fn(e)),
    resync: () => ls.resync.forEach((fn) => fn()),
  };
}

test("projects.list selects the first project, exposes roles and persists the choice", async () => {
  const s = store();
  const link = fakeLink({ "projects.list": { projects: [proj("p-1", "Alpha", "viewer"), proj("p-2", "Beta", "owner")] } });
  const c = createProjectsController(link, { storage: s });
  link.resync(); // ready: the controller loads on the link's resync
  await tick();
  assert.deepEqual(link.calls.map((x) => x.command), ["projects.list"]);
  assert.deepEqual(c.getState().projects.map((p) => [p.id, p.name, p.role]), [["p-1", "Alpha", "viewer"], ["p-2", "Beta", "owner"]]);
  assert.equal(c.getState().selectedId, "p-1");
  assert.equal(s.get(), "p-1");

  assert.equal(c.select("p-2"), true);
  assert.equal(c.getState().selectedId, "p-2");
  assert.equal(s.get(), "p-2");

  // A new page (new controller, same browser storage) restores the stored project, not the first one.
  const again = createProjectsController(fakeLink({ "projects.list": { projects: [proj("p-1", "Alpha", "viewer"), proj("p-2", "Beta", "owner")] } }), { storage: s });
  await again.load();
  assert.equal(again.getState().selectedId, "p-2");
});

test("a stored project that is gone falls back to the first project; an empty list keeps none", async () => {
  const s = store();
  s.set("p-gone");
  const c = createProjectsController(fakeLink({ "projects.list": { projects: [proj("p-1", "Alpha", "member")] } }), { storage: s });
  await c.load();
  assert.equal(c.getState().selectedId, "p-1");
  assert.equal(s.get(), "p-1");

  const empty = createProjectsController(fakeLink({ "projects.list": { projects: [] } }), { storage: store() });
  await empty.load();
  assert.deepEqual(empty.getState().projects, []);
  assert.equal(empty.getState().selectedId, null);
  assert.equal(empty.getState().loaded, true);
});

test("a stored project is selected at construction, before projects.list, and an empty list keeps it stored", async () => {
  const s = store();
  s.set("p-2");
  let reply;
  const link = fakeLink({ "projects.list": () => new Promise((r) => { reply = () => r({ projects: [proj("p-1", "Alpha", "viewer"), proj("p-2", "Beta", "owner")] }); }) });
  const c = createProjectsController(link, { storage: s });
  assert.equal(c.getState().selectedId, "p-2", "the remembered project scopes the first frame");
  assert.equal(c.getState().loaded, false);
  const loading = c.load();
  assert.equal(c.getState().loading, true);
  reply();
  await loading;
  assert.equal(c.getState().selectedId, "p-2");
  assert.equal(s.get(), "p-2");

  // L5: a host that briefly answers an empty list must not erase the remembered choice.
  const empty = createProjectsController(fakeLink({ "projects.list": { projects: [] } }), { storage: s });
  assert.equal(empty.getState().selectedId, "p-2", "seeded again on the next page load");
  await empty.load();
  assert.equal(empty.getState().selectedId, null);
  assert.equal(s.get(), "p-2", "the empty list did not overwrite the stored id");
});

test("the first snapshot and a send typed before the list wait for projects.list and name the stored project", async () => {
  const s = store();
  s.set("p-2");
  let release;
  const link = fakeLink({
    "projects.list": () => new Promise((r) => { release = () => r({ projects: [proj("p-1", "Alpha", "viewer"), proj("p-2", "Beta", "owner")] }); }),
    "chat.snapshot": { messages: [] },
    "chat.send": { accepted: true, requestId: "c-1" },
  });
  const projects = createProjectsController(link, { storage: s });
  const chat = createChatController(link, { projectId: () => projects.getSelectedId(), scopeReady: () => projects.whenLoaded() });
  link.resync();
  await tick();
  assert.equal(link.calls.filter((x) => x.command === "chat.snapshot").length, 0, "the snapshot waits");
  const sending = chat.send("hi");
  await tick();
  assert.equal(link.calls.filter((x) => x.command === "chat.send").length, 0, "the send waits too");

  release();
  await sending;
  await tick(10);
  assert.deepEqual(link.calls.find((x) => x.command === "chat.snapshot").payload, { limit: 200, projectId: "p-2" });
  assert.deepEqual(link.calls.find((x) => x.command === "chat.send").payload, { text: "hi", projectId: "p-2" });
});

test("the picker renders each project with the caller's role and a role badge", () => {
  const state = { projects: [proj("p-1", "Alpha", "viewer"), proj("p-2", "Beta", "owner")], selectedId: "p-2", loading: false, loaded: true, error: null, refusal: null };
  const out = html(h(UI.ProjectPicker, { state, onSelect: noop }));
  assert.match(out, /<label[^>]*>Project<\/label>/);
  assert.match(out, /Alpha — viewer/);
  assert.match(out, /Beta — owner/);
  assert.match(out, /<span class="web-project-role" data-role="owner">owner<\/span>/);
});

test("no projects is a clear empty state", () => {
  const state = { projects: [], selectedId: null, loading: false, loaded: true, error: null, refusal: null };
  assert.match(html(h(UI.ProjectPicker, { state, onSelect: noop })), /No projects are available to this account\./);
});

test("a failed projects.list shows the reason instead of claiming there are no projects", async () => {
  const c = createProjectsController(fakeLink({ "projects.list": new Error("This host does not serve that feature.") }), { storage: store() });
  await c.load();
  assert.equal(c.getState().error, "This host does not serve that feature.");
  const out = html(h(UI.ProjectPicker, { state: c.getState(), onSelect: noop }));
  assert.match(out, /Could not load projects\. This host does not serve that feature\./);
  assert.doesNotMatch(out, /No projects are available/);
});

test("a refusal shows the host's reason and leaves the picker usable", async () => {
  const s = store();
  const c = createProjectsController(fakeLink({ "projects.list": { projects: [proj("p-1", "Alpha", "member")] } }), { storage: s });
  await c.load();
  const refusal = c.noteRefusal(Object.assign(new Error("Your project role no longer allows this."), { code: "denied" }));
  assert.equal(refusal.code, "PROJECT_DENIED");
  assert.equal(refusal.message, "Your project role no longer allows this.");
  const out = html(h(UI.ProjectPicker, { state: c.getState(), onSelect: noop }));
  assert.match(out, /The desktop refused this project\./);
  assert.match(out, /Your project role no longer allows this\./);
  assert.doesNotMatch(out, /<select[^>]*disabled/);
  assert.equal(c.select("p-1"), true, "the picker still accepts a selection");
});

test("the contract's refusals map to the project reason the picker shows", () => {
  assert.deepEqual(projectRefusal(Object.assign(new Error("That project is not registered on this computer."), { code: "not_found" }), "p-1"),
    { code: "PROJECT_MISMATCH", message: "That project is not registered on this computer." });
  assert.equal(projectRefusal(new Error("PROJECT_REQUIRED: a project is required on this hub"), null)?.code, "PROJECT_REQUIRED");
  assert.deepEqual(projectRefusal(Object.assign(new Error("Refused."), { code: "PROJECT_DENIED" }), null), { code: "PROJECT_DENIED", message: "Refused." });
  assert.equal(projectRefusal(Object.assign(new Error("Your team role no longer allows this."), { code: "denied" }), null), null);
  assert.equal(projectRefusal(new Error("network down"), "p-1"), null);
});

test("chat frames carry the selected projectId wherever the contract has the field", async () => {
  const link = fakeLink({
    "chat.snapshot": { messages: [] }, "chat.send": { accepted: true }, "chat.new": { sessionId: "s-2" },
    "chat.history.clear": { cleared: true }, "chat.cancel": { cancelled: true },
    "approvals.answer": { accepted: true }, "toolApprovals.answer": { accepted: true },
  });
  const chat = createChatController(link, { projectId: () => "p-2" });
  await chat.resync();
  assert.deepEqual(link.calls.at(-1), { id: "c-1", command: "chat.snapshot", payload: { limit: 200, projectId: "p-2" } });

  await chat.send("hi");
  assert.deepEqual(link.calls.at(-1).payload, { text: "hi", projectId: "p-2" });
  const turn = link.calls.at(-1).id;

  link.emit({ command: "approval.request", payload: { requestId: "r-1", commandId: turn, questions: [{ question: "Pick?", multiSelect: false, options: [{ label: "Yes" }] }] }, rev: 1, replyTo: turn });
  await chat.answerQuestion("r-1", { "Pick?": "Yes" });
  assert.deepEqual(link.calls.at(-1).payload, { requestId: "r-1", commandId: turn, answers: { "Pick?": "Yes" }, projectId: "p-2" });

  link.emit({ command: "toolApproval.request", payload: { requestId: "t-1", commandId: turn, toolName: "Edit", truncated: false }, rev: 2, replyTo: turn });
  await chat.answerTool("t-1", "allow_once");
  assert.deepEqual(link.calls.at(-1).payload, { requestId: "t-1", commandId: turn, decision: "allow_once", projectId: "p-2" });

  await chat.cancel();
  assert.deepEqual(link.calls.at(-1).payload, { projectId: "p-2" });
  link.emit({ command: "chat.done", payload: { requestId: turn }, rev: 3, replyTo: turn });

  await chat.newChat();
  assert.equal(link.calls.at(-1).command, "chat.new");
  assert.deepEqual(link.calls.at(-1).payload, { projectId: "p-2" });
  await chat.clearHistory();
  assert.deepEqual(link.calls.at(-1).payload, { projectId: "p-2" });
});

test("a refused project-scoped chat frame is reported to the picker", async () => {
  const errors = [];
  const denied = Object.assign(new Error("Your project role no longer allows this."), { code: "denied" });
  const chat = createChatController(fakeLink({ "chat.send": denied }), { projectId: () => "p-1", onProjectRefused: (e) => errors.push(e) });
  await chat.send("hi");
  assert.equal(errors.length, 1);
  assert.equal(projectRefusal(errors[0], "p-1")?.code, "PROJECT_DENIED");
});

test("chat.options carries the projectId too", async () => {
  const link = fakeLink({ "chat.options": { modes: ["auto", "ask"], models: [{ model: "m-1" }] } });
  const compose = createComposeController(link, { projectId: () => "p-1" });
  await compose.load();
  assert.deepEqual(link.calls, [{ id: "c-1", command: "chat.options", payload: { projectId: "p-1" } }]);
});

test("a project change during an in-flight snapshot queues a second scoped snapshot", async () => {
  let selected = null;
  let release;
  let calls = 0;
  const link = fakeLink({ "chat.snapshot": () => (++calls === 1
    ? new Promise((r) => { release = () => r({ messages: [] }); })
    : Promise.resolve({ messages: [] })) });
  const chat = createChatController(link, { projectId: () => selected });
  const first = chat.resync();
  selected = "p-1";
  const queued = chat.resync(); // the projects.list reply landed while the snapshot was in flight
  assert.equal(link.calls.filter((c) => c.command === "chat.snapshot").length, 1);
  release();
  await first;
  await queued;
  const snaps = link.calls.filter((c) => c.command === "chat.snapshot");
  assert.equal(snaps.length, 2);
  assert.deepEqual(snaps.map((c) => c.payload), [{ limit: 200 }, { limit: 200, projectId: "p-1" }]);
});

test("without a project the payloads stay exactly the v1 team frames", async () => {
  const link = fakeLink({ "chat.snapshot": { messages: [] }, "chat.send": { accepted: true } });
  const chat = createChatController(link, { projectId: () => null });
  await chat.resync();
  await chat.send("hi");
  assert.deepEqual(link.calls.map((c) => c.payload), [{ limit: 200 }, { text: "hi" }]);
});
