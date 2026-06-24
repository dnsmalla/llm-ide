// Alias legacy MEETNOTES_* env vars to LLMIDE_* before any config is read.
import './core/env-compat.mjs';
import http from 'http';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { handleKB } from './kb/router.mjs';
import { handleAIRoutes } from './server/ai-routes.mjs';
import { handleExportRoutes } from './server/export-routes.mjs';

import { logger, newRequestId } from './core/logger.mjs';
import { authenticate, requireAdmin } from './server/auth.mjs';
import { handleAuth, isAuthRoute } from './server/auth-routes.mjs';
import { purgeExpiredRefreshTokens, purgeExpiredResetTokens } from './server/users.mjs';
import { purgeOldAuditRows } from './server/audit.mjs';
import { AppError, sendError, errInternal, errNotFound, errValidation, errRateLimit } from './core/errors.mjs';
import { tryConsume, saveBuckets, loadBuckets } from './server/rate-limit.mjs';
import { recordHttpRequest, recordRateLimitDeny, setKbGauge, renderPrometheus } from './server/metrics.mjs';
import { getDb, closeDb, statsAdmin, purgeExpiredJti } from './kb/db.mjs';
import { stopAllAgents } from './agents/meeting-agent.mjs';

import { migrationStatus } from './kb/migrations.mjs';
import { config, configSummary } from './core/config.mjs';
import { sendJSON } from './core/utils.mjs';
import { buildHealthPayload, buildNotFoundDetails } from './server/control-plane.mjs';
import { startBackgroundOutcomePoller, stopBackgroundOutcomePoller } from './agents/outcome-watcher.mjs';

const PORT = config.port;
const HOST = config.host;

// Bump whenever the HTTP surface changes so the extension can detect
// a stale server process ("you installed the new client but forgot to
// restart node server.mjs") and surface a clear message.
const SERVER_API_VERSION = 18;
const ENDPOINTS = [
  '/generate-notes',
  '/generate-docx',
  '/generate-doc',
  '/chat',
  '/code-assist',
  '/generate-questions',
  '/extract-entities',
  '/kb/ingest',
  '/kb/search',
  '/kb/meeting/:id',
  '/kb/entity/:id',
  '/kb/stats',
  '/kb/system/status',
  '/kb/delete',
  '/kb/connect-git',
  '/kb/connect-github-issues',
  '/kb/connect-tickets-json',
  '/kb/connect-qa',
  '/kb/email/test',
  '/kb/email/fetch',
  '/kb/email/seen',
  '/kb/slack/test',
  '/kb/slack/fetch',
  '/kb/slack/seen',
  '/kb/activity',
  '/kb/activity/seen',
  '/kb/generate-plan',
  '/kb/analyze-risks',
  '/kb/summarize',
  '/kb/conflict-questions',
  '/kb/providers/verify',
  '/kb/providers/models',
  '/kb/code-sync',
  '/kb/plans',
  '/kb/plan/:id',
  '/kb/plan/save',
  '/kb/plan-task/update',
  '/kb/plan/delete',
  '/kb/dispatch',
  '/kb/generate-code',
  '/kb/review/submit',
  '/kb/review/list',
  '/kb/review/get/:id',
  '/kb/review/approve',
  '/kb/review/reject',
  '/kb/review/delete',
  '/kb/notify/slack',
  '/kb/outcomes/refresh',
  '/kb/outcomes/retry-failed',
  '/kb/outcomes/task/:id',
  '/kb/outcomes/stats',
  '/kb/live/sessions',
  '/kb/live/:id',
  '/kb/live/:id/append',
  '/kb/live/:id/finalize',
  '/kb/agent/dispatch',
  '/kb/agent/stop',
  '/kb/agent/runs',
  '/kb/agent/feedback',
  '/kb/agent/feedback/stats',
  '/kb/agent/feedback/by-task',
  '/kb/agent/persona',
  '/kb/agent/personas',
  '/kb/agent/personas/:id',
  '/kb/agent/personas/active',
  '/kb/agent/ask',
  '/kb/agent/ask/history',
];

