// HTTP routes for /auth/*.  Kept separate from routes/router.mjs because
// (a) these are public-or-semi-public and have different threat
// posture, and (b) they take a direct DB handle rather than going
// through the kb facade.

import crypto from 'node:crypto';
import { config } from '../core/config.mjs';
import { errAuth, errNotFound, errValidation } from '../core/errors.mjs';
import { tryConsume } from './rate-limit.mjs';
import {
  changePassword, findUserById, login, logout, logoutAll, refreshSession, registerUser,
  createPasswordResetToken, consumePasswordResetToken,
} from './users.mjs';
import { listSecretKeys, setSecret, VAULT_KEYS, isVaultError, isUserSettableVaultKey } from './vault.mjs';
import {
  pkcePair, buildAuthUrl, exchangeCode, fetchEmailAddress,
  putState, getState, completeState, takeStatus,
} from '../connectors/google-oauth.mjs';
import {
  buildAuthUrl as buildSlackAuthUrl, exchangeCode as exchangeSlackCode,
  putState as putSlackState, getState as getSlackState,
  completeState as completeSlackState, takeStatus as takeSlackStatus,
} from '../connectors/slack-oauth.mjs';
import {
  startMcpAuthorization, finishMcpAuthorization, isMcpConnected,
  putMcpState, getMcpState, completeMcpState, takeMcpStatus,
} from '../connectors/mcp-client.mjs';
import { mcpConnectorDef } from '../connectors/mcp-connector-defs.mjs';
import { redactSecrets, redactWithKey } from '../core/redact-secrets.mjs';

// Errors surfaced by the MCP OAuth flow can carry the authorization server's
// RAW response body verbatim (the SDK appends "Raw body: <body>" whenever the
// response is not OAuth-shaped). That body reaches an HTML page and the stored
// flow status, so it is redacted and bounded before it leaves the process — a
// token endpoint that echoes its request would otherwise echo back `code` or
// `client_secret`, unbounded in length.
const MCP_ERR_MAX = 500;
function mcpPublicMessage(err) {
  const msg = redactSecrets(publicMessageFor(err));
  return msg.length > MCP_ERR_MAX ? msg.slice(0, MCP_ERR_MAX) + '…' : msg;
}

// Shared OAuth-callback HTML response — both Google and Slack redirect here
// after consent. A single copy so this HTML-escaping (a security control)
// can't silently drift between the two provider callbacks.
function oauthCallbackHtml(res, msg, status = 200) {
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:2rem"><p>${escHtml(msg)}</p><p>You can close this tab and return to LLM-IDE.</p><script>setTimeout(()=>window.close(),1500)</script>`);
}
import { send, readJson, clientIp, safeAudit, publicMessageFor } from './route-http.mjs';
import { dropAllHeldSecretsForUser } from './review-secrets.mjs';
import { flushWarmCliPool } from '../providers/warm-cli-pool.mjs';
import { getUserPrefs, setUserPrefs, revokeJti } from '../kb/db.mjs';

// Returns true when the request URL is one this module owns.  Caller
// dispatches us before falling through to the KB router.  The query
// string is stripped before matching so /auth/me/audit?limit=N still
// dispatches correctly.
export function isAuthRoute(url) {
  const path = String(url || '').split('?')[0];
  return path === '/auth/well-known'
      || path === '/auth/register'
      || path === '/auth/login'
      || path === '/auth/refresh'
      || path === '/auth/reset-request'
      || path === '/auth/reset-confirm'
      || path === '/auth/logout'
      || path === '/auth/me'
      || path === '/auth/me/delete'
      || path === '/auth/me/password'
      || path === '/auth/me/secrets'
      || path === '/auth/me/audit'
      || path === '/auth/me/repos'
      || path === '/auth/me/prefs'
      || path === '/auth/me/connectors'
      || path === '/auth/me/connectors/catalog'
      || path === '/auth/me/connectors/add'
      || path.startsWith('/auth/me/connectors/')
      || path === '/auth/mcp-connector/start'
      || path === '/auth/mcp-connector/callback'
      || path === '/auth/mcp-connector/status'
      || path === '/auth/google/start'
      || path === '/auth/google/callback'
      || path === '/auth/google/status'
      || path === '/auth/slack/start'
      || path === '/auth/slack/callback'
      || path === '/auth/slack/status';
}

