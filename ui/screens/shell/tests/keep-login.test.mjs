// "Keep me signed in" in ssh mode: one predicate (canKeepLogin), the shell's session key, the login panel wording and
// the forget rule. Hub mode never keeps a login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const { canKeepLogin, localSessionKey } = await load("host.ts");
const { createLocalSessionBinder, forgetSavedLoginFor } = await load("local-session.ts");
const { LoginPanel } = await load("Panels.tsx");
const { createCoreClient } = await load("core.ts");
const h = React.createElement;
const tick = () => new Promise((r) => setTimeout(r, 0));

const base = { adopted: false, error: null, claude: "found", pid: 1, restarts: 0 };
const local = (o = {}) => ({ ...base, url: "http://127.0.0.1:3457", mode: "local", state: "ready", trust: "spawned", link: null, ...o });
const ssh = (o = {}) => ({ ...base, url: "http://127.0.0.1:3456", mode: "ssh", state: "ssh", trust: "ssh_forward", link: "connected", ...o });
const hub = (o = {}) => ({ ...base, url: "https://hub.example.com", mode: "remote", state: "remote", trust: "remote_pinned", link: null, ...o });

test("canKeepLogin: spawned local and a connected ssh forward only", () => {
  assert.equal(canKeepLogin(local()), true);
  assert.equal(canKeepLogin(local({ trust: "adopted_unverified" })), false);
  assert.equal(canKeepLogin(ssh()), true);
  for (const link of ["reconnecting", "needs_password", "failed"]) assert.equal(canKeepLogin(ssh({ link })), false, link);
  assert.equal(canKeepLogin(hub()), false);
  assert.equal(canKeepLogin(null), false);
});

test("localSessionKey: empty for hub and for a down core, distinct per forward, changes across a reconnect", () => {
  assert.equal(localSessionKey(hub(), false), "");
  assert.equal(localSessionKey(local(), true), "");
  assert.equal(localSessionKey(ssh(), true), "");
  assert.equal(localSessionKey(ssh({ link: "reconnecting" }), false), "");
  assert.equal(localSessionKey(local({ state: "starting" }), false), "");
  assert.notEqual(localSessionKey(local(), false), "");
  const a = localSessionKey(ssh(), false);
  const b = localSessionKey(ssh({ url: "http://127.0.0.1:3999" }), false);
  assert.ok(a && b && a !== b);
  assert.notEqual(localSessionKey(ssh({ restarts: 1 }), false), a);
  assert.equal(localSessionKey(ssh(), false), a, "a plain poll does not rebind");
  // drop and return: "" in between, so the effect cleans up and binds again
  assert.equal(localSessionKey(ssh({ link: "reconnecting" }), false), "");
});

test("LoginPanel: ssh mode offers the checkbox with server-specific wording; hub offers none; local unchanged", () => {
  const client = createCoreClient({ baseUrl: () => null });
  const render = (status) => renderToStaticMarkup(h(LoginPanel, { client, getStatus: () => status }));
  const s = render(ssh());
  assert.match(s, /name="keepSignedIn"/);
  assert.match(s, /for this server/);
  assert.ok(!/at every start/.test(s));
  const hb = render(hub());
  assert.ok(!/keepSignedIn/.test(hb));
  const l = render(local());
  assert.match(l, /name="keepSignedIn"/);
  assert.match(l, /Keep me signed in on this computer/);
  assert.match(l, /at every start/);
});

function binder(opts) {
  const calls = [];
  const queue = [...opts.session];
  const core = {
    subscribeRefreshToken() { return () => undefined; },
    getSnapshot() { return { signedIn: false, user: { email: "a@b.c" } }; },
    async restoreSession(t) { calls.push(["restore", t]); },
  };
  const host = {
    async localLoginSession() { calls.push(["session"]); const n = queue.shift(); if (n && typeof n === "object") throw n; return n ?? null; },
    async localLoginStatus() { return { saved: false, email: null }; },
    async localLoginRelogin() { return null; },
    async localLoginStoreRefresh() {},
    async localLoginForget() {},
  };
  const off = createLocalSessionBinder(core, host, () => undefined, { isTrustedCore: opts.trusted, pause: async () => {} });
  return { calls, off };
}

test("binder: a trusted ssh forward restores the saved session; the one retry needs the predicate", async () => {
  const status = ssh();
  const ok = binder({ session: [{ code: "untrusted_core" }, "r1"], trusted: () => canKeepLogin(status) });
  await tick(); await tick();
  assert.deepEqual(ok.calls, [["session"], ["session"], ["restore", "r1"]]);
  ok.off();
  const down = ssh({ link: "reconnecting" });
  const no = binder({ session: [{ code: "untrusted_core" }, "r1"], trusted: () => canKeepLogin(down) });
  await tick(); await tick();
  assert.deepEqual(no.calls, [["session"]]);
  no.off();
});

test("forgetSavedLoginFor: forgets in local and ssh mode, never in hub mode", async () => {
  for (const [status, expected] of [[local(), 1], [local({ trust: "adopted_unverified" }), 1], [ssh(), 1], [ssh({ link: "reconnecting" }), 1], [hub(), 0], [null, 0]]) {
    let n = 0;
    await forgetSavedLoginFor(status, { async localLoginForget() { n += 1; } });
    assert.equal(n, expected, String(status?.mode));
  }
});
