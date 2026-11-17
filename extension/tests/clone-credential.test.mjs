// Single-use clone grant (POST /kb/repos/clone-grant) and its loopback redeem (POST /internal/clone-credential).
// The redeem needs the file-only redeem key (server/clone-redeem-key.mjs), never the /health identity nonce.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.LLMIDE_JWT_SECRET = "a".repeat(48);
process.env.LLMIDE_VAULT_KEY = "b".repeat(48);
process.env.NODE_ENV = "test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, "_clone-credential-test.db");
const DATA = path.join(HERE, "_clone-credential-data");
process.env.LLMIDE_DB_PATH = DB;

const NONCE = "c".repeat(64);
const TOKEN = "ghp_clone_secret_value_9876543210";

const db = await import("../kb/db.mjs");
const { handleKB } = await import("../routes/router.mjs");
const { setSecret } = await import("../server/vault.mjs");
const users = await import("../server/users.mjs");
const grants = await import("../server/clone-grants.mjs");
const credential = await import("../routes/clone-credential.mjs");
const redeemKey = await import("../server/clone-redeem-key.mjs");
const { ROUTE_POLICY, routeAuthorityFor } = await import("../server/route-authority.mjs");
const { isPublicPath } = await import("../server/auth.mjs");

after(() => {
  db.closeDb();
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
});

function reset() {
  db.closeDb();
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
  db.getDb();
  grants._resetCloneGrantsForTests();
  grants._setCloneGrantClockForTests(null);
  redeemKey.initCloneRedeemKey({ dataDir: DATA, serverMode: false });
}
/** Server mode: writes the redeem key file and returns the key. */
function startServerMode() {
  const key = redeemKey.initCloneRedeemKey({ dataDir: DATA, serverMode: true });
  assert.match(key, /^[0-9a-f]{64}$/);
  return key;
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
function redeemReq(body, { remoteAddress = "127.0.0.1", key = null, header = "x-llmide-redeem-key" } = {}) {
  const headers = key === null ? {} : { [header]: key };
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

test("redeem: a valid grant and the redeem key over loopback give { token } once", async () => {
  reset();
  const key = startServerMode();
  const u = newUser("redeem");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  const { grant } = JSON.parse((await issue(u.id, "github")).body);
  const out = await redeem({ grant }, { key });
  assert.equal(out.statusCode, 200, out.body);
  assert.deepEqual(JSON.parse(out.body), { token: TOKEN });
  assert.equal(out.headers["Cache-Control"], "no-store");
  const again = await redeem({ grant }, { key });
  assert.equal(again.statusCode, 403);
  assert.deepEqual(JSON.parse(again.body), { error: "clone_credential_refused" });
  const rows = auditRowsFor(u.id).filter((r) => r.action === "repos.clone_credential");
  assert.equal(rows.length, 1, "only the successful redeem is audited with its grant user");
  assert.deepEqual(JSON.parse(rows[0].detail), { provider: "github", ok: true });
  assert.equal(JSON.stringify(auditRowsFor(u.id)).includes(TOKEN), false);
  assert.equal(JSON.stringify(auditRowsFor(u.id)).includes(key), false);
});

test("redeem refuses a non-loopback peer, a wrong key, a missing key and a bad body with the same 403", async () => {
  reset();
  const key = startServerMode();
  const u = newUser("refuse");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  const cases = [
    { name: "remote peer", opts: { remoteAddress: "192.168.1.20", key }, body: null },
    { name: "wrong key", opts: { key: "d".repeat(64) }, body: null },
    { name: "short key", opts: { key: key.slice(1) }, body: null },
    { name: "missing key", opts: { key: null }, body: null },
    { name: "key in the wrong header", opts: { key, header: "x-llmide-core-nonce" }, body: null },
    { name: "bad grant shape", opts: { key }, body: { grant: "not-a-grant" } },
    { name: "missing body grant", opts: { key }, body: {} },
  ];
  for (const c of cases) {
    const { grant } = JSON.parse((await issue(u.id, "github")).body);
    const out = await redeem(c.body ?? { grant }, c.opts);
    assert.equal(out.statusCode, 403, `${c.name}: ${out.body}`);
    assert.deepEqual(JSON.parse(out.body), { error: "clone_credential_refused" }, c.name);
    assert.equal(out.body.includes(TOKEN), false, c.name);
  }
});

test("the /health identity nonce no longer redeems a grant", async () => {
  reset();
  process.env.LLMIDE_CORE_NONCE = NONCE;
  try {
    startServerMode();
    const u = newUser("healthnonce");
    setSecret(db.getDb(), u.id, "github.token", TOKEN);
    const { grant } = JSON.parse((await issue(u.id, "github")).body);
    const out = await redeem({ grant }, { key: NONCE });
    assert.equal(out.statusCode, 403, out.body);
    assert.equal(out.body.includes(TOKEN), false);
  } finally {
    delete process.env.LLMIDE_CORE_NONCE;
  }
});

test("redeem refuses an expired grant", async () => {
  reset();
  const key = startServerMode();
  const u = newUser("expired");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  let now = 5_000_000;
  grants._setCloneGrantClockForTests(() => now);
  const { grant } = JSON.parse((await issue(u.id, "github")).body);
  now += 60_001;
  const out = await redeem({ grant }, { key });
  assert.equal(out.statusCode, 403, out.body);
  assert.equal(out.body.includes(TOKEN), false);
  grants._setCloneGrantClockForTests(null);
});

test("no redeem key (not server mode) answers 404 to the redeem, and no key file is left behind", async () => {
  reset();
  startServerMode();
  assert.equal(fs.existsSync(path.join(DATA, redeemKey.CLONE_REDEEM_KEY_FILE)), true);
  // A later start without LLMIDE_CORE_NONCE clears the key and removes the stale file.
  assert.equal(redeemKey.initCloneRedeemKey({ dataDir: DATA, serverMode: false }), null);
  assert.equal(redeemKey.currentCloneRedeemKey(), null);
  assert.equal(fs.existsSync(path.join(DATA, redeemKey.CLONE_REDEEM_KEY_FILE)), false);
  const u = newUser("nokey");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  const { grant } = JSON.parse((await issue(u.id, "github")).body);
  const out = await redeem({ grant }, { key: "e".repeat(64) });
  assert.equal(out.statusCode, 404, out.body);
  assert.equal(out.body.includes(TOKEN), false);
});

test("the key file is written 0600 with the in-memory key, and replaced on each server-mode start", () => {
  reset();
  const first = startServerMode();
  const file = path.join(DATA, redeemKey.CLONE_REDEEM_KEY_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), first);
  const second = startServerMode();
  assert.notEqual(second, first);
  assert.equal(fs.readFileSync(file, "utf8"), second);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(DATA).filter((f) => f.endsWith(".tmp")), [], "no temp file is left behind");
});

