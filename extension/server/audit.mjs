// Append-only audit log.  Every state-mutating action records:
// who (user_id), what (action + resource), where from (ip + ua),
// when, and outcome (success / failure / denied).  The router
// invokes `recordAudit` after a write completes; non-mutating reads
// don't generate rows so the table stays sane in volume.

import { recordAuditEvent } from './metrics.mjs';
// Structural redaction lives in core (shared with kb/activity.mjs) — one
// policy for what may land in persisted detail payloads, no drift.
import { redact } from '../core/redact-object.mjs';

const ALLOWED_OUTCOMES = new Set(['success', 'failure', 'denied']);

// Field limits — defined once so changes stay consistent. (Redaction's own
// array/string caps live with `redact` in core/redact-object.mjs.)
const AUDIT_LIMITS = {
  actionField:   100,   // max chars for the action field
  resourceField: 200,   // max chars for the resource field
  queryMax:      500,   // hard cap on results per listAudit call
  queryDefault:  100,   // default results when limit is not specified
};

// Re-export for existing importers of the audit redactor.
export { redact };

// Retention sweep: delete audit rows older than `ageDays`. The audit log
// otherwise grows unbounded (indefinite retention of IPs/user-agents + DB
// bloat). Called on the auth GC interval alongside the token purges. Returns
// the number of rows deleted.
export function purgeOldAuditRows(db, ageDays = 90) {
  // Guard the modifier: a non-positive/NaN ageDays would otherwise build an
  // invalid SQLite datetime modifier (e.g. "--1 days") that silently deletes
  // nothing. Falls back to the 90-day default.
  const days = Number.isFinite(ageDays) && ageDays > 0 ? Math.floor(ageDays) : 90;
  const info = db.prepare(
    `DELETE FROM audit_log WHERE created_at < datetime('now', ?)`,
  ).run(`-${days} days`);
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

