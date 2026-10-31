// Google OAuth core for the Gmail, Calendar and Drive connectors (plan 2026-10-31-google-connectors-plan.md, G0/G1).
//
// Flow: Authorization Code + PKCE (S256) with a loopback redirect owned by the CORE. `startAuthFlow` binds a
// listener on 127.0.0.1 and an ephemeral port, only for this one flow: state + OIDC nonce, 5 minute timeout, single
// use, closed as soon as the callback is handled (or on timeout / abort). It returns the Google authorization URL;
// the CLIENT opens it in the system browser (the server never opens anything, the webview never sees a token).
//
// Credentials: a bring-your-own OAuth client (Desktop app type). The client id/secret and the refresh token live in
// the per-user vault under google.acct.<accountId>.*, written only after the token exchange proved the pair works.
// Access tokens live in memory with their expiry and are never persisted. The account id is the first 12 hex
// characters of sha256 of the Google `sub`, derived here from the token response, never from the client.
//
// The granted scope string is checked against what was requested: a grant with anything extra is refused AND revoked;
// a grant missing something turns only that product off (recorded, shown to the user).
//
// Every request goes through google-fetch.mjs (pinned, host allowlist, capped). No token, secret, code or response
// body reaches a log, an error message or an audit row: errors here carry stable codes and fixed text.
import crypto from 'node:crypto';
import http from 'node:http';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { redactWithKey } from '../../core/redact-secrets.mjs';
import { deleteSourcesByPrefix } from '../../kb/sources.mjs';
import {
  upsertGoogleAccount, getGoogleAccount, deleteGoogleAccount, setGoogleAccountStatus,
} from '../../kb/google-store.mjs';
import { googleOnce, parseJsonBody, GoogleApiError } from './google-fetch.mjs';
import {
  scopesFor, checkGranted, productsEnabledBy, driveContentGranted, describeScopes, PRODUCT_IDS,
} from './google-scopes.mjs';

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const TERMINAL_KEEP_MS = 10 * 60 * 1000;
const MAX_FLOWS = 8;
const MAX_BAD_CALLBACKS = 5;
const CALLBACK_PATH = '/oauth2/callback';
const ACCESS_TOKEN_MAX_MS = 55 * 60 * 1000;
const SKEW_MS = 60 * 1000;
const TOKEN_BODY_MAX = 64 * 1024;

const LEGACY_KEYS = ['google.email.refreshToken', 'google.email.clientId', 'google.email.clientSecret'];

// ---- pure helpers -----------------------------------------------------------------------------------------------

export function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url'); // 64 URL-safe characters (RFC 7636: 43..128)
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function accountIdFromSub(sub) {
  return crypto.createHash('sha256').update(`google-sub:${String(sub)}`).digest('hex').slice(0, 12);
}

const acctKey = (id, field) => `google.acct.${id}.${field}`;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Claims of an ID token received DIRECTLY from the token endpoint over the pinned TLS connection. The signature is
 * not verified (OpenID Connect Core 3.1.3.7 allows that for this path); aud, iss, exp and nonce are.
 */
export function readIdToken(idToken, { clientId, nonce, now = Date.now() }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new GoogleApiError('GOOGLE_BAD_ID_TOKEN', 'Google returned no usable identity');
  let c;
  try { c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new GoogleApiError('GOOGLE_BAD_ID_TOKEN', 'Google returned no usable identity'); }
  const issOk = c?.iss === 'https://accounts.google.com' || c?.iss === 'accounts.google.com';
  const audOk = Array.isArray(c?.aud) ? c.aud.includes(clientId) : c?.aud === clientId;
  if (!issOk || !audOk) throw new GoogleApiError('GOOGLE_BAD_ID_TOKEN', 'The identity token was not issued for this client');
  if (typeof c.exp !== 'number' || c.exp * 1000 < now - SKEW_MS) throw new GoogleApiError('GOOGLE_BAD_ID_TOKEN', 'The identity token is expired');
  if (typeof c.nonce !== 'string' || !safeEqual(c.nonce, nonce)) throw new GoogleApiError('GOOGLE_BAD_ID_TOKEN', 'The identity token nonce does not match');
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw new GoogleApiError('GOOGLE_BAD_ID_TOKEN', 'The identity token has no subject');
  return { sub: c.sub, email: typeof c.email === 'string' ? c.email.slice(0, 320) : '' };
}

