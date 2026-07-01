// HTTP routes for /auth/*.  Kept separate from kb/router.mjs because
// (a) these are public-or-semi-public and have different threat
// posture, and (b) they take a direct DB handle rather than going
// through the kb facade.

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

// Map any error (including VaultError) to a client-safe message.
// VaultError carries a `publicMessage` precisely so its internal
// detail (blob length, decipher failure, key version) never reaches
// the client; everything else uses err.message as before.
function publicMessageFor(err) {
  if (isVaultError(err)) return err.publicMessage || 'Vault operation failed';
  return err?.message || 'Request failed';
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
      || path === '/auth/me/plugins/reload'
      || path === '/auth/me/plugins/install'
      || path.startsWith('/auth/me/plugins/uninstall/')
      || path === '/auth/me/claude-plugins/installed'
      || path === '/auth/me/claude-plugins/marketplace'
      || path === '/auth/me/claude-plugins/import'
      || path === '/auth/me/claude-plugins/refresh'
      || path === '/auth/me/claude-plugins/updates';
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

  send(res, 404, { error: { code: 'NOT_FOUND', message: `No auth route for ${method} ${url}` } });
}
