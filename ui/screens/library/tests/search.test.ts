import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSearchHits, makeSearchRun, normalizeQuery, SearchController, SearchRequestError, searchPath, type SearchHit, type SearchState } from "../search.ts";

/** Manual clock and a request whose answers the test controls. */
function harness(over: { run?: (q: string, signal: AbortSignal) => Promise<SearchHit[]> } = {}) {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const states: SearchState[] = [];
  const calls: { q: string; signal: AbortSignal; resolve: (h: SearchHit[]) => void; reject: (e: unknown) => void }[] = [];
  const run =
    over.run ??
    ((q: string, signal: AbortSignal) =>
      new Promise<SearchHit[]>((resolve, reject) => {
        calls.push({ q, signal, resolve, reject });
      }));
  const c = new SearchController({
    run,
    onChange: (s) => states.push(s),
    debounceMs: 200,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  const tick = () => new Promise<void>((r) => setImmediate(r));
  return { c, states, calls, advance, tick, timers };
}

const hit = (rel: string): SearchHit => ({ rel, title: rel, snippet: "", date: "" });

test("debounce: typing fast fires one request for the last query", async () => {
  const h = harness();
  h.c.setQuery("bu");
  h.advance(100);
  h.c.setQuery("bud");
  h.advance(100);
  h.c.setQuery("budget");
  assert.equal(h.calls.length, 0);
  assert.equal(h.c.snapshot.phase, "debouncing");
  h.advance(199);
  assert.equal(h.calls.length, 0);
  h.advance(1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.q, "budget");
  assert.equal(h.c.snapshot.phase, "searching");
  h.calls[0]!.resolve([hit("a.md")]);
  await h.tick();
  assert.equal(h.c.snapshot.phase, "done");
  assert.deepEqual(h.c.snapshot.hits.map((x) => x.rel), ["a.md"]);
});

test("cancellation: a new query aborts the in-flight request and its late answer is ignored", async () => {
  const h = harness();
  h.c.setQuery("first");
  h.advance(200);
  const one = h.calls[0]!;
  h.c.setQuery("second");
  assert.equal(one.signal.aborted, true, "the previous request was aborted");
  h.advance(200);
  const two = h.calls[1]!;
  one.resolve([hit("stale.md")]); // arrives after being superseded
  await h.tick();
  assert.equal(h.c.snapshot.phase, "searching");
  assert.equal(h.c.snapshot.hits.length, 0);
  two.resolve([hit("fresh.md")]);
  await h.tick();
  assert.deepEqual(h.c.snapshot.hits.map((x) => x.rel), ["fresh.md"]);
});

test("an aborted request that rejects is silent (no error state)", async () => {
  const h = harness();
  h.c.setQuery("abort me");
  h.advance(200);
  const one = h.calls[0]!;
  h.c.clear();
  one.reject(new SearchRequestError(0));
  await h.tick();
  assert.equal(h.c.snapshot.phase, "idle");
  assert.equal(h.c.snapshot.error, null);
});

test("short or blank queries are idle: nothing is requested, pending work is cancelled", async () => {
  const h = harness();
  h.c.setQuery("budget");
  h.c.setQuery("b");
  h.advance(1000);
  assert.equal(h.calls.length, 0);
  assert.equal(h.c.snapshot.phase, "idle");
  assert.equal(h.timers.length, 0);
  h.c.setQuery("   ");
  assert.equal(h.c.snapshot.phase, "idle");
  assert.equal(normalizeQuery("  a   b \n c "), "a b c");
  assert.equal(normalizeQuery("x".repeat(500)).length, 200);
});

test("hits stay on screen while the next query is typed (no flicker)", async () => {
  const h = harness();
  h.c.setQuery("alpha");
  h.advance(200);
  h.calls[0]!.resolve([hit("a.md")]);
  await h.tick();
  h.c.setQuery("alphab");
  assert.equal(h.c.snapshot.phase, "debouncing");
  assert.deepEqual(h.c.snapshot.hits.map((x) => x.rel), ["a.md"]);
});

test("submit (Enter) skips the debounce", async () => {
  const h = harness();
  h.c.setQuery("budget");
  h.c.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.length, 0);
  h.c.submit(); // not debouncing any more: no second request
  assert.equal(h.calls.length, 1);
});

test("errors: 404 means unavailable and is remembered; 401, 500 and network map to short messages", async () => {
  const h = harness();
  h.c.setQuery("budget");
  h.advance(200);
  h.calls[0]!.reject(new SearchRequestError(404));
  await h.tick();
  assert.equal(h.c.snapshot.phase, "unavailable");
  h.c.setQuery("budgets");
  assert.equal(h.c.snapshot.phase, "unavailable", "no more requests while the route is missing");
  h.advance(500);
  assert.equal(h.calls.length, 1);
  h.c.reset();
  assert.equal(h.c.snapshot.phase, "debouncing", "reset asks again");
  h.advance(200);
  h.calls[1]!.reject(new SearchRequestError(401));
  await h.tick();
  assert.equal(h.c.snapshot.phase, "error");
  assert.match(h.c.snapshot.error!, /Sign in/);
  h.c.setQuery("again");
  h.advance(200);
  h.calls[2]!.reject(new SearchRequestError(500));
  await h.tick();
  assert.equal(h.c.snapshot.error, "Search failed. Try again.");
  h.c.setQuery("net");
  h.advance(200);
  h.calls[3]!.reject(new Error("boom: secret detail"));
  await h.tick();
  assert.equal(h.c.snapshot.error, "The core is not reachable.");
  assert.ok(!JSON.stringify(h.states).includes("secret detail"));
});

test("dispose: no timers, no callbacks afterwards", async () => {
  const h = harness();
  h.c.setQuery("budget");
  h.advance(200);
  const n = h.states.length;
  h.c.dispose();
  h.calls[0]!.resolve([hit("a.md")]);
  await h.tick();
  h.c.setQuery("more");
  assert.equal(h.states.length, n);
  assert.equal(h.timers.length, 0);
});

test("decodeSearchHits: bad rows dropped, unsafe keys refused, tags stripped, bounded", () => {
  const rows = [
    { noteKey: "a/b.md", title: "<b>Budget</b> review", snippet: "x <mark>hit</mark> y", date: "2026-10-01", kind: "meeting" },
    { noteKey: "../etc/passwd", title: "evil" },
    { noteKey: "/abs.md", title: "evil" },
    { noteKey: "a//b.md", title: "evil" },
    { noteKey: "a\\b.md", title: "evil" },
    { noteKey: 5 },
    null,
    "str",
    { noteKey: "c.md" },
  ];
  const out = decodeSearchHits({ results: rows });
  assert.deepEqual(out.map((h) => h.rel), ["a/b.md", "c.md"]);
  assert.equal(out[0]!.title, "Budget review");
  assert.equal(out[0]!.snippet, "x hit y");
  assert.equal(out[1]!.title, "c.md");
  assert.deepEqual(decodeSearchHits(null), []);
  assert.deepEqual(decodeSearchHits({ results: "nope" }), []);
  assert.equal(decodeSearchHits({ results: Array.from({ length: 500 }, (_, i) => ({ noteKey: `n${i}.md` })) }).length, 100);
});

test("makeSearchRun: builds an encoded path, maps statuses and transport errors", async () => {
  assert.equal(searchPath("a b&c=d/é", 500), "/kb/index/search?q=a%20b%26c%3Dd%2F%C3%A9&limit=100");
  const ac = new AbortController();
  const seen: string[] = [];
  const ok = makeSearchRun({ request: async (_m, path) => (seen.push(path), { status: 200, body: { results: [{ noteKey: "x.md", title: "X" }] } }) });
  assert.deepEqual((await ok("x y", ac.signal)).map((h) => h.rel), ["x.md"]);
  assert.equal(seen[0], "/kb/index/search?q=x%20y&limit=50");
  const nf = makeSearchRun({ request: async () => ({ status: 404, body: {} }) });
  await assert.rejects(nf("q", ac.signal), (e: unknown) => e instanceof SearchRequestError && e.status === 404);
  const down = makeSearchRun({ request: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(down("q", ac.signal), (e: unknown) => e instanceof SearchRequestError && e.status === 0);
});
