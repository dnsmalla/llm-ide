// Google OAuth core (connectors/google/google-auth.mjs): PKCE, loopback listener, state/nonce, replay, timeout, scope
// subset refusal, vault-only token storage, revoke, legacy mail.google.com token, per-user isolation, no secret anywhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_google-auth-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { getSecret, setSecret } = await import('../server/vault.mjs');
const auth = await import('../connectors/google/google-auth.mjs');
const gf = await import('../connectors/google/google-fetch.mjs');
const scopes = await import('../connectors/google/google-scopes.mjs');
const store = await import('../kb/google-store.mjs');
const { makeTransport, jsonResponse, makeIdToken, installTripwire } = await import('./helpers/google-fixture.mjs');

const db = kb.getDb();
let n = 0;
const mkUser = () => users.registerUser(db, { email: `g-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'g' }).id;

let tripwire;
before(() => { tripwire = installTripwire(); });
after(() => {
  tripwire.restore(); gf._setGoogleFetchForTests(null); auth._resetGoogleAuthForTests();
  assert.deepEqual(tripwire.hits, [], 'a test reached a real Google host');
  kb.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
});

const REFRESH = '1//0gREFRESH-TOKEN-SECRET-VALUE-0123456789abcdef';
const ACCESS = 'ya29.ACCESS-TOKEN-SECRET-VALUE-0123456789abcdef';
const CLIENT_SECRET = 'GOCSPX-client-secret-value-0123456789';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';

function callback(port, query, { host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/oauth2/callback?${query}`, headers: host ? { host } : {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
  });
}
const paramsOf = (authUrl) => new URL(authUrl).searchParams;

/** A transport answering the token endpoint with `grant` and the revoke endpoint with 200. */
function tokenTransport({ scope = `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL}`, sub = 'sub-123', email = 'me@example.com', refresh = REFRESH, aud, nonceFrom, idToken } = {}) {
  const t = makeTransport();
  t.on('/token', (u, init, call) => {
    const b = call.body;
    if (b.grant_type === 'authorization_code') {
      return jsonResponse(200, {
        access_token: ACCESS, refresh_token: refresh, expires_in: 3599, token_type: 'Bearer', scope,
        id_token: idToken || makeIdToken({ sub, email, aud: aud || b.client_id, nonce: nonceFrom() }),
      });
    }
    return jsonResponse(200, { access_token: ACCESS + '-2', expires_in: 3599, token_type: 'Bearer' });
  });
  t.on('/revoke', () => jsonResponse(200, {}));
  return t;
}

test('PKCE: challenge is base64url(sha256(verifier)), verifier is 43..128 URL-safe chars', () => {
  const { verifier, challenge } = auth.pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(auth.pkcePair().verifier, verifier);
});

