import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SshServerModel,
  createSshServerIo,
  decodeSshServerStatus,
  sshBundleBlock,
  SSH_NO_BUNDLE_TEXT,
  decodeSshServerTest,
  sshServerErrorText,
  type SshServerIo,
} from "../ssh-server-model.ts";
import type { SshServerStatus, SshServerTest, SshServerTarget } from "../host.ts";

const trusted: SshServerTest = {
  hostKeyType: "ssh-ed25519", fingerprint: "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff", trusted: true, changed: false,
  os: "Linux", arch: "x86_64", freeMb: 20480, installedVersion: null, claude: "missing", glibc: "2.35",
};
const unknownKey: SshServerTest = { ...trusted, trusted: false, os: null, arch: null, freeMb: null, claude: null };
const savedSettings = { host: "saved.example.com", port: 2222, user: "ops", keyPath: "", auth: "password" as const };
const status: SshServerStatus = { link: "connected", host: "server.example.com", port: 22, user: "deploy", localUrl: "http://127.0.0.1:3456", version: "1.2.3", claude: "2.0.0", error: null, bundleAvailable: true };

function fakeIo(over: Partial<SshServerIo> = {}): SshServerIo & { targets: SshServerTarget[] } {
  const targets: SshServerTarget[] = [];
  return {
    targets,
    async test(target) { targets.push(target); return unknownKey; },
    async confirm() { return trusted; },
    async connect(target) { targets.push(target); return status; },
    async disconnect() { return { ...status, link: "stopped" }; },
    async status() { return status; },
    async stop() { return { ...status, link: "stopped" }; },
    async uninstall() { return { ...status, link: "off" }; },
    async saved() { return savedSettings; },
    async installKey() { return status; },
    async recent() { return []; },
    async forget() {},
    ...over,
  };
}

function filled(io: SshServerIo): SshServerModel {
  const m = new SshServerModel(io);
  m.setField("host", "server.example.com");
  m.setField("port", "22");
  m.setField("user", "deploy");
  m.setField("keyPath", "/home/deploy/.ssh/id_ed25519");
  return m;
}

test('model: password is not in getState() after connect("hunter2")', async () => {
  const m = filled(fakeIo({ async test() { return trusted; }, async connect() { return status; } }));
  await m.test();
  await m.confirmFingerprint();
  await m.test();
  const connected = await m.connect("hunter2");
  assert.equal(connected?.link, "connected");
  assert.equal(JSON.stringify(m.getState()).includes("hunter2"), false);
  assert.equal(Object.keys(m.getState()).includes("password"), false);
});

test("model: key auth with empty keyPath has field error keyPath; password auth with empty keyPath has none", () => {
  const m = filled(fakeIo());
  m.setField("keyPath", "");
  m.setAuth("key");
  assert.equal(m.validate(), false);
  assert.ok(m.getState().fieldErrors.keyPath);
  m.setAuth("password");
  assert.equal(m.validate(), true);
  assert.equal(m.getState().fieldErrors.keyPath, undefined);
});

test("validation: host, port, user are required and the port must be an integer from 1 to 65535", () => {
  const m = new SshServerModel(fakeIo());
  m.setAuth("password");
  m.setField("port", "");
  assert.equal(m.validate(), false);
  const errors = m.getState().fieldErrors;
  assert.ok(errors.host);
  assert.ok(errors.port);
  assert.ok(errors.user);
  m.setField("host", "server.example.com");
  m.setField("user", "deploy");
  m.setField("port", "70000");
  assert.equal(m.validate(), false);
  m.setField("port", "2222");
  assert.equal(m.validate(), true);
});

test("the target sent to the host has exactly the five non-secret fields", async () => {
  const io = fakeIo();
  const m = filled(io);
  m.setAuth("password");
  await m.test();
  assert.deepEqual(Object.keys(io.targets[0]).sort(), ["auth", "host", "keyPath", "port", "user"]);
  assert.equal(io.targets[0].auth, "password");
});

test('model: SSH_AUTH_FAILED maps to "The server refused this login."', async () => {
  const m = filled(fakeIo({ async test() { return trusted; }, async connect() { throw { code: "SSH_AUTH_FAILED", message: "raw host text" }; } }));
  await m.test();
  await m.connect("wrong");
  assert.equal(m.getState().error, "The server refused this login.");
  assert.equal(m.getState().status, null);
});

