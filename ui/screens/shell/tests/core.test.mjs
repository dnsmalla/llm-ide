import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { createCoreClient, CoreError, isAbortError, isLoopbackUrl } = await load("core.ts");

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = (n, ttl = 900) => ({ user: { id: "u1", email: "a@b.c", displayName: null }, accessToken: `acc${n}`, refreshToken: `ref${n}`, accessTokenTTLSec: ttl });

function setup(handler, extra = {}) {
  const calls = [];
  let t = 1_000_000;
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  const client = createCoreClient({ baseUrl: () => "http://127.0.0.1:3456", fetch, now: () => t, ...extra });
  return { client, calls, advance: (ms) => (t += ms) };
}

test("loopback guard", () => {
  assert.ok(isLoopbackUrl("http://127.0.0.1:3456"));
  assert.ok(isLoopbackUrl("http://localhost:1"));
  assert.ok(!isLoopbackUrl("http://evil.example:3456"));
  assert.ok(!isLoopbackUrl("http://127.0.0.1@evil.example"));
  assert.ok(!isLoopbackUrl("file:///etc/passwd"));
});

test("never sends credentials to a non-loopback base URL, and rejects bad paths", async () => {
  const { client, calls } = setup(() => json(200, {}), {});
  const bad = createCoreClient({ baseUrl: () => "http://evil.example", fetch: async () => json(200, {}) });
  await assert.rejects(bad.request("/x", { auth: false }), (e) => e.code === "UNSAFE_URL");
  for (const p of ["//evil.example/x", "http://evil.example/x", "x", "/a\nb"]) {
    await assert.rejects(client.request(p, { auth: false }), (e) => e.code === "BAD_REQUEST", p);
  }
  assert.equal(calls.length, 0);
});

test("login keeps tokens out of the snapshot, then requests carry the bearer", async () => {
  const { client, calls } = setup((url) => (url.endsWith("/auth/login") ? json(200, session(1)) : json(200, { ok: true })));
  const snap = await client.login("a@b.c", "pw");
  assert.deepEqual(snap, { signedIn: true, user: { id: "u1", email: "a@b.c", displayName: null } });
  assert.ok(!JSON.stringify(client.getSnapshot()).includes("acc1"));
  await client.request("/kb/x");
  assert.equal(calls[1].init.headers.Authorization, "Bearer acc1");
  assert.equal(calls[1].init.credentials, "omit");
});

test("request without a session fails closed with NO_SESSION", async () => {
  const { client, calls } = setup(() => json(200, {}));
  await assert.rejects(client.request("/kb/x"), (e) => e.code === "NO_SESSION" && e.status === 401);
  assert.equal(calls.length, 0);
});

test("proactive refresh before expiry, single-flight across concurrent requests", async () => {
  let refreshes = 0;
  const { client, calls, advance } = setup(async (url) => {
    if (url.endsWith("/auth/login")) return json(200, session(1, 60));
    if (url.endsWith("/auth/refresh")) {
      refreshes++;
      await new Promise((r) => setTimeout(r, 10));
      return json(200, { accessToken: "acc2", refreshToken: "ref2", accessTokenTTLSec: 900 });
    }
    return json(200, {});
  });
  await client.login("a@b.c", "pw");
  advance(40_000); // 20 s left, inside the 30 s skew
  await Promise.all([client.request("/a"), client.request("/b"), client.request("/c")]);
  assert.equal(refreshes, 1);
  assert.ok(calls.filter((c) => !c.url.includes("/auth/")).every((c) => c.init.headers.Authorization === "Bearer acc2"));
  assert.equal(client.getSnapshot().user.id, "u1", "user kept when refresh omits it");
  const refreshCall = calls.find((c) => c.url.endsWith("/auth/refresh"));
  assert.equal(JSON.parse(refreshCall.init.body).refreshToken, "ref1");
});

test("a 401 triggers one refresh and one retry; a failed refresh signs out", async () => {
  let n = 0;
  const { client } = setup((url) => {
    if (url.endsWith("/auth/login")) return json(200, session(1));
    if (url.endsWith("/auth/refresh")) return json(200, { accessToken: "acc2", refreshToken: "ref2", accessTokenTTLSec: 900 });
    return ++n === 1 ? json(401, { error: { code: "AUTH_REQUIRED", message: "no" } }) : json(200, { ok: 1 });
  });
  await client.login("a@b.c", "pw");
  assert.deepEqual(await client.request("/kb/x"), { ok: 1 });

  const { client: c2 } = setup((url) => {
    if (url.endsWith("/auth/login")) return json(200, session(1));
    if (url.endsWith("/auth/refresh")) return json(401, { error: { code: "AUTH_REQUIRED", message: "revoked" } });
    return json(401, {});
  });
  await c2.login("a@b.c", "pw");
  await assert.rejects(c2.request("/kb/x"), (e) => e.code === "SESSION_EXPIRED");
  assert.equal(c2.getSnapshot().signedIn, false);
});

