// POST /kb/repos/check-token: the vault token is checked against the fixed provider /user endpoint; nothing is echoed.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.LLMIDE_JWT_SECRET = "a".repeat(48);
process.env.LLMIDE_VAULT_KEY = "b".repeat(48);
process.env.NODE_ENV = "test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, "_kb-repo-token-test.db");
process.env.LLMIDE_DB_PATH = DB;

const db = await import("../kb/db.mjs");
const { handleKB } = await import("../routes/router.mjs");
const { setSecret } = await import("../server/vault.mjs");
const { _setPinnedFetchForTests } = await import("../server/pinned-fetch.mjs");
const users = await import("../server/users.mjs");

function reset() {
  db.closeDb();
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  db.getDb();
}
function req(userId, body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const r = { method: "POST", url: "/kb/repos/check-token", user: { id: userId }, headers: {}, on(ev, cb) { if (ev === "data") chunks.forEach(cb); else if (ev === "end") cb(); return r; } };
  return r;
}
function res() {
  return { statusCode: 200, headers: {}, body: "", writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, setHeader(k, v) { this.headers[k] = v; }, write(c) { this.body += c; }, end(c) { if (c) this.body += c; } };
}

test("GitHub token check returns the login and scopes, never the token", async () => {
  reset();
  const u = users.registerUser(db.getDb(), { email: `tok-${Date.now()}@example.com`, password: "CorrectHorseBattery", displayName: "tok" });
  setSecret(db.getDb(), u.id, "github.token", "ghp_secret_value_123456");
  let seen = null;
  _setPinnedFetchForTests(async (url, init) => {
    seen = { url, auth: init.headers.Authorization };
    return new Response(JSON.stringify({ login: "octocat", name: "The Octocat" }), { status: 200, headers: { "x-oauth-scopes": "repo, read:user" } });
  });
  try {
    const out = res();
    await handleKB(req(u.id, { provider: "github" }), out);
    assert.equal(out.statusCode, 200, out.body);
    assert.deepEqual(JSON.parse(out.body), { ok: true, login: "octocat", name: "The Octocat", scopes: ["repo", "read:user"] });
    assert.equal(seen.url, "https://api.github.com/user");
    assert.match(seen.auth, /^Bearer /);
    assert.equal(out.body.includes("ghp_secret"), false);
  } finally { _setPinnedFetchForTests(null); }
});

test("a refused token is a 403 and a missing token is a 400", async () => {
  reset();
  const u = users.registerUser(db.getDb(), { email: `tok2-${Date.now()}@example.com`, password: "CorrectHorseBattery", displayName: "tok2" });
  setSecret(db.getDb(), u.id, "gitlab.token", "glpat_secret_value_12345");
  _setPinnedFetchForTests(async () => new Response(JSON.stringify({ message: "401 Unauthorized" }), { status: 401 }));
  try {
    const refused = res();
    await handleKB(req(u.id, { provider: "gitlab" }), refused);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(JSON.parse(refused.body).error.code, "TOKEN_REFUSED");
  } finally { _setPinnedFetchForTests(null); }
  const missing = res();
  await handleKB(req(u.id, { provider: "github" }), missing);
  assert.equal(missing.statusCode, 400, missing.body);
  assert.equal(JSON.parse(missing.body).error.code, "GITHUB_TOKEN_MISSING");
});
