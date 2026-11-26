// The one-Connect SSH flow: the Keychain checkbox flags, the take-over answer, the host-key step folded into Connect,
// and the wire arguments. The password itself is only ever an argument; these tests pin that the saved one is never read
// back into the webview and that the flags reach the host command.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SshServerModel,
  SSH_TAKE_OVER_TEXT,
  decodeSshServerStatus,
  UNAVAILABLE_SSH_IO,
  createSshServerIo,
  decodeSshRecentList,
  sshServerErrorText,
  type SshPasswordOptions,
  type SshRecentServer,
  type SshServerIo,
} from "../ssh-server-model.ts";
import type { SshServerStatus, SshServerTest } from "../host.ts";

const trusted: SshServerTest = {
  hostKeyType: "ssh-ed25519", fingerprint: "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff", trusted: true, changed: false,
  os: "Linux", arch: "x86_64", freeMb: 20480, installedVersion: null, claude: "missing", glibc: "2.35",
};
const unknownKey: SshServerTest = { ...trusted, trusted: false, os: null, arch: null, freeMb: null, claude: null };
const connected: SshServerStatus = { link: "connected", host: "server.example.com", port: 22, user: "deploy", localUrl: "http://127.0.0.1:3456", version: "1.2.3", claude: "2.0.0", error: null, bundleAvailable: true };
const foreign = { code: "SSH_CORE_FOREIGN", message: "Another computer started the server on this account." };
const passwordEntry: SshRecentServer = { host: "pw.example.com", port: 2222, user: "ops", keyPath: "", auth: "password", lastUsed: 1, passwordSaved: true };

interface Call { command: string; password: string | undefined; options: SshPasswordOptions | undefined }

function fakeIo(calls: Call[], over: Partial<SshServerIo> = {}): SshServerIo {
  return {
    ...UNAVAILABLE_SSH_IO,
    async test(_t, password, options) { calls.push({ command: "test", password, options }); return trusted; },
    async confirm() { return trusted; },
    async connect(_t, password, options) { calls.push({ command: "connect", password, options }); return connected; },
    async status() { return connected; },
    async recent() { return []; },
    ...over,
  };
}

function key(io: SshServerIo): SshServerModel {
  const m = new SshServerModel(io);
  m.setField("host", "server.example.com");
  m.setField("user", "deploy");
  m.setField("keyPath", "/home/deploy/.ssh/id_ed25519");
  return m;
}

test("one Connect on a new key server: check, then connect, in that order, with no Test click", async () => {
  const calls: Call[] = [];
  const m = key(fakeIo(calls));
  const status = await m.connectWithTest();
  assert.equal(status?.link, "connected");
  assert.deepEqual(calls.map((c) => c.command), ["test", "connect"]);
  assert.equal(calls[0]?.options, undefined, "a key login carries no password flags");
});

test("an unknown host key stops Connect at the fingerprint; Trust then runs the rest of the flow", async () => {
  const calls: Call[] = [];
  let confirmed = 0;
  const answers = [unknownKey, trusted];
  const m = key(fakeIo(calls, {
    async test() { calls.push({ command: "test", password: undefined, options: undefined }); return answers.shift() ?? trusted; },
    async confirm() { confirmed += 1; return { ...trusted, os: null, arch: null, freeMb: null, claude: null }; },
  }));
  assert.equal(await m.connectWithTest(), null);
  assert.equal(m.getState().test?.trusted, false, "the fingerprint shows and waits for the user's click");
  assert.deepEqual(calls.map((c) => c.command), ["test"], "nothing was connected");
  const status = await m.trustAndConnect();
  assert.equal(confirmed, 1, "the key is trusted only by this click");
  assert.equal(status?.link, "connected");
  assert.deepEqual(calls.map((c) => c.command), ["test", "test", "connect"], "confirm, probe again for the facts, then connect");
});

test("trustAndConnect stops where it fails and never connects", async () => {
  const calls: Call[] = [];
  const m = key(fakeIo(calls, {
    async test() { return unknownKey; },
    async confirm() { throw { code: "cancelled", message: "The server's host key was not trusted, so nothing was saved." }; },
  }));
  await m.connectWithTest();
  assert.equal(await m.trustAndConnect(), null);
  assert.equal(calls.filter((c) => c.command === "connect").length, 0);
  assert.match(m.getState().error ?? "", /not trusted/);
});

test("password login: the typed password and the checkbox reach the host as flags; the password is not in the state", async () => {
  const calls: Call[] = [];
  const m = key(fakeIo(calls));
  m.setAuth("password");
  m.setRemember(true);
  await m.connectWithTest("hunter2");
  assert.deepEqual(calls.map((c) => [c.command, c.password, c.options]), [
    ["test", "hunter2", { remember: true }],
    ["connect", "hunter2", { remember: true }],
  ]);
  assert.equal(JSON.stringify(m.getState()).includes("hunter2"), false);
  assert.equal(m.getState().passwordSaved, true, "the saved flag follows the checkbox after a good sign-in");
});

