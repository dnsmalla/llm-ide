import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { scrubPath, createDiagnosticsLog, buildDiagnosticsReport, DIAGNOSTICS_CAPACITY } = await load("diagnostics.ts");
const host = await load("host.ts");

test("scrubPath drops the query and replaces id-looking segments", () => {
  assert.equal(scrubPath("/kb/notes?q=secret&token=abc"), "/kb/notes");
  assert.equal(scrubPath("/chat/3f2c9d1e-8a7b-4c5d-9e0f-1a2b3c4d5e6f/messages"), "/chat/:id/messages");
  assert.equal(scrubPath("/x/0123456789abcdef0123/y"), "/x/:id/y");
  assert.equal(scrubPath("/x/1234567/y"), "/x/:id/y");
  assert.equal(scrubPath("/u/me@example.com"), "/u/:id");
  assert.equal(scrubPath("/health#frag"), "/health");
  assert.equal(scrubPath("/kb/search"), "/kb/search");
});

test("the ring buffer keeps the last 50, newest last, and clears", () => {
  const log = createDiagnosticsLog();
  let fired = 0;
  log.subscribe(() => fired++);
  for (let i = 0; i < 60; i++) log.record({ method: "get", path: `/p${i}?x=1`, status: 200, result: "200", ms: i, at: i, trust: "spawned" });
  const e = log.entries();
  assert.equal(e.length, DIAGNOSTICS_CAPACITY);
  assert.equal(e[0].path, "/p10");
  assert.equal(e[49].path, "/p59");
  assert.equal(e[0].method, "GET");
  log.clear();
  assert.equal(log.entries().length, 0);
  assert.equal(fired, 61);
});

test("the report has the essentials and no secrets", () => {
  const status = host.normalizeCoreStatus({ url: "http://127.0.0.1:3457", state: "ready", trust: "spawned", pid: 99, restarts: 2, core_log_path: "/Users/x/core.log", foreign_core: { port: 3456, detected: true, pid: 5, command: "node" } });
  const log = createDiagnosticsLog();
  log.record({ method: "GET", path: "/auth/me?token=SECRET", status: 0, result: "UNTRUSTED_CORE", ms: 3, at: 1000, trust: "pending" });
  const text = buildDiagnosticsReport({ status, signedIn: true, appVersion: "1.2.3", entries: log.entries(), now: 6000 });
  for (const need of ["App version: 1.2.3", "Signed in: yes", "Core state: ready", "Core port: 3457", "Core trust: spawned", "Launch nonce verified: yes", "Foreign server on :3456: yes", "Restarts: 2", "Core log: /Users/x/core.log", "GET /auth/me  UNTRUSTED_CORE  3ms  trust=pending", "5s ago"]) {
    assert.ok(text.includes(need), need);
  }
  assert.ok(!text.includes("SECRET"));
  assert.ok(!text.includes("http://"));
  assert.ok(!text.includes("pid"));
  assert.match(buildDiagnosticsReport({ status: null, signedIn: false, appVersion: "d", entries: [] }), /no status from the host/);
});

const { createCoreClient, CoreError } = await load("core.ts");

test("the core client reports one outcome per request: status or code, never bodies or tokens", async () => {
  const seen = [];
  let mode = "ok";
  const fetchFn = async (url, init) => {
    if (mode === "net") throw new TypeError("Failed to fetch");
    if (String(url).endsWith("/auth/login")) return new Response(JSON.stringify({ accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", accessTokenTTLSec: 900 }), { status: 200 });
    return new Response(JSON.stringify({ secret: "BODY-SECRET" }), { status: 200 });
  };
  const c = createCoreClient({ baseUrl: () => "http://127.0.0.1:3457", fetch: fetchFn, onOutcome: (o) => seen.push(o), trustLabel: () => "spawned" });
  await assert.rejects(() => c.request("/kb/x?q=1"), (e) => e instanceof CoreError && e.code === "NO_SESSION");
  await c.login("a@b.c", "pw");
  await c.request("/kb/chats/3f2c9d1e-8a7b-4c5d-9e0f-1a2b3c4d5e6f?x=1");
  mode = "net";
  await assert.rejects(() => c.request("/kb/y"), (e) => e.code === "NETWORK");
  assert.deepEqual(seen.map((o) => o.result), ["NO_SESSION", "200", "NETWORK"]);
  assert.equal(seen[0].status, 401);
  assert.equal(seen[2].status, 0);
  assert.equal(seen[1].trust, "spawned");
  const dumped = JSON.stringify(seen);
  for (const bad of ["SECRET", "Bearer", "pw"]) assert.ok(!dumped.includes(bad), bad);
  // the diagnostics log scrubs the path further
  const log = createDiagnosticsLog();
  for (const o of seen) log.record(o);
  assert.equal(log.entries()[1].path, "/kb/chats/:id");
});