test("connect is refused until the host key of the last test is trusted; confirm then test again unlocks it", async () => {
  let confirmed = false;
  const m = filled(fakeIo({ async test() { return confirmed ? trusted : unknownKey; }, async confirm() { confirmed = true; return trusted; } }));
  await m.test();
  assert.equal(m.getState().test?.trusted, false);
  assert.equal(await m.connect(), null);
  assert.match(m.getState().error ?? "", /confirm the server's host key/);
  await m.confirmFingerprint();
  assert.equal(m.getState().test?.trusted, true);
  await m.test();
  assert.equal((await m.connect())?.link, "connected");
});

test("changing the host or the port clears the stored test result", async () => {
  const m = filled(fakeIo({ async test() { return trusted; } }));
  await m.test();
  assert.ok(m.getState().test);
  m.setField("user", "ops");
  assert.ok(m.getState().test, "a user change keeps the host-key result");
  m.setField("port", "2222");
  assert.equal(m.getState().test, null);
});

test("decoders reject wrong types and read an unknown link as failed", () => {
  assert.equal(decodeSshServerTest({ ...trusted, trusted: "yes" }), null);
  assert.equal(decodeSshServerTest({ ...trusted, freeMb: "20" }), null);
  assert.deepEqual(decodeSshServerTest(unknownKey), unknownKey);
  assert.equal(decodeSshServerStatus({ ...status, port: "22" }), null);
  assert.equal(decodeSshServerStatus({ ...status, link: "weird" })?.link, "failed");
  assert.equal(decodeSshServerStatus({ ...status, link: "off" })?.link, "off");
});

test("createSshServerIo sends the camelCase arguments and the password only as an argument", async () => {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const io = createSshServerIo(async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    if (command === "remote_ssh_server_connect") return status as unknown as T;
    if (command === "remote_ssh_server_confirm") return trusted as unknown as T;
    return status as unknown as T;
  });
  const target: SshServerTarget = { host: "server.example.com", port: 22, user: "deploy", keyPath: "", auth: "password" };
  await io.connect(target, "hunter2");
  await io.confirm(target, "ssh-ed25519", trusted.fingerprint);
  await io.disconnect();
  assert.deepEqual(calls[0], ["remote_ssh_server_connect", { target, password: "hunter2" }]);
  assert.deepEqual(calls[1], ["remote_ssh_server_confirm", { target, hostKeyType: "ssh-ed25519", fingerprint: trusted.fingerprint }]);
  assert.deepEqual(calls[2], ["remote_ssh_server_disconnect", undefined]);
});

test("error text: fixed sentences for the known codes, the host message otherwise", () => {
  assert.equal(sshServerErrorText({ code: "SSH_UNREACHABLE", message: "x" }), "Could not reach the server.");
  assert.equal(sshServerErrorText({ code: "SSH_DISK_LOW", message: "Not enough disk: 120 MB free." }), "Not enough disk: 120 MB free.");
});

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

