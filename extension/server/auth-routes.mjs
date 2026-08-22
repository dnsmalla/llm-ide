// HTTP routes for /auth/*.  Kept separate from routes/router.mjs because
// (a) these are public-or-semi-public and have different threat
// posture, and (b) they take a direct DB handle rather than going
// through the kb facade.

import crypto from 'node:crypto';
import { config } from '../core/config.mjs';
import { errAuth, errNotFound, errValidation } from '../core/errors.mjs';
import { readBody, parseJSON } from '../core/utils.mjs';
import { requireAdmin } from './auth.mjs';
import { tryConsume } from './rate-limit.mjs';
import {
  changePassword, findUserById, login, logout, logoutAll, refreshSession, registerUser,
  createPasswordResetToken, consumePasswordResetToken,
} from './users.mjs';
import { listSecretKeys, setSecret, VAULT_KEYS, isVaultError } from './vault.mjs';
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

// Map any error (including VaultError) to a client-safe message.
// VaultError carries a `publicMessage` precisely so its internal
// detail (blob length, decipher failure, key version) never reaches
// the client; everything else uses err.message as before.
function publicMessageFor(err) {
  if (isVaultError(err)) return err.publicMessage || 'Vault operation failed';
  return err?.message || 'Request failed';
}

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
function oauthCallbackHtml(res, msg) {
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:2rem"><p>${escHtml(msg)}</p><p>You can close this tab and return to LLM-IDE.</p><script>setTimeout(()=>window.close(),1500)</script>`);
}
import { recordAudit } from './audit.mjs';
import { getUserPrefs, setUserPrefs, revokeJti } from '../kb/db.mjs';

