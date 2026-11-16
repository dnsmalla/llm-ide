// Single-use clone grant (POST /kb/repos/clone-grant) and its loopback redeem (POST /internal/clone-credential).
// The saved provider token leaves the vault only over loopback, only with the core nonce, only once per grant.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.LLMIDE_JWT_SECRET = "a".repeat(48);
process.env.LLMIDE_VAULT_KEY = "b".repeat(48);
process.env.NODE_ENV = "test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, "_clone-credential-test.db");
process.env.LLMIDE_DB_PATH = DB;

const NONCE = "c".repeat(64);
const TOKEN = "ghp_clone_secret_value_9876543210";

const db = await import("../kb/db.mjs");
const { handleKB } = await import("../routes/router.mjs");
const { setSecret } = await import("../server/vault.mjs");
const users = await import("../server/users.mjs");
const grants = await import("../server/clone-grants.mjs");
const credential = await import("../routes/clone-credential.mjs");
const { ROUTE_POLICY, routeAuthorityFor } = await import("../server/route-authority.mjs");
const { isPublicPath } = await import("../server/auth.mjs");

function reset() {
  db.closeDb();
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  db.getDb();
  grants._resetCloneGrantsForTests();
  grants._setCloneGrantClockForTests(null);
}
function newUser(tag) {
  return users.registerUser(db.getDb(), { email: `${tag}-${Date.now()}-${Math.random()}@example.com`, password: "CorrectHorseBattery", displayName: tag });
}
function res() {
  return { statusCode: 200, headers: {}, body: "", headersSent: false, writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, setHeader(k, v) { this.headers[k] = v; }, write(c) { this.body += c; }, end(c) { if (c) this.body += c; } };
}
function bodyReq(method, url, userId, body, extra = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const r = { method, url, user: userId ? { id: userId } : undefined, headers: { ...(extra.headers || {}) }, socket: { remoteAddress: extra.remoteAddress ?? "127.0.0.1" }, on(ev, cb) { if (ev === "data") chunks.forEach(cb); else if (ev === "end") cb(); return r; } };
  return r;
}
function redeemReq(body, { remoteAddress = "127.0.0.1", nonce = NONCE } = {}) {
  const headers = nonce === null ? {} : { "x-llmide-core-nonce": nonce };
  return bodyReq("POST", "/internal/clone-credential", null, body, { remoteAddress, headers });
}
function auditRowsFor(userId) {
  return db.getDb().prepare("SELECT action, resource, outcome, detail FROM audit_log WHERE user_id = ?").all(userId);
}
async function issue(userId, provider) {
  const out = res();
  await handleKB(bodyReq("POST", "/kb/repos/clone-grant", userId, { provider }), out);
  return out;
}
async function redeem(body, opts) {
  const out = res();
  await credential.handleCloneCredentialRedeem(redeemReq(body, opts), out, { logger: null });
  return out;
}

test("the grant store: 64 hex chars, single use, bound to user and provider", () => {
  grants._resetCloneGrantsForTests();
  const g = grants.issueCloneGrant("user-a", "github");
  assert.match(g, /^[0-9a-f]{64}$/);
  assert.deepEqual(grants.redeemCloneGrant(g), { userId: "user-a", provider: "github" });
  assert.equal(grants.redeemCloneGrant(g), null, "a grant is single use");
  assert.equal(grants.redeemCloneGrant("f".repeat(64)), null, "an unknown grant is refused");
});

test("the grant store: a grant expires 60 s after issue", () => {
  grants._resetCloneGrantsForTests();
  let now = 1_000_000;
  grants._setCloneGrantClockForTests(() => now);
  assert.equal(grants.CLONE_GRANT_TTL_MS, 60_000);
  const g = grants.issueCloneGrant("user-a", "gitlab");
  now += 59_999;
  const live = grants.issueCloneGrant("user-a", "gitlab");
  now += 2;
  assert.equal(grants.redeemCloneGrant(g), null, "a grant older than 60 s is refused");
  assert.notEqual(grants.redeemCloneGrant(live), null, "a grant still inside its window redeems");
  grants._setCloneGrantClockForTests(null);
});