test("model: a test answer that arrives after the host changed is dropped", async () => {
  const pending = deferred<SshServerTest>();
  const m = filled(fakeIo({ async test() { return pending.promise; } }));
  const running = m.test();
  m.setField("host", "other.example.com");
  pending.resolve(trusted);
  await running;
  assert.equal(m.getState().test, null);
  assert.equal(m.getState().busy, null);
  assert.equal(await m.connect(), null, "the old server's trust must not open the new host");
  assert.match(m.getState().error ?? "", /confirm the server's host key/);
});

test("model: any target field changed while a test runs drops its answer", async () => {
  for (const [field, value] of [["port", "2222"], ["user", "ops"], ["keyPath", "/home/ops/.ssh/id_ed25519"]] as const) {
    const pending = deferred<SshServerTest>();
    const m = filled(fakeIo({ async test() { return pending.promise; } }));
    const running = m.test();
    m.setField(field, value);
    pending.resolve(trusted);
    await running;
    assert.equal(m.getState().test, null, field);
  }
});

test("model: a confirmation answer that arrives after the host changed is dropped", async () => {
  const pending = deferred<SshServerTest>();
  const m = filled(fakeIo({ async confirm() { return pending.promise; } }));
  await m.test(); // untrusted, so there is something to confirm
  const running = m.confirmFingerprint();
  m.setField("host", "other.example.com");
  pending.resolve(trusted);
  await running;
  assert.equal(m.getState().test, null);
  assert.equal(m.getState().busy, null);
  assert.equal(await m.connect(), null);
});

test("model: a connect answer that arrives after the host changed is dropped", async () => {
  const pending = deferred<SshServerStatus>();
  const m = filled(fakeIo({ async test() { return trusted; }, async connect() { return pending.promise; } }));
  await m.test();
  const running = m.connect();
  m.setField("host", "other.example.com");
  pending.resolve(status);
  assert.equal(await running, null);
  assert.equal(m.getState().status, null);
  assert.equal(m.getState().busy, null);
});

const keyPathAfterInstall = "/Users/me/Library/Application Support/llmide/ssh/keys/saved_example_com_2222";

test("installKey: success reloads the saved settings so Key file and the generated key path show, and keeps no password", async () => {
  const calls: string[] = [];
  const m = filled(fakeIo({
    async installKey(password) { calls.push(`installKey:${password}`); return status; },
    async saved() { calls.push("saved"); return { ...savedSettings, host: "server.example.com", auth: "key", keyPath: keyPathAfterInstall }; },
  }));
  m.setAuth("password");
  const result = await m.installKey("hunter2");
  assert.equal(result?.link, "connected");
  assert.deepEqual(calls, ["installKey:hunter2", "saved"]);
  assert.equal(m.getState().auth, "key");
  assert.equal(m.getState().keyPath, keyPathAfterInstall);
  assert.equal(m.getState().error, null);
  assert.equal(JSON.stringify(m.getState()).includes("hunter2"), false);
});

test("installKey: a failure keeps the form on password login and shows the fixed sentence", async () => {
  const m = filled(fakeIo({ async installKey() { throw { code: "SSH_KEY_VERIFY_FAILED", message: "host text" }; } }));
  m.setAuth("password");
  assert.equal(await m.installKey("hunter2"), null);
  assert.equal(m.getState().error, "The server did not accept the new key. Your password login is unchanged.");
  assert.equal(m.getState().auth, "password");
});

test("installKey: the key codes read as fixed sentences", () => {
  assert.equal(sshServerErrorText({ code: "SSH_KEY_NOT_NEEDED", message: "x" }), "This server already uses a key.");
  assert.equal(sshServerErrorText({ code: "SSH_KEYGEN_FAILED", message: "x" }), "Could not create a key on this computer.");
  assert.equal(sshServerErrorText({ code: "SSH_KEY_INSTALL_FAILED", message: "x" }), "The key could not be added on the server.");
  assert.equal(sshServerErrorText({ code: "SSH_KEY_INVALID", message: "x" }), "The new key was not accepted.");
});

test("installKey: createSshServerIo passes the password only as an argument", async () => {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const io = createSshServerIo(async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    return status as unknown as T;
  });
  await io.installKey("hunter2");
  assert.deepEqual(calls[0], ["remote_ssh_server_install_key", { password: "hunter2" }]);
});

test("load: the saved target fills the form, with no test result yet", async () => {
  const m = new SshServerModel(fakeIo({ async saved() { return { ...savedSettings, auth: "key", keyPath: keyPathAfterInstall }; } }));
  await m.load();
  const s = m.getState();
  assert.equal(s.host, "saved.example.com");
  assert.equal(s.port, "2222");
  assert.equal(s.user, "ops");
  assert.equal(s.keyPath, keyPathAfterInstall);
  assert.equal(s.auth, "key");
  assert.equal(s.test, null);
});

test("load: a saved target that cannot be read leaves the form as it was", async () => {
  const m = new SshServerModel(fakeIo({ async saved() { throw new Error("no prefs"); } }));
  await m.load();
  assert.equal(m.getState().host, "");
  assert.equal(m.getState().error, null);
});

test("Trust this key calls confirmFingerprint then tests again", async () => {
  const order: string[] = [];
  const m = filled(fakeIo({
    async test(_target, password) { order.push(`test:${password ?? "-"}`); return order.length === 1 ? unknownKey : trusted; },
    async confirm(_target, type, fp) { order.push(`confirm:${type}:${fp}`); return trusted; },
  }));
  await m.test();
  await m.trustAndTest("hunter2");
  assert.deepEqual(order, ["test:-", `confirm:ssh-ed25519:${unknownKey.fingerprint}`, "test:hunter2"]);
  assert.equal(m.getState().test?.trusted, true);
});

test("connectWithTest tests first when the last test is missing, then connects only when the key is trusted", async () => {
  const order: string[] = [];
  const m = filled(fakeIo({
    async test() { order.push("test"); return trusted; },
    async connect(_target, password) { order.push(`connect:${password}`); return status; },
  }));
  const result = await m.connectWithTest("hunter2");
  assert.equal(result?.link, "connected");
  assert.deepEqual(order, ["test", "connect:hunter2"]);
});