test("a remembered password server connects with the useSaved flag and no password argument", async () => {
  const calls: Call[] = [];
  const m = new SshServerModel(fakeIo(calls));
  m.loadFrom(passwordEntry);
  assert.deepEqual([m.getState().passwordSaved, m.getState().rememberPassword], [true, true]);
  await m.connectWithTest();
  assert.deepEqual(calls.map((c) => [c.command, c.password, c.options]), [
    ["test", undefined, { useSaved: true, remember: true }],
    ["connect", undefined, { useSaved: true, remember: true }],
  ]);
});

test("unchecking the box on a later connect sends remember:false, and the saved flag clears after it worked", async () => {
  const calls: Call[] = [];
  const m = new SshServerModel(fakeIo(calls));
  m.loadFrom(passwordEntry);
  m.setRemember(false);
  await m.connectWithTest("typed");
  assert.deepEqual(calls[1]?.options, { remember: false });
  assert.equal(m.getState().passwordSaved, false);
});

test("a stored password belongs to one login: changing host, port or user drops the flag, the key path does not", () => {
  const m = new SshServerModel(UNAVAILABLE_SSH_IO);
  m.loadFrom(passwordEntry);
  m.setField("keyPath", "/x");
  assert.equal(m.getState().passwordSaved, true);
  m.setField("user", "other");
  assert.equal(m.getState().passwordSaved, false);
});

test("load() reads the saved-password flag from the recent list, never from the Keychain", async () => {
  const calls: Call[] = [];
  const m = new SshServerModel(fakeIo(calls, {
    async saved() { return { host: passwordEntry.host, port: passwordEntry.port, user: passwordEntry.user, keyPath: "", auth: "password" }; },
    async recent() { return [passwordEntry]; },
  }));
  await m.load();
  assert.equal(m.getState().passwordSaved, true);
});

test("SSH_CORE_FOREIGN on connect asks to take over; only an explicit take over repeats it with the flag", async () => {
  const calls: Call[] = [];
  let attempt = 0;
  const m = key(fakeIo(calls, {
    async connect(_t, password, options) {
      calls.push({ command: "connect", password, options });
      attempt += 1;
      if (attempt === 1) throw foreign;
      return connected;
    },
  }));
  assert.equal(await m.connectWithTest(), null);
  assert.equal(m.getState().foreign, "connect");
  assert.equal(m.getState().error, null, "the question replaces the error");
  assert.equal(calls.filter((c) => c.command === "connect")[0]?.options?.takeOver, undefined, "the first connect never takes over");
  const status = await m.connectWithTest(undefined, { takeOver: true });
  assert.equal(status?.link, "connected");
  assert.equal(calls.filter((c) => c.command === "connect")[1]?.options?.takeOver, true);
  assert.equal(m.getState().foreign, null);
});

test("Cancel on the take-over question sends nothing and clears it", async () => {
  const calls: Call[] = [];
  const m = key(fakeIo(calls, { async connect() { throw foreign; } }));
  await m.connectWithTest();
  const before = calls.length;
  m.dismissForeign();
  assert.equal(m.getState().foreign, null);
  assert.equal(calls.length, before);
});

test("the take-over text says what is stopped; where no Take over button exists the foreign code points to Welcome", () => {
  assert.match(SSH_TAKE_OVER_TEXT, /still running on this account \(another computer, or this one before its app data was reset\)\. Taking over stops it; any work running in it ends\./);
  const elsewhere = sshServerErrorText(foreign);
  assert.notEqual(elsewhere, SSH_TAKE_OVER_TEXT, "the startup and link paths have no Take over button to promise");
  assert.match(elsewhere, /Welcome.*Connect to SSH server.*Take over/);
});

test("wire: the flags are camelCase arguments added only when set, and a key login sends none", async () => {
  const sent: Array<[string, Record<string, unknown> | undefined]> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    sent.push([command, args]);
    return command === "remote_ssh_server_test" ? trusted : connected;
  }) as Parameters<typeof createSshServerIo>[0];
  const io = createSshServerIo(invoke);
  const target = { host: "h.example.com", port: 22, user: "u", keyPath: "", auth: "password" as const };
  await io.test(target, undefined, { useSaved: true, remember: true });
  await io.connect(target, "pw", { remember: false, takeOver: true });
  await io.connect({ ...target, auth: "key", keyPath: "/k" });
  assert.deepEqual(sent[0], ["remote_ssh_server_test", { target, useSavedPassword: true, rememberPassword: true }]);
  assert.deepEqual(sent[1], ["remote_ssh_server_connect", { target, password: "pw", rememberPassword: false, takeOver: true }]);
  assert.deepEqual(sent[2], ["remote_ssh_server_connect", { target: { ...target, auth: "key", keyPath: "/k" } }]);
});

