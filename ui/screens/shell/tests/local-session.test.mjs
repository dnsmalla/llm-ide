// Local-mode login memory: the saved local session is restored at start-up, refreshes are stored back, and only an
// explicit sign-out (outside this binder) forgets it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { createLocalSessionBinder } = await load("local-session.ts");
const tick = () => new Promise((r) => setTimeout(r, 0));
const USER = "dev@example.com";

function harness({
  session = null,
  status = { saved: false, email: null },
  relogin = null,
  reloginError = null,
  restoreErrors = [],
  signedIn = false,
} = {}) {
  const calls = [];
  let listener = null;
  const errors = [...restoreErrors];
  const core = {
    subscribeRefreshToken(cb) {
      listener = cb;
      return () => { listener = null; };
    },
    getSnapshot() { return { signedIn, user: { email: USER } }; },
    async restoreSession(token) {
      calls.push(["restore", token]);
      const e = errors.shift();
      if (e) throw e;
    },
  };
  const host = {
    async localLoginSession() { calls.push(["session"]); return session; },
    async localLoginStatus() { calls.push(["status"]); return status; },
    async localLoginRelogin() {
      calls.push(["relogin"]);
      if (reloginError) throw reloginError;
      return relogin;
    },
    async localLoginStoreRefresh(email, refresh) { calls.push(["store", email, refresh]); },
    async localLoginForget() { calls.push(["forget"]); },
  };
  const outcomes = [];
  return {
    core,
    host,
    calls,
    outcomes,
    emit: (token) => listener?.(token),
    bind: () => createLocalSessionBinder(core, host, (refused) => outcomes.push(refused)),
  };
}

test("a stored refresh token restores the session and rotations are stored back", async () => {
  const h = harness({ session: "r-old" });
  const off = h.bind();
  await tick();
  assert.deepEqual(h.calls, [["session"], ["restore", "r-old"]]);
  assert.deepEqual(h.outcomes, [false]);
  h.emit("r-new");
  await tick();
  assert.deepEqual(h.calls.at(-1), ["store", USER, "r-new"], "a rotation is stored under the signed-in email");
  off();
});

test("a rotation without a signed-in user is not stored at all", async () => {
  const h = harness({ session: "r-old" });
  h.core.getSnapshot = () => ({ signedIn: false, user: null });
  const off = h.bind();
  await tick();
  h.emit("r-new");
  await tick();
  assert.ok(!h.calls.some((c) => c[0] === "store"));
  off();
});

test("a null token (expiry or sign-out) never forgets the saved login", async () => {
  const h = harness({ session: "r-old" });
  const off = h.bind();
  await tick();
  h.emit(null);
  await tick();
  assert.ok(!h.calls.some((c) => c[0] === "forget"), "an expiry is not an explicit sign-out");
  assert.ok(!h.calls.some((c) => c[0] === "store"), "a null token is not stored");
  off();
});

test("a refused stored token asks the host to sign in again with the saved password", async () => {
  const h = harness({ session: "r-old", restoreErrors: [{ status: 401 }], relogin: "r-new" });
  const off = h.bind();
  await tick();
  assert.deepEqual(h.calls.slice(1), [["restore", "r-old"], ["relogin"], ["restore", "r-new"]]);
  assert.deepEqual(h.outcomes, [false]);
  off();
});

test("with no stored token but a saved login, it signs in with the saved password", async () => {
  const h = harness({ session: null, status: { saved: true, email: "dev@example.com" }, relogin: "r-1" });
  const off = h.bind();
  await tick();
  assert.deepEqual(h.calls, [["session"], ["status"], ["relogin"], ["restore", "r-1"]]);
  off();
});

test("with nothing saved it does nothing and does not call the core", async () => {
  const h = harness({ session: null, status: { saved: false, email: null } });
  const off = h.bind();
  await tick();
  assert.deepEqual(h.calls, [["session"], ["status"]]);
  assert.deepEqual(h.outcomes, []);
  off();
});

test("a rejected saved password leaves the user signed out and says so, without forgetting it", async () => {
  const h = harness({ session: "r-old", restoreErrors: [{ status: 401 }], reloginError: { code: "login_rejected" } });
  const off = h.bind();
  await tick();
  assert.deepEqual(h.outcomes, [true]);
  assert.ok(!h.calls.some((c) => c[0] === "forget"), "the entry is kept so the user can update it");
  off();
});

test("a network failure keeps the stored token for the next launch", async () => {
  const h = harness({ session: "r-old", restoreErrors: [{ status: 0, code: "NETWORK" }] });
  const off = h.bind();
  await tick();
  assert.ok(!h.calls.some((c) => c[0] === "relogin"), "a core that is down is not a refused session");
  assert.ok(!h.calls.some((c) => c[0] === "forget"));
  assert.deepEqual(h.outcomes, []);
  off();
});

test("an already signed-in session is left alone", async () => {
  const h = harness({ session: "r-old", signedIn: true });
  const off = h.bind();
  await tick();
  assert.ok(!h.calls.some((c) => c[0] === "session" || c[0] === "restore"));
  off();
});

test("after the binder is stopped, rotations are no longer stored", async () => {
  const h = harness({ session: null });
  const off = h.bind();
  await tick();
  off();
  h.emit("r-late");
  await tick();
  assert.ok(!h.calls.some((c) => c[0] === "store"));
});
