import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_COPY,
  RemoteServerModel,
  decodeRemoteSshResult,
  isValidHost,
  isValidKeyPath,
  isValidUser,
  parseSshPort,
  remoteSshErrorText,
  validateRemote,
  type RemoteServerIo,
} from "../remote-model.ts";
import type { RemoteServerConfig, RemoteSshResult } from "../host.ts";

const local = (over: Partial<RemoteServerConfig> = {}): RemoteServerConfig => ({
  mode: "local", host: "server.example.com", port: 22, user: "deploy", keyPath: "/home/deploy/.ssh/id_ed25519", label: "prod", hubUrl: "", tlsPin: "", ...over,
});
const remote = (over: Partial<RemoteServerConfig> = {}): RemoteServerConfig => local({ mode: "remote", ...over });

const result: RemoteSshResult = {
  host: "server.example.com", port: 2222, user: "deploy", hostKeyType: "ssh-ed25519",
  fingerprint: "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff", uname: "Linux 6.8.0 x86_64",
  node: true, nodePath: "/usr/bin/node", nodeVersion: "v22.11.0",
};

function io(over: Partial<RemoteServerIo> = {}): RemoteServerIo & { saved: RemoteServerConfig[]; tested: RemoteServerConfig[] } {
  const saved: RemoteServerConfig[] = [];
  const tested: RemoteServerConfig[] = [];
  return {
    saved,
    tested,
    async load() { return remote({ port: 2222 }); },
    async save(config) { saved.push(config); return config; },
    async test(config) { tested.push(config); return result; },
    ...over,
  };
}

test("the local copy is the required sentence", () => {
  assert.equal(LOCAL_COPY, "Desktop uses MEGA sync for web/mobile while it is online.");
});

test("mode switch keeps the typed fields and clears a stale test result", async () => {
  const m = new RemoteServerModel(io());
  await m.load();
  assert.equal(m.getState().mode, "remote");
  assert.equal(m.getState().host, "server.example.com");
  await m.test();
  assert.ok(m.getState().result);
  m.setMode("local");
  assert.equal(m.getState().mode, "local");
  assert.equal(m.getState().host, "server.example.com", "the remote fields survive a switch back");
  assert.equal(m.getState().result, null, "an old success cannot describe the newly chosen mode");
  assert.equal(m.getState().error, null);
  m.setMode("remote");
  assert.equal(m.getState().mode, "remote");
  assert.equal(m.getState().keyPath, "/home/deploy/.ssh/id_ed25519");
});

test("validation rejects empty fields and option injection before any SSH call", async () => {
  const fake = io();
  const m = new RemoteServerModel(fake);
  await m.load();
  m.setField("host", "-oProxyCommand=touch /tmp/pwned");
  m.setField("user", "-l");
  m.setField("port", "0");
  m.setField("keyPath", "-key");
  await m.test();
  assert.equal(fake.tested.length, 0, "no runner call for an invalid target");
  const errors = m.getState().fieldErrors;
  assert.match(errors.host ?? "", /not valid/);
  assert.match(errors.user ?? "", /not valid/);
  assert.match(errors.port ?? "", /between 1 and 65535/);
  assert.match(errors.keyPath ?? "", /absolute path/);
  assert.equal(m.getState().result, null);
  assert.match(m.getState().error ?? "", /highlighted fields/);
});

test("a host or user starting with a dash fails the shared validation rules", () => {
  assert.equal(isValidHost("example.com"), true);
  assert.equal(isValidHost("10.0.0.5"), true);
  assert.equal(isValidHost("::1"), true);
  assert.equal(isValidHost("-example.com"), false);
  assert.equal(isValidHost("user@example.com"), false);
  assert.equal(isValidHost("example.com:22"), false);
  assert.equal(isValidUser("deploy"), true);
  assert.equal(isValidUser("-deploy"), false);
  assert.equal(isValidUser("deploy@example.com"), false);
  assert.equal(isValidKeyPath("/home/deploy/.ssh/id_ed25519"), true);
  assert.equal(isValidKeyPath("~/.ssh/id_ed25519"), false);
  assert.equal(isValidKeyPath("-key"), false);
  assert.equal(parseSshPort("22"), 22);
  assert.equal(parseSshPort(""), null);
  assert.equal(parseSshPort("0"), null);
  assert.equal(parseSshPort("70000"), null);
  assert.deepEqual(validateRemote(remote({ label: "x".repeat(81) })), { label: "Keep the label under 80 characters." });
});

