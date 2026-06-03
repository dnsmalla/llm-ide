// Append-only audit log.  Every state-mutating action records:
// who (user_id), what (action + resource), where from (ip + ua),
// when, and outcome (success / failure / denied).  The router
// invokes `recordAudit` after a write completes; non-mutating reads
// don't generate rows so the table stays sane in volume.

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

function redact(obj, depth = 0) {
  if (depth > 4) return '…';
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.slice(0, AUDIT_LIMITS.arraySlice).map((v) => redact(v, depth + 1));
  if (typeof obj !== 'object') {
    if (typeof obj === 'string' && obj.length > AUDIT_LIMITS.stringLength) return obj.slice(0, AUDIT_LIMITS.stringLength) + '…';
    return obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = isRedactableKey(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
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

