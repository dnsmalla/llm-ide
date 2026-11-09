// R-034 #10: the hub session is restored on start-up and kept in step with refreshes/sign-out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { createRemoteSessionBinder } = await load("remote-session.ts");
const TARGET = { hubUrl: "https://hub.example.com", pin: `sha256:${"A".repeat(43)}` };
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness({ stored = "refresh-old", restoreError = null } = {}) {
  const calls = [];
  let listener = null;
  const core = {
    subscribeRefreshToken(cb) { listener = cb; return () => { listener = null; }; },
    async restoreSession(token) {
      calls.push(["restore", token]);
      if (restoreError) throw restoreError;
    },
  };
  const host = {
    async remoteServerTarget() { return TARGET; },
    async remoteSessionLoad(hub, pin) { calls.push(["load", hub, pin]); return stored; },
    async remoteSessionStore(hub, pin, refresh) { calls.push(["store", hub, pin, refresh]); },
    async remoteSessionClear() { calls.push(["clear"]); },
  };
  return { core, host, calls, emit: (t) => listener?.(t) };
}

test("a stored refresh token is exchanged on mount and the rotated token is stored", async () => {
  const h = harness();
  const off = createRemoteSessionBinder(h.core, h.host);
  await tick();
  assert.deepEqual(h.calls[0], ["load", TARGET.hubUrl, TARGET.pin]);
  assert.deepEqual(h.calls[1], ["restore", "refresh-old"]);
  h.emit("refresh-new");
  await tick();
  assert.deepEqual(h.calls.at(-1), ["store", TARGET.hubUrl, TARGET.pin, "refresh-new"]);
  h.emit(null);
  await tick();
  assert.deepEqual(h.calls.at(-1), ["clear"]);
  off();
});

test("a rejected stored token is cleared; a network failure keeps it", async () => {
  const rejected = harness({ restoreError: { status: 401 } });
  const off = createRemoteSessionBinder(rejected.core, rejected.host);
  await tick();
  assert.ok(rejected.calls.some((c) => c[0] === "clear"));
  off();

  const offline = harness({ restoreError: { status: 0, code: "NETWORK" } });
  const off2 = createRemoteSessionBinder(offline.core, offline.host);
  await tick();
  assert.ok(!offline.calls.some((c) => c[0] === "clear"), "a hub that is down is not a revoked session");
  off2();
});

test("no stored token means no refresh call", async () => {
  const h = harness({ stored: null });
  createRemoteSessionBinder(h.core, h.host);
  await tick();
  assert.ok(!h.calls.some((c) => c[0] === "restore"));
});