test("a successful test stores the fingerprint, uname and node presence", async () => {
  const fake = io();
  const m = new RemoteServerModel(fake);
  await m.load();
  m.setField("port", "2222");
  await m.test();
  assert.deepEqual(fake.tested[0], remote({ port: 2222 }));
  const s = m.getState();
  assert.equal(s.testing, false);
  assert.equal(s.error, null);
  assert.deepEqual(s.result, result);
  assert.equal(s.result?.node, true);
  assert.equal(s.result?.fingerprint, result.fingerprint);
});

test("a failed test shows a clear error and keeps no stale success", async () => {
  const fake = io({ async test() { throw { code: "ssh_failed", message: "SSH could not connect: Permission denied (publickey)." }; } });
  const m = new RemoteServerModel(fake);
  await m.load();
  await m.test();
  assert.equal(m.getState().result, null);
  assert.match(m.getState().error ?? "", /Permission denied \(publickey\)/);
  assert.equal(m.getState().testing, false);
});

test("an invalid key path reports no key file, and a missing ssh is named", () => {
  assert.match(remoteSshErrorText({ code: "key_not_found" }), /No private key file/);
  assert.match(remoteSshErrorText({ code: "ssh_missing" }), /system ssh command is not available/);
  assert.match(remoteSshErrorText({ code: "invalid_host" }), /leading '-'/);
  assert.match(remoteSshErrorText({ code: "no_host_key" }), /fingerprint/);
});

test("R-034 #7: confirm records the tested fingerprint, and a field change clears it", async () => {
  const confirmed: Array<{ type: string; fingerprint: string }> = [];
  const fake = io({ async confirm(_config, type, fingerprint) { confirmed.push({ type, fingerprint }); } });
  const m = new RemoteServerModel(fake);
  await m.load();
  await m.test();
  assert.ok(m.getState().result);
  await m.confirm();
  assert.deepEqual(confirmed, [{ type: "ssh-ed25519", fingerprint: result.fingerprint }]);
  assert.equal(m.getState().confirmed, true);
  m.setField("host", "other.example.com");
  assert.equal(m.getState().confirmed, false, "a fingerprint cannot describe a different target");
});

