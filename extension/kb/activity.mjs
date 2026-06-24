// Activity feed store — the single source of truth for auto-generated events.
// Mirrors the audit_log / recordAudit pattern (server/audit.mjs) but writes to
// the separate `activity` table (different semantics + retention).
//
// All functions are best-effort: callers wrap in try/catch and a failure here
// must never throw into the operation that triggered the event.
import { redact } from '../server/audit.mjs';

// The v1 event-kind allow-list (shared contract; Swift mirrors this).
export const ACTIVITY_KINDS = new Set([
  'knowledge_updated',
  'regression_done',
  'issue_created',
  'comment_added',
  'dispatch_issue_created',
  'outcome_changed',
  'meeting_added',
  'email_fetched',
  'slack_fetched',
]);

const TITLE_CAP = 200;
const DETAIL_CAP = 4000;
const LINK_CAP = 512;
const KEEP_PER_USER = 500;

function clamp(str, cap) {
  if (typeof str !== 'string') return null;
  return str.length > cap ? str.slice(0, cap) : str;
}

// Redact + stringify a detail object, capped to DETAIL_CAP chars.
// Mirrors recordAudit: structured key-name redaction first (catches
// object-property secrets like { apiKey: 'sk-...' }), then stringify,
// then cap — the same order audit.mjs uses.
function encodeDetail(detail) {
  if (detail == null) return null;
  let json;
  try { json = JSON.stringify(redact(detail)); } catch { return null; }
  return json.length > DETAIL_CAP ? json.slice(0, DETAIL_CAP) : json;
}

// Insert one event and prune the user's feed to the newest KEEP_PER_USER rows.
// Returns the inserted row id, or null on invalid input / failure.
export function recordActivity(db, { userId, kind, title, detail, link } = {}) {
  if (!userId || !ACTIVITY_KINDS.has(kind) || typeof title !== 'string' || !title) {
    return null;
  }
  try {
    const info = db.prepare(
      `INSERT INTO activity (user_id, kind, title, detail, link) VALUES (?, ?, ?, ?, ?)`
    ).run(userId, kind, clamp(title, TITLE_CAP), encodeDetail(detail), clamp(link, LINK_CAP));
    const id = Number(info.lastInsertRowid);
    db.prepare(
      `DELETE FROM activity
        WHERE user_id = ?
          AND id NOT IN (SELECT id FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ?)`
    ).run(userId, userId, KEEP_PER_USER);
    return id;
  } catch {
    return null;
  }
}