export function buildAuthUrl({ clientId, redirectUri, state, challenge, nonce, scopes, loginHint }) {
  const u = new URL(AUTH_ENDPOINT);
  const p = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  if (loginHint) p.login_hint = loginHint;
  u.search = new URLSearchParams(p).toString();
  return u.toString();
}

// ---- token endpoint ---------------------------------------------------------------------------------------------

function tokenFailure(r, secret) {
  let err = '';
  try { const j = JSON.parse(r.text); err = typeof j.error === 'string' ? j.error : ''; } catch { /* no body detail */ }
  const code = err === 'invalid_grant' ? 'GOOGLE_INVALID_GRANT' : err === 'invalid_client' ? 'GOOGLE_INVALID_CLIENT' : 'GOOGLE_TOKEN_ERROR';
  return new GoogleApiError(code, redactWithKey(`Google token request failed (${r.status}${err ? ` ${err.slice(0, 40)}` : ''})`, secret), { status: r.status });
}

async function tokenPost(form, secret) {
  const r = await googleOnce(TOKEN_ENDPOINT, { method: 'POST', form, maxBytes: TOKEN_BODY_MAX });
  if (!r.ok) throw tokenFailure(r, secret);
  const d = parseJsonBody(r.text);
  if (typeof d.access_token !== 'string' || !d.access_token) throw new GoogleApiError('GOOGLE_TOKEN_ERROR', 'Google returned no access token');
  return d;
}

/** Revoke a token (access or refresh). Never throws; `ok` false means the grant may still be visible in the Google account. */
export async function revokeToken(token) {
  if (!token) return { ok: false, reason: 'no_token' };
  try {
    const r = await googleOnce(REVOKE_ENDPOINT, { method: 'POST', form: { token }, maxBytes: 16 * 1024 });
    return r.ok ? { ok: true } : { ok: false, reason: `http_${r.status}` };
  } catch (e) {
    return { ok: false, reason: e?.code || 'error' };
  }
}

// ---- in-memory flow table ---------------------------------------------------------------------------------------

/** @type {Map<string, any>} state -> flow */
const flows = new Map();

function sweepFlows() {
  const now = Date.now();
  for (const [k, f] of flows) if (f.status !== 'pending' && now - f.endedAt > TERMINAL_KEEP_MS) flows.delete(k);
}

function closeFlowServer(f) {
  if (f.timer) { clearTimeout(f.timer); f.timer = null; }
  const s = f.server; f.server = null;
  // close() stops accepting at once; lingering keep-alive sockets (and the response being written) get a moment.
  if (s) { try { s.close(); const t = setTimeout(() => { try { s.closeAllConnections?.(); } catch { /* gone */ } }, 300); t.unref?.(); } catch { /* already closed */ } }
}

function endFlow(f, status, extra = {}) {
  f.status = status; f.endedAt = Date.now();
  Object.assign(f.result, extra);
  // secrets are not needed past this point
  f.verifier = null; f.clientSecret = null;
  closeFlowServer(f);
}

/** Abort every pending flow of a user (a new start replaces the old one; logout/disconnect may call it too). */
export function abortUserFlows(userId, message = 'Replaced by a newer connect attempt.') {
  for (const f of flows.values()) if (f.userId === userId && f.status === 'pending') endFlow(f, 'error', { message });
}

/** The flow's public status. Terminal results are returned once and removed (single use read). */
export function flowStatus(state, userId) {
  sweepFlows();
  const f = flows.get(String(state || ''));
  if (!f) return { status: 'unknown' };
  if (f.userId !== userId) return { forbidden: true };
  if (f.status === 'pending') return { status: 'pending' };
  flows.delete(f.state);
  return { status: f.status, ...f.result };
}

export function _flowCountForTests() { return flows.size; }
export function _resetGoogleAuthForTests() {
  for (const f of flows.values()) closeFlowServer(f);
  flows.clear();
  tokenCache.clear();
  refreshing.clear();
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(res, status, msg) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Connection': 'close', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:2rem"><p>${escHtml(msg)}</p><p>You can close this tab and return to LLM-IDE.</p>`);
}

// ---- starting a flow --------------------------------------------------------------------------------------------

/**
 * Bind the loopback listener and build the authorization URL.
 * @param {{ db: object, userId: string, clientId?: string, clientSecret?: string, products: string[], driveContent?: boolean,
 *   existingAccountId?: string, timeoutMs?: number }} o
 * @returns {Promise<{ authUrl: string, state: string, redirectPort: number, expiresInSec: number, scopes: object[], legacyMailTokenRevoked: boolean }>}
 */
