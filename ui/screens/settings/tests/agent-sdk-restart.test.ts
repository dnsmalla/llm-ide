import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSdkModel, SDK_TEXT, busyCounts, busyNote } from "../app-model.ts";
import { decodeAgentSdk } from "../decoders.ts";
import { deferred, fakeClient, reply } from "./helpers.ts";

const status = (busy?: unknown) => ({
  status: 200,
  body: { running: "1.0.0", installed: "1.0.0", latest: "1.1.0", updateAvailable: true, restartNeeded: false, updating: false, canUpdate: true, error: null, ...(busy === undefined ? {} : { busy }) },
});
const installed = { status: 200, body: { ok: true, from: "1.0.0", to: "1.1.0", rolledBack: false, restartNeeded: true, log: null } };

test("an installed update refreshes busy but never restarts the backend by itself", async () => {
  const c = fakeClient({ "GET /kb/agent-sdk": () => status({ chatTurns: 0, loopRuns: 0, total: 0 }), "POST /kb/agent-sdk/update": () => installed });
  const m = new AgentSdkModel(c);
  await m.load(false);
  await m.update();
  assert.equal(m.getState().result?.ok, true);
  assert.deepEqual(m.getState().status?.busy, { chatTurns: 0, loopRuns: 0, total: 0 });
  assert.equal(c.calls.filter((x) => x.method === "POST").length, 1);
});

test("an installed update keeps the busy counts for the restart note", async () => {
  const c = fakeClient({ "GET /kb/agent-sdk": () => status({ chatTurns: 2, loopRuns: 0, total: 2 }), "POST /kb/agent-sdk/update": () => installed });
  const m = new AgentSdkModel(c);
  await m.load(false);
  await m.update();
  assert.deepEqual(m.getState().status?.busy, { chatTurns: 2, loopRuns: 0, total: 2 });
  assert.equal(busyNote(m.getState().status!.busy!), "2 chats are still running; restart after they finish.");
});

test("an unknown busy count stays null, not zero", async () => {
  const c = fakeClient({ "GET /kb/agent-sdk": () => status(), "POST /kb/agent-sdk/update": () => installed });
  const m = new AgentSdkModel(c);
  await m.load(false);
  await m.update();
  assert.equal(m.getState().status?.busy, null);
  assert.equal(m.getState().result?.ok, true);
});

test("a malformed busy is unknown, not zero", () => {
  assert.equal(decodeAgentSdk({ busy: { chatTurns: "0", loopRuns: 0, total: 0 } }).busy, null);
  assert.equal(decodeAgentSdk({ busy: { chatTurns: -1, loopRuns: 0, total: 0 } }).busy, null);
  assert.equal(decodeAgentSdk({ busy: null }).busy, null);
});

test("a refused update (409, 503, or the server's ok:false answer) stays unapplied", async () => {
  for (const refusal of [
    { status: 409, body: { error: { code: "SDK_BUSY", message: "busy" } } },
    { status: 503, body: { error: { code: "UNAVAILABLE", message: "down" } } },
    reply("providers-usage/post-kb-agent-sdk-update-200-turn-running.json"),
  ]) {
    const c = fakeClient({ "GET /kb/agent-sdk": () => status({ chatTurns: 0, loopRuns: 0, total: 0 }), "POST /kb/agent-sdk/update": () => refusal });
    const m = new AgentSdkModel(c);
    await m.load(false);
    await m.update();
    assert.notEqual(m.getState().result?.ok, true);
  }
});

test("a double click on update runs one install", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const c = fakeClient({ "GET /kb/agent-sdk": () => status({ chatTurns: 0, loopRuns: 0, total: 0 }), "POST /kb/agent-sdk/update": () => gate.promise });
  const m = new AgentSdkModel(c);
  await m.load(false);
  const first = m.update();
  void m.update();
  gate.resolve(installed);
  await first;
  assert.equal(c.calls.filter((x) => x.method === "POST").length, 1);
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

test("the update confirm asks for a manual restart", () => {
  assert.match(SDK_TEXT.confirmBody, /After it installs, restart the backend/);
  assert.doesNotMatch(SDK_TEXT.confirmBody, /restarts by itself/);
});