test("the grant store: at most 16 live grants per user, the oldest is dropped", () => {
  grants._resetCloneGrantsForTests();
  assert.equal(grants.CLONE_GRANTS_PER_USER, 16);
  const first = grants.issueCloneGrant("user-cap", "github");
  for (let i = 0; i < 15; i += 1) grants.issueCloneGrant("user-cap", "github");
  const other = grants.issueCloneGrant("user-other", "github");
  const newest = grants.issueCloneGrant("user-cap", "github");
  assert.equal(grants.redeemCloneGrant(first), null, "the 17th grant drops the oldest of that user");
  assert.notEqual(grants.redeemCloneGrant(other), null, "another user's grant is not dropped");
  assert.notEqual(grants.redeemCloneGrant(newest), null);
});

test("grant route: no saved token answers { grant: null } and writes an audit row without the provider secret", async () => {
  reset();
  const u = newUser("nogrant");
  const out = await issue(u.id, "github");
  assert.equal(out.statusCode, 200, out.body);
  assert.deepEqual(JSON.parse(out.body), { grant: null });
  const rows = auditRowsFor(u.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "repos.clone_grant");
  assert.deepEqual(JSON.parse(rows[0].detail), { provider: "github" });
});

test("grant route: a saved token gets a grant; the audit row and the answer carry no token", async () => {
  reset();
  const u = newUser("grant");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  const out = await issue(u.id, "github");
  assert.equal(out.statusCode, 200, out.body);
  const { grant } = JSON.parse(out.body);
  assert.match(grant, /^[0-9a-f]{64}$/);
  assert.equal(out.body.includes(TOKEN), false);
  const rows = auditRowsFor(u.id);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].detail), { provider: "github" });
  assert.equal(JSON.stringify(rows).includes(TOKEN), false);
  assert.equal(JSON.stringify(rows).includes(grant), false);
});

test("grant route: a grant is bound to the signed-in user, not to a token the caller sends", async () => {
  reset();
  const owner = newUser("owner");
  const stranger = newUser("stranger");
  setSecret(db.getDb(), owner.id, "gitlab.token", TOKEN);
  const out = await issue(owner.id, "gitlab");
  const { grant } = JSON.parse(out.body);
  assert.equal(grants.redeemCloneGrant(grant)?.userId, owner.id);
  assert.notEqual(owner.id, stranger.id);
});

test("grant route: an unknown provider is a validation error", async () => {
  reset();
  const u = newUser("badprov");
  const out = await issue(u.id, "bitbucket");
  assert.equal(out.statusCode, 400, out.body);
  assert.equal(JSON.parse(out.body).error.code, "VALIDATION_FAILED");
});

test("redeem: a valid grant, the nonce and loopback give { token } once", async () => {
  reset();
  process.env.LLMIDE_CORE_NONCE = NONCE;
  const u = newUser("redeem");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  const { grant } = JSON.parse((await issue(u.id, "github")).body);
  const out = await redeem({ grant });
  assert.equal(out.statusCode, 200, out.body);
  assert.deepEqual(JSON.parse(out.body), { token: TOKEN });
  assert.equal(out.headers["Cache-Control"], "no-store");
  const again = await redeem({ grant });
  assert.equal(again.statusCode, 403);
  assert.deepEqual(JSON.parse(again.body), { error: "clone_credential_refused" });
  const rows = auditRowsFor(u.id).filter((r) => r.action === "repos.clone_credential");
  assert.equal(rows.length, 1, "only the successful redeem is audited with its grant user");
  assert.deepEqual(JSON.parse(rows[0].detail), { provider: "github", ok: true });
  assert.equal(JSON.stringify(auditRowsFor(u.id)).includes(TOKEN), false);
  delete process.env.LLMIDE_CORE_NONCE;
});

