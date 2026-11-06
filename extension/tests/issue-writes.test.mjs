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
// ---- the route (handleKB → gantt_issues → issue-schedule.mjs → issue-writes.mjs) ----
const db = await import("../kb/db.mjs");
const { handleKB } = await import("../routes/router.mjs");
const { setSecret } = await import("../server/vault.mjs");
const { _setPinnedFetchForTests } = await import("../server/pinned-fetch.mjs");
const users = await import("../server/users.mjs");
const { busHostProof } = await import("../core/host-approval.mjs");
const { indexTicketsJson } = await import("../connectors/issues.mjs");
const PROOF = busHostProof();

function reset() {
  _resetIssueWriteIdemForTests();
  db.closeDb();
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  db.getDb();
}
const user = (tag) => users.registerUser(db.getDb(), { email: `${tag}-${Date.now()}@example.com`, password: "CorrectHorseBattery", displayName: tag }).id;
function seed(u) {
  indexTicketsJson(u, { provider: "github", tickets: [
    { url: "https://github.com/o/r/issues/7", title: "Seven", meta: { repo: "o/r", number: 7, state: "open", isPR: false } },
    { url: "https://github.com/o/r/pull/8", title: "Eight", meta: { repo: "o/r", number: 8, state: "open", isPR: true } },
    { url: "https://github.com.evil.example/o/far/issues/1", title: "Look-alike", meta: { repo: "o/far", number: 1, state: "open" } },
  ] });
  indexTicketsJson(u, { provider: "gitlab", tickets: [
    { url: "https://gitlab.com/g/sub/p/-/issues/3", title: "Three", meta: { repo: "g/sub/p", number: 3, state: "opened" } },
    { url: "https://gitlab.internal.example/g/self/-/issues/1", title: "Self-hosted", meta: { repo: "g/self", number: 1, state: "opened" } },
  ] });
  setSecret(db.getDb(), u, "github.token", "ghp_secret_value_123456");
  setSecret(db.getDb(), u, "gitlab.token", "glpat_secret_value_12345");
}
function post(userId, url, body, { proof = PROOF } = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const headers = { "user-agent": "issue-writes-test", ...(proof ? { "x-llmide-host-nonce": proof } : {}) };
  const r = { method: "POST", url, user: { id: userId }, headers, socket: { remoteAddress: "127.0.0.1" }, on(ev, cb) { if (ev === "data") chunks.forEach(cb); else if (ev === "end") cb(); return r; } };
  return r;
}
function res() {
  return { statusCode: 200, headers: {}, body: "", writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, setHeader(k, v) { this.headers[k] = v; }, write(c) { this.body += c; }, end(c) { if (c) this.body += c; } };
}
async function call(userId, url, body, opts) {
  const out = res();
  await handleKB(post(userId, url, body, opts), out);
  return { status: out.statusCode, body: JSON.parse(out.body), raw: out.body };
}
const auditRows = (u) => db.getDb().prepare("SELECT action, resource, outcome, detail FROM audit_log WHERE user_id = ? ORDER BY id").all(u);
function fakeProvider(answer) {
  const seen = [];
  _setPinnedFetchForTests(async (url, init) => { seen.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) }); return answer(url, init); });
  return seen;
}
const json = (status, data) => new Response(JSON.stringify(data), { status });

test("without the host proof every write is 403 HOST_PROOF_REQUIRED, the provider is never called, and the refusal is audited", async () => {
  reset();
  const u = user("proof");
  seed(u);
  const seen = fakeProvider(() => json(201, {}));
  try {
    for (const [p, body] of [["/kb/issues/create", { provider: "github", repo: "o/r", title: "T", idem: IDEM }], ["/kb/issues/comment", { provider: "github", repo: "o/r", number: 7, body: "c" }], ["/kb/issues/close", { provider: "github", repo: "o/r", number: 7 }]]) {
      const r = await call(u, p, body, { proof: null });
      assert.equal(r.status, 403, p);
      assert.equal(r.body.error.code, "HOST_PROOF_REQUIRED");
      assert.equal((await call(u, p, body, { proof: "0".repeat(64) })).body.error.code, "HOST_PROOF_REQUIRED", "a wrong proof too");
    }
    assert.equal(seen.length, 0);
    assert.deepEqual(auditRows(u).map((a) => [a.action, a.outcome]).slice(0, 2), [["issues.create", "denied"], ["issues.create", "denied"]]);
  } finally { _setPinnedFetchForTests(null); }
});

test("a GitHub comment reaches the fixed comments endpoint with the vault token, answers without it, and audits no text", async () => {
  reset();
  const u = user("comment");
  seed(u);
  const seen = fakeProvider(() => json(201, { id: 2002, html_url: "https://github.com/o/r/issues/7#issuecomment-2002" }));
  try {
    const r = await call(u, "/kb/issues/comment", { provider: "github", repo: "o/r", number: 7, body: "secret-free comment text" });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { ok: true, id: 2002, url: "https://github.com/o/r/issues/7#issuecomment-2002", state: null });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.github.com/repos/o/r/issues/7/comments");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].headers.Authorization, "Bearer ghp_secret_value_123456");
    assert.equal(r.raw.includes("ghp_secret"), false);
    const [row] = auditRows(u);
    assert.deepEqual([row.action, row.resource, row.outcome], ["issues.comment", "github:o/r#7", "success"]);
    assert.equal(row.detail.includes("comment text"), false, "the audit never holds the text");
    assert.equal(row.detail.includes("ghp_"), false);
  } finally { _setPinnedFetchForTests(null); }
});