// Map a route URL to a rate-limit profile (see server/rate-limit.mjs).
// Anything not listed has no limit applied.
function rateLimitProfile(url, method) {
  // Expensive GET reads get a profile BEFORE the POST-only short-circuit.
  // /kb/export-all streams a user's whole meeting corpus, so it must be
  // throttled even though it's a GET. (Strip any query string first.)
  if (method === 'GET') {
    const path = url.split('?')[0];
    if (path === '/kb/export-all') return 'kbExport';
    return null;
  }
  if (method !== 'POST') return null;
  if (url === '/generate-notes')         return 'llmFast';
  if (url === '/chat')                   return 'llmFast';
  if (url === '/kb/agent/ask')           return 'llmFast';
  if (url === '/generate-questions')     return 'llmFast';
  if (url === '/extract-entities')       return 'llmFast';
  if (url === '/generate-docx')          return 'llmFast';
  if (url === '/code-assist')            return 'llm';            // expensive, cap tighter
  if (url === '/kb/generate-plan')       return 'llm';
  if (url === '/kb/analyze-risks')       return 'llm';
  if (url === '/kb/generate-code')       return 'llm';
  if (url === '/kb/summarize')           return 'llm';            // runClaude, 3-min ceiling
  if (url === '/kb/conflict-questions')  return 'llm';            // runClaude
  if (url === '/kb/providers/verify')    return 'llmFast';        // tiny live probe / CLI check
  if (url === '/kb/providers/models')    return 'llmFast';        // provider model-list fetch
  if (url === '/kb/dispatch')            return 'dispatch';
  if (url === '/kb/notify/slack')        return 'dispatch';
  if (url === '/kb/outcomes/refresh')    return 'outcomePoll';
  if (url.startsWith('/kb/connect-'))    return 'kbWrite';
  if (url.startsWith('/kb/review/'))     return 'kbWrite';
  if (url.startsWith('/kb/plan-task/'))  return 'kbWrite';
  if (url === '/kb/ingest')              return 'kbWrite';
  // Email routes open outbound IMAP connections + parse mail — expensive and
  // externally-directed, so throttle them like other external-API writes
  // (dispatch: ~1/10s burst 4) rather than the cheap kbWrite bucket.
  if (url === '/kb/email/test' || url === '/kb/email/fetch') return 'dispatch';
  // /kb/email/seen is a cheap LOCAL write (dedup ledger + high-water) — no
  // outbound IMAP — so it belongs on the kbWrite bucket, not dispatch.
  if (url === '/kb/email/seen') return 'kbWrite';
  // Slack routes mirror email: test/fetch hit the Slack API (dispatch bucket);
  // seen is a cheap local write (kbWrite bucket).
  if (url === '/kb/slack/test' || url === '/kb/slack/fetch') return 'dispatch';
  if (url === '/kb/slack/seen') return 'kbWrite';
  if (url === '/kb/activity' || url === '/kb/activity/seen') return 'kbWrite';
  return null;
}

