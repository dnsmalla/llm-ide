// The restore retries once on a refused read from a busy core, and an untrusted core is silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { createLocalSessionBinder } = await load("local-session.ts");
const tick = () => new Promise((r) => setTimeout(r, 0));
const USER = "dev@example.com";

function fakes(sessionResults) {
  const calls = [];
  const queue = [...sessionResults];
  const core = {
    subscribeRefreshToken() { return () => undefined; },
    getSnapshot() { return { signedIn: false, user: { email: USER } }; },
    async restoreSession(token) { calls.push(["restore", token]); },
  };
  const host = {
    async localLoginSession() {
      calls.push(["session"]);
      const next = queue.shift();
      if (next instanceof Error || (next && typeof next === "object" && "code" in next)) throw next;
      return next ?? null;
    },
    async localLoginStatus() { return { saved: false, email: null }; },
    async localLoginRelogin() { calls.push(["relogin"]); return null; },
    async localLoginStoreRefresh() {},
    async localLoginForget() {},
  };
  return { core, host, calls };
}

test("a refused read from a busy core is retried once after a pause, then restores", async () => {
  const h = fakes([{ code: "untrusted_core" }, "r-old"]);
  const pauses = [];
  const outcomes = [];
  const off = createLocalSessionBinder(h.core, h.host, (r) => outcomes.push(r), {
    isLocalSpawned: () => true,
    pause: async (ms) => { pauses.push(ms); },
  });
  await tick();
  assert.deepEqual(pauses, [1500]);
  assert.deepEqual(h.calls, [["session"], ["session"], ["restore", "r-old"]]);
  assert.deepEqual(outcomes, [false]);
  off();
});

test("an untrusted core that is not local+spawned is not retried and shows nothing", async () => {
  const h = fakes([{ code: "untrusted_core" }]);
  const pauses = [];
  const outcomes = [];
  const off = createLocalSessionBinder(h.core, h.host, (r) => outcomes.push(r), {
    isLocalSpawned: () => false,
    pause: async (ms) => { pauses.push(ms); },
  });
  await tick();
  assert.deepEqual(pauses, []);
  assert.deepEqual(h.calls, [["session"]]);
  assert.deepEqual(outcomes, [], "an adopted core is not an error");
  off();
});

test("a core that stays untrusted after the retry gives up silently", async () => {
  const h = fakes([{ code: "untrusted_core" }, { code: "untrusted_core" }]);
  const outcomes = [];
  const off = createLocalSessionBinder(h.core, h.host, (r) => outcomes.push(r), {
    isLocalSpawned: () => true,
    pause: async () => undefined,
  });
  await tick();
  assert.deepEqual(h.calls, [["session"], ["session"]]);
  assert.deepEqual(outcomes, []);
  off();
});