test("a transient refresh failure (5xx) keeps the session", async () => {
  const { client, advance } = setup((url) => {
    if (url.endsWith("/auth/login")) return json(200, session(1, 31));
    if (url.endsWith("/auth/refresh")) return json(503, { error: { code: "UNAVAILABLE", message: "later" } });
    return json(200, {});
  });
  await client.login("a@b.c", "pw");
  advance(5_000);
  await assert.rejects(client.request("/kb/x"), (e) => e.code === "UNAVAILABLE");
  assert.equal(client.getSnapshot().signedIn, true);
});

test("error envelopes and non-JSON errors become CoreError", async () => {
  const { client } = setup((url) => (url.endsWith("/a") ? json(409, { error: { code: "CONFLICT", message: "dup" } }) : new Response("<html>", { status: 502 })));
  await assert.rejects(client.request("/a", { auth: false }), (e) => e instanceof CoreError && e.status === 409 && e.code === "CONFLICT" && e.message === "dup");
  await assert.rejects(client.request("/b", { auth: false }), (e) => e.status === 502 && e.code === "HTTP_ERROR");
});

test("abort: caller abort rejects with ABORTED and reaches fetch; timeout rejects with TIMEOUT", async () => {
  const abortErr = () => Object.assign(new Error("x"), { name: "AbortError" });
  const hang = (_u, init) =>
    new Promise((_res, rej) => {
      if (init.signal.aborted) rej(abortErr());
      init.signal.addEventListener("abort", () => rej(abortErr()));
    });
  const { client } = setup(hang);
  const ctl = new AbortController();
  const p = client.request("/slow", { auth: false, signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (e) => isAbortError(e));
  await assert.rejects(client.request("/slow", { auth: false, timeoutMs: 20 }), (e) => e.code === "TIMEOUT");
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(client.request("/slow", { auth: false, signal: pre.signal }), (e) => isAbortError(e));
});

test("logout clears locally even if the server is down", async () => {
  const { client } = setup((url) => {
    if (url.endsWith("/auth/login")) return json(200, session(1));
    throw new TypeError("down");
  });
  await client.login("a@b.c", "pw");
  let notified = 0;
  client.subscribe(() => notified++);
  await client.logout();
  assert.equal(client.getSnapshot().signedIn, false);
  assert.equal(notified, 1);
});

const sseResponse = (chunks, status = 200) => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
};

test("stream yields decoded events (multi-byte split) with Accept and Last-Event-ID", async () => {
  const bytes = new TextEncoder().encode('data: {"t":"h\u00e9llo"}\n\n');
  const mk = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes.slice(0, 15));
          c.enqueue(bytes.slice(15));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const { client, calls } = setup((url) => (url.endsWith("/auth/login") ? json(200, session(1)) : mk()));
  await client.login("a@b.c", "pw");
  const got = [];
  for await (const ev of client.stream("/s", { lastEventId: "41", method: "POST", body: { q: 1 } })) got.push(ev);
  assert.deepEqual(got.map((e) => JSON.parse(e.data).t), ["h\u00e9llo"]);
  const h = calls[1].init.headers;
  assert.equal(h.Accept, "text/event-stream");
  assert.equal(h["Last-Event-ID"], "41");
  assert.equal(h.Authorization, "Bearer acc1");
  assert.equal(calls[1].init.body, '{"q":1}');
});

test("stream: HTTP error throws before yielding; abort mid-stream throws ABORTED and cancels the reader", async () => {
  const { client } = setup((url) => (url.endsWith("/auth/login") ? json(200, session(1)) : json(500, { error: { code: "BOOM", message: "x" } })));
  await client.login("a@b.c", "pw");
  await assert.rejects(client.stream("/s").next(), (e) => e.code === "BOOM");

  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: 1\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const { client: c2 } = setup((url) => (url.endsWith("/auth/login") ? json(200, session(1)) : new Response(body)));
  await c2.login("a@b.c", "pw");
  const ctl = new AbortController();
  const it = c2.stream("/s", { signal: ctl.signal });
  assert.equal((await it.next()).value.data, "1");
  ctl.abort();
  await assert.rejects(it.next(), (e) => isAbortError(e));
  assert.ok(cancelled);
});
