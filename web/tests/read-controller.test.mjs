import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadController, initialReadState } from "../src/read/controller.ts";

function fakeLink(results = {}, caps = ["host", "chat", "read"]) {
  const ls = { event: new Set(), resync: new Set(), state: new Set() };
  const calls = [];
  let n = 0;
  return {
    capabilities: new Set(caps), calls,
    send(command, payload) {
      const id = `c-${++n}`;
      calls.push({ command, payload });
      const r = results[command];
      return { id, done: r instanceof Error ? Promise.reject(r) : Promise.resolve(typeof r === "function" ? r(payload) : r ?? {}) };
    },
    onEvent: (fn) => (ls.event.add(fn), () => ls.event.delete(fn)),
    onResync: (fn) => (ls.resync.add(fn), () => ls.resync.delete(fn)),
    onState: (fn) => (ls.state.add(fn), () => ls.state.delete(fn)),
    resync: () => ls.resync.forEach((fn) => fn()),
    emit: (e) => ls.event.forEach((fn) => fn(e)),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("without the read capability nothing is sent", async () => {
  const link = fakeLink({}, ["host", "chat"]);
  const r = createReadController(link);
  await r.refresh();
  assert.equal(link.calls.length, 0);
  assert.deepEqual(r.getState(), initialReadState);
});

test("refresh loads chats and usage; more appends the next page", async () => {
  const link = fakeLink({
    "chat.sessions": (p) => (p.offset ? { sessions: [{ id: "b", title: "B", updatedAt: 1 }] } : { sessions: [{ id: "a", title: "A", updatedAt: 2 }], nextOffset: 50 }),
    "usage.get": { providers: [{ provider: "anthropic", status: "ok", models: [] }] },
  });
  const r = createReadController(link);
  await r.refresh();
  assert.deepEqual(r.getState().sessions.map((s) => s.id), ["a"]);
  assert.equal(r.getState().nextOffset, 50);
  assert.equal(r.getState().usage[0].provider, "anthropic");
  await r.moreSessions();
  assert.deepEqual(link.calls.at(-1), { command: "chat.sessions", payload: { limit: 50, offset: 50 } });
  assert.deepEqual(r.getState().sessions.map((s) => s.id), ["a", "b"]);
  assert.equal(r.getState().nextOffset, null);
});

test("open shows one chat read-only; older prepends; a stale reply for another chat is dropped", async () => {
  let release;
  const slow = new Promise((res) => { release = res; });
  const link = fakeLink({
    "chat.history": (p) => p.sessionId === "slow" ? slow
      : p.beforeSeq ? { messages: [{ seq: 1, role: "user", content: "old" }] }
      : { messages: [{ seq: 2, role: "assistant", content: "new" }], nextBeforeSeq: 2 },
  });
  const r = createReadController(link);
  const first = r.open("slow", "Slow");
  await r.open("x", "X");
  release({ messages: [{ seq: 9, role: "user", content: "stale" }] });
  await first;
  assert.equal(r.getState().open.id, "x");
  assert.deepEqual(r.getState().open.messages.map((m) => m.content), ["new"]);
  await r.older();
  assert.deepEqual(link.calls.at(-1).payload, { sessionId: "x", beforeSeq: 2, limit: 100 });
  assert.deepEqual(r.getState().open.messages.map((m) => m.content), ["old", "new"]);
  assert.equal(r.getState().open.nextBeforeSeq, null);
  r.close();
  assert.equal(r.getState().open, null);
});

test("an error is shown, not thrown; a resync refreshes", async () => {
  const link = fakeLink({ "chat.sessions": new Error("This chat is not on this computer."), "usage.get": { providers: [] } });
  const r = createReadController(link);
  await r.refresh();
  assert.match(r.getState().error, /not on this computer/);
  link.resync();
  await tick();
  assert.ok(link.calls.filter((c) => c.command === "usage.get").length >= 2);
  r.dispose();
});

test("more stops at the memory cap and two quick clicks append the page once", async () => {
  const { MAX_SESSIONS } = await import("../src/read/controller.ts");
  const page = (offset) => Array.from({ length: 50 }, (_, i) => ({ id: `s${offset + i}`, title: "t", updatedAt: 1 }));
  const link = fakeLink({ "chat.sessions": (p) => ({ sessions: page(p.offset ?? 0), nextOffset: (p.offset ?? 0) + 50 }), "usage.get": { providers: [] } });
  const r = createReadController(link);
  await r.refresh();
  await Promise.all([r.moreSessions(), r.moreSessions()]);
  assert.equal(r.getState().sessions.length, 100, "the second click while the first is in flight is ignored");
  assert.equal(new Set(r.getState().sessions.map((s) => s.id)).size, 100, "no duplicates");
  while (r.getState().nextOffset !== null) await r.moreSessions();
  assert.equal(r.getState().sessions.length, MAX_SESSIONS);
  const sent = link.calls.length;
  await r.moreSessions();
  assert.equal(link.calls.length, sent, "nothing more is fetched at the cap");
});

test("a failed reply for a chat the user already left shows no error", async () => {
  let failA;
  const link = fakeLink({ "chat.history": (p) => (p.sessionId === "a" ? new Promise((_, rej) => { failA = rej; }) : { messages: [] }) });
  const r = createReadController(link);
  const first = r.open("a", "A");
  await r.open("b", "B");
  failA(new Error("boom"));
  await first;
  assert.equal(r.getState().open?.id, "b");
  assert.equal(r.getState().error, null);
});

test("a finished reply refreshes the usage strip", async () => {
  const link = fakeLink({ "usage.get": { providers: [{ provider: "anthropic", status: "ok", models: [] }] } });
  const r = createReadController(link);
  link.emit({ command: "chat.done", payload: { requestId: "c-1" }, rev: 1, replyTo: "c-1" });
  await tick();
  assert.deepEqual(link.calls, [{ command: "usage.get", payload: {} }]);
  assert.equal(r.getState().usage[0].provider, "anthropic");
});

test("API 128: sessions and history name the selected project; switching projects shows only the new project", async () => {
  let selected = "p-1";
  const link = fakeLink({
    "chat.sessions": (p) => ({ sessions: [{ id: p.projectId === "p-2" ? "b" : "a", title: "t", updatedAt: 1 }] }),
    "chat.history": (p) => ({ messages: [{ seq: 1, role: "user", content: p.projectId === "p-2" ? "beta" : "alpha" }] }),
    "usage.get": { providers: [] },
  });
  const r = createReadController(link, { projectId: () => selected });
  await r.refresh();
  assert.deepEqual(r.getState().sessions.map((s) => s.id), ["a"]);
  assert.deepEqual(link.calls.find((c) => c.command === "chat.sessions").payload, { limit: 50, projectId: "p-1" });

  await r.open("a", "A");
  assert.deepEqual(link.calls.at(-1).payload, { sessionId: "a", limit: 100, projectId: "p-1" });

  selected = "p-2";
  await r.projectChanged();
  assert.deepEqual(r.getState().sessions.map((s) => s.id), ["b"], "the other project's chat is gone");
  assert.equal(r.getState().open, null, "the open chat belonged to the old project");
  const lastSessions = [...link.calls].reverse().find((c) => c.command === "chat.sessions");
  assert.deepEqual(lastSessions.payload, { limit: 50, projectId: "p-2" });
  assert.deepEqual(link.calls.filter((c) => c.command === "chat.sessions").map((c) => c.payload.projectId), ["p-1", "p-2"]);
});

test("API 128: a history reply from the project the user left is dropped, error included", async () => {
  let release;
  const slow = new Promise((res) => { release = res; });
  const denied = Object.assign(new Error("PROJECT_MISMATCH: That chat belongs to another project."), { code: "denied" });
  const link = fakeLink({ "chat.history": () => slow });
  const r = createReadController(link, { projectId: () => "p-1" });
  const first = r.open("a", "A");
  await r.projectChanged();
  release({ messages: [{ seq: 1, role: "user", content: "stale" }] });
  await first;
  assert.equal(r.getState().open, null);
  assert.equal(r.getState().error, null, "the old project's reply and error are both dropped");

  const mismatch = createReadController(fakeLink({ "chat.history": denied }), { projectId: () => "p-2" });
  await mismatch.open("a", "A");
  assert.match(mismatch.getState().error, /PROJECT_MISMATCH/);
  assert.equal(mismatch.getState().open, null);
});

test("API 128: a sessions reply from the previous project never lands after a switch", async () => {
  let release;
  const first = new Promise((res) => { release = res; });
  let calls = 0;
  let selected = "p-1";
  const link = fakeLink({
    "chat.sessions": () => (++calls === 1 ? first : { sessions: [{ id: "b", title: "B", updatedAt: 1 }] }),
    "usage.get": { providers: [] },
  });
  const r = createReadController(link, { projectId: () => selected });
  const old = r.refresh();
  selected = "p-2";
  const changed = r.projectChanged();
  await tick();
  release({ sessions: [{ id: "a", title: "A", updatedAt: 1 }] });
  await Promise.all([old, changed]);
  assert.deepEqual(r.getState().sessions.map((s) => s.id), ["b"]);
});