test("connectWithTest does not connect when the host key is not trusted (for example it changed)", async () => {
  const order: string[] = [];
  const m = filled(fakeIo({
    async test() { order.push("test"); return { ...unknownKey, changed: true }; },
    async connect() { order.push("connect"); return status; },
  }));
  assert.equal(await m.connectWithTest("hunter2"), null);
  assert.deepEqual(order, ["test"]);
  assert.equal(m.getState().test?.changed, true);
});

test("uninstall: a typed name that does not match the target is refused before any host call", async () => {
  const calls: string[] = [];
  const m = filled(fakeIo({ async uninstall(_password, confirmHost) { calls.push(`uninstall:${confirmHost}`); return { ...status, link: "off" }; } }));
  assert.equal(await m.uninstall(undefined, "server"), null);
  assert.equal(await m.uninstall(undefined, ""), null);
  assert.deepEqual(calls, []);
  assert.equal(m.getState().error, "Type the server's host name to uninstall.");
});

test("uninstall: the typed name matches trimmed and case-insensitive, and the target host is what the host receives", async () => {
  const calls: string[] = [];
  const m = filled(fakeIo({ async uninstall(password, confirmHost) { calls.push(`uninstall:${password}:${confirmHost}`); return { ...status, link: "off" }; } }));
  const result = await m.uninstall("hunter2", "  SERVER.example.COM ");
  assert.equal(result?.link, "off");
  assert.deepEqual(calls, ["uninstall:hunter2:server.example.com"]);
  assert.equal(m.getState().error, null);
});

const foreignError = { code: "SSH_CORE_FOREIGN", message: "Another computer started the server on this account." };

test("stopServer sends the form's current target and force false, with no password when none is given", async () => {
  const calls: unknown[][] = [];
  const m = filled(fakeIo({ async stop(target, password, force) { calls.push([target, password, force]); return { ...status, link: "stopped" }; } }));
  m.setField("host", "edited.example.com");
  await m.stopServer();
  assert.deepEqual(calls, [[{ host: "edited.example.com", port: 22, user: "deploy", keyPath: "/home/deploy/.ssh/id_ed25519", auth: "key" }, undefined, false]]);
});

test("stopServer forwards the password for this call only, and force true when asked", async () => {
  const calls: unknown[][] = [];
  const m = filled(fakeIo({ async stop(_target, password, force) { calls.push([password, force]); return { ...status, link: "stopped" }; } }));
  await m.stopServer("hunter2", { force: true });
  assert.deepEqual(calls, [["hunter2", true]]);
  assert.equal(JSON.stringify(m.getState()).includes("hunter2"), false);
});

test("stopServer on a core another computer started records foreign: stop, and no error text", async () => {
  const m = filled(fakeIo({ async stop() { throw foreignError; } }));
  assert.equal(await m.stopServer(), null);
  assert.equal(m.getState().foreign, "stop");
  assert.equal(m.getState().error, null);
});

test("the forced stop sends force true, and a success clears foreign", async () => {
  const forces: boolean[] = [];
  const m = filled(fakeIo({ async stop(_target, _password, force) { forces.push(force); if (!force) throw foreignError; return { ...status, link: "stopped" }; } }));
  await m.stopServer();
  const result = await m.stopServer(undefined, { force: true });
  assert.deepEqual(forces, [false, true]);
  assert.equal(result?.link, "stopped");
  assert.equal(m.getState().foreign, null);
  assert.equal(m.getState().error, null);
});

test("uninstall on a foreign core records foreign: uninstall; the forced uninstall sends force true", async () => {
  const calls: unknown[][] = [];
  const m = filled(fakeIo({ async uninstall(password, confirmHost, force) { calls.push([password, confirmHost, force]); if (!force) throw foreignError; return { ...status, link: "off" }; } }));
  assert.equal(await m.uninstall("hunter2", "server.example.com"), null);
  assert.equal(m.getState().foreign, "uninstall");
  assert.equal(m.getState().error, null);
  const result = await m.uninstall("hunter2", "server.example.com", { force: true });
  assert.equal(result?.link, "off");
  assert.deepEqual(calls, [["hunter2", "server.example.com", false], ["hunter2", "server.example.com", true]]);
  assert.equal(m.getState().foreign, null);
});