test("a GitLab close goes to gitlab.com with the encoded project path and marks the board row closed", async () => {
  reset();
  const u = user("close");
  seed(u);
  const seen = fakeProvider(() => json(200, { id: 3003, web_url: "https://gitlab.com/g/sub/p/-/issues/3", state: "closed" }));
  try {
    const r = await call(u, "/kb/issues/close", { provider: "gitlab", repo: "g/sub/p", number: 3 });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.state, "closed");
    assert.deepEqual([seen[0].url, seen[0].method, seen[0].headers["PRIVATE-TOKEN"]], ["https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/issues/3", "PUT", "glpat_secret_value_12345"]);
    assert.deepEqual(seen[0].body, { state_event: "close" });
    assert.equal(db.listTicketSources(u, { provider: "gitlab", repo: "g/sub/p", state: "closed" }).total, 1);
  } finally { _setPinnedFetchForTests(null); }
});

test("only issues and repos on the caller's board, on the pinned host, are written; PRs never", async () => {
  reset();
  const u = user("allow");
  const other = user("allow2");
  seed(u);
  setSecret(db.getDb(), other, "github.token", "ghp_other_value_123456");
  const seen = fakeProvider(() => json(201, { id: 1 }));
  try {
    const code = async (who, p, body) => (await call(who, p, body)).body.error?.code;
    assert.equal(await code(u, "/kb/issues/comment", { provider: "github", repo: "o/r", number: 99, body: "c" }), "REPO_NOT_ALLOWED");
    assert.equal(await code(u, "/kb/issues/create", { provider: "github", repo: "x/y", title: "T", idem: IDEM }), "REPO_NOT_ALLOWED");
    assert.equal(await code(u, "/kb/issues/create", { provider: "github", repo: "o/far", title: "T", idem: IDEM }), "REPO_NOT_ALLOWED", "look-alike host");
    assert.equal(await code(u, "/kb/issues/close", { provider: "gitlab", repo: "g/self", number: 1 }), "REPO_NOT_ALLOWED", "a self-hosted GitLab row never sends the token to gitlab.com");
    assert.equal(await code(u, "/kb/issues/close", { provider: "github", repo: "o/r", number: 8 }), "NOT_AN_ISSUE");
    assert.equal(await code(other, "/kb/issues/close", { provider: "github", repo: "o/r", number: 7 }), "REPO_NOT_ALLOWED", "another user's board");
    assert.equal(seen.length, 0);
    assert.equal((await call(u, "/kb/issues/create", { provider: "github", repo: "o/r", title: "T", idem: IDEM })).status, 200, "a repo whose only other row is a PR still takes a create");
  } finally { _setPinnedFetchForTests(null); }
});

test("create dedupes a double click on its idem key", async () => {
  reset();
  const u = user("idem");
  seed(u);
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = fakeProvider(async () => { await gate; return json(201, { id: 1001, html_url: "https://github.com/o/r/issues/42", state: "open" }); });
  try {
    const body = { provider: "github", repo: "o/r", title: "Crash on save", body: "Steps", idem: IDEM };
    const a = call(u, "/kb/issues/create", body);
    const b = call(u, "/kb/issues/create", body);
    await new Promise((r) => setImmediate(r));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(seen.length, 1);
    assert.deepEqual([ra.status, ra.body.deduped, rb.status, rb.body.deduped], [200, false, 200, true]);
    assert.deepEqual(seen[0].body, { title: "Crash on save", body: "Steps" });
    assert.equal((await call(u, "/kb/issues/create", { ...body, title: "Other" })).status, 409);
  } finally { _setPinnedFetchForTests(null); }
});

test("provider refusals map to stable codes and a missing token is 400", async () => {
  reset();
  const u = user("errors");
  seed(u);
  const comment = { provider: "github", repo: "o/r", number: 7, body: "c" };
  try {
    for (const [status, want, code] of [[401, 403, "TOKEN_UNAUTHORIZED"], [404, 403, "TOKEN_FORBIDDEN"], [422, 400, "PROVIDER_REJECTED"], [500, 502, "PROVIDER_ERROR"]]) {
      fakeProvider(() => json(status, { message: "provider said no" }));
      const r = await call(u, "/kb/issues/comment", comment);
      assert.deepEqual([r.status, r.body.error.code], [want, code], String(status));
    }
    _setPinnedFetchForTests(async () => { throw new Error("ECONNRESET"); });
    assert.deepEqual((await call(u, "/kb/issues/comment", comment)).body.error.code, "PROVIDER_UNREACHABLE");
  } finally { _setPinnedFetchForTests(null); }
  setSecret(db.getDb(), u, "github.token", "");
  assert.equal((await call(u, "/kb/issues/comment", comment)).body.error.code, "GITHUB_TOKEN_MISSING");
  assert.equal((await call(u, "/kb/issues/comment", { ...comment, body: "x".repeat(20_001) })).body.error.details.field, "body");
});