// Only allow requests from Chrome extensions and localhost origins.
// This prevents random websites from calling the local server.
// We never echo "*" — if the origin isn't allowed, the ACAO header is
// simply omitted, which makes the browser block the response from the caller.
function setCORS(req, res) {
  const origin = req.headers.origin || '';
  // IPv6 loopback parity: the client-side `isSafeServerUrl()` accepts
  // `http://[::1]:<port>`; without the same here a user on an
  // IPv6-only loopback would see CORS-blocked requests with no
  // diagnostic.  Also accept https:// localhost variants for the
  // hypothetical TLS-fronted deployment.
  const isAllowed =
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('http://localhost:')   || origin.startsWith('https://localhost:')   ||
    origin.startsWith('http://127.0.0.1:')   || origin.startsWith('https://127.0.0.1:')   ||
    origin.startsWith('http://[::1]:')       || origin.startsWith('https://[::1]:')       ||
    config.extraCorsOrigins.includes(origin);

  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID');
  // Security headers — minimal but meaningful for an API server.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

const server = http.createServer(async (req, res) => {
  setCORS(req, res);

  // Per-request logger child — every line emitted by handlers downstream
  // carries the same request ID so a single user action can be traced
  // through agents, KB writes, and external API calls.
  // Strip CR/LF/NUL from the client-supplied header before echoing it
  // back.  An unvalidated echo of a value containing \r\n allows a
  // response-splitting / header-injection attack.
  const rawId = req.headers['x-request-id'];
  const requestId = (typeof rawId === 'string' && rawId.length > 0 && rawId.length <= 128)
    ? rawId.replace(/[\r\n\0]/g, '').trim() || newRequestId()
    : newRequestId();
  res.setHeader('X-Request-ID', requestId);
  const reqLog = logger.child({ requestId, method: req.method, url: req.url });
  req.log = reqLog;

  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'info';
    reqLog[level]('http_request', {
      status: res.statusCode, durationMs, userId: req.user?.id || null,
    });
    recordHttpRequest({
      method: req.method,
      route: req.url || 'unknown',
      status: res.statusCode,
      durationMs,
    });
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Authenticate — public paths (health, /auth/login etc.) are
  // exempted inside `authenticate`.  On success it attaches req.user.
  try {
    authenticate(req);
  } catch (err) {
    sendError(res, err, { logger: reqLog });
    return;
  }

  // Auth-route dispatcher — registration, login, refresh, /me/*.
  // Runs before rate limiting because the auth-routes module applies
  // its own per-IP profile to login/register.
  if (isAuthRoute(req.url || '')) {
    try {
      await handleAuth(req, res, { db: getDb({ logger }), logger: reqLog, requestId });
    } catch (err) {
      sendError(res, err, { logger: reqLog });
    }
    return;
  }

  // Rate limit per-(profile, user).  Anonymous health probes don't
  // hit this branch because they have no profile.
  const profile = rateLimitProfile(req.url || '', req.method || 'GET');
  if (profile) {
    const scope = req.user?.id || (req.socket?.remoteAddress || 'anon');
    const r = tryConsume(profile, scope);
    if (!r.ok) {
      recordRateLimitDeny(profile);
      res.setHeader('Retry-After', String(r.retryAfterSec));
      sendError(res, errRateLimit(r.retryAfterSec), { logger: reqLog });
      return;
    }
  }



  // Mount the Phase-2 KB router before the rest so /kb/* never falls
  // through to the legacy "no route" branch.  handleKB returns true once
  // it has written a response; false means the URL isn't a /kb/* path.
  if ((req.url || '').startsWith('/kb')) {
    if (await handleKB(req, res)) return;
  }

  // Health check.  The client checks this on load and every 30s; it
  // doubles as an API-capability probe so the side panel can show an
  // informative error ("restart the server to pick up new endpoints")
  // instead of a raw 404 when a new feature ships.  In production we
  // also surface schema status, uptime, and a Claude-CLI presence
  // indicator so an operator can spot problems without grepping logs.
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    let migration = null;
    let dbOk = false;
    try { migration = migrationStatus(getDb({ logger })); dbOk = true; } catch { /* dbOk stays false */ }
    // Mirror the cached Claude-CLI probe result; the probe runs at
    // boot and once an hour after.  We don't run it inline because
    // execFile would add ~50ms to every health request.
    const claude = claudeProbeResult();
    // /health is unauthenticated. Minimal liveness shape only — the
    // verbose detail (pid, env, schema, endpoint list) used to be
    // gated behind ?debug=1 but that was no gate at all: any caller
    // could just append the query. Operators who need verbose status
    // should authenticate and hit /metrics or /auth/me/audit.
    sendJSON(res, 200, buildHealthPayload({
      dbOk,
      claude,
      migration,
      apiVersion: SERVER_API_VERSION,
      endpoints: ENDPOINTS,
      serverStartedAt: SERVER_STARTED_AT,
    }));
    return;
  }

  // Cross-client deep link to the desktop app.  Used by the Chrome
  // extension's ↗ button: it opens this URL in a new tab; the server
  // returns a 302 with `Location: llmide://<tab>`.  Chrome's URL
  // bar then asks the OS to handle the custom scheme — the JS-driven
  // path from a chrome-extension:// origin is unreliable because MV3
  // strips user-gesture context on cross-tab navigation, but a real
  // server-side redirect is treated like any other navigation.
  //
  // We also serve a small HTML body alongside the redirect so a
  // browser that ignores the Location header (or the user clicks
  // back) still gets a manual button.  Public path — anyone on the
  // local machine can launch the desktop app via this URL.


  if (req.method === 'GET' && (req.url || '').startsWith('/launch-app')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const ALLOWED_TABS = new Set(['transcript', 'plan', 'review', 'history', 'settings']);
    const requestedTab = (u.searchParams.get('to') || 'transcript').toLowerCase();
    const tab = ALLOWED_TABS.has(requestedTab) ? requestedTab : 'transcript';
    const session = u.searchParams.get('session');
    let target = `llmide://${tab}`;
    if (session) target += `?session=${encodeURIComponent(session)}`;
    const targetHtml = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

    const body = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="0; url=${targetHtml}" />
<title>Opening LLM IDE…</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family:-apple-system,BlinkMacSystemFont,sans-serif;
         display:flex; align-items:center; justify-content:center;
         min-height:100vh; margin:0; background:#f5f6f8; color:#1f2027; }
  @media (prefers-color-scheme: dark) {
    body { background:#0d0e12; color:#e8eaf2; }
    .card { background:#16181f; border-color:#25272f; }
    .muted { color:#8a8e98; }
  }
  .card { padding:24px 28px; border-radius:12px; max-width:420px;
          background:#fff; border:1px solid #e4e6ea;
          box-shadow:0 8px 28px rgba(0,0,0,.08); text-align:center; }
  h1 { margin:0 0 6px; font-size:18px; font-weight:600; }
  p { margin:0; font-size:13px; line-height:1.5; }
  .muted { color:#6b6f78; font-size:12px; margin-top:10px; }
  a.btn { display:inline-block; margin-top:14px; padding:8px 16px;
          background:#2f7f93; color:#fff; border-radius:6px;
          font-size:13px; text-decoration:none; font-weight:600; }
  a.btn:hover { filter:brightness(1.1); }
  .pulse { display:inline-block; width:10px; height:10px; border-radius:50%;
           background:#2f7f93; margin-right:6px; vertical-align:middle;
           animation:pulse 1.1s ease-out infinite; }
  @keyframes pulse {
    0% { transform:scale(.7); opacity:.6; }
    50% { transform:scale(1); opacity:1; }
    100% { transform:scale(.7); opacity:.6; }
  }
</style>
</head><body>
<div class="card">
  <h1><span class="pulse"></span>Opening LLM IDE…</h1>
  <p>Handing off to the desktop app.</p>
  <p class="muted">If nothing happens, click the button below.</p>
  <a class="btn" href="${targetHtml}">Open LLM IDE</a>
</div>
<script>
  // Belt-and-braces: in addition to the meta refresh, fire the URL
  // explicitly.  Window-level setTimeout(0) is treated as a real
  // navigation by Chrome when initiated from an http(s) origin.
  setTimeout(function () { try { location.href = ${JSON.stringify(target)}; } catch (e) {} }, 0);
  // Self-close the tab after the OS has had time to pick up the URL
  // and the user is back in their meeting / desktop app.
  setTimeout(function () { try { window.close(); } catch (e) {} }, 5000);
</script>
</body></html>`;

    res.writeHead(302, {
      'Location': target,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      // Don't cache — the redirect target depends on the query string
      // and we want every click to re-evaluate.
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  // Admin-only DB backup. Uses SQLite `VACUUM INTO` which produces a
  // self-consistent copy without locking the live DB (works on a hot
  // database). Defaults to <dbDir>/backups/data-<unix>.db; explicit
  // `?path=` lets ops aim it at a mounted volume. The endpoint is
  // synchronous — on a small DB (single-user) it returns in <1s; on
  // larger DBs the client may hit a timeout, but the backup completes
  // server-side regardless.
  if (req.method === 'POST' && (req.url === '/admin/backup' || req.url?.startsWith('/admin/backup?'))) {
    try { requireAdmin(req); } catch (err) { sendError(res, err, { logger: reqLog }); return; }
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const dbDir = path.dirname(config.dbPath);
      const defaultBackupDir = path.join(dbDir, 'backups');
      const rawDir = u.searchParams.get('dir') || defaultBackupDir;
      // Resolve symlinks / ".." components and enforce containment:
      // the final target must sit inside the default backup directory so
      // an admin cannot aim the backup at an arbitrary path (e.g. /etc).
      const targetDir  = path.resolve(rawDir);
      const backupBase = path.resolve(defaultBackupDir);
      if (!targetDir.startsWith(backupBase + path.sep) && targetDir !== backupBase) {
        sendError(res, errValidation(`dir must be under the server backup directory (${backupBase})`), { logger: reqLog });
        return;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      const stamp = Math.floor(Date.now() / 1000);
      const filename = `data-${stamp}.db`;
      const target = path.join(targetDir, filename);
      // Escape single-quotes in the literal path for SQLite's syntax.
      const safeTarget = target.replace(/'/g, "''");
      const db = getDb({ logger });
      db.exec(`VACUUM INTO '${safeTarget}'`);
      const stat = fs.statSync(target);
      reqLog.info('db_backup_created', { path: target, bytes: stat.size });
      sendJSON(res, 200, { ok: true, path: target, bytes: stat.size });
    } catch (err) {
      reqLog.error('db_backup_failed', { error: err.message });
      sendError(res, errInternal(`backup failed: ${err.message}`), { logger: reqLog });
    }
    return;
  }

  // DELETE /admin/users/:userId — admin-only data-subject delete.
  //
  // Cascades through every user-scoped table (meetings, sources,
  // plans, tasks, outcomes, reviews, repos, secrets, feedback,
  // refresh tokens) and removes the users row. audit_log entries are
  // anonymised (user_id → NULL) rather than deleted so the operator
  // retains forensic context. Same cascade primitive as the user-
  // initiated /auth/me/delete, but here the actor is the admin.
  //
  // Safety rails:
  //   - Admin cannot delete themselves through this endpoint; use
  //     /auth/me/delete instead (which requires password confirmation).
  //   - The reserved 'legacy' user is refused — it's a system row
  //     used to attribute pre-multitenancy data and removing it would
  //     orphan every legacy row.
  //   - The whole operation runs in a single transaction so a
  //     mid-cascade failure leaves nothing partially deleted.
  if (req.method === 'DELETE' && req.url?.startsWith('/admin/users/')) {
    try { requireAdmin(req); } catch (err) { sendError(res, err, { logger: reqLog }); return; }
    const targetId = decodeURIComponent(req.url.slice('/admin/users/'.length).split('?')[0]);
    try {
      if (!/^[a-z0-9_-]{1,64}$/.test(targetId)) {
        sendError(res, errValidation('Invalid user id'), { logger: reqLog });
        return;
      }
      if (targetId === req.user.id) {
        sendError(res, errValidation('Admins cannot delete themselves via /admin/users — use /auth/me/delete'), { logger: reqLog });
        return;
      }
      if (targetId === 'legacy') {
        sendError(res, errValidation("The 'legacy' system user cannot be deleted"), { logger: reqLog });
        return;
      }
      const { deleteUserCascade } = await import('./kb/db.mjs');
      const { findUserById } = await import('./server/users.mjs');
      const target = findUserById(getDb({ logger }), targetId);
      if (!target) {
        sendError(res, errNotFound(`User ${targetId} not found`), { logger: reqLog });
        return;
      }
      const counts = deleteUserCascade(targetId);
      // Re-import the audit helper inline to keep server.mjs lean.
      const { recordAudit } = await import('./server/audit.mjs');
      try {
        recordAudit(getDb({ logger }), {
          userId: req.user.id,  // actor = admin
          requestId,
          ip: req.socket?.remoteAddress || 'unknown',
          userAgent: req.headers['user-agent'] || '',
          action: 'admin.user_deleted',
          resource: targetId,
          outcome: 'success',
          detail: { ...counts, targetEmail: target.email },
        });
      } catch { /* audit failure must not block the delete */ }
      sendJSON(res, 200, { ok: true, targetUserId: targetId, counts });
    } catch (err) {
      reqLog.error('admin_user_delete_failed', { error: err.message, targetId });
      sendError(res, errInternal(`user delete failed: ${err.message}`), { logger: reqLog });
    }
    return;
  }

  // Prometheus scrape target.  Public so a scraper running in-cluster
  // Requires admin JWT — or lock down at the network layer (firewall to scraper subnet).
  if (req.method === 'GET' && req.url === '/metrics') {
    try { requireAdmin(req); } catch (err) { sendError(res, err, { logger: reqLog }); return; }
    try {
      const admin = statsAdmin();
      setKbGauge('meeting',  admin.meetings);
      setKbGauge('entity',   admin.entities);
      setKbGauge('source',   admin.sources);
      setKbGauge('plan',     admin.plans);
      setKbGauge('task',     admin.tasks);
      setKbGauge('review',   admin.reviews);
      setKbGauge('outcome',  admin.outcomes);
      setKbGauge('user',     admin.users);
      setKbGauge('audit',    admin.audit);
    } catch { /* metrics path must never throw */ }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(renderPrometheus());
    return;
  }

  try {
    if (await handleAIRoutes(req, res)) return;
    if (await handleExportRoutes(req, res)) return;

    sendError(res, new AppError('NOT_FOUND', `No route for ${req.method} ${req.url}`, {
      status: 404,
      details: buildNotFoundDetails(ENDPOINTS),
    }), { logger: reqLog });
  } catch (err) {
    if (err instanceof AppError) {
      sendError(res, err, { logger: reqLog });
    } else {
      // Unexpected — log full stack at error level, return generic
      // INTERNAL_ERROR to the client (no stack leak).
      reqLog.error('unhandled_exception', { error: err.message, stack: err.stack });
      sendError(res, errInternal('Internal error'), { logger: null });
    }
  }
});

const SERVER_STARTED_AT = Date.now();

// Claude-CLI presence probe.  Runs at boot and every hour; cached so
// /health is cheap.  We treat a missing CLI as "degraded" rather than
// "down" because read-only routes (history, search, audit) still work
// without it.
let _claudeProbe = { ok: false, error: 'not yet probed', checkedAt: 0 };
const CLAUDE_PROBE_INTERVAL_MS = 60 * 60_000;

function probeClaude() {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 5000 }, (err) => {
      if (err) {
        _claudeProbe = {
          ok: false,
          error: err.code === 'ENOENT' ? 'CLI not installed' : `version probe failed: ${(err.message || '').slice(0, 80)}`,
          checkedAt: Date.now(),
        };
      } else {
        _claudeProbe = { ok: true, checkedAt: Date.now() };
      }
      resolve();
    });
  });
}

function claudeProbeResult() {
  // Re-probe lazily if the cache is stale; never blocks the request.
  if (Date.now() - _claudeProbe.checkedAt > CLAUDE_PROBE_INTERVAL_MS) {
    probeClaude().catch(() => { /* swallow */ });
  }
  return _claudeProbe;
}

// Process-fatal handlers: once we land here Node's invariants are
// broken — the safe move is to log a structured record and exit(1) so
// the supervisor (Mac BackendManager or `npm run server`) restarts us
// in a clean state.  Previously we swallowed these, which left the
// process running with half-torn-down state and held the port.
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
// Unhandled rejection: log and keep running.  An unhandledRejection is
// not the same kind of state corruption as uncaughtException — Node's
// invariants are still intact, only a Promise chain was dropped on the
// floor.  Exiting on every dangling rejection turned a single bad
// request (e.g. SSE write after socket close, fire-and-forget audit
// rejection) into a server-wide DoS.  Log loudly so we can fix the
// missing await, but don't take the supervisor down.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Graceful shutdown — SIGTERM/SIGINT both stop accepting new requests,
// drain the in-flight ones, then close the DB cleanly.  10-second hard
// timeout protects against a stuck Claude CLI subprocess holding the
// process open forever.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_initiated', { signal });
  if (authGcTimer)  { clearInterval(authGcTimer);  authGcTimer  = null; }
  if (backupTimer)  { clearInterval(backupTimer);  backupTimer  = null; }
  stopBackgroundOutcomePoller();
  // Stop per-meeting agent tick loops so they don't fire (or publish a
  // late question) while we drain in-flight requests.
  try { stopAllAgents(); } catch { /* best-effort */ }
  const hardTimeout = setTimeout(() => {
    logger.warn('shutdown_hard_timeout');
    process.exit(1);
  }, 10_000);
  hardTimeout.unref();
  server.close(() => {
    // Save rate-limit state before closing the DB so the next startup
    // inherits current bucket levels.
    try { saveBuckets(getDb({ logger })); } catch { /* best-effort */ }
    closeDb({ logger });
    logger.info('shutdown_complete');
    process.exit(0);
  });
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Ignore SIGPIPE — prevents the process from terminating when a client
// disconnects mid-response (broken pipe on the socket write).
process.on('SIGPIPE', () => {});

// Bound per-socket lifetimes so abandoned/stalled clients can't pile up
// FDs.  requestTimeout caps a single in-flight request end-to-end;
// headersTimeout ensures slowloris-style clients can't hold half-open
// sockets; keepAliveTimeout reaps idle pooled sockets before they
// outlive any reasonable client expectation.
server.requestTimeout   = 300_000;   // total per-request budget (5 min)
server.headersTimeout   = 65_000;    // headers must arrive within 65 s
server.keepAliveTimeout = 60_000;    // close idle keep-alive sockets after 60 s

// Catch listen-time errors (EADDRINUSE, EACCES) cleanly — otherwise the
// process logs the error but the http.Server stays half-initialised,
// which historically caused us to hold the port in a broken state.
server.on('error', (err) => {
  logger.error('server_listen_error', { code: err.code, message: err.message });
  process.exit(1);
});

// Periodic auth-table GC. Boot-only sweeps left rows piling up on
// long-running servers; the interval picks them up between restarts.
// 6 hours is a tradeoff: short enough that a runaway refresh-token
// flood can't bloat the table for too long, long enough that a single
// stuck DB lock can't pin the loop.
const AUTH_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
let authGcTimer = null;
function runAuthGc(stage) {
  // Skip if shutdown began between the timer tick and now — closeDb()
  // may have already run in the shutdown callback. Future refactors
  // that make purgeExpired* async would otherwise race the close.
  if (shuttingDown) return;
  try {
    const purgedJti    = purgeExpiredJti();
    const purgedTokens = purgeExpiredRefreshTokens(getDb({ logger }));
    const purgedReset  = purgeExpiredResetTokens(getDb({ logger }));
    const purgedAudit  = purgeOldAuditRows(getDb({ logger }));
    if (purgedJti    > 0) logger.info(`jti_purge_${stage}`,            { purged: purgedJti });
    if (purgedTokens > 0) logger.info(`refresh_token_purge_${stage}`,  { purged: purgedTokens });
    if (purgedReset  > 0) logger.info(`reset_token_purge_${stage}`,    { purged: purgedReset });
    if (purgedAudit  > 0) logger.info(`audit_purge_${stage}`,          { purged: purgedAudit });
    // Persist rate-limit bucket state so a restart doesn't give a free burst window.
    try { saveBuckets(getDb({ logger })); } catch (err) {
      logger.warn(`rate_limit_save_${stage}_failed`, { error: err.message });
    }
  } catch (err) {
    logger.error(`auth_gc_${stage}_failed`, { error: err.message });
  }
}

// Automatic DB backup — runs every 24 hours (configurable via
// LLMIDE_BACKUP_INTERVAL_HOURS). Uses the same VACUUM INTO primitive
// as the /admin/backup endpoint: produces a self-consistent snapshot
// without locking the live DB. Keeps up to LLMIDE_BACKUP_RETAIN
// recent copies (default 7) and prunes older ones so disk doesn't
// grow unboundedly. Disabled when LLMIDE_BACKUP_INTERVAL_HOURS=0.
const BACKUP_INTERVAL_HOURS = (() => {
  const v = Number(process.env.LLMIDE_BACKUP_INTERVAL_HOURS ?? 24);
  return Number.isFinite(v) && v >= 0 ? v : 24;
})();
const BACKUP_RETAIN = (() => {
  const v = Number(process.env.LLMIDE_BACKUP_RETAIN ?? 7);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 7;
})();
let backupTimer = null;

function runAutoBackup() {
  if (shuttingDown) return;
  if (BACKUP_INTERVAL_HOURS === 0) return;
  try {
    const dbDir     = path.dirname(config.dbPath);
    const backupDir = process.env.LLMIDE_BACKUP_DIR || path.join(dbDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp  = Math.floor(Date.now() / 1000);
    const target = path.join(backupDir, `data-${stamp}.db`);
    const safeTarget = target.replace(/'/g, "''");
    getDb({ logger }).exec(`VACUUM INTO '${safeTarget}'`);
    const stat = fs.statSync(target);
    logger.info('auto_backup_created', { path: target, bytes: stat.size });

    // Prune: keep only the N most-recent backups.
    const all = fs.readdirSync(backupDir)
      .filter((f) => /^data-\d+\.db$/.test(f))
      .sort()          // ascending by timestamp prefix
      .reverse();      // newest first
    for (const old of all.slice(BACKUP_RETAIN)) {
      try {
        fs.unlinkSync(path.join(backupDir, old));
        logger.info('auto_backup_pruned', { file: old });
      } catch (e) {
        logger.warn('auto_backup_prune_failed', { file: old, error: e.message });
      }
    }
  } catch (err) {
    logger.error('auto_backup_failed', { error: err.message });
  }
}

// ── Fail-closed loopback guard ──────────────────────────────────────────
// This server has no built-in TLS and exposes auth tokens + an encrypted
// vault. Binding a non-loopback address is only allowed when the operator
// has explicitly opted in via LLMIDE_ALLOW_REMOTE=1 AND is expected to
// front it with a TLS-terminating reverse proxy. Otherwise we refuse to
// start rather than silently exposing secrets on the network.
const IS_LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (!IS_LOOPBACK && !config.allowRemote) {
  logger.error('server_bind_refused', {
    host: HOST,
    message:
      `Refusing to bind non-loopback address "${HOST}" without LLMIDE_ALLOW_REMOTE=1. ` +
      'This server has no built-in TLS; exposing it leaks tokens and vault data. ' +
      'Set LLMIDE_HOST=127.0.0.1 for local use, or set LLMIDE_ALLOW_REMOTE=1 ' +
      'AND place a TLS-terminating reverse proxy (nginx, Caddy) in front.',
  });
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  // Even when remote binding is explicitly allowed, warn loudly so the
  // operator is reminded the app itself terminates no TLS.
  if (!IS_LOOPBACK) {
    logger.warn('server_network_exposed', {
      host: HOST,
      message:
        'Server is bound to a non-loopback address with no built-in TLS. ' +
        'Place a TLS-terminating reverse proxy (nginx, Caddy) in front before ' +
        'accepting external traffic. All tokens and vault data travel unencrypted otherwise.',
    });
  }

  // Open the DB at boot so migrations apply BEFORE we accept traffic;
  // a slow first request would otherwise pay the migration cost.
  try {
    getDb({ logger });
    // Restore persisted rate-limit state before accepting any requests
    // so a restart doesn't reset all buckets to full.
    try { loadBuckets(getDb({ logger })); } catch (err) {
      logger.warn('rate_limit_load_failed', { error: err.message });
    }
    runAuthGc('at_boot');
    // Start the recurring sweep. unref() so the timer doesn't keep
    // the process alive past shutdown signals.
    authGcTimer = setInterval(() => runAuthGc('periodic'), AUTH_GC_INTERVAL_MS);
    if (typeof authGcTimer.unref === 'function') authGcTimer.unref();

    // Automatic backup scheduler. Skip when disabled (interval=0).
    if (BACKUP_INTERVAL_HOURS > 0) {
      runAutoBackup();  // first backup at boot
      backupTimer = setInterval(runAutoBackup, BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
      if (typeof backupTimer.unref === 'function') backupTimer.unref();
    }
    // Server-side outcome poller — polls all dispatched tasks on a
    // schedule using vault-stored credentials. No client needs to be
    // connected for status updates to flow in.
    startBackgroundOutcomePoller();
  } catch (err) {
    logger.error('db_open_failed_at_boot', { error: err.message });
    process.exit(1);
  }
  // Initial probe — non-blocking; result lands in the cache for /health.
  probeClaude().catch(() => { /* logged inside */ });
  logger.info('server_started', {
    host: HOST,
    port: PORT,
    apiVersion: SERVER_API_VERSION,
    endpoints: ENDPOINTS.length,
    pid: process.pid,
    config: configSummary(),
  });
});
