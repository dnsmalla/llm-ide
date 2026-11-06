// Hosted issue writes (routes/issue-writes.mjs): the pure layer here; the route (host proof, allowlist, provider,
// audit) below in Task 3's tests. The provider is always faked (_setPinnedFetchForTests); no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.LLMIDE_JWT_SECRET = "a".repeat(48);
process.env.LLMIDE_VAULT_KEY = "b".repeat(48);
process.env.LLMIDE_HOST_APPROVAL_KEY = "c".repeat(64);
process.env.NODE_ENV = "test";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, "_issue-writes-test.db");
process.env.LLMIDE_DB_PATH = DB;

const { parseIssueWrite, providerCall, mapProviderFailure, onceForIdem, IDEM_TTL_MS, _resetIssueWriteIdemForTests } = await import("../routes/issue-writes.mjs");

const IDEM = "A".repeat(20);

test("parseIssueWrite accepts the three shapes and refuses everything outside the limits", () => {
  assert.deepEqual(parseIssueWrite("comment", { provider: "github", repo: "o/r", number: 7, body: "hi" }), { op: "comment", provider: "github", repo: "o/r", number: 7, body: "hi" });
  assert.deepEqual(parseIssueWrite("close", { provider: "gitlab", repo: "g/sub/p", number: 3 }), { op: "close", provider: "gitlab", repo: "g/sub/p", number: 3 });
  assert.deepEqual(parseIssueWrite("create", { provider: "github", repo: "o/r", title: "  T  ", idem: IDEM }), { op: "create", provider: "github", repo: "o/r", title: "T", body: "", idem: IDEM });
  const field = (op, b) => parseIssueWrite(op, b).error?.details?.field;
  assert.equal(field("close", { repo: "o/r", number: 1 }), "provider", "provider is required, no github default");
  assert.equal(field("close", { provider: "github", repo: "o/r/x", number: 1 }), "repo");
  assert.equal(field("close", { provider: "github", repo: "o/..", number: 1 }), "repo");
  assert.equal(field("close", { provider: "gitlab", repo: "g/../p", number: 1 }), "repo");
  assert.equal(field("close", { provider: "gitlab", repo: `g/${"p".repeat(200)}`, number: 1 }), "repo");
  assert.equal(field("close", { provider: "github", repo: "o/r", number: "7" }), "number");
  assert.equal(field("close", { provider: "github", repo: "o/r", number: 0 }), "number");
  assert.equal(field("comment", { provider: "github", repo: "o/r", number: 1, body: "  " }), "body");
  assert.equal(field("comment", { provider: "github", repo: "o/r", number: 1, body: "x".repeat(20_001) }), "body", "refused, never cut short");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "x".repeat(256), idem: IDEM }), "title");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "   ", idem: IDEM }), "title");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "T", body: 5, idem: IDEM }), "body");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "T", body: "x".repeat(20_001), idem: IDEM }), "body");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "T" }), "idem");
  assert.equal(field("create", { provider: "github", repo: "o/r", title: "T", idem: "short" }), "idem");
  assert.equal(parseIssueWrite("close", null).error.code, "VALIDATION_FAILED");
});

test("providerCall builds one fixed-host call per operation", () => {
  assert.deepEqual(providerCall({ op: "create", provider: "github", repo: "o/r", title: "T", body: "B" }), { url: "https://api.github.com/repos/o/r/issues", method: "POST", payload: { title: "T", body: "B" } });
  assert.deepEqual(providerCall({ op: "comment", provider: "github", repo: "o/r", number: 7, body: "c" }), { url: "https://api.github.com/repos/o/r/issues/7/comments", method: "POST", payload: { body: "c" } });
  assert.deepEqual(providerCall({ op: "close", provider: "github", repo: "o/r", number: 7 }), { url: "https://api.github.com/repos/o/r/issues/7", method: "PATCH", payload: { state: "closed" } });
  assert.deepEqual(providerCall({ op: "create", provider: "gitlab", repo: "g/sub/p", title: "T", body: "B" }), { url: "https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/issues", method: "POST", payload: { title: "T", description: "B" } });
  assert.deepEqual(providerCall({ op: "comment", provider: "gitlab", repo: "g/p", number: 3, body: "c" }), { url: "https://gitlab.com/api/v4/projects/g%2Fp/issues/3/notes", method: "POST", payload: { body: "c" } });
  assert.deepEqual(providerCall({ op: "close", provider: "gitlab", repo: "g/p", number: 3 }), { url: "https://gitlab.com/api/v4/projects/g%2Fp/issues/3", method: "PUT", payload: { state_event: "close" } });
});

test("mapProviderFailure never answers 401 and keeps token refusals apart from provider faults", () => {
  assert.deepEqual(mapProviderFailure("github", 401, { message: "Bad credentials" }), { status: 403, code: "TOKEN_UNAUTHORIZED", message: "Bad credentials" });
  assert.equal(mapProviderFailure("github", 403, {}).code, "TOKEN_FORBIDDEN");
  assert.equal(mapProviderFailure("github", 404, {}).code, "TOKEN_FORBIDDEN", "GitHub hides a repo the token cannot see behind 404");
  assert.deepEqual(mapProviderFailure("gitlab", 422, { message: { title: ["is too long"] } }), { status: 400, code: "PROVIDER_REJECTED", message: "GitLab answered 422." });
  assert.deepEqual(mapProviderFailure("github", 500, null), { status: 502, code: "PROVIDER_ERROR", message: "GitHub answered 500." });
  assert.equal(mapProviderFailure("github", 500, { message: "x".repeat(400) }).message.length, 300);
});

test("onceForIdem runs a create once per key, replays it, refuses other content and frees a failed key", async () => {
  _resetIssueWriteIdemForTests();
  const W = { op: "create", provider: "github", repo: "o/r", title: "T", body: "", idem: IDEM };
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = async () => { calls += 1; await gate; return { status: 200, body: { ok: true, id: 1, url: "https://github.com/o/r/issues/9", state: "open" } }; };
  const a = onceForIdem("u1", W, run, 1000);
  const b = onceForIdem("u1", W, run, 1001);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1, "a double click reaches the provider once");
  assert.equal(ra.body.deduped, false);
  assert.equal(rb.body.deduped, true);
  assert.equal(rb.body.url, ra.body.url);
  const conflict = await onceForIdem("u1", { ...W, title: "Other" }, run, 2000);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "IDEM_CONFLICT");
  assert.equal((await onceForIdem("u2", W, run, 2000)).body.deduped, false, "keys are per user");
  assert.equal(calls, 2);
  assert.equal((await onceForIdem("u1", W, run, 1000 + IDEM_TTL_MS + 1)).body.deduped, false, "the key expires");
  assert.equal(calls, 3);
  const failing = async () => { calls += 1; return { status: 502, body: { error: { code: "PROVIDER_ERROR", message: "x" } } }; };
  const W2 = { ...W, idem: "B".repeat(20) };
  assert.equal((await onceForIdem("u1", W2, failing, 5000)).status, 502);
  assert.equal((await onceForIdem("u1", W2, run, 5001)).body.deduped, false, "a failed attempt frees its key");
  assert.equal(calls, 5);
});
