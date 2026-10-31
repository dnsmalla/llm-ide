// TauriChatStore against the in-memory host (fake-host.mjs): ids, paging by seq, header-only rename, serialised
// appends, one retry after a conflict, error mapping. No server needed.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDir } from "../../../../../desktop/scripts/test-outdir.mjs";
import { createFakeChatHost } from "./fake-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const require = createRequire(join(REPO, "desktop/package.json"));
let m;
before(async () => {
  const { build } = require("esbuild");
  const outfile = join(bundleDir("shell-e2e-ts"), "entry.mjs");
  await build({ entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") } });
  m = await import(`${outfile}?t=${Date.now()}`);
});

async function boundStore() {
  const host = createFakeChatHost();
  await host.invoke("chat_bind_session", { token: "x".repeat(20) });
  return { host, store: new m.TauriChatStore({ invoke: host.invoke, ready: async () => {}, now: () => 1_800_000_000_000 }) };
}

test("concurrent appends are serialised: no conflict, order kept, seq = index + 1", async () => {
  const { store } = await boundStore();
  const s = await store.createSession({ title: "t" });
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.appendMessage(s.id, { role: i % 2 ? "assistant" : "user", content: `m${i}` })));
  const page = await store.loadMessages(s.id, { limit: 100 });
  assert.deepEqual(page.messages.map((x) => x.content), Array.from({ length: 12 }, (_, i) => `m${i}`));
  assert.deepEqual(page.messages.map((x) => x.seq), Array.from({ length: 12 }, (_, i) => i + 1));
});

