import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LOADED, MAX_PAGES } from "../issues-model.ts";
import { decodeIssuePage, issuesLoadError, loadIssuePages, pagingNote } from "../issue-paging.ts";

const row = (n: number) => ({
  id: String(n), title: `t${n}`, number: n, url: `https://github.com/o/r/issues/${n}`, provider: "github",
  repo: "o/r", state: "open", labels: [], isPR: false,
});

/** A core shaped like GET /kb/issues: honours limit (capped at 100) and offset, reports total/hasMore/nextOffset. */
function fakeCore(total: number, opts: { legacy?: boolean } = {}) {
  const calls: string[] = [];
  const request = async (_m: "GET", path: string) => {
    calls.push(path);
    const u = new URL(path, "http://127.0.0.1");
    const limit = Math.min(Number(u.searchParams.get("limit") ?? 20), 100);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const n = Math.max(0, Math.min(limit, total - offset));
    const issues = Array.from({ length: n }, (_, k) => row(offset + k + 1));
    const end = offset + n;
    if (opts.legacy) return { status: 200, body: { issues } };
    const hasMore = end < total;
    return { status: 200, body: { issues, total, hasMore, nextOffset: hasMore ? end : null } };
  };
  return { request, calls };
}

test("a page decodes total, hasMore and nextOffset; an old core without them is one final page", () => {
  const p = decodeIssuePage({ issues: [row(1), row(2)], total: 5, hasMore: true, nextOffset: 2 });
  assert.deepEqual([p.issues.length, p.raw, p.total, p.hasMore, p.nextOffset], [2, 2, 5, true, 2]);
  const legacy = decodeIssuePage({ issues: [row(1)] });
  assert.deepEqual([legacy.total, legacy.hasMore, legacy.nextOffset], [null, false, null]);
  assert.deepEqual(decodeIssuePage("nope").issues, []);
  // A malformed nextOffset or total is treated as absent, never as a real offset.
  const bad = decodeIssuePage({ issues: [], total: "5", hasMore: true, nextOffset: -3 });
  assert.deepEqual([bad.total, bad.nextOffset], [null, null]);
});

test("the walk pages with offset until hasMore is false; the first request keeps the old URL shape (no offset)", async () => {
  const core = fakeCore(250);
  const r = await loadIssuePages(core.request, { provider: "github", state: "open" }, {});
  assert.equal(r.issues.length, 250);
  assert.equal(r.stop, "end");
  assert.equal(r.total, 250);
  assert.deepEqual(core.calls, [
    "/kb/issues?provider=github&state=open&limit=100",
    "/kb/issues?provider=github&state=open&limit=100&offset=100",
    "/kb/issues?provider=github&state=open&limit=100&offset=200",
  ]);
});

test("the walk stops at the Mac's 20-page cap and says so: 2,000 of 4,212", async () => {
  assert.equal(MAX_PAGES, 20);
  assert.equal(MAX_LOADED, 2000);
  const core = fakeCore(4212);
  const r = await loadIssuePages(core.request, { provider: "github", state: "all" }, {});
  assert.equal(core.calls.length, 20);
  assert.equal(r.issues.length, MAX_LOADED);
  assert.equal(r.stop, "cap");
  assert.equal(r.total, 4212);
  assert.equal(pagingNote({ stop: r.stop, loaded: r.issues.length, total: r.total }), "Showing the first 2,000 of 4,212");
});

test("an old core with no total is one page, and its 100 rows are said to maybe be incomplete", async () => {
  const core = fakeCore(100, { legacy: true });
  const r = await loadIssuePages(core.request, { provider: "github", state: "all" }, {});
  assert.equal(core.calls.length, 1);
  assert.equal(r.stop, "end");
  assert.equal(r.total, null);
  assert.equal(pagingNote({ stop: r.stop, loaded: r.issues.length, total: r.total }), "The core did not report a total, so this list may be incomplete.");
  const few = await loadIssuePages(fakeCore(3, { legacy: true }).request, { provider: "github", state: "all" }, {});
  assert.equal(pagingNote({ stop: few.stop, loaded: few.issues.length, total: few.total }), "");
});

