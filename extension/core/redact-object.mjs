// Structural redaction for objects that get persisted or echoed back
// (audit log details, activity feed payloads). Two defenses layered:
//
//   1. Key-name redaction — any key matching REDACT_KEYS or containing a
//      credential-ish substring is replaced with '[redacted]' wholesale.
//   2. Value-shape redaction — free-text strings (an error `message`, a
//      `detail` string) are scrubbed by redactSecrets so a token embedded
//      in prose doesn't land in the log verbatim.
//
// Pure (string/object in → object out, no DB/network) so it lives in core
// and both the audit log (server/audit.mjs) and the activity feed
// (kb/activity.mjs) share one policy that can't drift.

import { redactSecrets } from './redact-secrets.mjs';

// Limits applied during redaction — defined once so changes stay consistent.
const REDACT_LIMITS = {
  arraySlice:   20,    // max array elements to include in redacted output
  stringLength: 500,   // max string chars before truncating
};

const REDACT_KEYS = new Set([
  'password', 'currentPassword', 'newPassword',
  'token', 'apiKey', 'secret', 'webhookUrl', 'authorization',
  'ghToken', 'ghKey', 'lnKey',
  // Additional token / credential fields identified in audit:
  'refreshToken', 'resetToken', 'accessToken', 'idToken',
  'code',          // OAuth authorization codes
  'privateKey', 'clientSecret', 'masterKey', 'encryptionKey',
]);

// Pattern-based fallback: also redact any key whose name contains these
// substrings (case-insensitive), so newly-added fields don't slip through.
const REDACT_KEY_PATTERNS = ['token', 'secret', 'password', 'apikey', 'auth', 'credential'];

function isRedactableKey(k) {
  if (REDACT_KEYS.has(k)) return true;
  const lower = String(k).toLowerCase();
  return REDACT_KEY_PATTERNS.some((p) => lower.includes(p));
}

export function redact(obj, depth = 0) {
  if (depth > 4) return '…';
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.slice(0, REDACT_LIMITS.arraySlice).map((v) => redact(v, depth + 1));
  if (typeof obj !== 'object') {
    if (typeof obj !== 'string') return obj;
    // Key-name redaction only catches secrets stored under a credential-named
    // key. A token embedded in a free-text value (an error `message`, a `detail`
    // string) would otherwise land in the audit log verbatim — scrub by value
    // shape too. Truncate first so the cap applies to the post-redaction text.
    const truncated = obj.length > REDACT_LIMITS.stringLength ? obj.slice(0, REDACT_LIMITS.stringLength) + '…' : obj;
    return redactSecrets(truncated);
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = isRedactableKey(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}