test("the key is compared in constant time (timingSafeEqual) and rejects any length mismatch", () => {
  const key = "f".repeat(64);
  assert.equal(redeemKey.redeemKeyMatches(key, key), true);
  assert.equal(redeemKey.redeemKeyMatches(key.slice(1), key), false);
  assert.equal(redeemKey.redeemKeyMatches(undefined, key), false);
  assert.equal(redeemKey.redeemKeyMatches(key, null), false);
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
  assert.match(src, /const SERVER_API_VERSION = 149;/);
});

test("no token, grant or redeem key reaches the stderr logger during issue and redeem", async () => {
  reset();
  const key = startServerMode();
  const u = newUser("logs");
  setSecret(db.getDb(), u.id, "github.token", TOKEN);
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c, ...rest) => { chunks.push(String(c)); return original(c, ...rest); };
  try {
    const { grant } = JSON.parse((await issue(u.id, "github")).body);
    const ok = await redeem({ grant }, { key });
    const bad = await redeem({ grant: "e".repeat(64) }, { key: "d".repeat(64) });
    const logged = chunks.join("");
    for (const secret of [TOKEN, grant, key]) assert.equal(logged.includes(secret), false);
    for (const body of [ok.body, bad.body]) assert.equal(body.includes(key), false);
  } finally {
    process.stderr.write = original;
  }
});

test("server mode is an SSH server core only: the flag, not a hub, on a loopback bind", () => {
  const on = { LLMIDE_SSH_SERVER: "1" };
  assert.equal(redeemKey.isCloneRedeemServerMode({ env: on, hub: false, host: "127.0.0.1" }), true);
  assert.equal(redeemKey.isCloneRedeemServerMode({ env: on, hub: false, host: "::1" }), true);
  assert.equal(redeemKey.isCloneRedeemServerMode({ env: { LLMIDE_SSH_SERVER: "0" }, hub: false, host: "127.0.0.1" }), false);
  assert.equal(redeemKey.isCloneRedeemServerMode({ env: {}, hub: false, host: "127.0.0.1" }), false, "a nonce alone is not the mode");
  assert.equal(redeemKey.isCloneRedeemServerMode({ env: on, hub: true, host: "127.0.0.1" }), false, "a hub never holds the key");
  assert.equal(redeemKey.isCloneRedeemServerMode({ env: on, hub: false, host: "0.0.0.0" }), false, "a non-loopback bind is refused");
});

test("a stale temp file from an earlier crash is replaced: the key file is 0600 and no temp file remains", () => {
  reset();
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = path.join(DATA, `${redeemKey.CLONE_REDEEM_KEY_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, "stale", { mode: 0o644 });
  const key = startServerMode();
  assert.equal(fs.existsSync(tmp), false);
  const file = path.join(DATA, redeemKey.CLONE_REDEEM_KEY_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), key);
});

test("a write error does not abort the boot: no key, the redeem answers 404, and the key is not logged", async () => {
  reset();
  // A regular file where the data directory should be makes every write fail.
  const blocked = path.join(HERE, "_clone-credential-blocked");
  fs.writeFileSync(blocked, "not a directory");
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c, ...rest) => { chunks.push(String(c)); return original(c, ...rest); };
  try {
    assert.equal(redeemKey.initCloneRedeemKey({ dataDir: blocked, serverMode: true }), null);
  } finally {
    process.stderr.write = original;
    fs.rmSync(blocked, { force: true });
  }
  assert.equal(redeemKey.currentCloneRedeemKey(), null);
  assert.match(chunks.join(""), /clone_redeem_key_unavailable/);
  const out = await redeem({ grant: "e".repeat(64) }, { key: "e".repeat(64) });
  assert.equal(out.statusCode, 404, out.body);
});

test("the redeem answers POST only: any other method is 405 and does nothing", async () => {
  reset();
  const key = startServerMode();
  const out = res();
  const req = redeemReq({ grant: "e".repeat(64) }, { key });
  req.method = "GET";
  await credential.handleCloneCredentialRedeem(req, out, { logger: null });
  assert.equal(out.statusCode, 405);
  assert.equal(out.headers.Allow, "POST");
});

test("redeem handler is exported for the dispatcher", () => {
  assert.equal(typeof credential.handleCloneCredentialRedeem, "function");
  assert.equal(typeof credential.handleCloneGrant, "function");
});