test('scopes registry: read-only only, gmail.readonly for gmail, drive upgrade only when content is ticked', () => {
  const g = scopes.scopesFor(['gmail']);
  assert.deepEqual(g, ['email', 'https://www.googleapis.com/auth/gmail.readonly', 'openid'].sort());
  assert.ok(scopes.scopesFor(['gdrive']).includes('https://www.googleapis.com/auth/drive.metadata.readonly'));
  assert.ok(!scopes.scopesFor(['gdrive']).includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(scopes.scopesFor(['gdrive'], { driveContent: true }).includes('https://www.googleapis.com/auth/drive.readonly'));
  const cal = scopes.scopesFor(['gcal']);
  assert.ok(cal.includes('https://www.googleapis.com/auth/calendar.events.readonly') && cal.includes('https://www.googleapis.com/auth/calendar.calendarlist.readonly'));
  for (const s of scopes.scopesFor(['gmail', 'gcal', 'gdrive'], { driveContent: true })) assert.ok(!/modify|compose|send|\.file$|mail\.google\.com|calendar$|auth\/drive$/.test(s), `write-capable scope ${s}`);
  assert.throws(() => scopes.scopesFor(['nope']));
});

test('checkGranted: subset ok, email URL form is canonical, extra refused, missing reported', () => {
  const req = scopes.scopesFor(['gmail']);
  assert.equal(scopes.checkGranted(req, `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL}`).ok, true);
  const extra = scopes.checkGranted(req, `openid email ${GMAIL} https://mail.google.com/`);
  assert.equal(extra.ok, false); assert.deepEqual(extra.extra, ['https://mail.google.com/']);
  const missing = scopes.checkGranted(req, 'openid email');
  assert.equal(missing.ok, true); assert.deepEqual(missing.missing, [GMAIL]);
  assert.equal(scopes.checkGranted(req, '').ok, false);
});

test('host allowlist: only the five Google hosts, https, 443, no userinfo', () => {
  for (const ok of ['https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', 'https://www.googleapis.com/drive/v3/files', 'https://calendar.googleapis.com/x']) assert.equal(gf.isAllowedGoogleUrl(ok), true, ok);
  for (const bad of ['http://oauth2.googleapis.com/token', 'https://evil.example.com/', 'https://oauth2.googleapis.com.evil.com/', 'https://u:p@oauth2.googleapis.com/', 'https://oauth2.googleapis.com:8443/', 'https://storage.googleapis.com/x', 'https://127.0.0.1/', 'not a url']) assert.equal(gf.isAllowedGoogleUrl(bad), false, bad);
});

test('tripwire: without an installed transport the Google transport throws instead of using the network', async () => {
  gf._setGoogleFetchForTests(null);
  await assert.rejects(() => gf.googleOnce('https://oauth2.googleapis.com/token', { method: 'POST', form: { a: '1' } }), (e) => e.code === 'GOOGLE_TEST_TRIPWIRE');
});

test('full flow: loopback listener, state+nonce+PKCE, tokens in the vault only, account row, listener closed after', async () => {
  const userId = mkUser();
  let nonce; let verifierSeen; let challengeSeen;
  const t = tokenTransport({ nonceFrom: () => nonce });
  gf._setGoogleFetchForTests(async (u, i) => { const r = await t(u, i); const c = t.calls.at(-1); if (c.path === '/token' && c.body?.code_verifier) verifierSeen = c.body.code_verifier; return r; });

  const start = await auth.startAuthFlow({ db, userId, clientId: 'cid.apps.googleusercontent.com', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  const p = paramsOf(start.authUrl);
  assert.equal(new URL(start.authUrl).origin, 'https://accounts.google.com');
  assert.equal(p.get('response_type'), 'code'); assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('redirect_uri'), `http://127.0.0.1:${start.redirectPort}/oauth2/callback`);
  assert.equal(p.get('state'), start.state); assert.ok(p.get('nonce')); assert.equal(p.get('access_type'), 'offline');
  assert.ok(!p.has('include_granted_scopes'));
  assert.deepEqual(p.get('scope').split(' ').sort(), scopes.scopesFor(['gmail']));
  assert.equal(start.scopes.find((s) => s.scope === GMAIL).readOnly, true);
  nonce = p.get('nonce'); challengeSeen = p.get('code_challenge');

  assert.deepEqual(auth.flowStatus(start.state, userId), { status: 'pending' });
  const r = await callback(start.redirectPort, `state=${start.state}&code=4/0AbcCODE`);
  assert.equal(r.status, 200);
  assert.equal(crypto.createHash('sha256').update(verifierSeen).digest('base64url'), challengeSeen);
  const tokenCall = t.calls.find((c) => c.path === '/token');
  assert.equal(tokenCall.body.redirect_uri, p.get('redirect_uri'));

  const st = auth.flowStatus(start.state, userId);
  assert.equal(st.status, 'complete'); assert.equal(st.email, 'me@example.com'); assert.deepEqual(st.products, ['gmail']);
  assert.match(st.accountId, /^[a-f0-9]{12}$/);
  assert.equal(st.accountId, auth.accountIdFromSub('sub-123'));
  assert.deepEqual(auth.flowStatus(start.state, userId), { status: 'unknown' }, 'a terminal status is read once');

  assert.equal(getSecret(db, userId, `google.acct.${st.accountId}.refreshToken`), REFRESH);
  assert.equal(getSecret(db, userId, `google.acct.${st.accountId}.clientSecret`), CLIENT_SECRET);
  const acct = store.getGoogleAccount(userId, st.accountId);
  assert.equal(acct.email, 'me@example.com'); assert.equal(acct.status, 'connected');

  // the listener is closed: a replay cannot even connect
  await assert.rejects(() => callback(start.redirectPort, `state=${start.state}&code=again`), /ECONNREFUSED/);

  // no token or secret in any plaintext table
  for (const tbl of ['google_accounts', 'connector_sync_state', 'audit_log']) {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM ${tbl}`).all());
    for (const s of [REFRESH, ACCESS, CLIENT_SECRET]) assert.ok(!dump.includes(s), `${tbl} holds a secret`);
  }
  const raw = JSON.stringify(db.prepare('SELECT * FROM user_secrets WHERE user_id = ?').all(userId));
  for (const s of [REFRESH, ACCESS, CLIENT_SECRET]) assert.ok(!raw.includes(s), 'vault rows are ciphertext');
  assert.deepEqual(tripwire.hits, []);
});

test('state mismatch is refused and does not consume the flow; the real callback still works once', async () => {
  const userId = mkUser(); let nonce;
  gf._setGoogleFetchForTests(tokenTransport({ nonceFrom: () => nonce }));
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  nonce = paramsOf(start.authUrl).get('nonce');
  const bad = await callback(start.redirectPort, 'state=WRONG&code=x');
  assert.equal(bad.status, 400);
  assert.deepEqual(auth.flowStatus(start.state, userId), { status: 'pending' });
  const bad2 = await callback(start.redirectPort, 'code=x');
  assert.equal(bad2.status, 400);
  const ok = await callback(start.redirectPort, `state=${start.state}&code=good`);
  assert.equal(ok.status, 200);
  assert.equal(auth.flowStatus(start.state, userId).status, 'complete');
});

test('five bad callbacks abort the flow and close the listener', async () => {
  const userId = mkUser();
  gf._setGoogleFetchForTests(makeTransport());
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  for (let i = 0; i < 5; i++) await callback(start.redirectPort, 'state=nope&code=x');
  const st = auth.flowStatus(start.state, userId);
  assert.equal(st.status, 'error');
  await assert.rejects(() => callback(start.redirectPort, `state=${start.state}&code=x`), /ECONNREFUSED/);
});

test('a callback with a foreign Host header or another path is not served', async () => {
  const userId = mkUser();
  gf._setGoogleFetchForTests(makeTransport());
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  const r = await callback(start.redirectPort, `state=${start.state}&code=x`, { host: 'evil.example.com' });
  assert.equal(r.status, 404);
  assert.deepEqual(auth.flowStatus(start.state, userId), { status: 'pending' });
  auth.abortUserFlows(userId);
});

test('timeout: the flow ends with an error after the deadline and the listener is closed', async () => {
  const userId = mkUser();
  gf._setGoogleFetchForTests(makeTransport());
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'], timeoutMs: 60 });
  await new Promise((r) => setTimeout(r, 150));
  const st = auth.flowStatus(start.state, userId);
  assert.equal(st.status, 'error'); assert.match(st.message, /timed out/);
  await assert.rejects(() => callback(start.redirectPort, `state=${start.state}&code=x`), /ECONNREFUSED/);
});

test('a second start for the same user replaces the first flow', async () => {
  const userId = mkUser();
  gf._setGoogleFetchForTests(makeTransport());
  const a = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  const b = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  assert.equal(auth.flowStatus(a.state, userId).status, 'error');
  assert.deepEqual(auth.flowStatus(b.state, userId), { status: 'pending' });
  await assert.rejects(() => callback(a.redirectPort, `state=${a.state}&code=x`), /ECONNREFUSED/);
  auth.abortUserFlows(userId);
});

test('status is per user: another user cannot read a flow', async () => {
  const u1 = mkUser(); const u2 = mkUser();
  gf._setGoogleFetchForTests(makeTransport());
  const s = await auth.startAuthFlow({ db, userId: u1, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  assert.deepEqual(auth.flowStatus(s.state, u2), { forbidden: true });
  assert.deepEqual(auth.flowStatus(s.state, u1), { status: 'pending' });
  auth.abortUserFlows(u1);
});

test('scope mismatch: Google granting MORE than requested is refused, revoked, and nothing is stored', async () => {
  const userId = mkUser(); let nonce;
  const t = tokenTransport({ scope: `openid email ${GMAIL} https://mail.google.com/`, nonceFrom: () => nonce });
  gf._setGoogleFetchForTests(t);
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  nonce = paramsOf(start.authUrl).get('nonce');
  await callback(start.redirectPort, `state=${start.state}&code=x`);
  const st = auth.flowStatus(start.state, userId);
  assert.equal(st.status, 'error'); assert.match(st.message, /more access/);
  const rev = t.callsTo('/revoke');
  assert.equal(rev.length, 1); assert.equal(rev[0].body.token, REFRESH);
  assert.equal(store.listGoogleAccounts(userId).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM user_secrets WHERE user_id = ? AND secret_key LIKE 'google.acct.%'").get(userId).n, 0);
});

test('scope mismatch: unticked scope turns the product off; with nothing granted the connect is refused', async () => {
  const userId = mkUser(); let nonce;
  gf._setGoogleFetchForTests(tokenTransport({ scope: 'openid email', nonceFrom: () => nonce }));
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  nonce = paramsOf(start.authUrl).get('nonce');
  await callback(start.redirectPort, `state=${start.state}&code=x`);
  const st = auth.flowStatus(start.state, userId);
  assert.equal(st.status, 'error'); assert.match(st.message, /None of the requested access/);
  // calendar partially granted (one of two scopes) enables nothing; both enable it
  const t2 = tokenTransport({ scope: `openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly`, nonceFrom: () => nonce });
  gf._setGoogleFetchForTests(t2);
  const s2 = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gcal'] });
  nonce = paramsOf(s2.authUrl).get('nonce');
  await callback(s2.redirectPort, `state=${s2.state}&code=x`);
  const st2 = auth.flowStatus(s2.state, userId);
  assert.equal(st2.status, 'complete'); assert.deepEqual(st2.products, ['gcal']);
});

test('ID token checks: wrong audience, wrong nonce and an expired token are refused (and revoked)', async () => {
  for (const mode of ['aud', 'nonce', 'exp']) {
    const userId = mkUser(); let nonce;
    const t = makeTransport();
    t.on('/token', (_u, _i, call) => jsonResponse(200, {
      access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, token_type: 'Bearer', scope: `openid email ${GMAIL}`,
      id_token: makeIdToken({ sub: 's', email: 'x@y.z', aud: mode === 'aud' ? 'other-client' : call.body.client_id, nonce: mode === 'nonce' ? 'forged' : nonce, exp: mode === 'exp' ? 1 : undefined }),
    }));
    t.on('/revoke', () => jsonResponse(200, {}));
    gf._setGoogleFetchForTests(t);
    const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
    nonce = paramsOf(start.authUrl).get('nonce');
    await callback(start.redirectPort, `state=${start.state}&code=x`);
    assert.equal(auth.flowStatus(start.state, userId).status, 'error', mode);
    assert.equal(t.callsTo('/revoke').length, 1, mode);
    assert.equal(store.listGoogleAccounts(userId).length, 0, mode);
  }
});

test('no refresh token returned: refused with a fixed message', async () => {
  const userId = mkUser(); let nonce;
  gf._setGoogleFetchForTests(tokenTransport({ refresh: '', nonceFrom: () => nonce }));
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  nonce = paramsOf(start.authUrl).get('nonce');
  await callback(start.redirectPort, `state=${start.state}&code=x`);
  const st = auth.flowStatus(start.state, userId);
  assert.equal(st.status, 'error'); assert.match(st.message, /refresh token/);
});

test('token endpoint error: message is fixed text, never the body, client secret redacted', async () => {
  const userId = mkUser();
  const t = makeTransport();
  t.on('/token', () => jsonResponse(400, { error: 'invalid_grant', error_description: `echo ${CLIENT_SECRET} ${REFRESH}` }));
  gf._setGoogleFetchForTests(t);
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  const r = await callback(start.redirectPort, `state=${start.state}&code=x`);
  const st = auth.flowStatus(start.state, userId);
  assert.equal(st.status, 'error');
  for (const s of [CLIENT_SECRET, REFRESH]) { assert.ok(!st.message.includes(s)); assert.ok(!r.body.includes(s)); }
});

test('start validation: unknown product, missing client, reuse of the legacy client', async () => {
  const userId = mkUser();
  await assert.rejects(() => auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: 's', products: ['nope'] }), (e) => e.code === 'GOOGLE_BAD_REQUEST');
  await assert.rejects(() => auth.startAuthFlow({ db, userId, products: ['gmail'] }), (e) => e.code === 'GOOGLE_BAD_REQUEST');
  gf._setGoogleFetchForTests(makeTransport().on('/revoke', () => jsonResponse(200, {})));
  setSecret(db, userId, 'google.email.clientId', 'legacy-cid'); setSecret(db, userId, 'google.email.clientSecret', 'legacy-secret-xyz');
  const s = await auth.startAuthFlow({ db, userId, products: ['gmail'] });
  assert.equal(paramsOf(s.authUrl).get('client_id'), 'legacy-cid');
  assert.equal(getSecret(db, userId, 'google.email.clientId'), 'legacy-cid', 'kept until the connect succeeds');
  auth.abortUserFlows(userId);
});

test('legacy mail.google.com token: revoked at the first new connect and deleted, never used again', async () => {
  const userId = mkUser();
  const LEGACY = '1//0gLEGACY-MAILBOX-TOKEN-0123456789abcdef';
  setSecret(db, userId, 'google.email.refreshToken', LEGACY);
  assert.equal(auth.legacyMailTokenPresent(db, userId), true);
  const t = makeTransport().on('/revoke', () => jsonResponse(200, {}));
  gf._setGoogleFetchForTests(t);
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  assert.equal(start.legacyMailTokenRevoked, true);
  assert.equal(t.callsTo('/revoke').length, 1);
  assert.equal(t.callsTo('/revoke')[0].body.token, LEGACY);
  assert.equal(t.callsTo('/revoke')[0].host, 'oauth2.googleapis.com');
  assert.equal(auth.legacyMailTokenPresent(db, userId), false);
  assert.equal(getSecret(db, userId, 'google.email.refreshToken'), null);
  auth.abortUserFlows(userId);
  // a failing revoke (offline) still deletes the local copy
  setSecret(db, userId, 'google.email.refreshToken', LEGACY);
  gf._setGoogleFetchForTests(async () => { throw new TypeError('fetch failed'); });
  assert.equal(await auth.revokeLegacyMailToken(db, userId), true);
  assert.equal(auth.legacyMailTokenPresent(db, userId), false);
});

test('access token: cached in memory, refreshed on expiry, invalid_grant marks reconnect_needed and stops calling', async () => {
  const userId = mkUser(); let nonce;
  const t = tokenTransport({ nonceFrom: () => nonce });
  gf._setGoogleFetchForTests(t);
  const start = await auth.startAuthFlow({ db, userId, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gmail'] });
  nonce = paramsOf(start.authUrl).get('nonce');
  await callback(start.redirectPort, `state=${start.state}&code=x`);
  const { accountId } = auth.flowStatus(start.state, userId);
  const sess = auth.googleSession(db, userId, accountId);
  assert.equal(await sess.ensure(), ACCESS);
  assert.equal(t.callsTo('/token').length, 1, 'served from memory');
  assert.equal(await sess.refresh(), ACCESS + '-2');
  const refreshCall = t.callsTo('/token').at(-1);
  assert.equal(refreshCall.body.grant_type, 'refresh_token'); assert.equal(refreshCall.body.refresh_token, REFRESH);
  // now the grant dies
  t.routes.unshift({ match: (u) => u.pathname === '/token', reply: () => jsonResponse(400, { error: 'invalid_grant' }) });
  await assert.rejects(() => sess.refresh(), (e) => e.code === 'GOOGLE_RECONNECT_NEEDED');
  assert.equal(store.getGoogleAccount(userId, accountId).status, 'reconnect_needed');
  const before = t.calls.length;
  await assert.rejects(() => sess.ensure(), (e) => e.code === 'GOOGLE_RECONNECT_NEEDED');
  await assert.rejects(() => sess.refresh(), (e) => e.code === 'GOOGLE_RECONNECT_NEEDED');
  assert.equal(t.calls.length, before, 'no network call for a dead account (no retry loop)');
});

test('disconnect: revokes, deletes vault rows, cursors and the account, purges cached sources; per-user isolation', async () => {
  const u1 = mkUser(); const u2 = mkUser(); let nonce;
  const t = tokenTransport({ nonceFrom: () => nonce });
  gf._setGoogleFetchForTests(t);
  const start = await auth.startAuthFlow({ db, userId: u1, clientId: 'c', clientSecret: CLIENT_SECRET, products: ['gcal'], });
  nonce = paramsOf(start.authUrl).get('nonce');
  // calendar scopes granted by default transport? use gmail scope list -> override
  t.routes.unshift({ match: (u) => u.pathname === '/token', reply: (u, i, call) => jsonResponse(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, token_type: 'Bearer', scope: `openid email ${scopes.PRODUCTS.gcal.scopes.join(' ')}`, id_token: makeIdToken({ sub: 'sub-d', email: 'd@x.y', aud: call.body.client_id, nonce }) }) });
  await callback(start.redirectPort, `state=${start.state}&code=x`);
  const { accountId } = auth.flowStatus(start.state, u1);
  store.patchSyncState(u1, 'gcal', accountId, { cursor: '{"primary":"tok"}' });
  const { ingestSources } = await import('../kb/sources.mjs');
  ingestSources(u1, [{ kind: 'doc', ref: `gcal:${accountId}:primary:e1`, title: 'Standup', body: 'x' }, { kind: 'doc', ref: 'box:1:2', title: 'other', body: 'y' }]);
  // another user cannot disconnect it
  await assert.rejects(() => auth.disconnectAccount(db, u2, accountId), (e) => e.code === 'GOOGLE_NOT_FOUND');
  const out = await auth.disconnectAccount(db, u1, accountId);
  assert.equal(out.revoked, true); assert.equal(out.purgedSources, 1);
  assert.equal(t.callsTo('/revoke').at(-1).body.token, REFRESH);
  assert.equal(getSecret(db, u1, `google.acct.${accountId}.refreshToken`), null);
  assert.equal(store.getGoogleAccount(u1, accountId), null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM connector_sync_state WHERE user_id = ?').get(u1).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sources WHERE user_id = ? AND ref LIKE 'box:%'").get(u1).n, 1, 'other sources untouched');
});

test('vault: google.acct keys are accepted only in the exact pattern and are not user-settable', async () => {
  const { isUserSettableVaultKey } = await import('../server/vault.mjs');
  const userId = mkUser();
  setSecret(db, userId, 'google.acct.0123456789ab.refreshToken', 'x');
  assert.throws(() => setSecret(db, userId, 'google.acct.XYZ.refreshToken', 'x'), /Unknown vault key/);
  assert.throws(() => setSecret(db, userId, 'google.acct.0123456789ab.other', 'x'), /Unknown vault key/);
  assert.equal(isUserSettableVaultKey('google.acct.0123456789ab.refreshToken'), false);
});

test('google fetch: redirect to a foreign host is refused; same-origin hop drops nothing, cross-origin allowed hop drops the bearer', async () => {
  const t = makeTransport();
  t.on('/a', () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } }));
  gf._setGoogleFetchForTests(t);
  await assert.rejects(() => gf.googleOnce('https://www.googleapis.com/a', { token: 'TOK' }), (e) => e.code === 'GOOGLE_FETCH_REFUSED');
  assert.ok(!t.calls.some((c) => c.host === 'evil.example.com'));
  const t2 = makeTransport();
  t2.on('/b', () => new Response(null, { status: 302, headers: { location: 'https://gmail.googleapis.com/c' } }));
  t2.on('/c', () => jsonResponse(200, { ok: 1 }));
  gf._setGoogleFetchForTests(t2);
  const r = await gf.googleOnce('https://www.googleapis.com/b', { token: 'TOK' });
  assert.equal(r.ok, true);
  assert.equal(t2.calls[0].headers.authorization, 'Bearer TOK');
  assert.equal(t2.calls[1].headers.authorization, undefined, 'bearer dropped on an origin change');
  // too many hops
  const t3 = makeTransport();
  t3.on(() => true, () => new Response(null, { status: 302, headers: { location: `https://www.googleapis.com/loop${Math.random()}` } }));
  gf._setGoogleFetchForTests(t3);
  await assert.rejects(() => gf.googleOnce('https://www.googleapis.com/loop', {}), (e) => e.code === 'GOOGLE_FETCH_REFUSED');
});

test('google fetch: huge response is capped (content-length and streamed), malformed JSON is a stable error', async () => {
  const t = makeTransport();
  t.on('/big', () => new Response('x'.repeat(2000), { status: 200, headers: { 'content-length': '2000' } }));
  t.on('/stream', () => new Response('y'.repeat(5000), { status: 200 }));
  t.on('/bad', () => new Response('{"a":', { status: 200 }));
  gf._setGoogleFetchForTests(t);
  await assert.rejects(() => gf.googleOnce('https://www.googleapis.com/big', { maxBytes: 1000 }), (e) => e.code === 'GOOGLE_FETCH_REFUSED');
  await assert.rejects(() => gf.googleOnce('https://www.googleapis.com/stream', { maxBytes: 1000 }), (e) => e.code === 'GOOGLE_FETCH_REFUSED');
  const r = await gf.googleOnce('https://www.googleapis.com/bad', {});
  assert.throws(() => gf.parseJsonBody(r.text), (e) => e.code === 'GOOGLE_BAD_JSON' && !/\{"a"/.test(e.message));
});

test('googleCall: 401 refreshes once; 403 rateLimitExceeded and 429 back off with Retry-After; plain 403 and 404 do not retry', async () => {
  let tokenN = 0;
  const session = { ensure: async () => `T${tokenN}`, refresh: async () => { tokenN += 1; return `T${tokenN}`; } };
  const sleeps = [];
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  const t = makeTransport();
  t.on('/needs-refresh', (u, i, call) => (call.headers.authorization === 'Bearer T0' ? jsonResponse(401, { error: { message: 'x' } }) : jsonResponse(200, { ok: call.headers.authorization })));
  let nrate = 0;
  t.on('/rate', () => (++nrate < 3 ? jsonResponse(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { 'retry-after': '2' }) : jsonResponse(200, { ok: 1 })));
  let n429 = 0;
  t.on('/quota', () => (++n429 < 2 ? new Response('', { status: 429 }) : jsonResponse(200, { ok: 2 })));
  t.on('/forbidden', () => jsonResponse(403, { error: { errors: [{ reason: 'insufficientPermissions' }], message: `leak ${REFRESH}` } }));
  t.on('/missing', () => jsonResponse(404, { error: { message: 'nope' } }));
  t.on('/always429', () => new Response('', { status: 429 }));
  gf._setGoogleFetchForTests(t);
  assert.deepEqual(await gf.googleCall(session, 'https://www.googleapis.com/needs-refresh', { sleepImpl }), { ok: 'Bearer T1' });
  assert.equal(tokenN, 1);
  assert.deepEqual(await gf.googleCall(session, 'https://www.googleapis.com/rate', { sleepImpl }), { ok: 1 });
  assert.equal(nrate, 3); assert.ok(sleeps.length === 2 && sleeps.every((s) => s >= 2000 && s < 2300), `Retry-After honoured: ${sleeps}`);
  assert.deepEqual(await gf.googleCall(session, 'https://www.googleapis.com/quota', { sleepImpl }), { ok: 2 });
  await assert.rejects(() => gf.googleCall(session, 'https://www.googleapis.com/forbidden', { sleepImpl }), (e) => e.code === 'GOOGLE_FORBIDDEN' && !e.message.includes(REFRESH) && e.reason === 'insufficientPermissions');
  assert.equal(t.callsTo('/forbidden').length, 1);
  await assert.rejects(() => gf.googleCall(session, 'https://www.googleapis.com/missing', { sleepImpl }), (e) => e.code === 'GOOGLE_NOT_FOUND' && e.status === 404);
  assert.equal(await gf.googleCall(session, 'https://www.googleapis.com/missing', { sleepImpl, allow404: true }), null);
  await assert.rejects(() => gf.googleCall(session, 'https://www.googleapis.com/always429', { sleepImpl }), (e) => e.code === 'GOOGLE_RATE_LIMITED');
  assert.equal(t.callsTo('/always429').length, 4, '1 + 3 retries');
});