export async function startAuthFlow({ db, userId, clientId, clientSecret, products, driveContent = false, existingAccountId, timeoutMs = FLOW_TIMEOUT_MS }) {
  if (!userId) throw new GoogleApiError('GOOGLE_BAD_REQUEST', 'user required');
  const prods = [...new Set((products || []).map(String))];
  if (prods.length === 0 || prods.some((p) => !PRODUCT_IDS.includes(p))) throw new GoogleApiError('GOOGLE_BAD_REQUEST', 'products must be a non-empty list of gmail, gcal, gdrive');

  let cid = typeof clientId === 'string' ? clientId.trim() : '';
  let sec = typeof clientSecret === 'string' ? clientSecret.trim() : '';
  let existing = null;
  if (existingAccountId) {
    existing = getGoogleAccount(userId, existingAccountId);
    if (!existing) throw new GoogleApiError('GOOGLE_NOT_FOUND', 'Unknown Google account');
    if (!cid && !sec) { cid = getSecret(db, userId, acctKey(existingAccountId, 'clientId')) || ''; sec = getSecret(db, userId, acctKey(existingAccountId, 'clientSecret')) || ''; }
  }
  // A user who already created a Desktop client for the legacy Gmail sign-in may reuse it: it is the user's own client.
  let usedLegacyClient = false;
  if (!cid && !sec) {
    cid = getSecret(db, userId, 'google.email.clientId') || ''; sec = getSecret(db, userId, 'google.email.clientSecret') || '';
    usedLegacyClient = !!(cid && sec);
  }
  if (!cid || !sec) throw new GoogleApiError('GOOGLE_BAD_REQUEST', 'clientId and clientSecret are required');
  if (cid.length > 300 || sec.length > 300) throw new GoogleApiError('GOOGLE_BAD_REQUEST', 'clientId or clientSecret is too long');

  // Reconnect or an upgrade keeps what the account already had, so the granted set never needs include_granted_scopes.
  const wantProducts = new Set(prods);
  let wantDriveContent = !!driveContent;
  if (existing) { for (const p of existing.products) wantProducts.add(p); wantDriveContent = wantDriveContent || existing.driveContent; }
  const scopes = scopesFor([...wantProducts], { driveContent: wantDriveContent });

  sweepFlows();
  abortUserFlows(userId);
  if ([...flows.values()].filter((f) => f.status === 'pending').length >= MAX_FLOWS) throw new GoogleApiError('GOOGLE_BUSY', 'Too many sign-ins in progress');

  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const flow = {
    state, userId, verifier, nonce, clientId: cid, clientSecret: sec, scopes, products: [...wantProducts], driveContent: wantDriveContent,
    existingAccountId: existing?.accountId || null, usedLegacyClient, status: 'pending', result: {}, bad: 0, consumed: false, server: null, timer: null, endedAt: 0, redirectUri: '', db,
  };

  const server = http.createServer((req, res) => { handleCallback(flow, req, res).catch(() => { try { page(res, 500, 'Sign-in failed.'); } catch { /* */ } }); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = server.address().port;
  flow.server = server;
  flow.redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  flow.timer = setTimeout(() => endFlow(flow, 'error', { message: 'The sign-in timed out. Start again from the app.' }), timeoutMs);
  flow.timer.unref?.();
  flows.set(state, flow);

  // The legacy Gmail grant asked for the full mailbox (mail.google.com). Revoke it BEFORE the new consent, so a revoke
  // can never take the new grant with it, and delete it locally either way. Nothing reads mail with it again.
  const legacyMailTokenRevoked = await revokeLegacyMailToken(db, userId);

  return {
    authUrl: buildAuthUrl({ clientId: cid, redirectUri: flow.redirectUri, state, challenge, nonce, scopes, loginHint: existing?.email || undefined }),
    state, redirectPort: port, expiresInSec: Math.round(timeoutMs / 1000), scopes: describeScopes(scopes), legacyMailTokenRevoked,
  };
}

/** True when the vault still holds the legacy `mail.google.com` refresh token. */
export function legacyMailTokenPresent(db, userId) {
  try { return !!getSecret(db, userId, 'google.email.refreshToken'); } catch { return false; }
}

/** Revoke (best effort) and delete the legacy full-mailbox token and its client fields. Returns true when a token existed. */
export async function revokeLegacyMailToken(db, userId) {
  let rt = null;
  try { rt = getSecret(db, userId, 'google.email.refreshToken'); } catch { rt = null; }
  if (!rt) return false;
  await revokeToken(rt);
  for (const k of LEGACY_KEYS) { try { setSecret(db, userId, k, ''); } catch { /* best effort */ } }
  return true;
}

// ---- the callback -----------------------------------------------------------------------------------------------

async function handleCallback(flow, req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const port = flow.server?.address?.()?.port;
  const hostOk = port && req.headers.host === `127.0.0.1:${port}`;
  if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || !hostOk) { page(res, 404, 'Not found.'); return; }
  if (flow.status !== 'pending') { page(res, 400, 'This sign-in link has already been used. Start again from the app.'); return; }
  const given = url.searchParams.get('state') || '';
  if (!given || !safeEqual(given, flow.state)) {
    flow.bad += 1;
    if (flow.bad >= MAX_BAD_CALLBACKS) endFlow(flow, 'error', { message: 'Sign-in aborted after repeated invalid callbacks.' });
    page(res, 400, 'This sign-in link is not valid. Start again from the app.');
    return;
  }
  if (flow.consumed) { page(res, 400, 'This sign-in link has already been used. Start again from the app.'); return; }
  flow.consumed = true; // single use: set before any await
  if (url.searchParams.get('error')) {
    endFlow(flow, 'error', { message: 'Sign-in cancelled.' });
    page(res, 200, 'Sign-in cancelled.');
    return;
  }
  const code = url.searchParams.get('code') || '';
  if (!code || code.length > 2048) { endFlow(flow, 'error', { message: 'Google returned no authorization code.' }); page(res, 400, 'Sign-in failed.'); return; }
  const secret = flow.clientSecret;
  try {
    const result = await finishFlow(flow, code);
    endFlow(flow, 'complete', result);
    page(res, 200, 'Connected to Google.');
  } catch (e) {
    const msg = e instanceof GoogleApiError ? e.message : 'Sign-in failed.';
    endFlow(flow, 'error', { message: redactWithKey(msg, secret) });
    page(res, 200, 'Sign-in failed.');
  }
}

async function finishFlow(flow, code) {
  const { db, userId, clientId, clientSecret } = flow;
  const tok = await tokenPost({
    grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret,
    code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri,
  }, clientSecret);
  // From here on, any refusal revokes what Google just minted.
  const refuseAndRevoke = async (e) => { await revokeToken(tok.refresh_token || tok.access_token); throw e; };
  if (String(tok.token_type || '').toLowerCase() !== 'bearer') await refuseAndRevoke(new GoogleApiError('GOOGLE_TOKEN_ERROR', 'Google returned an unexpected token type'));
  const check = checkGranted(flow.scopes, tok.scope);
  if (!check.ok) {
    await refuseAndRevoke(new GoogleApiError('GOOGLE_SCOPE_MISMATCH', check.extra.length
      ? 'Google granted more access than was requested. The connection was refused and the grant revoked.'
      : 'Google granted no access.'));
  }
  if (typeof tok.refresh_token !== 'string' || !tok.refresh_token) {
    await refuseAndRevoke(new GoogleApiError('GOOGLE_NO_REFRESH_TOKEN', 'Google did not return a refresh token. Remove the app under myaccount.google.com/permissions and connect again.'));
  }
  let ident;
  try { ident = readIdToken(tok.id_token, { clientId, nonce: flow.nonce }); } catch (e) { return refuseAndRevoke(e); }
  const products = productsEnabledBy(check.granted);
  if (products.length === 0) await refuseAndRevoke(new GoogleApiError('GOOGLE_SCOPE_MISMATCH', 'None of the requested access was granted.'));
  const driveContent = driveContentGranted(check.granted);
  const accountId = accountIdFromSub(ident.sub);

  setSecret(db, userId, acctKey(accountId, 'refreshToken'), tok.refresh_token);
  setSecret(db, userId, acctKey(accountId, 'clientId'), clientId);
  setSecret(db, userId, acctKey(accountId, 'clientSecret'), clientSecret);
  upsertGoogleAccount(userId, { accountId, email: ident.email, scopes: check.granted, products, driveContent });
  cacheAccessToken(userId, accountId, tok.access_token, tok.expires_in);
  // The legacy client pair now lives under the account; the legacy copy is no longer needed.
  if (flow.usedLegacyClient) for (const k of ['google.email.clientId', 'google.email.clientSecret']) { try { setSecret(db, userId, k, ''); } catch { /* best effort */ } }
  return { accountId, email: ident.email, products, grantedScopes: check.granted, missingScopes: check.missing, driveContent };
}

// ---- access tokens (memory only) --------------------------------------------------------------------------------

/** @type {Map<string, { token: string, expiresAt: number }>} */
const tokenCache = new Map();
/** @type {Map<string, Promise<string>>} */
const refreshing = new Map();
const cacheKey = (userId, accountId) => `${userId}\u0000${accountId}`;

function cacheAccessToken(userId, accountId, token, expiresInSec) {
  const ms = Math.min(ACCESS_TOKEN_MAX_MS, Math.max(0, Number(expiresInSec) || 3300) * 1000);
  tokenCache.set(cacheKey(userId, accountId), { token, expiresAt: Date.now() + ms });
}

/**
 * A `{ ensure, refresh }` pair for googleCall. `ensure` returns a cached access token or refreshes; `refresh` forces a
 * refresh. An account already marked reconnect_needed fails at once, with no network call (no retry loop on a dead token);
 * `invalid_grant` marks it so.
 */
export function googleSession(db, userId, accountId) {
  const key = cacheKey(userId, accountId);
  async function doRefresh() {
    const acct = getGoogleAccount(userId, accountId);
    if (!acct) throw new GoogleApiError('GOOGLE_NOT_FOUND', 'Unknown Google account');
    if (acct.status === 'reconnect_needed') throw new GoogleApiError('GOOGLE_RECONNECT_NEEDED', 'Reconnect this Google account.');
    const refreshToken = getSecret(db, userId, acctKey(accountId, 'refreshToken'));
    const clientId = getSecret(db, userId, acctKey(accountId, 'clientId'));
    const clientSecret = getSecret(db, userId, acctKey(accountId, 'clientSecret'));
    if (!refreshToken || !clientId || !clientSecret) { setGoogleAccountStatus(userId, accountId, 'reconnect_needed'); throw new GoogleApiError('GOOGLE_RECONNECT_NEEDED', 'Reconnect this Google account.'); }
    try {
      const d = await tokenPost({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }, clientSecret);
      cacheAccessToken(userId, accountId, d.access_token, d.expires_in);
      return d.access_token;
    } catch (e) {
      if (e?.code === 'GOOGLE_INVALID_GRANT' || e?.code === 'GOOGLE_INVALID_CLIENT') {
        tokenCache.delete(key);
        setGoogleAccountStatus(userId, accountId, 'reconnect_needed');
        throw new GoogleApiError('GOOGLE_RECONNECT_NEEDED', 'Reconnect this Google account.');
      }
      throw e;
    }
  }
  const single = () => {
    let p = refreshing.get(key);
    if (!p) { p = doRefresh().finally(() => refreshing.delete(key)); refreshing.set(key, p); }
    return p;
  };
  return {
    async ensure() {
      const acct = getGoogleAccount(userId, accountId);
      if (acct?.status === 'reconnect_needed') throw new GoogleApiError('GOOGLE_RECONNECT_NEEDED', 'Reconnect this Google account.');
      const c = tokenCache.get(key);
      if (c && c.expiresAt - SKEW_MS > Date.now()) return c.token;
      return single();
    },
    async refresh() { tokenCache.delete(key); return single(); },
  };
}

// ---- disconnect -------------------------------------------------------------------------------------------------

/**
 * Revoke the refresh token at Google, delete the vault rows, the sync cursors and the account row, and purge the cached
 * index rows (Calendar and Drive sources). Gmail notes were written into the Library folder by the client and are not
 * touched here. If the revoke fails (offline) the local credentials are deleted anyway and `revoked` is false: the grant
 * stays visible at myaccount.google.com/permissions.
 */
export async function disconnectAccount(db, userId, accountId) {
  const acct = getGoogleAccount(userId, accountId);
  if (!acct) throw new GoogleApiError('GOOGLE_NOT_FOUND', 'Unknown Google account');
  let rt = null;
  try { rt = getSecret(db, userId, acctKey(accountId, 'refreshToken')); } catch { rt = null; }
  const rev = rt ? await revokeToken(rt) : { ok: false, reason: 'no_token' };
  for (const f of ['refreshToken', 'clientId', 'clientSecret']) { try { setSecret(db, userId, acctKey(accountId, f), ''); } catch { /* best effort */ } }
  tokenCache.delete(cacheKey(userId, accountId));
  const purged = deleteSourcesByPrefix(userId, 'doc', `gcal:${accountId}:`) + deleteSourcesByPrefix(userId, 'doc', `gdrive:${accountId}:`);
  const removed = deleteGoogleAccount(userId, accountId);
  return { ok: true, revoked: rev.ok, purgedSources: purged, removed };
}