export async function handleAuth(req, res, { db, logger, requestId }) {
  const url = req.url || '';
  const method = req.method;
  const bodyLimit = config.bodyLimitMB * 1024 * 1024;
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  // Public discovery.  Lets the side panel decide whether to render the
  // register button (vs. show "ask your admin to create an account").
  if (method === 'GET' && url === '/auth/well-known') {
    send(res, 200, {
      issuer: config.jwtIssuer,
      registrationOpen: config.registrationOpen,
      vaultKeys: VAULT_KEYS,
      accessTokenTTLSec: config.accessTokenTTLSec,
    });
    return;
  }

  // ---- Public, rate-limited per-IP ----------------------------------

  if (method === 'POST' && url === '/auth/register') {
    const r = tryConsume('authRegister', ip);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      return;
    }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      const user = registerUser(db, {
        email: body.email,
        password: body.password,
        displayName: body.displayName,
      });
      safeAudit(db, { userId: user.id, requestId, ip, userAgent: ua, action: 'auth.register', outcome: 'success' });
      send(res, 201, { user });
    } catch (err) {
      safeAudit(db, { userId: null, requestId, ip, userAgent: ua, action: 'auth.register', outcome: 'failure', detail: { error: err.code || err.message } });
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  if (method === 'POST' && url === '/auth/login') {
    const r = tryConsume('authPublic', `login:${ip}`);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      return;
    }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      const session = login(db, { email: body.email, password: body.password, userAgent: ua });
      safeAudit(db, { userId: session.user.id, requestId, ip, userAgent: ua, action: 'auth.login', outcome: 'success' });
      send(res, 200, session);
    } catch (err) {
      safeAudit(db, { userId: null, requestId, ip, userAgent: ua, action: 'auth.login', outcome: 'failure', detail: { error: err.code || err.message } });
      send(res, err.status || 401, { error: { code: err.code || 'AUTH_REQUIRED', message: err.message } });
    }
    return;
  }

  if (method === 'POST' && url === '/auth/refresh') {
    // Read body first so we can key the rate-limit bucket by the
    // refresh token rather than just the IP.  An IP-only key lets a
    // single machine (or a shared NAT) lock out every user behind it —
    // keying by the first 24 chars of the refresh token gives each
    // session its own independent bucket without revealing the token.
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    const rtKey = typeof body.refreshToken === 'string' && body.refreshToken.length >= 8
      ? `refresh:token:${body.refreshToken.slice(0, 24)}`
      : `refresh:ip:${ip}`;
    const r = tryConsume('authPublic', rtKey);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      return;
    }
    try {
      const session = refreshSession(db, { refreshToken: body.refreshToken, userAgent: ua });
      send(res, 200, session);
    } catch (err) {
      send(res, err.status || 401, { error: { code: err.code || 'AUTH_REQUIRED', message: err.message } });
    }
    return;
  }

  // ---- Password reset (public, rate-limited per IP) ------------------
  //
  // POST /auth/reset-request { email }
  //   Always returns 200 even for unknown emails (prevents enumeration).
  //   In dev: raw token is in the response.
  //   In prod: token is written to the server log; operator delivers OOB.
  //
  // POST /auth/reset-confirm { token, newPassword }
  //   Consumes the token (single-use, 1-hour TTL) and sets the new
  //   password.  Revokes all active sessions for that user.

  if (method === 'POST' && url === '/auth/reset-request') {
    const r = tryConsume('authPublic', `reset-request:${ip}`);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      return;
    }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      const result = createPasswordResetToken(db, { email: body.email });
      if (result.token) {
        if (config.isProd) {
          // Production: write token to structured log; operator delivers OOB.
          // Replace this block with your SMTP / SES / SendGrid call.
          logger.warn('password_reset_token', {
            email: result.email,
            token: result.token,
            expiresAt: result.expiresAt,
            note: 'Deliver this token OOB to the user requesting the reset.',
          });
          send(res, 200, { ok: true, message: 'If that email is registered, check the server logs for the reset token.' });
        } else {
          // Development: return token directly for easy local testing.
          send(res, 200, { ok: true, token: result.token, expiresAt: result.expiresAt });
        }
      } else {
        // Unknown / disabled account — same shape as success.
        send(res, 200, { ok: true, message: 'If that email is registered, check the server logs for the reset token.' });
      }
    } catch (err) {
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  if (method === 'POST' && url === '/auth/reset-confirm') {
    const r = tryConsume('authPublic', `reset-confirm:${ip}`);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      return;
    }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      consumePasswordResetToken(db, { token: body.token, newPassword: body.newPassword });
      safeAudit(db, { userId: null, requestId, ip, userAgent: ua, action: 'auth.password_reset', outcome: 'success' });
      send(res, 200, { ok: true });
    } catch (err) {
      safeAudit(db, { userId: null, requestId, ip, userAgent: ua, action: 'auth.password_reset', outcome: 'failure', detail: { error: err.code || err.message } });
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  // ---- OAuth callbacks: one per-IP bucket for all three ------------------
  //
  // These are public GETs (the provider's redirect carries no bearer), and
  // the dispatcher's rateLimitProfile throttles POSTs plus two named GETs
  // only — so until now they were the one unauthenticated surface with no
  // bucket at all. `state` is verified before any outbound exchange, so a
  // hammered callback costs a lookup and an HTML page rather than a token
  // round-trip — but a free loop against a public route is still a free loop.
  // Same per-IP bucket as login/refresh; a real sign-in is a single redirect.
  const OAUTH_CALLBACK_PATHS = new Set([
    '/auth/google/callback', '/auth/slack/callback', '/auth/mcp-connector/callback',
  ]);
  if (method === 'GET' && OAUTH_CALLBACK_PATHS.has(url.split('?')[0])) {
    const r = tryConsume('authPublic', `oauth-callback:${ip}`);
    if (!r.ok) {
      // A browser tab is looking at this, not XHR — render the page.
      res.setHeader('Retry-After', String(r.retryAfterSec));
      oauthCallbackHtml(res, 'Too many sign-in attempts — wait a moment and start again from the app.', 429);
      return;
    }
  }

  // ---- Google Sign-In callback (public) -------------------------------
  //
  // GET /auth/google/callback?code=...&state=...
  //   Google redirects the user's browser here after consent — there is
  //   no Authorization header on this request, so it must stay public
  //   (also allow-listed in server/auth.mjs PUBLIC_PATHS). The state
  //   token (minted by POST /auth/google/start) carries the userId, PKCE
  //   verifier, and the already-resolved clientId/clientSecret (BYO or
  //   hosted) — never re-derived here, so this code path is identical
  //   for both.
  if (method === 'GET' && url.split('?')[0] === '/auth/google/callback') {
    const q = new URL(url, 'http://127.0.0.1').searchParams;
    const state = q.get('state') || '';
    const st = getState(state);
    if (q.get('error')) { if (st) completeState(state, { status: 'error', message: 'Sign-in cancelled.' }); oauthCallbackHtml(res, 'Sign-in cancelled.'); return; }
    if (!st) { oauthCallbackHtml(res, 'This sign-in link has expired — start again from the app.'); return; }
    if (st.status !== 'pending') { oauthCallbackHtml(res, 'This sign-in link has already been used — start again from the app.'); return; }
    const { clientId, clientSecret, isByo } = st;
    try {
      const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/google/callback';
      const tok = await exchangeCode({ clientId, clientSecret, code: q.get('code') || '', verifier: st.verifier, redirectUri });
      if (!tok.refreshToken) throw new Error('Google did not return a refresh token — remove the app under myaccount.google.com/permissions and try again.');
      setSecret(db, st.userId, 'google.email.refreshToken', tok.refreshToken);
      if (isByo) {
        // Only now — after the token exchange has proven this exact
        // clientId/clientSecret pair actually works against Google — persist
        // them for future refreshes. Deliberately NOT done in /start (see
        // the comment there): an abandoned attempt must never leave
        // unverified credentials sitting in the vault.
        setSecret(db, st.userId, 'google.email.clientId', clientId);
        setSecret(db, st.userId, 'google.email.clientSecret', clientSecret);
      } else {
        // This flow used the hosted client, so the new refresh token is
        // minted under it — clear any stale per-user clientId/clientSecret
        // left over from a PREVIOUS bring-your-own setup. Otherwise the
        // token-refresh resolver (connectors/email-source.mjs) would find the
        // old BYO client still present, prefer it, and try to refresh a
        // hosted-minted token with the wrong client — Google rejects that
        // outright (invalid_grant), permanently breaking the connection.
        setSecret(db, st.userId, 'google.email.clientId', '');
        setSecret(db, st.userId, 'google.email.clientSecret', '');
      }
      const email = await fetchEmailAddress(tok.accessToken).catch(() => '');
      completeState(state, { status: 'complete', email });
      oauthCallbackHtml(res, 'Signed in to Google.');
    } catch (e) {
      completeState(state, { status: 'error', message: redactWithKey(e.message, clientSecret) });
      oauthCallbackHtml(res, 'Sign-in failed: ' + redactWithKey(e.message, clientSecret));
    }
    return;
  }

  // ---- Slack Connect callback (public) --------------------------------
  //
  // GET /auth/slack/callback?code=...&state=...
  //   Slack redirects the user's browser here after consent — no bearer
  //   token on this request, so it stays public (allow-listed in
  //   server/auth.mjs PUBLIC_PATHS). Unlike Google, LLM-IDE owns the Slack
  //   App itself: client id/secret come from config (env vars), never from
  //   the vault or the query string.
  if (method === 'GET' && url.split('?')[0] === '/auth/slack/callback') {
    const q = new URL(url, 'http://127.0.0.1').searchParams;
    const state = q.get('state') || '';
    const st = getSlackState(state);
    if (q.get('error')) { if (st) completeSlackState(state, { status: 'error', message: 'Sign-in cancelled.' }); oauthCallbackHtml(res, 'Sign-in cancelled.'); return; }
    if (!st) { oauthCallbackHtml(res, 'This sign-in link has expired — start again from the app.'); return; }
    if (st.status !== 'pending') { oauthCallbackHtml(res, 'This sign-in link has already been used — start again from the app.'); return; }
    let tok;
    try {
      const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/slack/callback';
      tok = await exchangeSlackCode({
        clientId: config.slackClientId, clientSecret: config.slackClientSecret,
        code: q.get('code') || '', redirectUri,
      });
      setSecret(db, st.userId, 'slack.userToken', tok.accessToken);
    } catch (e) {
      const msg = redactWithKey(publicMessageFor(e), config.slackClientSecret);
      if (isVaultError(e)) {
        process.stderr.write(JSON.stringify({ level: 'warn', msg: 'slack_oauth_vault_set_failed', error: e.message }) + '\n');
      }
      completeSlackState(state, { status: 'error', message: msg });
      oauthCallbackHtml(res, 'Connection failed: ' + msg);
      return;
    }
    // Vault write succeeded — nothing below this point can turn a
    // successful connection into an "error" state.
    safeAudit(db, {
      userId: st.userId, requestId, ip, userAgent: ua,
      action: 'auth.secret_set', resource: 'slack.userToken', outcome: 'success', detail: {},
    });
    completeSlackState(state, { status: 'complete', teamName: tok.teamName });
    oauthCallbackHtml(res, 'Connected to Slack.');
    return;
  }

  // ---- MCP connector callback (public) --------------------------------
  //
  // GET /auth/mcp-connector/callback?code=...&state=...
  //   The authorization server redirects the user's browser here — no bearer
  //   token, so it stays public (allow-listed in server/auth.mjs
  //   PUBLIC_PATHS). `state` is the only link back to the user: it was minted
  //   by the start route below and handed to the SDK through the provider's
  //   state() hook. The credentials themselves live in the vault, so we
  //   rebuild the provider from (userId, connectorId) rather than holding a
  //   live object across the browser round trip.
  if (method === 'GET' && url.split('?')[0] === '/auth/mcp-connector/callback') {
    const q = new URL(url, 'http://127.0.0.1').searchParams;
    const state = q.get('state') || '';
    const st = getMcpState(state);
    if (q.get('error')) {
      if (st) completeMcpState(state, { status: 'error', message: 'Sign-in cancelled.' });
      oauthCallbackHtml(res, 'Sign-in cancelled.');
      return;
    }
    if (!st) { oauthCallbackHtml(res, 'This sign-in link has expired — start again from the app.'); return; }
    if (st.status !== 'pending') { oauthCallbackHtml(res, 'This sign-in link has already been used — start again from the app.'); return; }
    const def = mcpConnectorDef(st.connectorId);
    if (!def) {
      completeMcpState(state, { status: 'error', message: 'Unknown connector.' });
      oauthCallbackHtml(res, 'Connection failed: unknown connector.');
      return;
    }
    try {
      const { account } = await finishMcpAuthorization({
        db, userId: st.userId, def, code: q.get('code') || '',
      });
      safeAudit(db, {
        userId: st.userId, requestId, ip, userAgent: ua,
        action: 'auth.secret_set', resource: `mcp.${def.id}.tokens`,
        outcome: 'success', detail: {},
      });
      completeMcpState(state, { status: 'complete', account });
      oauthCallbackHtml(res, `Connected to ${def.name}.`);
    } catch (e) {
      const msg = mcpPublicMessage(e);
      completeMcpState(state, { status: 'error', message: msg });
      oauthCallbackHtml(res, 'Connection failed: ' + msg);
    }
    return;
  }

  // ---- Authenticated -------------------------------------------------
  // Guard placed here — immediately after the last public route block —
  // so every route below this point is guaranteed to have req.user set.
  // Adding a new authed route below this line is safe by construction;
  // adding one ABOVE would bypass auth (don't do that).

  if (!req.user) {
    send(res, 401, { error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
    return;
  }

  if (method === 'POST' && url === '/auth/logout') {
    let body;
    try { body = await readJson(req, bodyLimit); } catch { body = {}; }
    // Revoke the access-token JTI FIRST so the bearer token is
    // immediately dead even if the process crashes before the refresh-
    // token step completes.  The inverse order left a live access token
    // usable within its remaining TTL whenever the two writes were split
    // by a crash or an exception.
    if (req.user.jti && req.user.tokenExp) {
      const expiresAt = new Date(req.user.tokenExp * 1000).toISOString();
      revokeJti(req.user.jti, req.user.id, expiresAt);
    }
    flushWarmCliPool('logout');   // an idle child answers as the account that was logged in when it started
    // Refresh-token revocation. We have no session-id linkage between an
    // access token and its refresh token, so a bearer-only logout cannot
    // target a single session. Fail safe: if the client supplies its
    // refreshToken we revoke exactly that one (true per-device logout);
    // otherwise we revoke ALL the user's refresh tokens so logout can
    // never leave a live refresh token behind that silently re-mints the
    // session. `allDevices` is the explicit all-sessions form.
    let scope;
    if (body.allDevices) { logoutAll(db, req.user.id); scope = 'all'; }
    else if (body.refreshToken) { logout(db, body.refreshToken); scope = 'one'; }
    else { logoutAll(db, req.user.id); scope = 'all_no_refresh_token'; }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'auth.logout', outcome: 'success', detail: { allDevices: !!body.allDevices, scope } });
    send(res, 200, { ok: true });
    return;
  }

  // ---- Google Sign-In: start + status (authed) ------------------------
  //
  // POST /auth/google/start { clientId?, clientSecret? }
  //   Both fields present → bring-your-own: the pasted credentials are
  //   carried in the OAuth state entry and used for this flow, but NOT
  //   persisted to the vault yet — only the callback does that, and only
  //   after the token exchange proves they work (see the callback below
  //   for why). Both absent → hosted: LLM-IDE's own Testing-mode Google
  //   Cloud OAuth client (env vars), nothing to paste, 503 if the operator
  //   hasn't configured it. Either way, the resolved clientId/clientSecret
  //   are carried in the state entry itself so the callback below never
  //   needs to re-derive them (uniform code path for both BYO and hosted).
  if (method === 'POST' && url === '/auth/google/start') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    const bodyClientId = (body?.clientId || '').trim();
    const bodyClientSecret = (body?.clientSecret || '').trim();
    // BYO intent is keyed on the FIELD being present in the body, not on
    // its trimmed value being truthy — a caller sending explicit empty
    // strings (e.g. a form the user cleared) is still asking for the BYO
    // path and should get a validation error, not a silent fallback to
    // hosted credentials. Only a body with neither key at all (or no
    // body) means "no opinion, use hosted."
    const isByo = Object.prototype.hasOwnProperty.call(body || {}, 'clientId')
      || Object.prototype.hasOwnProperty.call(body || {}, 'clientSecret');
    let clientId, clientSecret;
    if (isByo) {
      if (!bodyClientId || !bodyClientSecret) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'clientId and clientSecret are required' } }); return; }
      clientId = bodyClientId;
      clientSecret = bodyClientSecret;
      // NOTE: do NOT persist these to the vault here — the state entry
      // below already carries them through to the callback. Writing them
      // eagerly would overwrite a still-working BYO client the moment a
      // user starts a new attempt; if they then abandon consent (closes
      // the tab, denies access), the vault is left with unverified
      // credentials paired against the OLD refresh token, and Google
      // rejects that refresh outright (invalid_grant) — silently breaking
      // a connection that worked a moment ago. Persist only after the
      // token exchange proves the credentials actually work (see the
      // callback below).
    } else {
      if (!config.googleClientId || !config.googleClientSecret) {
        send(res, 503, { error: { code: 'CONFIG_MISSING', message: "Google connect isn't set up on this server yet." } });
        return;
      }
      clientId = config.googleClientId;
      clientSecret = config.googleClientSecret;
    }
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(24).toString('base64url');
    putState(state, { userId: req.user.id, verifier, clientId, clientSecret, isByo });
    const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/google/callback';
    send(res, 200, { authUrl: buildAuthUrl({ clientId, redirectUri, state, challenge }), state });
    return;
  }

  // GET /auth/google/status?state=...
  //   Polled by the client while the browser tab is open. Ownership
  //   check: only the user who initiated the flow may read its status.
  if (method === 'GET' && url.split('?')[0] === '/auth/google/status') {
    const state = new URL(url, 'http://127.0.0.1').searchParams.get('state') || '';
    const s = getState(state);
    if (s && s.userId !== req.user.id) { send(res, 403, { error: { code: 'FORBIDDEN', message: 'not your sign-in' } }); return; }
    send(res, 200, takeStatus(state));
    return;
  }

  // ---- Slack Connect: start + status (authed) --------------------------
  //
  // POST /auth/slack/start
  //   LLM-IDE owns a single hosted Slack App — nothing to paste. Returns
  //   503 if the operator hasn't configured LLMIDE_SLACK_CLIENT_ID/SECRET.
  if (method === 'POST' && url === '/auth/slack/start') {
    if (!config.slackClientId || !config.slackClientSecret) {
      send(res, 503, { error: { code: 'CONFIG_MISSING', message: "Slack connect isn't set up on this server yet." } });
      return;
    }
    const state = crypto.randomBytes(24).toString('base64url');
    putSlackState(state, { userId: req.user.id });
    const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/slack/callback';
    send(res, 200, { authUrl: buildSlackAuthUrl({ clientId: config.slackClientId, redirectUri, state }), state });
    return;
  }

  // GET /auth/slack/status?state=...
  //   Polled by the client while the browser tab is open. Ownership check:
  //   only the user who initiated the flow may read its status.
  if (method === 'GET' && url.split('?')[0] === '/auth/slack/status') {
    const state = new URL(url, 'http://127.0.0.1').searchParams.get('state') || '';
    const s = getSlackState(state);
    if (s && s.userId !== req.user.id) { send(res, 403, { error: { code: 'FORBIDDEN', message: 'not your sign-in' } }); return; }
    send(res, 200, takeSlackStatus(state));
    return;
  }

  // ---- MCP connectors: start + status (authed) -------------------------
  //
  // POST /auth/mcp-connector/start { id } -> { authUrl, state }
  //   There is no way to redirect from here — no user agent is on this
  //   request — so the SDK's redirectToAuthorization hook captures the URL
  //   and we hand it back for the Mac app to open. Miro uses dynamic client
  //   registration, so nothing is configured: the first call registers a
  //   client and stores it in the vault.
  if (method === 'POST' && url === '/auth/mcp-connector/start') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    const def = mcpConnectorDef(typeof body?.id === 'string' ? body.id : '');
    if (!def) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: `Unknown MCP connector '${body?.id ?? ''}'` } });
      return;
    }
    const state = crypto.randomBytes(24).toString('base64url');
    putMcpState(state, { userId: req.user.id, connectorId: def.id });
    try {
      const r = await startMcpAuthorization({ db, userId: req.user.id, def, stateToken: state });
      if (r.alreadyConnected) {
        completeMcpState(state, { status: 'complete', account: def.name });
        send(res, 200, { state, alreadyConnected: true });
        return;
      }
      send(res, 200, { authUrl: r.authorizationUrl, state });
    } catch (e) {
      const msg = mcpPublicMessage(e);
      completeMcpState(state, { status: 'error', message: msg });
      send(res, 502, { error: { code: 'MCP_AUTH_START_FAILED', message: msg } });
    }
    return;
  }

  // GET /auth/mcp-connector/status?id=<connector>[&state=<flow>]
  //   `connected` reads the vault, so the Mac can ask at any time with just
  //   an id. Adding `state` also returns the single-use flow status while
  //   the browser tab is open (same contract as /auth/slack/status), with
  //   the same ownership check: only the initiator may read their flow.
  if (method === 'GET' && url.split('?')[0] === '/auth/mcp-connector/status') {
    const q = new URL(url, 'http://127.0.0.1').searchParams;
    const def = mcpConnectorDef(q.get('id') || '');
    if (!def) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Unknown MCP connector' } });
      return;
    }
    const state = q.get('state') || '';
    if (state) {
      const s = getMcpState(state);
      if (s && s.userId !== req.user.id) { send(res, 403, { error: { code: 'FORBIDDEN', message: 'not your sign-in' } }); return; }
    }
    const flow = state ? takeMcpStatus(state) : { status: 'unknown' };
    send(res, 200, { id: def.id, connected: isMcpConnected(db, req.user.id, def), ...flow });
    return;
  }

  if (method === 'GET' && url === '/auth/me') {
    const me = findUserById(db, req.user.id);
    if (!me) { send(res, 404, { error: { code: 'NOT_FOUND', message: 'User not found' } }); return; }
    send(res, 200, me);
    return;
  }

  // Full data-subject delete. POST with { password: "..." } as a
  // confirmation step. Uses POST instead of DELETE because the body
  // carries the password and many proxies/clients drop DELETE bodies.
  // On success: every user-scoped row (meetings, sources, plans,
  // tasks, outcomes, reviews, repos, secrets, feedback, refresh
  // tokens) is wiped, the users row is removed, audit log entries
  // are anonymised (user_id → NULL) so the operator can still answer
  // forensic questions about the period leading up to deletion.
  if (method === 'POST' && url === '/auth/me/delete') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      // Re-authenticate via password — same primitive `changePassword`
      // uses for the password-change confirmation step.
      const me = findUserById(db, req.user.id);
      if (!me) throw errNotFound('User not found');
      const { verifyPassword } = await import('./users.mjs');
      const valid = await verifyPassword(db, req.user.id, String(body?.password ?? ''));
      if (!valid) throw errAuth('Password confirmation failed');
      const { deleteUserCascade } = await import('../kb/db.mjs');
      const counts = deleteUserCascade(req.user.id);
      dropAllHeldSecretsForUser(req.user.id);
      safeAudit(db, {
        userId: null,           // user is gone
        requestId, ip, userAgent: ua,
        action: 'auth.account_deleted',
        resource: req.user.id,
        outcome: 'success',
        detail: counts,
      });
      send(res, 200, { ok: true, counts });
    } catch (err) {
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'auth.account_delete',
        outcome: 'failure',
        detail: { error: err.code || err.message },
      });
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  if (method === 'POST' && url === '/auth/me/password') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      changePassword(db, req.user.id, body);
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'auth.password_change', outcome: 'success' });
      send(res, 200, { ok: true });
    } catch (err) {
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'auth.password_change', outcome: 'failure', detail: { error: err.code } });
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  if (method === 'GET' && url === '/auth/me/secrets') {
    const keys = listSecretKeys(db, req.user.id).map((r) => ({ key: r.secret_key, updatedAt: r.updated_at }));
    send(res, 200, { secrets: keys, available: VAULT_KEYS });
    return;
  }

  if (method === 'POST' && url === '/auth/me/secrets') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      if (!body || !isUserSettableVaultKey(body.key)) {
        throw errValidation(`Unknown secret key (allowed: ${VAULT_KEYS.join(', ')})`);
      }
      // Empty/null value => delete (logged with "deleted" outcome detail).
      const value = typeof body.value === 'string' ? body.value : null;
      setSecret(db, req.user.id, body.key, value);
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'auth.secret_set', resource: body.key,
        outcome: 'success', detail: { deleted: !value },
      });
      send(res, 200, { ok: true });
    } catch (err) {
      // Log the operator-facing detail server-side, but only ship a
      // sanitised publicMessage for vault errors so internal cipher
      // state (blob length, key version, GCM auth failures) never
      // reaches the client.
      if (isVaultError(err)) {
        process.stderr.write(JSON.stringify({ level: 'warn', msg: 'auth_routes_vault_set_secret_failed', error: err.message }) + '\n');
      }
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: publicMessageFor(err) } });
    }
    return;
  }

  if (url === '/auth/me/repos' || url.split('?')[0] === '/auth/me/repos') {
    const { listUserRepos, addUserRepo, removeUserRepo } = await import('../kb/db.mjs');
    if (method === 'GET') {
      send(res, 200, { repos: listUserRepos(req.user.id) });
      return;
    }
    if (method === 'POST') {
      let body;
      try { body = await readJson(req, bodyLimit); }
      catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
      try {
        if (typeof body.path !== 'string') {
          throw errValidation('path is required');
        }
        const abs = addUserRepo(req.user.id, body.path, body.label);
        safeAudit(db, {
          userId: req.user.id, requestId, ip, userAgent: ua,
          action: 'auth.repo_add', resource: abs, outcome: 'success',
        });
        send(res, 200, { ok: true, path: abs });
      } catch (err) {
        send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
      }
      return;
    }
    if (method === 'DELETE') {
      const u = new URL(req.url, 'http://127.0.0.1');
      const repoPath = u.searchParams.get('path');
      if (!repoPath) {
        send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'path query param required' } });
        return;
      }
      try {
        removeUserRepo(req.user.id, repoPath);
        safeAudit(db, {
          userId: req.user.id, requestId, ip, userAgent: ua,
          action: 'auth.repo_remove', resource: repoPath, outcome: 'success',
        });
        send(res, 200, { ok: true });
      } catch (err) {
        send(res, err.status || 400, { error: { code: 'VALIDATION_FAILED', message: err.message } });
      }
      return;
    }
  }

  // Per-user UI preferences (synced across the Chrome extension and
  // Mac app).  Both clients GET on login and PUT on change.  Only
  // allow-listed keys are persisted; unknown ones are silently dropped.
  if (url === '/auth/me/prefs') {
    if (method === 'GET') {
      send(res, 200, { prefs: getUserPrefs(req.user.id) });
      return;
    }
    if (method === 'PUT') {
      let body;
      try { body = await readJson(req, bodyLimit); }
      catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
      try {
        const next = setUserPrefs(req.user.id, body || {});
        safeAudit(db, {
          userId: req.user.id, requestId, ip, userAgent: ua,
          action: 'auth.prefs_set', outcome: 'success',
          detail: { keys: Object.keys(next) },
        });
        send(res, 200, { prefs: next });
      } catch (err) {
        send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
      }
      return;
    }
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/audit') {
    // Audit log is per-user and read-only.  Pagination is by limit only;
    // if you need real cursor-based pagination, this is the place to add it.
    const u = new URL(req.url, 'http://127.0.0.1');
    const rawLimit = Number(u.searchParams.get('limit') || 100);
    const limit = Math.min(rawLimit, 1000);
    const action = u.searchParams.get('action') || undefined;
    const { listAuditForUser } = await import('./audit.mjs');
    let auditItems;
    try {
      auditItems = listAuditForUser(db, req.user.id, { limit, action });
    } catch (auditErr) {
      process.stderr.write(JSON.stringify({ level: 'error', msg: 'audit_list_failed', userId: req.user.id, error: auditErr.message }) + '\n');
      send(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve audit log' } });
      return;
    }
    send(res, 200, { items: auditItems });
    return;
  }

  // Connector catalog (connector-catalog spec phase 1): the Library's
  // "Add from catalog…" list plus the per-user selection that drives which
  // cards Settings → Connections renders. Meeting and Email are fixed
  // defaults and are deliberately NOT catalog entries. Removing a connector
  // only hides it — no fetched file or note is deleted.
  // GET    /auth/me/connectors          → the user's selected connectors
  // GET    /auth/me/connectors/catalog  → the full catalog + `selected` flag
  // POST   /auth/me/connectors/add      → { id }
  // DELETE /auth/me/connectors/<id>
  if (method === 'GET' && url.split('?')[0] === '/auth/me/connectors') {
    const { selectedConnectors } = await import('../connectors/connector-state.mjs');
    const { CONNECTOR_CATALOG } = await import('../connectors/connector-catalog.mjs');
    const selected = selectedConnectors(req.user.id);
    send(res, 200, {
      connectors: CONNECTOR_CATALOG
        .filter((e) => selected.has(e.id))
        .map(({ id, name, description, icon, authKind, docsUrl, pipelineReady }) =>
          ({ id, name, description, icon, authKind, docsUrl, pipelineReady })),
    });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/connectors/catalog') {
    const { selectedConnectors } = await import('../connectors/connector-state.mjs');
    const { CONNECTOR_CATALOG } = await import('../connectors/connector-catalog.mjs');
    const selected = selectedConnectors(req.user.id);
    send(res, 200, {
      catalog: CONNECTOR_CATALOG.map((e) => ({ ...e, selected: selected.has(e.id) })),
    });
    return;
  }

  if (method === 'POST' && url === '/auth/me/connectors/add') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,20}$/.test(body.id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'id must be a connector slug' } });
      return;
    }
    const { selectConnector } = await import('../connectors/connector-state.mjs');
    if (!selectConnector(req.user.id, body.id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: `unknown connector '${body.id}'` } });
      return;
    }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'connector.select', resource: body.id, outcome: 'success' });
    send(res, 200, { ok: true, id: body.id });
    return;
  }

  if (method === 'DELETE' && url.startsWith('/auth/me/connectors/')) {
    const id = decodeURIComponent(url.slice('/auth/me/connectors/'.length).split('?')[0]);
    if (!/^[a-z][a-z0-9-]{1,20}$/.test(id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid id' } }); return;
    }
    const { deselectConnector } = await import('../connectors/connector-state.mjs');
    deselectConnector(req.user.id, id);
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'connector.deselect', resource: id, outcome: 'success' });
    send(res, 200, { ok: true, id });
    return;
  }

  send(res, 404, { error: { code: 'NOT_FOUND', message: `No auth route for ${method} ${url}` } });
}