test("a page that repeats rows ends the walk; a non-advancing nextOffset cannot loop", async () => {
  const calls: string[] = [];
  const repeat = async (_m: "GET", path: string) => {
    calls.push(path);
    return { status: 200, body: { issues: Array.from({ length: 100 }, (_, k) => row(k + 1)), total: 500, hasMore: true, nextOffset: calls.length * 100 } };
  };
  const r = await loadIssuePages(repeat, { provider: "github", state: "all" }, {});
  assert.equal(calls.length, 2, "the second page is all duplicates, so the walk stops");
  assert.equal(r.issues.length, 100);
  assert.equal(r.stop, "end");

  const stuck = fakeCore(10);
  const stalled = async (m: "GET", path: string) => {
    const res = await stuck.request(m, path);
    return { ...res, body: { ...(res.body as object), hasMore: true, nextOffset: 0 } };
  };
  const s = await loadIssuePages(stalled, { provider: "github", state: "all" }, {});
  assert.equal(stuck.calls.length, 1, "nextOffset 0 on offset 0 does not advance: stop");
  assert.equal(s.stop, "end");
});

test("a failing later page keeps the rows already read and names the failure; a first-page failure has no rows", async () => {
  const core = fakeCore(250);
  let n = 0;
  const flaky = async (m: "GET", path: string) => {
    n += 1;
    if (n === 2) return { status: 500, body: null };
    return core.request(m, path);
  };
  const partial = await loadIssuePages(flaky, { provider: "github", state: "all" }, {});
  assert.equal(partial.stop, "error");
  assert.equal(partial.status, 500);
  assert.equal(partial.issues.length, 100);
  assert.equal(pagingNote({ stop: partial.stop, loaded: partial.issues.length, total: partial.total }), "Loaded 100 of 250; the next page could not be read.");

  const down = await loadIssuePages(async () => { throw new Error("offline"); }, { provider: "github", state: "all" }, {});
  assert.deepEqual([down.stop, down.status, down.issues.length], ["error", null, 0]);
  const unauth = await loadIssuePages(async () => ({ status: 401, body: null }), { provider: "github", state: "all" }, {});
  assert.deepEqual([unauth.stop, unauth.status], ["error", 401]);
});

test("cancelling stops the walk before the next request and reports progress per page", async () => {
  const core = fakeCore(350);
  const ctrl = new AbortController();
  const seen: string[] = [];
  const r = await loadIssuePages(core.request, { provider: "github", state: "all" }, {
    signal: ctrl.signal,
    onProgress: (p) => {
      seen.push(`${p.loaded}/${p.total}`);
      if (p.loaded === 200) ctrl.abort();
    },
  });
  assert.deepEqual(seen, ["100/350", "200/350"]);
  assert.equal(r.stop, "aborted");
  assert.equal(core.calls.length, 2, "no request is sent after the abort");
});

test("the loading note reads 'Loaded 300 of 4,212' while pages arrive", () => {
  assert.equal(pagingNote({ stop: null, loaded: 300, total: 4212 }), "Loaded 300 of 4,212");
  assert.equal(pagingNote({ stop: null, loaded: 0, total: null }), "Loading issues…");
  assert.equal(pagingNote({ stop: "end", loaded: 250, total: 250 }), "");
});

test("an abort while a page is in flight discards that page and sends nothing more", async () => {
  const core = fakeCore(350);
  const ctrl = new AbortController();
  const slow = async (m: "GET", path: string) => {
    const res = await core.request(m, path);
    if (core.calls.length === 2) ctrl.abort(); // a newer load starts while page 2 is on the wire
    return res;
  };
  const seen: number[] = [];
  const r = await loadIssuePages(slow, { provider: "github", state: "all" }, { signal: ctrl.signal, onProgress: (p) => seen.push(p.loaded) });
  assert.equal(r.stop, "aborted");
  assert.deepEqual(seen, [100], "page 2 arrived after the abort and is never reported");
  assert.equal(core.calls.length, 2);
});

