// ssh mode with the link down: the server home (Welcome) and Settings stay usable so the user can connect again, switch
// or fix the server. Connecting or reconnecting keeps the screens as they are. Also: the background loops run only locally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { serverHomeReachable, keptScreensText, sectionInert, computeGate } = await load("gate.ts");
const { localBackgroundRoot } = await load("background-scope.ts");

const DOWN_LINKS = ["stopped", "needs_password", "failed"];

test("ssh + a link that will not come back by itself: Welcome and Settings are reachable", () => {
  for (const link of DOWN_LINKS) {
    assert.equal(serverHomeReachable("ssh", link, "welcome"), true, `welcome, ${link}`);
    assert.equal(serverHomeReachable("ssh", link, "settings"), true, `settings, ${link}`);
  }
});

test("ssh + connecting or reconnecting: not reachable (the screens wait for the link as before)", () => {
  for (const link of ["connecting", "reconnecting"]) {
    assert.equal(serverHomeReachable("ssh", link, "welcome"), false, link);
  }
});

test("ssh + connected, another section, or no link: not reachable", () => {
  assert.equal(serverHomeReachable("ssh", "connected", "welcome"), false);
  assert.equal(serverHomeReachable("ssh", "stopped", "explorer"), false);
  assert.equal(serverHomeReachable("ssh", null, "welcome"), false);
});

test("local or hub mode: the link does not apply, nothing is reachable", () => {
  for (const mode of ["local", "remote", undefined]) {
    assert.equal(serverHomeReachable(mode, "stopped", "welcome"), false, String(mode));
  }
});

test("reachable welcome is not inert under the core and restarting gates; the login gate stays inert", () => {
  for (const gate of ["core", "restarting"]) {
    assert.equal(sectionInert(gate, "welcome", true), false, gate);
    assert.equal(sectionInert(gate, "settings", true), false, gate);
    assert.equal(sectionInert(gate, "explorer", true), true, `${gate}: other sections stay inert`);
    assert.equal(sectionInert(gate, "welcome", false), true, `${gate}: not reachable, inert`);
  }
  assert.equal(sectionInert("login", "welcome", true), true, "login is never exempt");
});

test("the gate for a down link is core before first use and restarting after", () => {
  const view = { down: true, fatal: false };
  assert.equal(computeGate({ view, signedIn: true, everUsable: false, bypass: false }), "core");
  assert.equal(computeGate({ view, signedIn: true, everUsable: true, bypass: false }), "restarting");
});

test("the restarting banner does not promise a reconnect when the link will not come back by itself", () => {
  assert.equal(keptScreensText("SSH server unreachable", "ssh", "failed"), "SSH server unreachable. Your screens are kept. Connect to the server again from the server home.");
  assert.equal(keptScreensText("Core stopped", "ssh", "stopped"), "Core stopped. Your screens are kept. Connect to the server again from the server home.");
  assert.equal(keptScreensText("Reconnecting to the SSH server…", "ssh", "reconnecting"), "Reconnecting to the SSH server…. Your screens are kept and will reconnect.");
  assert.equal(keptScreensText("Core crashed", "local", null), "Core crashed. Your screens are kept and will reconnect.");
});

test("background loops run only for the local mode, with the project root", () => {
  assert.equal(localBackgroundRoot("local", "/Users/me/proj"), "/Users/me/proj");
  assert.equal(localBackgroundRoot("ssh", "/home/me/proj"), null, "ssh: the folder is on the server");
  assert.equal(localBackgroundRoot("remote", "/Users/me/proj"), null, "hub: refused as the other local work is");
  assert.equal(localBackgroundRoot(undefined, "/Users/me/proj"), null, "mode not known yet");
  assert.equal(localBackgroundRoot("local", null), null, "no project");
});