test("R-034 #7: the deploy refusal codes read as plain sentences", () => {
  assert.match(remoteSshErrorText({ code: "host_key_unconfirmed" }), /Confirm the server's host-key fingerprint/);
  assert.match(remoteSshErrorText({ code: "host_key_changed" }), /no longer matches the fingerprint/);
});

test("save trims and sends only the non-secret fields in remote mode", async () => {
  const fake = io();
  const m = new RemoteServerModel(fake);
  await m.load();
  m.setField("host", "  server.example.com ");
  m.setField("user", " deploy ");
  m.setField("keyPath", " /home/deploy/.ssh/id_ed25519 ");
  m.setField("label", " prod ");
  await m.save();
  assert.deepEqual(fake.saved.at(-1), remote({ port: 2222 }));
  assert.equal(m.getState().saved, true);
  assert.equal(JSON.stringify(fake.saved.at(-1)).includes("keyContents"), false);
  assert.equal("keyContents" in (fake.saved.at(-1) as object), false);
});

test("local mode saves without requiring remote fields", async () => {
  const fake = io();
  const m = new RemoteServerModel(fake);
  await m.load();
  m.setMode("local");
  m.setField("host", "");
  m.setField("user", "");
  m.setField("keyPath", "");
  await m.save();
  assert.equal(fake.saved.at(-1)?.mode, "local");
  assert.equal(m.getState().saved, true);
  assert.deepEqual(m.getState().fieldErrors, {});
});

test("a failed load reads as unavailable, never as a healthy empty configuration", async () => {
  const m = new RemoteServerModel(io({ async load() { throw { code: "internal", message: "prefs unreadable" }; } }));
  await m.load();
  assert.equal(m.getState().loadFailed, true);
  assert.match(m.getState().error ?? "", /prefs unreadable/);
});

test("the host result decoder refuses invented or malformed answers", () => {
  assert.deepEqual(decodeRemoteSshResult(result), result);
  assert.equal(decodeRemoteSshResult({ ...result, port: 0 }), null);
  assert.equal(decodeRemoteSshResult({ ...result, node: "yes" }), null);
  assert.equal(decodeRemoteSshResult({ ...result, fingerprint: "" }), null);
  assert.equal(decodeRemoteSshResult(null), null);
});

// ---- URL-first flow (option A) -------------------------------------------------------------

import { decodeHubCheck, decodeHubLogin, hubErrorText, validateHubUrl, type HubLogin } from "../remote-model.ts";

const login: HubLogin = {
  hubUrl: "https://hub.example.com",
  user: { id: "u1", email: "owner@example.com", displayName: "Owner", role: "admin" },
  role: "admin",
  projects: [{ id: "p1", name: "Alpha", role: "owner" }],
  webPki: true,
  pin: "",
};

function hubIo(over: Partial<RemoteServerIo> = {}) {
  const calls: string[] = [];
  return {
    calls,
    io: {
      ...io(),
      async check(url: string) {
        calls.push(`check:${url}`);
        return { hubUrl: url, webPki: true, pin: "", status: "ok", apiVersion: 130, hub: true, dbOk: true };
      },
      async login(url: string, email: string, password: string) {
        calls.push(`login:${url}:${email}:${password}`);
        return login;
      },
      async signOut() { calls.push("signOut"); },
      async logoutCore() { calls.push("logoutCore"); },
      async restart() { calls.push("restart"); },
      async unpin(url: string) { calls.push(`unpin:${url}`); },
      ...over,
    } as RemoteServerIo,
  };
}

test("the hub URL validator trims, requires https, a public domain, and localhost only in dev", () => {
  assert.deepEqual(validateHubUrl("  https://Hub.Example.com  "), { ok: true, url: "https://hub.example.com", host: "hub.example.com", port: 443 });
  assert.deepEqual(validateHubUrl("https://hub.example.com:8443", { allowLocalhost: false }), { ok: true, url: "https://hub.example.com:8443", host: "hub.example.com", port: 8443 });
  for (const bad of ["", "http://hub.example.com", "https://8.8.8.8", "https://hub", "https://hub.local", "https://hub.example.com/path", "https://user@hub.example.com", "https://hub.example.com?x", "https://hub.example.com:0"]) {
    assert.equal(validateHubUrl(bad).ok, false, bad);
  }
  assert.equal(validateHubUrl("https://localhost").ok, false);
  assert.deepEqual(validateHubUrl("https://localhost:3457", { allowLocalhost: true }), { ok: true, url: "https://localhost:3457", host: "localhost", port: 3457 });
});

test("Connect logs in with the trimmed URL/email, keeps the password out of state, and restarts", async () => {
  const h = hubIo();
  const m = new RemoteServerModel(h.io);
  await m.load();
  m.setHubUrl("  https://hub.example.com  ");
  const result = await m.connect(" owner@example.com ", "secret", false);
  assert.equal(result?.role, "admin");
  assert.equal(h.calls[0], "login:https://hub.example.com:owner@example.com:secret");
  assert.equal(h.calls[1], "restart");
  assert.equal(m.getState().mode, "remote");
  assert.equal(m.getState().hubLogin?.projects.length, 1);
  assert.equal(m.getState().hubBusy, null);
  assert.equal(JSON.stringify(m.getState()).includes("secret"), false, "the password is never retained");
});

test("a wrong password or unreachable hub is a clear error, not a mode change", async () => {
  for (const [error, text] of [
    [{ code: "invalid_credentials" }, /incorrect/i],
    [{ code: "unreachable" }, /did not answer/i],
    [{ code: "tls_pin_mismatch" }, /certificate changed/i],
    [{ code: "project_access_denied" }, /project access/i],
  ] as const) {
    const h = hubIo({ async login() { throw error; } });
    const m = new RemoteServerModel(h.io);
    await m.load();
    m.setHubUrl("https://hub.example.com");
    assert.equal(await m.connect("owner@example.com", "wrong", false), null);
    assert.match(m.getState().hubError ?? "", text);
    assert.equal(m.getState().mode, "remote", "the loaded mode is unchanged; no save/restart happened");
    assert.ok(!h.calls.some((c) => c.startsWith("restart")));
  }
});

test("Test connection reports public-CA trust without a pin and does not sign in", async () => {
  const h = hubIo();
  const m = new RemoteServerModel(h.io);
  await m.load();
  m.setHubUrl("https://hub.example.com");
  const check = await m.checkConnection(false);
  assert.equal(check?.webPki, true);
  assert.equal(m.getState().hubCheck?.dbOk, true);
  assert.equal(m.getState().tlsPin, "");
  assert.ok(!h.calls.some((c) => c.startsWith("login")));
});

test("a saved pin is shown as the optional fallback, and can be removed for public-CA trust", async () => {
  const h = hubIo({ async check(url) { return { hubUrl: url, webPki: false, pin: `sha256:${"A".repeat(43)}`, status: "ok", apiVersion: 130, hub: true, dbOk: true }; } });
  const m = new RemoteServerModel(h.io);
  await m.load();
  m.setHubUrl("https://hub.example.com");
  await m.checkConnection(false);
  assert.equal(m.getState().hubCheck?.webPki, false);
  assert.match(m.getState().tlsPin, /^sha256:/);
  await m.unpin(false);
  assert.equal(m.getState().tlsPin, "");
  assert.equal(h.calls.at(-1), "unpin:https://hub.example.com");
});

test("switching back to Local is explicit, saves local mode and restarts", async () => {
  const h = hubIo();
  const m = new RemoteServerModel(h.io);
  await m.load();
  m.setMode("remote");
  const ok = await m.switchToLocal();
  assert.equal(ok, true);
  assert.equal(m.getState().mode, "local");
  assert.equal(h.calls.at(-1), "restart");
});

test("Sign out clears the keychain session and the in-memory core session", async () => {
  const h = hubIo();
  const m = new RemoteServerModel(h.io);
  await m.load();
  await m.signOut();
  assert.deepEqual(h.calls, ["signOut", "logoutCore"]);
  assert.equal(m.getState().hubLogin, null);
});

test("the hub decoders refuse invented answers and map every clear error code", () => {
  assert.deepEqual(decodeHubLogin(login), login);
  assert.equal(decodeHubLogin({ ...login, user: { id: "u" } }), null);
  assert.equal(decodeHubLogin({ ...login, webPki: "yes" }), null);
  assert.equal(decodeHubCheck({ hubUrl: "https://h.example.com", webPki: true, pin: "", status: "ok", apiVersion: 1, hub: true, dbOk: true })?.dbOk, true);
  assert.equal(decodeHubCheck({ hubUrl: "https://h.example.com" }), null);
  for (const code of ["invalid_credentials", "unreachable", "tls_untrusted", "tls_pin_mismatch", "project_access_denied", "keychain_unavailable"]) {
    assert.ok(hubErrorText({ code }).length > 10, code);
  }
});
