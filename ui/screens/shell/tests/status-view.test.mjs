// Status-bar wording for the ssh server mode (status-view.ts), the poll rate it needs (status-store.ts) and the
// core-not-ready reason screens show (core-explain.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { deriveStatusView } = await load("status-view.ts");
const { nextDelay } = await load("status-store.ts");
const { coreNotReadyReason } = await load("core-explain.ts");

const ssh = (o = {}) => ({ url: "http://127.0.0.1:3456", state: "ssh", trust: "ssh_forward", mode: "ssh", link: "connected", restarts: 0, pid: null, adopted: false, error: null, claude: "found", ...o });
const view = (status, pollError = null) => deriveStatusView({ status, pollError, everReady: false });

test("ssh mode: connected is ok and not down", () => {
  const v = view(ssh());
  assert.equal(v.level, "ok");
  assert.equal(v.label, "SSH server connected");
  assert.equal(v.down, false);
});

test("ssh mode: connecting is busy, not an error", () => {
  const v = view(ssh({ link: "connecting" }));
  assert.equal(v.label, "Connecting to the SSH server…");
  assert.notEqual(v.level, "error");
});

test("ssh mode: reconnecting is a warning", () => {
  const v = view(ssh({ link: "reconnecting" }));
  assert.equal(v.level, "warn");
  assert.equal(v.label, "Reconnecting to the SSH server…");
  // The core cannot serve requests while the forward is down: the same "core is down" presentation as a stopped core.
  assert.equal(v.down, true);
});

test("ssh mode: needs_password asks for the password as a warning", () => {
  const v = view(ssh({ link: "needs_password" }));
  assert.equal(v.level, "warn");
  assert.equal(v.label, "Enter the server password to connect");
});

test("ssh mode: failed is an error with the status error as detail, or the fixed sentence", () => {
  const withError = view(ssh({ link: "failed", error: "ssh exited with 255" }));
  assert.equal(withError.level, "error");
  assert.equal(withError.label, "SSH server unreachable");
  assert.equal(withError.detail, "ssh exited with 255");
  const bare = view(ssh({ link: "failed", error: null }));
  assert.equal(bare.detail, "The SSH connection could not be opened.");
});

test("ssh mode: a stopped link (or a stopped core) shows the existing stopped presentation", () => {
  const local = view({ ...ssh(), state: "stopped", mode: "local", link: null, trust: "spawned" });
  for (const v of [view(ssh({ link: "stopped" })), view(ssh({ state: "stopped" }))]) {
    assert.equal(v.level, local.level);
    assert.equal(v.label, local.label);
    assert.equal(v.detail, local.detail);
    assert.equal(v.down, true);
  }
});

test("ssh mode: a connected forward polls at the steady rate, a reconnecting one at the fast rate", () => {
  const iv = { fast: 1000, slow: 4000, hidden: 15000 };
  assert.equal(nextDelay({ status: ssh(), pollError: null, everReady: false }, iv, false), 4000);
  assert.equal(nextDelay({ status: ssh({ link: "reconnecting" }), pollError: null, everReady: false }, iv, false), 1000);
});

test("core not ready: a usable ssh forward is ready; otherwise the link word is the reason", () => {
  assert.equal(coreNotReadyReason(ssh()), null);
  assert.equal(coreNotReadyReason(ssh({ link: "failed" })), "failed");
  assert.equal(coreNotReadyReason(ssh({ link: "connecting" })), "connecting");
});