test("a change of the target clears the foreign-core prompt; a status read does not", async () => {
  const m = filled(fakeIo({ async stop() { throw foreignError; } }));
  await m.stopServer();
  await m.refreshStatus();
  assert.equal(m.getState().foreign, "stop", "a background status read keeps the prompt");
  m.setField("user", "ops");
  assert.equal(m.getState().foreign, null);
  await m.stopServer();
  m.setAuth("password");
  assert.equal(m.getState().foreign, null);
});

test("dismissForeign clears the prompt without any host call", async () => {
  const calls: string[] = [];
  const m = filled(fakeIo({ async stop() { calls.push("stop"); throw foreignError; } }));
  await m.stopServer();
  m.dismissForeign();
  assert.equal(m.getState().foreign, null);
  assert.deepEqual(calls, ["stop"]);
});

test("createSshServerIo: stop and uninstall send force, and the password only as an argument", async () => {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const io = createSshServerIo(async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    return status as unknown as T;
  });
  const target: SshServerTarget = { host: "server.example.com", port: 22, user: "deploy", keyPath: "", auth: "password" };
  await io.stop(target, undefined, false);
  await io.stop(target, "hunter2", true);
  await io.uninstall("hunter2", "server.example.com", true);
  await io.uninstall(undefined, "server.example.com", false);
  assert.deepEqual(calls, [
    ["remote_ssh_server_stop", { target, force: false }],
    ["remote_ssh_server_stop", { target, password: "hunter2", force: true }],
    ["remote_ssh_server_uninstall", { confirmHost: "server.example.com", password: "hunter2", force: true }],
    ["remote_ssh_server_uninstall", { confirmHost: "server.example.com", force: false }],
  ]);
});

test("error text: the timeout and busy start read as fixed sentences; forward, glibc and mismatch show the host's message", () => {
  assert.equal(sshServerErrorText({ code: "SSH_TIMEOUT", message: "x" }), "The server did not answer in time.");
  assert.equal(sshServerErrorText({ code: "SSH_START_BUSY", message: "x" }), "The server is already starting. Try again in a moment.");
  const forward = "The local port for this server is in use. Quit the other program and connect again.";
  assert.equal(sshServerErrorText({ code: "SSH_FORWARD_FAILED", message: forward }), forward);
  const glibc = "This server's system libraries are too old for the standard server bundle (glibc 2.31; 2.34 needed). Build the compatible bundle and try again.";
  assert.equal(sshServerErrorText({ code: "SSH_GLIBC_TOO_OLD", message: glibc }), glibc);
  assert.equal(sshServerErrorText({ code: "confirm_mismatch", message: "Those are not the saved server's details." }), "Those are not the saved server's details.");
});

test("error text: a missing server bundle shows the host's sentence, which names the build command and folder", () => {
  const host = "This build has no Linux server bundle. Build it with: node desktop/scripts/stage-hub-core.mjs --compat-sqlite <module> (it is written to desktop/hub-dist/).";
  assert.equal(sshServerErrorText({ code: "SSH_BUNDLE_MISSING", message: host }), host);
  assert.equal(sshServerErrorText({ code: "SSH_BUNDLE_MISSING", message: "" }), "This build has no Linux server bundle.");
});

test("decodeSshServerTest: glibc is the version text when present; absent or a wrong type reads as null", () => {
  assert.equal(decodeSshServerTest({ ...trusted, glibc: "2.31" })?.glibc, "2.31");
  const { glibc: _absent, ...older } = trusted;
  assert.equal(decodeSshServerTest(older)?.glibc, null, "an older host build still decodes");
  assert.equal(decodeSshServerTest({ ...trusted, glibc: 231 })?.glibc, null);
  assert.equal(decodeSshServerTest({ ...trusted, glibc: "two" })?.glibc, null);
  assert.equal(decodeSshServerTest({ ...trusted, glibc: null })?.glibc, null);
});

test("a build without the server bundle disables SSH with a plain sentence; an older host reads as available", () => {
  const { bundleAvailable: _omit, ...older } = status;
  assert.equal(decodeSshServerStatus(older)?.bundleAvailable, true);
  assert.equal(decodeSshServerStatus({ ...status, bundleAvailable: false })?.bundleAvailable, false);
  assert.equal(sshBundleBlock({ ...status, bundleAvailable: false }), SSH_NO_BUNDLE_TEXT);
  assert.equal(sshBundleBlock(status), null);
  assert.equal(sshBundleBlock(null), null);
});
