// HS256 JWT implementation built on Node's `crypto`.  We don't pull
// jsonwebtoken because the surface we use is tiny (sign + verify with
// a shared secret) and the dep brings transitive churn we don't want
// in a security-sensitive path.
//
// Spec: RFC 7515 + RFC 7519, alg='HS256' only.  Tokens we don't sign
// are rejected even if they parse — we never accept 'none' or RS*.

import crypto from 'crypto';
import { config } from '../core/config.mjs';

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

const JWT_CLOCK_SKEW_SEC = 2;

function b64encode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function sign(payload) {
  const body = b64encode(payload);
  const data = `${HEADER}.${body}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Constant-time compare for two base64url strings of equal length.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Try to verify the token signature against `secret`. Returns true only
// when the signature matches.
function verifySignature(headerB64, payloadB64, sig, secret) {
  const expected = crypto.createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`).digest('base64url');
  return safeEqual(sig, expected);
}

function verifyAndDecode(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sig] = parts;

  // Try current key first; fall back to the previous key when set so
  // tokens issued before a rotation remain valid for their TTL window.
  const verified =
    verifySignature(headerB64, payloadB64, sig, config.jwtSecret) ||
    (config.jwtSecretPrevious
      ? verifySignature(headerB64, payloadB64, sig, config.jwtSecretPrevious)
      : false);
  if (!verified) return null;

  // Reject anything that isn't HS256 — guards against `alg: none`
  // and key-confusion attacks even if the signature happened to match.
  let header;
  try { header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')); }
  catch { return null; }
  if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!payload || typeof payload !== 'object') return null;

  // Validate standard claims.  We're strict about iss, exp, iat — nbf
  // is optional and ignored if absent.
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== config.jwtIssuer) return null;
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null;
  // A malformed token (exp not after iat) is just an invalid token —
  // return null like every other validation failure here so the caller
  // produces a clean 401 instead of throwing a 500 out of the verifier.
  if (payload.exp <= payload.iat) return null;
  if (payload.exp < now - JWT_CLOCK_SKEW_SEC) return null;
  if (payload.iat > now + JWT_CLOCK_SKEW_SEC) return null;
  return payload;
}

export function signAccessToken({ userId, role = 'user' }) {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    iss: config.jwtIssuer,
    sub: String(userId),
    role,
    typ: 'access',
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + config.accessTokenTTLSec,
  });
}

export function verifyAccessToken(token) {
  const payload = verifyAndDecode(token);
  if (!payload || payload.typ !== 'access') return null;
  return { userId: payload.sub, role: payload.role || 'user', jti: payload.jti, exp: payload.exp };
}

// Refresh tokens are opaque random strings rather than JWTs — they're
// stored hashed in `refresh_tokens` so even a DB read leak doesn't
// allow direct session hijack.  See server/users.mjs for issue.
export function newRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function extractBearer(req) {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
