// Auth middleware (multi-tenant).  Replaces the v2.10 shared-secret
// model with JWT-per-user.  An access token is mandatory on every
// state-mutating endpoint; the middleware attaches `req.user` so
// downstream routers can scope DB queries by `user_id`.
//
// Public paths (no auth required):
//   GET  /                  — health probe
//   GET  /health            — health probe
//   POST /auth/register     — public sign-up (rate-limited per IP)
//   POST /auth/login        — credential exchange (rate-limited per IP)
//   POST /auth/refresh      — refresh-token rotation
//   POST /auth/reset-request — password-reset request (rate-limited per IP)
//   POST /auth/reset-confirm — password-reset confirmation (rate-limited per IP)
//   GET  /auth/well-known   — server capabilities + auth metadata
//   GET  /auth/google/callback — Google's OAuth redirect (no bearer token;
//                                ownership is enforced via the state token)
//   GET  /auth/slack/callback  — Slack's OAuth redirect (no bearer token;
//                                ownership is enforced via the state token)
//   GET  /auth/mcp-connector/callback — a remote MCP server's OAuth redirect
//                                (no bearer token; ownership is enforced via
//                                the state token)
//
// Anything else returns 401 with a stable `AUTH_REQUIRED` error code.

import { errAuth, errForbidden } from '../core/errors.mjs';
import { extractBearer, verifyAccessToken } from './jwt.mjs';
import { isJtiRevoked, tokensValidAfter, getDb, lazyPrepare } from '../kb/db.mjs';
import { getMember, atLeast } from '../kb/members.mjs';

const PUBLIC_PATHS = new Set([
  '/',
  '/health',
  '/auth/well-known',
  '/auth/register',
  '/auth/login',
  '/auth/refresh',
  '/auth/reset-request',               // Password-reset request (rate-limited per IP)
  '/auth/reset-confirm',               // Password-reset confirm (rate-limited per IP)
  '/auth/google/callback',             // Google's OAuth redirect carries no bearer token
  '/kb/sync/box/callback',             // Box OAuth redirect for the sync store
  '/auth/slack/callback',              // Slack's OAuth redirect carries no bearer token
  '/auth/mcp-connector/callback',      // MCP connector OAuth redirect carries no bearer token
  '/launch-app',                       // Cross-client deep link → llmide://
]);

// Path prefixes that are public.  Used for routes whose URL contains
// a token or id segment (so an exact-match Set won't work).
const PUBLIC_PREFIXES = [];

export function isPublicPath(method, url) {
  if (method === 'OPTIONS') return true;
  // Strip query string before matching so /launch-app?to=transcript
  // is recognized as the same public route as /launch-app.
  const pathOnly = String(url || '').split('?')[0];
  if (PUBLIC_PATHS.has(pathOnly)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathOnly.startsWith(prefix)) return true;
  }
  return false;
}

// Attach req.user when a valid token is present.  Returns true if the
// caller is authenticated (or the path is public).  Throws AppError
// for invalid/expired tokens — server.mjs serializes those via
// sendError so the client sees the standard envelope.
export function authenticate(req) {
  if (isPublicPath(req.method, req.url || '')) return true;
  const token = extractBearer(req);
  if (!token) throw errAuth('Missing access token');
  const claims = verifyAccessToken(token);
  if (!claims) throw errAuth('Invalid or expired access token');
  if (claims.jti && isJtiRevoked(claims.jti)) throw errAuth('Token has been revoked');
  // Per-user revocation epoch: a "revoke all" (logoutAll / password reset)
  // sets a cutoff; any access token issued before it is dead, so a stolen
  // bearer token can't outlive the revocation by its TTL. (`<` not `<=`: a
  // token minted in the same second as the cutoff is still honoured.)
  if (typeof claims.iat === 'number' && claims.iat < tokensValidAfter(claims.userId)) {
    throw errAuth('Session has been revoked — please sign in again');
  }
  // A disabled account stops on its next request, not when its access token expires (LLMIDE_ACCESS_TTL_SEC,
  // 15 min). Refresh already refuses (server/users.mjs); a still-valid access token must not outlive the
  // disable. One primary-key read, never a JWT claim: `status` is not in the token.
  if (lazyPrepare(getDb(), 'SELECT status FROM users WHERE id = ?').get(String(claims.userId))?.status !== 'active') {
    const e = errAuth('This account is disabled');
    e.code = 'ACCOUNT_DISABLED';
    throw e;
  }
  req.user = { id: claims.userId, role: claims.role, jti: claims.jti, tokenExp: claims.exp };
  return true;
}

// Enforced team authority (ADR 0021). Reads the members row on every call: it is one indexed
// primary-key read, and a grant change must apply on the next request, not at the next login.
// The six admin-gated call sites in server.mjs / extension-routes.mjs call this; a refused caller
// gets 403 ROLE_DENIED and `req.member` is left unset. Never gate per route with a JWT claim:
// `users.role` stays the legacy flag.
export function requireRole(db, req, minRole = 'admin') {
  if (!req.user) {
    throw errForbidden('Authentication required');
  }
  const m = getMember(db, req.user.id);
  if (!m || !atLeast(m.teamRole, minRole)) {
    const e = errForbidden(`Requires team role ${minRole}`);
    e.code = 'ROLE_DENIED';
    throw e;
  }
  req.member = m;
  return m;
}

// Kept for one release so out-of-tree callers fail loudly instead of silently passing.
export function requireAdmin() {
  throw new Error('requireAdmin was replaced by requireRole(db, req, "admin") (ADR 0021)');
}