function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Hardened body reader: delegates to core/utils readBody (uses req.pause()
// on overflow, not req.destroy()) so the route handler's catch block can
// still write a 413/400 JSON response to the now-unblocked res socket.
// Returns a parsed object; throws with a descriptive message on errors.
async function readJson(req, max) {
  let raw;
  try {
    raw = await readBody(req, max);
  } catch (err) {
    // Map readBody's AppError (status 413/408) to something the existing
    // callers already handle: they catch any Error and send a 400/413 response.
    const e = new Error(err.message || 'Body too large');
    e.status = err.status || 413;
    throw e;
  }
  if (!raw) return {};
  const parsed = parseJSON(raw);
  if (parsed === null) throw new Error('Body must be valid JSON');
  return parsed;
}

// Raw-bytes reader for binary uploads (plugin install zips). Uses
// req.pause() instead of req.destroy() on overflow so the route
// handler still has a writable `res` to send the 413 envelope — same
// fix we applied to core/utils.mjs#readBody.
async function readRawBody(req, max) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        try { req.pause(); } catch { /* ignore */ }
        const err = new Error('Request body too large');
        err.status = 413;
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req) {
  // We respect X-Forwarded-For ONLY when LLMIDE_TRUST_PROXY is on.
  // Otherwise we use the socket address — anything else is spoofable.
  //
  // XFF is built left-to-right as "client, proxy1, proxy2, …": each hop
  // APPENDS the address it saw. The leftmost value is therefore the value
  // the original client CLAIMED and is fully attacker-controlled (a client
  // can pre-set the header; our trusted proxy just appends to it). The only
  // entry we can trust is the RIGHTMOST one — the address our single
  // trusted proxy actually observed. Taking the first entry would let any
  // client spoof its IP in the audit log. (This assumes one trusted proxy
  // hop, which is the documented LLMIDE_TRUST_PROXY deployment.)
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Audit a write — failures captured too so denied registrations show
// up in the log.  Wraps the DB row so a recordAudit failure can never
// drop the actual response.
function safeAudit(db, fields) {
  try { recordAudit(db, fields); }
  catch (err) {
    process.stderr.write(JSON.stringify({ level: 'warn', msg: 'audit_write_failed', action: fields.action, error: err.message }) + '\n');
  }
}

// Redact an MCP plugin's env VALUES for a client response — key names are
// harmless (they're identifiers like "SLACK_TOKEN", not secrets) and the
// Mac client only ever displays the key list, but the values are real
// credentials that must never leave the server for a plain GET.
function redactEnvValues(env) {
  if (!env || typeof env !== 'object') return env;
  return Object.fromEntries(Object.keys(env).map((k) => [k, '••••']));
}

// A hosted MCP server's headers carry its bearer token, so they need exactly
// the same treatment as env: the plugin registry is shared across users and
// this endpoint is reachable by any authenticated one, so an unredacted
// passthrough would hand over another user's imported credentials. Key names
// are kept — the detail view lists them, never values.
const redactHeaderValues = redactEnvValues;

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
      || path === '/auth/me/plugins'
      || path === '/auth/me/plugins/toggle'
      || path === '/auth/me/plugins/hook-trust'
      || path === '/auth/me/plugins/reload'
      || path === '/auth/me/plugins/install'
      || path.startsWith('/auth/me/plugins/uninstall/')
      || path === '/auth/me/claude-plugins/installed'
      || path === '/auth/me/claude-plugins/marketplace'
      || path === '/auth/me/claude-plugins/import'
      || path === '/auth/me/claude-plugins/refresh'
      || path === '/auth/me/claude-plugins/updates'
      || path === '/auth/me/codex-plugins/installed'
      || path === '/auth/me/codex-plugins/marketplace'
      || path === '/auth/me/codex-plugins/import'
      || path === '/auth/me/codex-plugins/refresh'
      || path === '/auth/me/codex-plugins/updates'
      || path === '/auth/me/llm-sources'
      || path === '/auth/me/llm-sources/toggle'
      || path === '/auth/me/llm-sources/add'
      || path === '/auth/me/llm-sources/update'
      || path.startsWith('/auth/me/llm-sources/')
      || path === '/auth/me/mcp-plugins'
      || path === '/auth/me/mcp-plugins/catalog'
      || path === '/auth/me/mcp-plugins/claude-sources'
      || path === '/auth/me/mcp-plugins/codex-sources'
      || path === '/auth/me/mcp-plugins/add'
      || path === '/auth/me/mcp-plugins/consent'
      || path === '/auth/me/mcp-plugins/toggle'
      || path.startsWith('/auth/me/mcp-plugins/')
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
      if (!body || typeof body.key !== 'string' || !VAULT_KEYS.includes(body.key)) {
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

  // ── Plugin management ───────────────────────────────────────────────
  // GET  /auth/me/plugins         → list installed + per-user enable state
  // POST /auth/me/plugins/toggle  → { name, enabled }
  // POST /auth/me/plugins/reload  → re-scan the plugin directory
  if (method === 'GET' && url.split('?')[0] === '/auth/me/plugins') {
    const { listInstalledPlugins } = await import('../llm_agent/runtime/route.mjs');
    send(res, 200, listInstalledPlugins(req.user.id));
    return;
  }

  if (method === 'POST' && url === '/auth/me/plugins/toggle') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      if (!body || typeof body.name !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.name)) {
        throw errValidation('name must be a valid plugin slug');
      }
      if (typeof body.enabled !== 'boolean') {
        throw errValidation('enabled must be a boolean');
      }
      const { setEnabled } = await import('../plugins/state.mjs');
      const { listInstalledPlugins } = await import('../llm_agent/runtime/route.mjs');
      // Refuse to enable something that isn't installed — prevents
      // stale enable entries for plugins the user uninstalled.
      const installed = listInstalledPlugins(req.user.id);
      const found = installed.plugins.find((p) => p.name === body.name);
      if (!found && body.enabled) {
        throw errValidation(`plugin '${body.name}' is not installed`);
      }
      setEnabled(req.user.id, body.name, body.enabled);
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: body.enabled ? 'plugin.enable' : 'plugin.disable',
        resource: body.name, outcome: 'success',
      });
      send(res, 200, { ok: true, enabled: body.enabled });
    } catch (err) {
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  // POST /auth/me/plugins/hook-trust → { name, trusted }
  // Trusting a plugin's hooks authorizes shell commands from that plugin to
  // run during a turn, so it is a separate, audited grant — never implied by
  // enabling the plugin.
  if (method === 'POST' && url === '/auth/me/plugins/hook-trust') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    const { setPluginHookTrust } = await import('../plugins/hook-trust.mjs');
    const { listInstalledPlugins } = await import('../llm_agent/runtime/route.mjs');
    const result = setPluginHookTrust(req.user.id, body?.name, body?.trusted, {
      listPlugins: (userId) => listInstalledPlugins(userId).plugins,
    });
    if (result.error) {
      send(res, result.status || 400, { error: { code: 'VALIDATION_FAILED', message: result.error } });
      return;
    }
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: result.hooksTrusted ? 'plugin.hooks.trust' : 'plugin.hooks.revoke',
      resource: body.name, outcome: 'success',
    });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/plugins/reload') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const { reloadPlugins } = await import('../llm_agent/skills/index.mjs');
    const result = reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'plugin.reload', outcome: 'success',
      detail: { count: result.count },
    });
    send(res, 200, result);
    return;
  }

  // POST /auth/me/plugins/install
  //
  // Body is the raw zip bytes (Content-Type: application/zip). Why
  // not multipart/form-data? Because we'd need a multipart parser as
  // a dep and the only field is the bytes themselves. raw bytes is
  // smaller surface. Body cap is 5 MB enforced by readRawBody — the
  // larger of bodyLimitMB or the installer's own internal cap.
  if (method === 'POST' && url.split('?')[0] === '/auth/me/plugins/install') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const u = new URL(url, 'http://127.0.0.1');
    const replace = u.searchParams.get('replace') === '1';
    let zipBytes;
    try {
      zipBytes = await readRawBody(req, 5 * 1024 * 1024);
    } catch (err) {
      send(res, err.status || 413, { error: { code: err.code || 'PAYLOAD_TOO_LARGE', message: err.message } });
      return;
    }
    const { installFromZip } = await import('../plugins/installer.mjs');
    const result = await installFromZip(zipBytes, { replace });
    if (result.error) {
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'plugin.install', outcome: 'failure',
        detail: { error: result.error.slice(0, 200) },
      });
      send(res, result.status || 400, { error: { code: 'INSTALL_FAILED', message: result.error } });
      return;
    }
    // Re-scan so the runtime picks up the new plugin immediately.
    const { reloadPlugins } = await import('../llm_agent/runtime/route.mjs');
    reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'plugin.install', resource: result.plugin.name, outcome: 'success',
      detail: { version: result.plugin.version, replaced: !!result.plugin.replaced },
    });
    send(res, 200, result);
    return;
  }

  // DELETE /auth/me/plugins/uninstall/<name>
  //
  // Removes the plugin folder + prunes orphaned enable-state entries
  // for users who had it enabled. Plugin removal is a server-wide
  // operation (plugins are global, enable state is per-user) — any
  // authenticated user can remove. If you want admin-only later,
  // wrap with requireAdmin here.
  if (method === 'DELETE' && url.startsWith('/auth/me/plugins/uninstall/')) {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const pluginName = decodeURIComponent(url.slice('/auth/me/plugins/uninstall/'.length).split('?')[0]);
    // Validate the plugin slug before passing to the uninstaller — an
    // attacker who can call this endpoint could otherwise attempt path
    // traversal via a crafted name like '../../etc/passwd'.
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(pluginName)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid plugin name' } });
      return;
    }
    const { uninstall } = await import('../plugins/installer.mjs');
    const result = await uninstall(pluginName);
    if (result.error) {
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'plugin.uninstall', resource: pluginName, outcome: 'failure',
        detail: { error: result.error.slice(0, 200) },
      });
      send(res, result.status || 400, { error: { code: 'UNINSTALL_FAILED', message: result.error } });
      return;
    }
    // Reload to drop the registry entry + prune orphan state.
    const { reloadPlugins } = await import('../llm_agent/runtime/route.mjs');
    reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'plugin.uninstall', resource: pluginName, outcome: 'success',
      detail: { removed: result.removed },
    });
    send(res, 200, result);
    return;
  }

  // ── Claude Plugin Bridge ───────────────────────────────────────────
  if (method === 'GET' && url.split('?')[0] === '/auth/me/claude-plugins/installed') {
    const { scanInstalled, listImportedNames, getImportedVersion } = await import('../plugins/claude-adapter.mjs');
    const plugins = scanInstalled();
    const imported = listImportedNames();
    for (const p of plugins) {
      const mnName = p.name.startsWith('claude-') ? p.name : `claude-${p.name}`;
      p.alreadyImported = imported.has(mnName);
      p.importedVersion = p.alreadyImported ? getImportedVersion(mnName) : null;
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/claude-plugins/marketplace') {
    const { scanMarketplace, scanInstalled, listImportedNames, getImportedVersion } = await import('../plugins/claude-adapter.mjs');
    const plugins = scanMarketplace();
    const installed = scanInstalled();
    const installedNames = new Set(installed.map(p => p.name));
    const imported = listImportedNames();
    for (const p of plugins) {
      p.installedInClaude = installedNames.has(p.name);
      const mnName = p.name.startsWith('claude-') ? p.name : `claude-${p.name}`;
      p.alreadyImported = imported.has(mnName);
      p.importedVersion = p.alreadyImported ? getImportedVersion(mnName) : null;
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'POST' && url === '/auth/me/claude-plugins/import') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    if (!body || !body.name || !body.source) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'name and source required' } });
      return;
    }
    if (!['installed', 'marketplace'].includes(body.source)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'source must be installed or marketplace' } });
      return;
    }
    // Validate plugin name to prevent path traversal
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(body.name)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid plugin name' } });
      return;
    }
    const { importPlugin } = await import('../plugins/claude-adapter.mjs');
    const result = importPlugin({ source: body.source, name: body.name });
    if (!result.ok) {
      send(res, 404, { error: { code: 'NOT_FOUND', message: result.error } });
      return;
    }
    const { reloadPlugins } = await import('../llm_agent/runtime/route.mjs');
    reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'claude-plugin.import', resource: result.plugin.name, outcome: 'success',
      detail: { source: body.source, version: result.plugin.version },
    });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/claude-plugins/refresh') {
    const { scanInstalled, scanMarketplace } = await import('../plugins/claude-adapter.mjs');
    const installed = scanInstalled();
    const marketplace = scanMarketplace();
    send(res, 200, { installed: installed.length, marketplace: marketplace.length });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/claude-plugins/updates') {
    const { checkForUpdates } = await import('../plugins/claude-adapter.mjs');
    const updates = checkForUpdates();
    send(res, 200, { updates });
    return;
  }

  // ── Codex Plugin Bridge ─────────────────────────────────────────────
  // Mirrors the Claude Plugin Bridge above — same shape, different vendor
  // (OpenAI Codex CLI's plugin system: ~/.codex/plugins/cache + config.toml,
  // see plugins/codex-adapter.mjs).
  if (method === 'GET' && url.split('?')[0] === '/auth/me/codex-plugins/installed') {
    const { scanInstalled, listImportedNames, getImportedVersion } = await import('../plugins/codex-adapter.mjs');
    const plugins = scanInstalled();
    const imported = listImportedNames();
    for (const p of plugins) {
      const mnName = p.name.startsWith('codex-') ? p.name : `codex-${p.name}`;
      p.alreadyImported = imported.has(mnName);
      p.importedVersion = p.alreadyImported ? getImportedVersion(mnName) : null;
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/codex-plugins/marketplace') {
    const { scanMarketplace, scanInstalled, listImportedNames, getImportedVersion } = await import('../plugins/codex-adapter.mjs');
    const plugins = scanMarketplace();
    const installed = scanInstalled();
    const installedNames = new Set(installed.map((p) => p.name));
    const imported = listImportedNames();
    for (const p of plugins) {
      p.installedInCodex = installedNames.has(p.name);
      const mnName = p.name.startsWith('codex-') ? p.name : `codex-${p.name}`;
      p.alreadyImported = imported.has(mnName);
      p.importedVersion = p.alreadyImported ? getImportedVersion(mnName) : null;
    }
    send(res, 200, { plugins });
    return;
  }

  if (method === 'POST' && url === '/auth/me/codex-plugins/import') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    if (!body || !body.name || !body.source) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'name and source required' } });
      return;
    }
    if (!['installed', 'marketplace'].includes(body.source)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'source must be installed or marketplace' } });
      return;
    }
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(body.name)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid plugin name' } });
      return;
    }
    const { importPlugin } = await import('../plugins/codex-adapter.mjs');
    const result = importPlugin({ source: body.source, name: body.name });
    if (!result.ok) {
      send(res, 404, { error: { code: 'NOT_FOUND', message: result.error } });
      return;
    }
    const { reloadPlugins } = await import('../llm_agent/runtime/route.mjs');
    reloadPlugins();
    safeAudit(db, {
      userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'codex-plugin.import', resource: result.plugin.name, outcome: 'success',
      detail: { source: body.source, version: result.plugin.version },
    });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/codex-plugins/refresh') {
    const { scanInstalled, scanMarketplace } = await import('../plugins/codex-adapter.mjs');
    const installed = scanInstalled();
    const marketplace = scanMarketplace();
    send(res, 200, { installed: installed.length, marketplace: marketplace.length });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/codex-plugins/updates') {
    const { checkForUpdates } = await import('../plugins/codex-adapter.mjs');
    const updates = checkForUpdates();
    send(res, 200, { updates });
    return;
  }

  // ── LLM sources management ────────────────────────────────────────
  // A registered LLM source contributes any mix of skills (chat "/" menu
  // discovery), agents (subagent definitions), and hooks — the latter two
  // are catalogued for display only, never invoked/executed (see the
  // Safety note atop llm-sources/registry.mjs).
  // GET  /auth/me/llm-sources          → list sources + per-user enable
  // POST /auth/me/llm-sources/toggle   → { id, enabled }
  // POST /auth/me/llm-sources/refresh-default → rebuild llm_default_sources now
  // POST /auth/me/llm-sources/add      → { url|path, ref?, name? }  (admin)
  // POST /auth/me/llm-sources/update   → { id }                     (admin)
  // DELETE /auth/me/llm-sources/<id>                                (admin)
  if (method === 'GET' && url.split('?')[0] === '/auth/me/llm-sources') {
    const { listSourcesWithState, seedBuiltinOnce } = await import('../llm-sources/registry.mjs');
    seedBuiltinOnce();
    send(res, 200, listSourcesWithState(req.user.id));
    return;
  }

  if (method === 'POST' && url === '/auth/me/llm-sources/toggle') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    try {
      if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id)) {
        throw errValidation('id must be a valid source slug');
      }
      if (typeof body.enabled !== 'boolean') throw errValidation('enabled must be a boolean');
      const { getSource } = await import('../llm-sources/registry.mjs');
      if (!getSource(body.id)) throw errValidation(`source '${body.id}' is not registered`);
      const { setEnabled } = await import('../llm-sources/state.mjs');
      setEnabled(req.user.id, body.id, body.enabled);
      const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
      _resetSkillLibraryCache();
      // Rebuild llm_default_sources so the snapshot reflects the new enable set.
      try {
        const { scheduleSnapshotRefresh } = await import('../llm_agent/default-snapshot.mjs');
        scheduleSnapshotRefresh(req.user.id);
      } catch { /* snapshot is best-effort; toggle already succeeded */ }
      safeAudit(db, {
        userId: req.user.id, requestId, ip, userAgent: ua,
        action: body.enabled ? 'llm-source.enable' : 'llm-source.disable',
        resource: body.id, outcome: 'success',
      });
      send(res, 200, { ok: true, enabled: body.enabled });
    } catch (err) {
      send(res, err.status || 400, { error: { code: err.code || 'VALIDATION_FAILED', message: err.message } });
    }
    return;
  }

  // POST /auth/me/llm-sources/refresh-default — rebuild the llm_default_sources
  // snapshot (skills+agents from enabled sources, hooks catalog, effective
  // .mcp.json) for the requesting user, right now. Also refreshed
  // automatically on toggle/MCP-consent/server-start; this is the on-demand
  // escape hatch.
  if (method === 'POST' && url === '/auth/me/llm-sources/refresh-default') {
    try {
      const { refreshDefaultSnapshot } = await import('../llm_agent/default-snapshot.mjs');
      const result = refreshDefaultSnapshot(req.user.id);
      // noSources must survive the wire: it's what tells the client the
      // guard kept the existing folder (zero enabled input sources) instead
      // of rebuilding — dropping it turns that outcome into a silent no-op.
      send(res, 200, { ok: true, dir: result.dir, counts: result.counts, noSources: result.noSources === true });
    } catch (err) {
      send(res, 500, { error: { code: 'SNAPSHOT_FAILED', message: err.message || 'snapshot failed' } });
    }
    return;
  }

  if (method === 'POST' && url === '/auth/me/llm-sources/add') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    const { addSource } = await import('../llm-sources/registry.mjs');
    const result = await addSource({ url: body?.url, path: body?.path, ref: body?.ref, name: body?.name });
    if (result.error) {
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'llm-source.add', outcome: 'failure', detail: { error: result.error.slice(0, 200) } });
      send(res, result.status || 400, { error: { code: 'ADD_FAILED', message: result.error } });
      return;
    }
    const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
    _resetSkillLibraryCache();
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'llm-source.add', resource: result.source.id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/llm-sources/update') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid source id' } }); return;
    }
    const { updateSource, DEFAULT_SOURCES_ID } = await import('../llm-sources/registry.mjs');
    // "Update" on the Default Sources entry means: regenerate the committed
    // llm_default_sources snapshot from the enabled sources (its skills are a
    // frozen copy, not a git checkout — there is nothing to pull).
    if (body.id === DEFAULT_SOURCES_ID) {
      try {
        const { refreshDefaultSnapshot } = await import('../llm_agent/default-snapshot.mjs');
        const r = refreshDefaultSnapshot(req.user.id);
        // Same noSources passthrough as the refresh-default route above.
        send(res, 200, { ok: true, dir: r.dir, counts: r.counts, noSources: r.noSources === true });
      } catch (err) {
        send(res, 500, { error: { code: 'SNAPSHOT_FAILED', message: err.message || 'snapshot failed' } });
      }
      return;
    }
    const result = await updateSource(body.id);
    if (result.error) {
      send(res, result.status || 400, { error: { code: 'UPDATE_FAILED', message: result.error } }); return;
    }
    const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
    _resetSkillLibraryCache();
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'llm-source.update', resource: body.id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  if (method === 'DELETE' && url.startsWith('/auth/me/llm-sources/')) {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const id = decodeURIComponent(url.slice('/auth/me/llm-sources/'.length).split('?')[0]);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid source id' } }); return;
    }
    const { removeSource } = await import('../llm-sources/registry.mjs');
    const result = removeSource(id);
    if (result.error) {
      send(res, result.status || 400, { error: { code: 'REMOVE_FAILED', message: result.error } }); return;
    }
    const { _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
    _resetSkillLibraryCache();
    // The removed source's files must leave the snapshot too (it may have
    // been enabled). Deferred — see the toggle handler.
    try {
      const { scheduleSnapshotRefresh } = await import('../llm_agent/default-snapshot.mjs');
      scheduleSnapshotRefresh(req.user.id);
    } catch { /* snapshot is best-effort; removal already succeeded */ }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: 'llm-source.remove', resource: id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  if (method === 'GET' && url.split('?')[0].startsWith('/auth/me/llm-sources/') && url.split('?')[0].endsWith('/discovery')) {
    const id = decodeURIComponent(url.split('?')[0].slice('/auth/me/llm-sources/'.length, -'/discovery'.length));
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid source id' } }); return;
    }
    const { sourceDiscoveryDetail } = await import('../llm-sources/registry.mjs');
    const detail = sourceDiscoveryDetail(id);
    if (!detail) { send(res, 404, { error: { code: 'NOT_FOUND', message: 'source not found or not installed' } }); return; }
    send(res, 200, detail);
    return;
  }

  // MCP plugins (SP1): servers imported from ~/.claude.json or registered
  // manually, gated by per-user consent + enable before they reach the
  // Claude CLI's --mcp-config. Every authenticated user registers/scans/
  // removes (no admin concept — see requireAdmin's doc comment); any user
  // consents + enables their own dispatch. See docs/superpowers/specs/
  // 2026-08-12-mcp-plugin-runtime-design.md.
  // GET    /auth/me/mcp-plugins                 → list + per-user consent/enable
  // GET    /auth/me/mcp-plugins/claude-sources   → scan ~/.claude.json
  // GET    /auth/me/mcp-plugins/codex-sources    → scan ~/.codex/config.toml
  // POST   /auth/me/mcp-plugins/add              → { command,args,env,name,source } | { claudeName } | { codexName }
  // POST   /auth/me/mcp-plugins/consent          → { id, consented }
  // POST   /auth/me/mcp-plugins/toggle           → { id, enabled }
  // DELETE /auth/me/mcp-plugins/<id>
  if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins') {
    const { listMcpPluginsWithState } = await import('../mcp/state.mjs');
    const { plugins } = listMcpPluginsWithState(req.user.id);
    // Redact env VALUES before this reaches a non-admin caller — every
    // plugin's env is userId-independent (stored once on the shared
    // registry record, not per-user), so an unredacted spread here would
    // hand any authenticated user another plugin's real credentials
    // (e.g. a Slack/Linear bearer token) merely by hitting this endpoint,
    // whether or not they've ever consented to or enabled that plugin.
    // Key NAMES are kept (mirrors vault's listSecretKeys) since the Mac
    // detail view only ever displays the key list, never a value.
    const { credentialMissing } = await import('../mcp/mcp-config.mjs');
    const { makeSecretReader } = await import('./vault.mjs');
    const readSecret = makeSecretReader(db, req.user.id);
    send(res, 200, {
      plugins: plugins.map((p) => ({
        ...p,
        env: redactEnvValues(p.env),
        headers: redactHeaderValues(p.headers),
        // Surfaced rather than silently dropping the server from the effective
        // config: a catalog entry whose vault key is empty still gets passed to
        // the CLI (which reports a real auth failure), and the client needs to
        // be able to say "add the token" instead of leaving the user guessing.
        credentialMissing: credentialMissing(p, readSecret),
      })),
    });
    return;
  }

  // GET /auth/me/mcp-plugins/catalog → the curated one-click list. Static and
  // user-independent, but `registered` marks what this install already has so
  // the client can avoid offering a duplicate add.
  if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins/catalog') {
    const { MCP_CATALOG } = await import('../mcp/catalog.mjs');
    const { readMcpRegistry } = await import('../mcp/state.mjs');
    const existing = new Set(readMcpRegistry().map((p) => p.id));
    send(res, 200, {
      servers: MCP_CATALOG.map((e) => ({ ...e, registered: existing.has(e.id) })),
    });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins/claude-sources') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const { scanClaudeMcpServers } = await import('../mcp/claude-source.mjs');
    send(res, 200, { servers: scanClaudeMcpServers() });
    return;
  }

  if (method === 'GET' && url.split('?')[0] === '/auth/me/mcp-plugins/codex-sources') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const { scanCodexMcpServers } = await import('../mcp/codex-source.mjs');
    send(res, 200, { servers: scanCodexMcpServers() });
    return;
  }

  if (method === 'POST' && url === '/auth/me/mcp-plugins/add') {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON body' } }); return; }
    // A catalog add resolves entirely server-side from the id, so the client
    // never restates a command or URL (and cannot drift from the catalog).
    if (body?.catalogId) {
      const { addMcpPluginFromCatalog } = await import('../mcp/state.mjs');
      const result = addMcpPluginFromCatalog(body.catalogId, { arg: body.arg, name: body.name });
      if (result.error) {
        safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
          action: 'mcp-plugin.add', outcome: 'failure', detail: { error: String(result.error).slice(0, 200) } });
        send(res, result.status || 400, { error: { code: 'ADD_FAILED', message: result.error } });
        return;
      }
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'mcp-plugin.add', resource: result.plugin.id, outcome: 'success' });
      send(res, 200, result);
      return;
    }
    // Imports forward the scanned shape verbatim — including the hosted
    // (url/headers) one, which used to be dropped here because the scanners
    // never emitted it.
    if (body?.claudeName) {
      const { scanClaudeMcpServers } = await import('../mcp/claude-source.mjs');
      const found = scanClaudeMcpServers().find((s) => s.name === body.claudeName);
      if (!found) { send(res, 400, { error: { code: 'ADD_FAILED', message: `no Claude MCP server named '${body.claudeName}'` } }); return; }
      body = { ...found, name: body.name || found.name, source: 'claude' };
    } else if (body?.codexName) {
      const { scanCodexMcpServers } = await import('../mcp/codex-source.mjs');
      const found = scanCodexMcpServers().find((s) => s.name === body.codexName);
      if (!found) { send(res, 400, { error: { code: 'ADD_FAILED', message: `no Codex MCP server named '${body.codexName}'` } }); return; }
      body = { ...found, name: body.name || found.name, source: 'codex' };
    }
    const { addMcpPlugin } = await import('../mcp/state.mjs');
    const result = addMcpPlugin(body || {});
    if (result.error) {
      safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
        action: 'mcp-plugin.add', outcome: 'failure', detail: { error: String(result.error).slice(0, 200) } });
      send(res, result.status || 400, { error: { code: 'ADD_FAILED', message: result.error } });
      return;
    }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'mcp-plugin.add', resource: result.plugin.id, outcome: 'success' });
    send(res, 200, result);
    return;
  }

  if (method === 'POST' && url === '/auth/me/mcp-plugins/consent') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id) || typeof body.consented !== 'boolean') {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'id + consented required' } }); return;
    }
    const { setConsented } = await import('../mcp/state.mjs');
    setConsented(req.user.id, body.id, body.consented);
    try {
      const { scheduleSnapshotRefresh } = await import('../llm_agent/default-snapshot.mjs');
      scheduleSnapshotRefresh(req.user.id);
    } catch { /* snapshot is best-effort; consent change already succeeded */ }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: body.consented ? 'mcp-plugin.consent' : 'mcp-plugin.revoke-consent', resource: body.id, outcome: 'success' });
    send(res, 200, { ok: true, consented: body.consented });
    return;
  }

  if (method === 'POST' && url === '/auth/me/mcp-plugins/toggle') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    if (!body || typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(body.id) || typeof body.enabled !== 'boolean') {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'id + enabled required' } }); return;
    }
    const { setEnabledMcp } = await import('../mcp/state.mjs');
    setEnabledMcp(req.user.id, body.id, body.enabled);
    try {
      const { scheduleSnapshotRefresh } = await import('../llm_agent/default-snapshot.mjs');
      scheduleSnapshotRefresh(req.user.id);
    } catch { /* snapshot is best-effort; toggle already succeeded */ }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua,
      action: body.enabled ? 'mcp-plugin.enable' : 'mcp-plugin.disable', resource: body.id, outcome: 'success' });
    send(res, 200, { ok: true, enabled: body.enabled });
    return;
  }

  if (method === 'DELETE' && url.startsWith('/auth/me/mcp-plugins/')) {
    try { requireAdmin(req); } catch (err) { send(res, err.status || 403, { error: { code: err.code || 'FORBIDDEN', message: err.message } }); return; }
    const id = decodeURIComponent(url.slice('/auth/me/mcp-plugins/'.length).split('?')[0]);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
      send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid id' } }); return;
    }
    const { removeMcpPlugin } = await import('../mcp/state.mjs');
    const result = removeMcpPlugin(id);
    if (result.error) { send(res, result.status || 400, { error: { code: 'REMOVE_FAILED', message: result.error } }); return; }
    safeAudit(db, { userId: req.user.id, requestId, ip, userAgent: ua, action: 'mcp-plugin.remove', resource: id, outcome: 'success' });
    send(res, 200, result);
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
