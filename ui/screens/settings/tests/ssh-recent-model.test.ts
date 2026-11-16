import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SSH_RECENT_MAX,
  SshServerModel,
  UNAVAILABLE_SSH_IO,
  createSshServerIo,
  decodeSshRecentList,
  type SshInvoke,
  type SshRecentServer,
} from "../ssh-server-model.ts";
import type { SshServerTest } from "../host.ts";

const entry: SshRecentServer = { host: "server.example.com", port: 22, user: "deploy", keyPath: "/home/me/.ssh/id_ed25519", auth: "key", lastUsed: 1700000000000 };
/** A host stand-in whose answer is untyped, as the real host's is; the io decodes it. */
function fakeInvoke(fn: (command: string, args?: Record<string, unknown>) => Promise<unknown>): SshInvoke {
  return (command, args) => fn(command, args) as Promise<never>;
}

const trusted: SshServerTest = {
  hostKeyType: "ssh-ed25519", fingerprint: "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff", trusted: true, changed: false,
  os: "Linux", arch: "x86_64", freeMb: 20480, installedVersion: null, claude: "missing", glibc: "2.35",
};

test("decodeSshRecentList: a list of well-formed entries decodes; anything else reads as unreadable", () => {
  assert.deepEqual(decodeSshRecentList([entry]), [entry]);
  assert.deepEqual(decodeSshRecentList([]), []);
  assert.equal(decodeSshRecentList({ entries: [entry] }), null, "not an array");
  assert.equal(decodeSshRecentList([{ ...entry, auth: "token" }]), null, "unknown sign-in method");
  assert.equal(decodeSshRecentList([{ ...entry, port: 0 }]), null, "port below 1");
  assert.equal(decodeSshRecentList([{ ...entry, port: "22" }]), null, "port as text");
  assert.equal(decodeSshRecentList([{ ...entry, lastUsed: Number.NaN }]), null, "non-finite time");
  assert.equal(decodeSshRecentList([{ ...entry, keyPath: undefined }]), null, "missing key path");
  assert.equal(decodeSshRecentList([entry, null]), null, "one bad item makes the whole answer unreadable");
});

test("recent(): calls the host command and decodes the answer; an unknown or malformed answer rejects", async () => {
  const calls: string[] = [];
  const io = createSshServerIo(fakeInvoke(async (command) => { calls.push(command); return [entry]; }));
  assert.deepEqual(await io.recent(), [entry]);
  assert.deepEqual(calls, ["remote_ssh_server_recent"]);
  await assert.rejects(createSshServerIo(fakeInvoke(async () => ({ not: "a list" }))).recent());
  await assert.rejects(createSshServerIo(fakeInvoke(async () => { throw { code: "unknown_command", message: "" }; })).recent());
});

test("recent(): the list keeps at most ten servers, most recent first as the host sends them", async () => {
  assert.equal(SSH_RECENT_MAX, 10);
  const many = Array.from({ length: 12 }, (_, i) => ({ ...entry, host: `h${i}.example.com` }));
  const list = await createSshServerIo(fakeInvoke(async () => many)).recent();
  assert.equal(list.length, 10);
  assert.equal(list[0]?.host, "h0.example.com");
});

test("forget(): sends host, port and user only", async () => {
  const calls: Array<[string, unknown]> = [];
  const io = createSshServerIo(fakeInvoke(async (command, args) => { calls.push([command, args]); return undefined; }));
  await io.forget({ host: entry.host, port: entry.port, user: entry.user });
  assert.deepEqual(calls, [["remote_ssh_server_forget", { host: "server.example.com", port: 22, user: "deploy" }]]);
});

test("loadFrom(entry) fills the form, clears the last test, and holds no password", () => {
  const m = new SshServerModel(UNAVAILABLE_SSH_IO);
  m.loadFrom({ ...entry, host: "pw.example.com", port: 2222, user: "ops", keyPath: "", auth: "password" });
  const s = m.getState();
  assert.equal(s.host, "pw.example.com");
  assert.equal(s.port, "2222");
  assert.equal(s.user, "ops");
  assert.equal(s.auth, "password");
  assert.equal(s.test, null);
  assert.equal(m.target().port, 2222);
  assert.equal(Object.keys(s).includes("password"), false);
});

test("reset() empties the form but keeps the busy flag of an action still running", async () => {
  let release: () => void = () => {};
  const io = { ...UNAVAILABLE_SSH_IO, test: () => new Promise<SshServerTest>((resolve) => { release = () => resolve(trusted); }) };
  const m = new SshServerModel(io);
  m.loadFrom(entry);
  const pending = m.test();
  assert.equal(m.getState().busy, "test");
  m.reset();
  assert.equal(m.getState().host, "");
  assert.equal(m.getState().busy, "test", "reset must not let a second action start beside the running one");
  release();
  await pending;
  assert.equal(m.getState().busy, null);
});
