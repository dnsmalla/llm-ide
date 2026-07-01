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
  'model_fallback',
]);

const TITLE_CAP = 200;
const DETAIL_CAP = 4000;
const LINK_CAP = 512;
const KEEP_PER_USER = 500;

function clamp(str, cap) {
  if (typeof str !== 'string') return null;
  return str.length > cap ? str.slice(0, cap) : str;
}

// A feed link is a deep-link target a client may render as an href, so only
// http(s) schemes are stored — a `javascript:`/`data:`/etc. link is dropped
// (returns null) to avoid a stored-XSS vector. Capped to LINK_CAP first.
function safeLink(link) {
  const clamped = clamp(link, LINK_CAP);
  if (clamped == null || clamped === '') return null;
  try {
    const proto = new URL(clamped).protocol;
    return (proto === 'http:' || proto === 'https:') ? clamped : null;
  } catch {
    return null;
  }
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
    ).run(userId, kind, clamp(title, TITLE_CAP), encodeDetail(detail), safeLink(link));
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

// Newest-first feed.  sinceId>0 → only rows after that id (incremental poll);
// otherwise the newest `limit` rows.
export function listActivity(db, userId, { sinceId = 0, limit = 100 } = {}) {
  // Clamp defensively: the HTTP route already bounds limit, but other callers
  // could pass 0 (SQLite LIMIT 0 → no rows) or a negative (LIMIT -1 → no limit).
  limit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const rows = sinceId > 0
    ? db.prepare(
        `SELECT id, kind, title, detail, link, created_at
           FROM activity WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT ?`
      ).all(userId, sinceId, limit)
    : db.prepare(
        `SELECT id, kind, title, detail, link, created_at
           FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ?`
      ).all(userId, limit);
  return rows.map((r) => {
    let detail = null;
    if (r.detail) { try { detail = JSON.parse(r.detail); } catch { detail = null; } }
    return { id: r.id, kind: r.kind, title: r.title, detail, link: r.link, created_at: r.created_at };
  });
}

// Number of events newer than the user's last-seen cursor.
export function unreadCount(db, userId) {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM activity
      WHERE user_id = ?
        AND id > COALESCE((SELECT last_seen_id FROM activity_seen WHERE user_id = ?), 0)`
  ).get(userId, userId);
  return row ? row.c : 0;
}

// Advance the last-seen cursor; never lowers it.
export function markSeen(db, userId, uptoId) {
  // Only a positive integer id advances the cursor; anything else is a no-op
  // floor of 0 (the MAX upsert below never lowers an existing cursor).
  const upto = Number.isInteger(uptoId) && uptoId > 0 ? uptoId : 0;
  db.prepare(
    `INSERT INTO activity_seen (user_id, last_seen_id) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_seen_id = MAX(last_seen_id, excluded.last_seen_id)`
  ).run(userId, upto);
  const row = db.prepare(`SELECT last_seen_id FROM activity_seen WHERE user_id = ?`).get(userId);
  return row ? row.last_seen_id : 0;
}
