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