test("paging by seq: newest page first, then the messages just older than the cursor", async () => {
  const { store } = await boundStore();
  const s = await store.createSession({});
  for (let i = 0; i < 25; i++) await store.appendMessage(s.id, { role: "user", content: `m${i}` });
  const newest = await store.loadMessages(s.id, { limit: 10 });
  assert.deepEqual(newest.messages.map((x) => x.seq), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  assert.equal(newest.hasMore, true);
  const older = await store.loadMessages(s.id, { limit: 10, beforeSeq: 16 });
  assert.deepEqual(older.messages.map((x) => x.seq), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const oldest = await store.loadMessages(s.id, { limit: 10, beforeSeq: 6 });
  assert.deepEqual(oldest.messages.map((x) => x.seq), [1, 2, 3, 4, 5]);
  assert.equal(oldest.hasMore, false);
});

test("rename is a header-only update that keeps the messages and the scope", async () => {
  const { store, host } = await boundStore();
  const s = await store.createSession({ title: "old" });
  await store.appendMessage(s.id, { role: "user", content: "hi" });
  await store.renameSession(s.id, "new title");
  const doc = host.files.get(s.id).doc;
  assert.equal(doc.title, "new title");
  assert.equal(doc.messages.length, 1);
  assert.equal(doc.scope, "explorer");
  assert.equal((await store.listSessions({ limit: 5, offset: 0 }))[0].title, "new title");
});

test("a write by another process (the Mac app) is one retried conflict, not a lost or failed message", async () => {
  const { store, host } = await boundStore();
  const s = await store.createSession({});
  await store.appendMessage(s.id, { role: "user", content: "a" });
  host.bumpExternally(s.id); // revision changed behind our back
  await store.appendMessage(s.id, { role: "assistant", content: "b" });
  assert.deepEqual((await store.loadMessages(s.id, { limit: 10 })).messages.map((x) => x.content), ["a", "b"]);
  assert.equal(host.calls.filter((c) => c.command === "chat_save").length >= 4, true);
});

test("host errors map to the shapes the UI handles; an unbound host is a 503, never a silent success", async () => {
  const host = createFakeChatHost(); // not bound
  const store = new m.TauriChatStore({ invoke: host.invoke, ready: async () => {} });
  await assert.rejects(store.listSessions({ limit: 5, offset: 0 }), (e) => e.status === 503 && e.code === "NOT_BOUND");
  await host.invoke("chat_bind_session", { token: "x".repeat(20) });
  await assert.rejects(store.loadMessages("AAAAAAAA-0000-4000-8000-000000000009", { limit: 5 }), (e) => e.status === 404);
});

test("timestamps convert between Apple reference seconds and epoch seconds", async () => {
  const { store } = await boundStore();
  const s = await store.createSession({});
  const [row] = await store.listSessions({ limit: 5, offset: 0 });
  assert.equal(row.id, s.id);
  assert.ok(Math.abs(row.createdAt - 1_800_000_000) < 5, `createdAt ${row.createdAt}`);
});

async function chatWith(store, host, n) {
  const s = await store.createSession({ title: "big" });
  for (let i = 0; i < n; i++) await store.appendMessage(s.id, { role: i % 2 ? "assistant" : "user", content: `m${i}` });
  return s;
}

test("a declined delete is a clean DECLINED cancel: chat stays, nothing is retried", async () => {
  const { store, host } = await boundStore();
  const s = await store.createSession({ title: "keep" });
  host.knobs.declineDelete = true;
  await assert.rejects(store.deleteSession(s.id), (e) => m.isDeclined(e) && e.message === "Cancelled");
  assert.equal(host.calls.filter((c) => c.command === "chat_delete").length, 1);
  assert.equal(host.files.has(s.id), true);
  assert.equal((await store.listSessions({ limit: 5, offset: 0 })).length, 1);
});

test("a Replace that drops more than half of a chat over 4 messages confirms first and passes the token", async () => {
  const { store, host } = await boundStore();
  const s = await chatWith(store, host, 8);
  await store.replaceMessages(s.id, [{ role: "user", content: "only" }]);
  const cmds = host.calls.map((c) => c.command);
  assert.ok(cmds.indexOf("chat_confirm_truncate") > -1 && cmds.indexOf("chat_confirm_truncate") < cmds.lastIndexOf("chat_save"));
  const confirm = host.calls.find((c) => c.command === "chat_confirm_truncate");
  assert.deepEqual(confirm.args.args, { id: s.id, newCount: 1 });
  assert.match(host.calls.at(-1).args.args.allowTruncate, /^tok/);
  assert.equal(host.files.get(s.id).doc.messages.length, 1);
});

test("a declined truncate confirm saves nothing and is not retried; small shrinks skip the dialog", async () => {
  const { store, host } = await boundStore();
  const s = await chatWith(store, host, 8);
  host.knobs.declineTruncate = true;
  await assert.rejects(store.replaceMessages(s.id, []), (e) => m.isDeclined(e));
  assert.equal(host.files.get(s.id).doc.messages.length, 8);
  assert.equal(host.calls.filter((c) => c.command === "chat_confirm_truncate").length, 1);
  assert.equal(m.needsTruncateConfirm(8, 4), false);
  assert.equal(m.needsTruncateConfirm(8, 3), true);
  assert.equal(m.needsTruncateConfirm(4, 0), false);
  const before = host.calls.filter((c) => c.command === "chat_confirm_truncate").length;
  await store.replaceMessages(s.id, host.files.get(s.id).doc.messages.slice(0, 5));
  assert.equal(host.calls.filter((c) => c.command === "chat_confirm_truncate").length, before);
});

test("pending_corrupt on save or delete shows the non-alarming bookkeeping notice, never raw host text", async () => {
  const { store, host } = await boundStore();
  const s = await store.createSession({ title: "x" });
  host.knobs.pendingCorrupt = true;
  await assert.rejects(store.deleteSession(s.id), (e) => m.isPendingCorrupt(e) && e.message === m.PENDING_CORRUPT_NOTICE);
  await assert.rejects(store.appendMessage(s.id, { role: "user", content: "a" }), (e) => m.isPendingCorrupt(e) && !/raw host/.test(e.message));
  assert.match(m.PENDING_CORRUPT_NOTICE, /core\.log \/ Settings > Diagnostics/);
});

test("unreadable and unsupported files are counted and worded, never hidden", async () => {
  const { store, host } = await boundStore();
  await store.createSession({});
  assert.equal(m.unreadableNotice(store.listHealth()), null);
  host.knobs.unreadable = 2;
  host.knobs.unsupported = 1;
  await store.listSessions({ limit: 5, offset: 0 });
  assert.deepEqual(store.listHealth(), { unreadable: 2, unsupported: 1 });
  const text = m.unreadableNotice(store.listHealth());
  assert.match(text, /2 chats could not be read \(not touched\)/);
  assert.match(text, /1 chat uses a format this version does not read/);
});
