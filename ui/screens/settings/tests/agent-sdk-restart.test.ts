import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSdkModel, busyCounts, busyNote } from "../app-model.ts";
import { decodeAgentSdk } from "../decoders.ts";
import { deferred, fakeClient, reply } from "./helpers.ts";

const status = (busy?: unknown) => ({
  status: 200,
  body: { running: "1.0.0", installed: "1.0.0", latest: "1.1.0", updateAvailable: true, restartNeeded: false, updating: false, canUpdate: true, error: null, ...(busy === undefined ? {} : { busy }) },
});
const installed = { status: 200, body: { ok: true, from: "1.0.0", to: "1.1.0", rolledBack: false, restartNeeded: true, log: null } };

test("update installed and busy 0: the restart callback runs once", async () => {
  const c = fakeClient({ "GET /kb/agent-sdk": () => status({ chatTurns: 0, loopRuns: 0, total: 0 }), "POST /kb/agent-sdk/update": () => installed });
  const m = new AgentSdkModel(c);
  await m.load(false);
  let restarts = 0;
  await m.update(() => { restarts += 1; });
  assert.equal(restarts, 1);
  assert.equal(m.getState().result?.ok, true);
  assert.equal(c.calls.filter((x) => x.method === "POST").length, 1);
});

test("update installed but busy 2: no restart, the counts are kept for the note", async () => {
  const c = fakeClient({ "GET /kb/agent-sdk": () => status({ chatTurns: 2, loopRuns: 0, total: 2 }), "POST /kb/agent-sdk/update": () => installed });
  const m = new AgentSdkModel(c);
  await m.load(false);
  let restarts = 0;
  await m.update(() => { restarts += 1; });
  assert.equal(restarts, 0);
  assert.deepEqual(m.getState().status?.busy, { chatTurns: 2, loopRuns: 0, total: 2 });
  assert.equal(busyNote(m.getState().status!.busy!), "2 chats are still running; restart after they finish.");
});

test("update installed but busy absent (older core): unknown, so no restart", async () => {
  const c = fakeClient({ "GET /kb/agent-sdk": () => status(), "POST /kb/agent-sdk/update": () => installed });
  const m = new AgentSdkModel(c);
  await m.load(false);
  let restarts = 0;
  await m.update(() => { restarts += 1; });
  assert.equal(restarts, 0);
  assert.equal(m.getState().status?.busy, null);
  assert.equal(m.getState().result?.ok, true);
});

test("a malformed busy is unknown, not zero", () => {
  assert.equal(decodeAgentSdk({ busy: { chatTurns: "0", loopRuns: 0, total: 0 } }).busy, null);
  assert.equal(decodeAgentSdk({ busy: { chatTurns: -1, loopRuns: 0, total: 0 } }).busy, null);
  assert.equal(decodeAgentSdk({ busy: null }).busy, null);
});

test("a refused update (409, 503, or the server's ok:false answer) never restarts", async () => {
  for (const refusal of [
    { status: 409, body: { error: { code: "SDK_BUSY", message: "busy" } } },
    { status: 503, body: { error: { code: "UNAVAILABLE", message: "down" } } },
    reply("providers-usage/post-kb-agent-sdk-update-200-turn-running.json"),
  ]) {
    const c = fakeClient({ "GET /kb/agent-sdk": () => status({ chatTurns: 0, loopRuns: 0, total: 0 }), "POST /kb/agent-sdk/update": () => refusal });
    const m = new AgentSdkModel(c);
    await m.load(false);
    let restarts = 0;
    await m.update(() => { restarts += 1; });
    assert.equal(restarts, 0, `refusal ${refusal.status} must not restart`);
    assert.notEqual(m.getState().result?.ok, true);
  }
});

test("a double click on update runs one install and at most one restart", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const c = fakeClient({ "GET /kb/agent-sdk": () => status({ chatTurns: 0, loopRuns: 0, total: 0 }), "POST /kb/agent-sdk/update": () => gate.promise });
  const m = new AgentSdkModel(c);
  await m.load(false);
  let restarts = 0;
  const cb = () => { restarts += 1; };
  const first = m.update(cb);
  void m.update(cb);
  gate.resolve(installed);
  await first;
  assert.equal(c.calls.filter((x) => x.method === "POST").length, 1);
  assert.equal(restarts, 1);
});

test("the Restart click re-reads busy; a failed read reports unknown counts", async () => {
  let fail = false;
  const c = fakeClient({ "GET /kb/agent-sdk": () => (fail ? { status: 500, body: { error: { code: "X", message: "x" } } } : status({ chatTurns: 1, loopRuns: 1, total: 2 })) });
  const m = new AgentSdkModel(c);
  await m.load(false);
  assert.deepEqual(await m.checkBusy(), { chatTurns: 1, loopRuns: 1, total: 2 });
  fail = true;
  assert.equal(await m.checkBusy(), null);
  assert.equal(m.getState().status?.busy, null);
});

test("counts wording is singular and plural", () => {
  assert.equal(busyNote({ chatTurns: 1, loopRuns: 0, total: 1 }), "1 chat is still running; restart after it finishes.");
  assert.equal(busyNote({ chatTurns: 0, loopRuns: 1, total: 1 }), "1 Loop run is still running; restart after it finishes.");
  assert.equal(busyNote({ chatTurns: 0, loopRuns: 2, total: 2 }), "2 Loop runs are still running; restart after they finish.");
  assert.equal(busyNote({ chatTurns: 2, loopRuns: 1, total: 3 }), "2 chats and 1 Loop run are still running; restart after they finish.");
  assert.equal(busyCounts({ chatTurns: 0, loopRuns: 0, total: 0 }), "");
});

test("the update confirm says the restart is automatic only when nothing runs (review)", async () => {
  const { SDK_TEXT } = await import("../app-model.ts");
  assert.match(SDK_TEXT.confirmBody, /restarts by itself when no chat or Loop run is going; otherwise it waits and asks you/);
  assert.doesNotMatch(SDK_TEXT.confirmBody, /After it installs, restart the backend/);
});

test("an update that is already current (ok, restartNeeded false) never restarts, even with busy 0 (review)", async () => {
  const current = { status: 200, body: { ok: true, from: "1.1.0", to: "1.1.0", rolledBack: false, restartNeeded: false, log: "Already on 1.1.0 (latest 1.1.0)." } };
  const odd = { status: 200, body: { ok: false, from: "1.0.0", to: "1.1.0", rolledBack: true, restartNeeded: true, log: null } };
  for (const answer of [current, odd]) {
    const c = fakeClient({ "GET /kb/agent-sdk": () => status({ chatTurns: 0, loopRuns: 0, total: 0 }), "POST /kb/agent-sdk/update": () => answer });
    const m = new AgentSdkModel(c);
    await m.load(false);
    let restarts = 0;
    await m.update(() => { restarts += 1; });
    assert.equal(restarts, 0, JSON.stringify(answer.body));
  }
});
