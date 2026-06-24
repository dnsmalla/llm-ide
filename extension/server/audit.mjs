// Append-only audit log.  Every state-mutating action records:
// who (user_id), what (action + resource), where from (ip + ua),
// when, and outcome (success / failure / denied).  The router
// invokes `recordAudit` after a write completes; non-mutating reads
// don't generate rows so the table stays sane in volume.

import { recordAuditEvent } from './metrics.mjs';
import { redactSecrets } from '../core/redact-secrets.mjs';

const ALLOWED_OUTCOMES = new Set(['success', 'failure', 'denied']);

// Field limits — defined once so changes stay consistent.
const AUDIT_LIMITS = {
  arraySlice:    20,    // max array elements to include in redacted output
  stringLength:  500,   // max string chars before truncating
  actionField:   100,   // max chars for the action field
  resourceField: 200,   // max chars for the resource field
  queryMax:      500,   // hard cap on results per listAudit call
  queryDefault:  100,   // default results when limit is not specified
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
  if (Array.isArray(obj)) return obj.slice(0, AUDIT_LIMITS.arraySlice).map((v) => redact(v, depth + 1));
  if (typeof obj !== 'object') {
    if (typeof obj !== 'string') return obj;
    // Key-name redaction only catches secrets stored under a credential-named
    // key. A token embedded in a free-text value (an error `message`, a `detail`
    // string) would otherwise land in the audit log verbatim — scrub by value
    // shape too. Truncate first so the cap applies to the post-redaction text.
    const truncated = obj.length > AUDIT_LIMITS.stringLength ? obj.slice(0, AUDIT_LIMITS.stringLength) + '…' : obj;
    return redactSecrets(truncated);
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = isRedactableKey(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

// Retention sweep: delete audit rows older than `ageDays`. The audit log
// otherwise grows unbounded (indefinite retention of IPs/user-agents + DB
// bloat). Called on the auth GC interval alongside the token purges. Returns
// the number of rows deleted.
export function purgeOldAuditRows(db, ageDays = 90) {
  const info = db.prepare(
    `DELETE FROM audit_log WHERE created_at < datetime('now', ?)`,
  ).run(`-${Number(ageDays) || 90} days`);
  return info.changes;
}

export function recordAudit(db, {
  userId, requestId, ip, userAgent, action, resource, outcome = 'success', detail,
}) {
  if (!ALLOWED_OUTCOMES.has(outcome)) outcome = 'success';
  let detailJson = null;
  if (detail !== undefined) {
    try { detailJson = JSON.stringify(redact(detail)); }
    catch { detailJson = '"<unstringifiable>"'; }
  }
  db.prepare(`
    INSERT INTO audit_log (user_id, request_id, ip, user_agent, action, resource, outcome, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId ? String(userId) : null,
    requestId || null,
    ip || null,
    userAgent || null,
    String(action).slice(0, AUDIT_LIMITS.actionField),
    resource ? String(resource).slice(0, AUDIT_LIMITS.resourceField) : null,
    outcome,
    detailJson,
  );
  recordAuditEvent();
}

export function listAuditForUser(db, userId, { limit = 100, action } = {}) {
  const cap = Math.max(1, Math.min(AUDIT_LIMITS.queryMax, Number(limit) || AUDIT_LIMITS.queryDefault));
  let rows;
  if (action) {
    rows = db.prepare(`
      SELECT id, action, resource, outcome, detail, created_at, ip, user_agent
      FROM audit_log WHERE user_id = ? AND action = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(String(userId), String(action), cap);
  } else {
    rows = db.prepare(`
      SELECT id, action, resource, outcome, detail, created_at, ip, user_agent
      FROM audit_log WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(String(userId), cap);
  }
  return rows.map((r) => {
    let detail = null;
    if (r.detail) {
      // A corrupted row must not crash the entire list — use null so
      // the UI still gets the rest of the audit trail.
      try { detail = JSON.parse(r.detail); }
      catch { detail = null; }
    }
    return {
      id: r.id,
      action: r.action,
      resource: r.resource,
      outcome: r.outcome,
      detail,
      createdAt: r.created_at,
      ip: r.ip,
      userAgent: r.user_agent,
    };
  });
}