test("the recent list decodes passwordSaved for a password login only; an older host's list reads as not saved", () => {
  const base = { host: "h.example.com", port: 22, user: "u", keyPath: "", lastUsed: 1 };
  const list = decodeSshRecentList([
    { ...base, auth: "password", passwordSaved: true },
    { ...base, auth: "password" },
    { ...base, auth: "key", keyPath: "/k", passwordSaved: true },
  ]);
  assert.deepEqual(list?.map((e) => e.passwordSaved), [true, false, false]);
});

const changedKey: SshServerTest = { ...unknownKey, changed: true };

test("a changed host key never sends the saved password: after Trust the password must be typed", async () => {
  const calls: Call[] = [];
  const answers = [changedKey, trusted, trusted];
  const m = new SshServerModel(fakeIo(calls, {
    async test(_t, password, options) { calls.push({ command: "test", password, options }); return answers.shift() ?? trusted; },
    async confirm() { return { ...trusted, os: null, arch: null, freeMb: null, claude: null }; },
  }));
  m.loadFrom(passwordEntry);
  assert.equal(await m.connectWithTest(), null, "the changed key stops Connect at the fingerprint");
  assert.equal(await m.trustAndConnect(), null, "Trust alone does not sign in");
  assert.equal(m.getState().passwordSaved, false, "the host forgot the saved password with the old pin");
  assert.match(m.getState().error ?? "", /Enter the password/);
  assert.deepEqual(calls.map((c) => c.command), ["test"], "no second test and no connect went out with useSaved");
  assert.ok(calls.every((c) => c.options?.useSaved !== undefined || c.command === "test"));
  const status = await m.connectWithTest("typed");
  assert.equal(status?.link, "connected");
  const connect = calls.find((c) => c.command === "connect");
  assert.equal(connect?.password, "typed");
  assert.equal(connect?.options?.useSaved, undefined, "the typed password is used, not the saved flag");
});

test("cancel while Connect runs drops the late answer: nothing for the form to act on", async () => {
  let release: (s: SshServerStatus) => void = () => undefined;
  const late = new Promise<SshServerStatus>((resolve) => { release = resolve; });
  const m = key(fakeIo([], { async connect() { return late; } }));
  const pending = m.connectWithTest();
  await Promise.resolve();
  await Promise.resolve();
  m.cancel();
  release({ ...connected, link: "restart_required" });
  assert.equal(await pending, null, "the form's finish gets null, so onRestartRequired is never called");
  assert.notEqual(m.getState().status?.link, "restart_required");
});

test("a Test never flips the saved flag: unticking the box changes it only after a good Connect", async () => {
  const calls: Call[] = [];
  const m = new SshServerModel(fakeIo(calls));
  m.loadFrom(passwordEntry);
  m.setRemember(false);
  await m.test();
  assert.equal(m.getState().passwordSaved, true, "the password is still stored after a Test");
  await m.connect();
  assert.equal(m.getState().passwordSaved, false);
});

test("a connect that worked but could not save to the Keychain shows the warning and keeps the connect", async () => {
  const warning = "Connected, but the password could not be saved in Keychain.";
  const m = new SshServerModel(fakeIo([], { async connect() { return { ...connected, warning }; } }));
  m.setField("host", "server.example.com");
  m.setField("user", "deploy");
  m.setAuth("password");
  m.setRemember(true);
  const status = await m.connectWithTest("typed");
  assert.equal(status?.link, "connected");
  assert.equal(m.getState().error, null, "the connect is not reported as failed");
  assert.equal(m.getState().status?.warning, warning);
  assert.equal(m.getState().passwordSaved, false, "no saved password is claimed");
  assert.equal(decodeSshServerStatus({ ...connected, warning })?.warning, warning);
  assert.equal(decodeSshServerStatus(connected)?.warning, undefined);
});

test("loading another login clears the previous connect's Keychain warning", async () => {
  const warning = "Connected, but the password could not be saved in Keychain.";
  const m = new SshServerModel(fakeIo([], { async connect() { return { ...connected, warning }; } }));
  m.setField("host", "server.example.com");
  m.setField("user", "deploy");
  m.setAuth("password");
  m.setRemember(true);
  await m.connectWithTest("typed");
  assert.equal(m.getState().status?.warning, warning);
  m.loadFrom(passwordEntry);
  assert.equal(m.getState().status?.warning, undefined);
  assert.equal(m.getState().status?.link, "connected", "the link state itself is kept");
});
