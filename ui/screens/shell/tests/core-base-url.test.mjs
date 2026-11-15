// Which core URL the shell may hand out for requests (runtime.ts `baseUrl` uses coreBaseUrl). In ssh mode only a
// connected forward qualifies: a reconnecting forward answers on a local port that another process may hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { coreBaseUrl } = await load("host.ts");
const { coreNotReadyReason } = await load("core-explain.ts");

const ssh = (o = {}) => ({ url: "http://127.0.0.1:3456", state: "ssh", trust: "ssh_forward", mode: "ssh", link: "connected", restarts: 0, pid: null, adopted: false, error: null, claude: "found", ...o });

test("ssh mode: a connected forward hands out its URL; reconnecting hands out nothing", () => {
  assert.equal(coreBaseUrl(ssh()), "http://127.0.0.1:3456");
  for (const link of ["reconnecting", "connecting", "needs_password", "failed", "stopped"]) {
    assert.equal(coreBaseUrl(ssh({ link })), null, link);
  }
});

test("ssh mode: the core-not-ready reason for a reconnecting forward is the link word", () => {
  assert.equal(coreNotReadyReason(ssh({ link: "reconnecting" })), "reconnecting");
  assert.equal(coreNotReadyReason(ssh()), null);
});

test("a local core: a ready core hands out its URL, anything else nothing (unchanged)", () => {
  const local = { url: "http://127.0.0.1:3457", state: "ready", trust: "spawned", mode: "local", link: null, restarts: 0, pid: 9, adopted: false, error: null, claude: "found" };
  assert.equal(coreBaseUrl(local), "http://127.0.0.1:3457");
  assert.equal(coreBaseUrl({ ...local, state: "starting" }), null);
  assert.equal(coreBaseUrl(null), null);
});
