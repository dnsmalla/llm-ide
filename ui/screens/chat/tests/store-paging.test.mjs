// HttpChatStore paging over core API 97 (beforeSeq / hasMore): O(page), no dead end, fixtures decoded.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, fakeCore, REPO } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("store-paging"); });
const fx = (name) => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/agent", name), "utf8"));

/** A core with `n` stored messages answering the real query contract. */
function pagingCore(n) {
  const all = Array.from({ length: n }, (_, i) => ({ seq: i + 1, role: i % 2 ? "assistant" : "user", content: `m${i + 1}`, meta: null, createdAt: 1 }));
  const reads = [];
  const core = fakeCore({ json: { "GET /kb/chat/sessions/s1": (_b, path) => {
    const q = new URLSearchParams(path.split("?")[1]);
    const limit = Math.min(2000, Number(q.get("limit") ?? 200));
    const before = q.has("beforeSeq") ? Number(q.get("beforeSeq")) : Infinity;
    const older = all.filter((m) => m.seq < before);
    const page = older.slice(Math.max(0, older.length - limit));
    reads.push({ limit, before, returned: page.length });
    return { session: { id: "s1", messages: page, hasMore: older.length > page.length } };
  } } });
  return { core, reads };
}

test("older pages never re-read the newest N and there is no dead end past 2,000 messages", async () => {
  const { core, reads } = pagingCore(5000);
  const store = new c.HttpChatStore(core);
  let page = await store.loadMessages("s1", { limit: 100 });
  const seen = new Set(page.messages.map((m) => m.seq));
  assert.equal(page.messages.at(-1).seq, 5000);
  let pages = 1;
  while (page.hasMore) {
    page = await store.loadMessages("s1", { limit: 100, beforeSeq: page.messages[0].seq });
    for (const m of page.messages) { assert.equal(seen.has(m.seq), false, `seq ${m.seq} repeated`); seen.add(m.seq); }
    pages++;
  }
  assert.equal(seen.size, 5000, "all 5,000 messages are reachable (the old design stopped at 2,000)");
  assert.equal(pages, 50);
  assert.ok(reads.every((r) => r.limit === 100 && r.returned <= 100), "every read is one page: O(page), never a larger newest-N read");
  assert.ok(core.calls.every((x) => !/limit=(?!100\b)/.test(x.path)));
});

test("an older core that ignores beforeSeq cannot repeat a page; a malformed row is skipped", async () => {
  const rows = [{ seq: 1, role: "user", content: "a" }, { seq: 2, role: "assistant", content: "b" }, { seq: "x", role: "user", content: "bad" }, { seq: 3, role: "tool", content: "bad" }, { seq: 4, role: "user", content: 5 }];
  const store = new c.HttpChatStore(fakeCore({ json: { "GET /kb/chat/sessions/s1": { session: { messages: rows } } } }));
  const newest = await store.loadMessages("s1", { limit: 10 });
  assert.deepEqual(newest.messages.map((m) => m.seq), [1, 2]);
  const older = await store.loadMessages("s1", { limit: 10, beforeSeq: 2 });
  assert.deepEqual(older.messages.map((m) => m.seq), [1], "rows at or above the cursor are dropped");
});

test("the schema fixtures decode: newest page with hasMore, the older page, and an empty chat", async () => {
  const more = fx("get-kb-chat-sessions-id-200-more.json");
  const older = fx("get-kb-chat-sessions-id-200-older.json");
  const empty = fx("get-kb-chat-sessions-id-200-empty.json");
  const run = async (f, opts) => new c.HttpChatStore(fakeCore({ json: { [`GET /kb/chat/sessions/${f.request.params.id}`]: f.response } })).loadMessages(f.request.params.id, opts);
  const a = await run(more, { limit: 1 });
  assert.deepEqual([a.messages.map((m) => m.seq), a.hasMore], [[2], true]);
  const b = await run(older, { limit: 1, beforeSeq: 2 });
  assert.deepEqual([b.messages.map((m) => m.seq), b.hasMore], [[1], false]);
  const e = await run(empty, { limit: 50 });
  assert.deepEqual([e.messages.length, e.hasMore], [0, false]);
  assert.equal(c.toMessages(a.messages)[0].role, "assistant");
});

test("the query carries limit (capped at the server's 2,000) and beforeSeq", async () => {
  const core = fakeCore({ json: { "GET /kb/chat/sessions/a%20b": { session: { messages: [], hasMore: false } } } });
  const store = new c.HttpChatStore(core);
  await store.loadMessages("a b", { limit: 99999 });
  await store.loadMessages("a b", { limit: 50, beforeSeq: 77 });
  assert.equal(core.calls[0].path, "/kb/chat/sessions/a%20b?limit=2000");
  assert.equal(core.calls[1].path, "/kb/chat/sessions/a%20b?limit=50&beforeSeq=77");
});