test("redeem refuses a non-loopback peer, a wrong nonce, a missing nonce and a bad body with the same 403", async () => {
  reset();
  process.env.LLMIDE_CORE_NONCE = NONCE;
  const u = newUser("refuse");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  const cases = [
    { name: "remote peer", opts: { remoteAddress: "192.168.1.20" }, body: null },
    { name: "wrong nonce", opts: { nonce: "d".repeat(64) }, body: null },
    { name: "short nonce", opts: { nonce: NONCE.slice(1) }, body: null },
    { name: "missing nonce", opts: { nonce: null }, body: null },
    { name: "bad grant shape", opts: {}, body: { grant: "not-a-grant" } },
    { name: "missing body grant", opts: {}, body: {} },
  ];
  for (const c of cases) {
    const { grant } = JSON.parse((await issue(u.id, "github")).body);
    const out = await redeem(c.body ?? { grant }, c.opts);
    assert.equal(out.statusCode, 403, `${c.name}: ${out.body}`);
    assert.deepEqual(JSON.parse(out.body), { error: "clone_credential_refused" }, c.name);
    assert.equal(out.body.includes(TOKEN), false, c.name);
  }
  delete process.env.LLMIDE_CORE_NONCE;
});

test("redeem refuses an expired grant", async () => {
  reset();
  process.env.LLMIDE_CORE_NONCE = NONCE;
  const u = newUser("expired");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  let now = 5_000_000;
  grants._setCloneGrantClockForTests(() => now);
  const { grant } = JSON.parse((await issue(u.id, "github")).body);
  now += 60_001;
  const out = await redeem({ grant });
  assert.equal(out.statusCode, 403, out.body);
  assert.equal(out.body.includes(TOKEN), false);
  grants._setCloneGrantClockForTests(null);
  delete process.env.LLMIDE_CORE_NONCE;
});

test("a core with no nonce (a desktop-spawned local core) answers 404 to the redeem", async () => {
  reset();
  delete process.env.LLMIDE_CORE_NONCE;
  const u = newUser("nononce");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  const { grant } = JSON.parse((await issue(u.id, "github")).body);
  const out = await redeem({ grant }, { nonce: NONCE });
  assert.equal(out.statusCode, 404, out.body);
  assert.equal(out.body.includes(TOKEN), false);
});

test("the redeem route is public for auth but has its own explicit route-policy entry, and the grant route is in external.read", () => {
  const redeemRule = routeAuthorityFor("POST", "/internal/clone-credential");
  assert.equal(redeemRule?.cls, "public");
  assert.equal(isPublicPath("POST", "/internal/clone-credential"), true);
  const grantRule = routeAuthorityFor("POST", "/kb/repos/clone-grant");
  assert.equal(grantRule?.cls, "external.read");
  assert.equal(ROUTE_POLICY.filter((r) => r.path === "/internal/clone-credential").length, 1);
});

test("the endpoint list advertises the grant route and not the redeem route", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "server.mjs"), "utf8");
  const block = src.slice(src.indexOf("const ALL_ENDPOINTS = ["), src.indexOf("];", src.indexOf("const ALL_ENDPOINTS = [")));
  assert.match(block, /'\/kb\/repos\/clone-grant'/);
  assert.equal(block.includes("clone-credential"), false);
  assert.match(src, /const SERVER_API_VERSION = 148;/);
});

test("no token or grant reaches the stderr logger during issue and redeem", async () => {
  reset();
  process.env.LLMIDE_CORE_NONCE = NONCE;
  const u = newUser("logs");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c, ...rest) => { chunks.push(String(c)); return original(c, ...rest); };
  try {
    const { grant } = JSON.parse((await issue(u.id, "github")).body);
    await redeem({ grant });
    await redeem({ grant: "e".repeat(64) });
    assert.equal(chunks.join("").includes(TOKEN), false);
    assert.equal(chunks.join("").includes(grant), false);
  } finally {
    process.stderr.write = original;
    delete process.env.LLMIDE_CORE_NONCE;
  }
});

test("redeem handler is exported for the dispatcher", () => {
  assert.equal(typeof credential.handleCloneCredentialRedeem, "function");
  assert.equal(typeof credential.handleCloneGrant, "function");
});