test("rows shifted between pages by a concurrent import are de-duplicated, and a short read says the list changed", async () => {
  // Page 2 starts one row early (a row moved to the front during the walk): row 100 repeats, row 201 is never sent.
  const request = async (_m: "GET", path: string) => {
    const offset = Number(new URL(path, "http://127.0.0.1").searchParams.get("offset") ?? 0);
    const from = offset === 0 ? 1 : offset;
    const n = offset === 0 ? 100 : 100;
    const issues = Array.from({ length: n }, (_, k) => row(from + k));
    const hasMore = offset === 0;
    return { status: 200, body: { issues, total: 201, hasMore, nextOffset: hasMore ? 100 : null } };
  };
  const r = await loadIssuePages(request, { provider: "github", state: "all" }, {});
  assert.equal(r.issues.length, 199);
  assert.equal(new Set(r.issues.map((i) => i.id)).size, 199, "no row twice");
  assert.equal(r.stop, "end");
  assert.equal(pagingNote({ stop: r.stop, loaded: r.issues.length, total: r.total }), "Loaded 199 of 201; the list changed while it was read. Refresh to read it again.");
});

test("a row with neither id nor number gets an id that includes its page offset, so rows from different pages never collide", async () => {
  const anon = (k: number) => ({ title: `t${k}`, provider: "github", repo: "o/r", state: "open", labels: [], isPR: false });
  const request = async (_m: "GET", path: string) => {
    const offset = Number(new URL(path, "http://127.0.0.1").searchParams.get("offset") ?? 0);
    const n = offset === 0 ? 100 : 50;
    const hasMore = offset === 0;
    return { status: 200, body: { issues: Array.from({ length: n }, (_, k) => anon(offset + k)), total: 150, hasMore, nextOffset: hasMore ? 100 : null } };
  };
  const r = await loadIssuePages(request, { provider: "github", state: "all" }, {});
  assert.equal(r.issues.length, 150, "page 2 is not dropped as a repeat of page 1");
  assert.equal(new Set(r.issues.map((i) => i.id)).size, 150);
  assert.notEqual(decodeIssuePage({ issues: [anon(0)] }, 0).issues[0]!.id, decodeIssuePage({ issues: [anon(0)] }, 100).issues[0]!.id);
});

test("a 401 on a later page says sign in again and keeps the rows read so far, marked partial; a first-page 401 is the same message", async () => {
  const core = fakeCore(250);
  let n = 0;
  const expired = async (m: "GET", path: string) => {
    n += 1;
    if (n === 2) return { status: 401, body: null };
    return core.request(m, path);
  };
  const partial = await loadIssuePages(expired, { provider: "github", state: "all" }, {});
  assert.deepEqual([partial.stop, partial.status, partial.issues.length], ["error", 401, 100]);
  assert.equal(issuesLoadError(partial), "Sign in again to read issues.");
  assert.equal(pagingNote({ stop: partial.stop, loaded: partial.issues.length, total: partial.total }), "Loaded 100 of 250; the next page could not be read.");
  const first = await loadIssuePages(async () => ({ status: 401, body: null }), { provider: "github", state: "all" }, {});
  assert.equal(issuesLoadError(first), "Sign in again to read issues.");
});

test("the banner for a walk: a later-page 500 keeps only the count note; an outright failure names the cause", async () => {
  const core = fakeCore(250);
  let n = 0;
  const flaky = async (m: "GET", path: string) => {
    n += 1;
    if (n === 2) return { status: 500, body: null };
    return core.request(m, path);
  };
  const partial = await loadIssuePages(flaky, { provider: "github", state: "all" }, {});
  assert.equal(issuesLoadError(partial), null, "the count note already says the next page failed");
  const down = await loadIssuePages(async () => { throw new Error("offline"); }, { provider: "github", state: "all" }, {});
  assert.equal(issuesLoadError(down), "The core is not reachable right now.");
  const bad = await loadIssuePages(async () => ({ status: 500, body: null }), { provider: "github", state: "all" }, {});
  assert.equal(issuesLoadError(bad), "The core could not list issues (500).");
  const ok = await loadIssuePages(fakeCore(3).request, { provider: "github", state: "all" }, {});
  assert.equal(issuesLoadError(ok), null);
});
