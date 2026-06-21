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
//   GET  /auth/well-known   — server capabilities + auth metadata
//
// Anything else returns 401 with a stable `AUTH_REQUIRED` error code.

import { errAuth, errForbidden } from '../core/errors.mjs';
import { extractBearer, verifyAccessToken } from './jwt.mjs';
import { isJtiRevoked } from '../kb/db.mjs';

const PUBLIC_PATHS = new Set([
  '/',
  '/health',
  '/auth/well-known',
  '/auth/register',
  '/auth/login',
  '/auth/refresh',
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
  req.user = { id: claims.userId, role: claims.role, jti: claims.jti, tokenExp: claims.exp };
  return true;
}

// Helper for handlers that must be admin-only.  Use sparingly — most
// authorization is "owner of resource" which lives in the route logic.
export function requireAdmin(req) {
  if (!req.user || req.user.role !== 'admin') {
    throw errForbidden('Admin role required');
  }
}
