// Meeting + entity CRUD: ingest, delete, fetch, list, entities,
// stats. The core of the KB — every other domain (plans, agent,
// search) reads meetings/entities. Kept as one module because
// they share the FTS triggers + tenancy invariant tightly.
//
// Extracted from kb/db.mjs as part of the modularization sweep.

import {
  getDb,
  lazyPrepare,
  safeJSONStringify,
  safeParseMeta,
  requireUser,
} from './db.mjs';
import { outcomeStats as outcomeStatsImpl } from './outcomes.mjs';
import { recordActivity } from './activity.mjs';

const ALLOWED_KINDS = new Set(['action', 'decision', 'blocker']);

// ── Writes ────────────────────────────────────────────────────────

export function ingestMeeting(userId, input) {
  requireUser(userId);
  const db = getDb();
  const meta = {
    ...(input.meta && typeof input.meta === 'object' ? input.meta : {}),
    ...(input.projectId ? { projectId: String(input.projectId).slice(0, 64) } : {}),
  };
  const meeting = {
    id: String(input.id || ''),
    user_id: userId,
    title: String(input.title || 'Untitled meeting'),
    date: String(input.date || new Date().toISOString()),
    duration_sec: Number.isFinite(input.duration) ? Math.round(input.duration) : 0,
    language: input.language ? String(input.language) : null,
    participants: safeJSONStringify(Array.isArray(input.participants) ? input.participants : []),
    transcript: typeof input.transcript === 'string' ? input.transcript : '',
    meta: safeJSONStringify(meta),
  };
  if (!meeting.id) throw new Error('Missing meeting id');

  const tx = db.transaction((m, entities) => {
    // Refuse upserts that would steal another tenant's row by id collision.
    // Check ownership INSIDE the transaction so the check+upsert are atomic;
    // mismatches throw rather than silently rebinding the row to the new caller.
    const existing = lazyPrepare(db, 'SELECT user_id FROM meetings WHERE id = ?').get(m.id);
    if (existing && existing.user_id !== userId) {
      throw new Error('Meeting id is owned by another user');
    }

    lazyPrepare(db, `
      INSERT INTO meetings (id, user_id, title, date, duration_sec, language, participants, transcript, meta)
      VALUES (@id, @user_id, @title, @date, @duration_sec, @language, @participants, @transcript, @meta)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        date = excluded.date,
        duration_sec = excluded.duration_sec,
        language = excluded.language,
        participants = excluded.participants,
        transcript = excluded.transcript,
        meta = excluded.meta
    `).run(m);

    // Replace this meeting's entities wholesale on every ingest so the
    // KB always reflects the latest extraction (re-runs on the same
    // transcript don't accumulate duplicates).
    lazyPrepare(db, 'DELETE FROM entities WHERE meeting_id = ? AND user_id = ?').run(m.id, userId);

    const ins = lazyPrepare(db, `
      INSERT INTO entities (id, meeting_id, user_id, kind, text, meta, quote)
      VALUES (@id, @meeting_id, @user_id, @kind, @text, @meta, @quote)
    `);
    for (const e of entities) {
      if (!ALLOWED_KINDS.has(e.kind)) continue;
      if (!e.id || !e.text) continue;
      ins.run({
        id: String(e.id),
        meeting_id: m.id,
        user_id: userId,
        kind: e.kind,
        text: String(e.text).slice(0, 2000),
        meta: safeJSONStringify(e.meta || {}),
        quote: e.quote ? String(e.quote).slice(0, 500) : null,
      });
    }
  });

  const entityList = Array.isArray(input.entities) ? input.entities : [];
  tx(meeting, entityList);

  const title = String(input.title || 'Untitled meeting');
  const participantCount = Array.isArray(input.participants) ? input.participants.length : 0;
  const date = String(input.date || new Date().toISOString());
  try {
    recordActivity(db, {
      userId,
      kind: 'meeting_added',
      title: `Meeting added — ${title}${participantCount ? ` (${participantCount} participants)` : ''}`,
      detail: { title, participantCount, date },
    });
  } catch {}

  return { meetingId: meeting.id, entityCount: entityList.length };
}

export function deleteMeeting(userId, meetingId) {
  requireUser(userId);
  const db = getDb();
  lazyPrepare(db, 'DELETE FROM meetings WHERE id = ? AND user_id = ?')
    .run(String(meetingId), userId);
}

// ── Reads ─────────────────────────────────────────────────────────

export function getMeetingTranscript(userId, meetingId) {
  requireUser(userId);
  const db = getDb();
  const row = lazyPrepare(db,
    'SELECT transcript FROM meetings WHERE id = ? AND user_id = ?',
  ).get(String(meetingId), userId);
  return row?.transcript || '';
}

export function getMeeting(userId, meetingId) {
  requireUser(userId);
  const db = getDb();
  const m = lazyPrepare(db,
    'SELECT * FROM meetings WHERE id = ? AND user_id = ?',
  ).get(String(meetingId), userId);
  if (!m) return null;
  const entities = lazyPrepare(db,
    'SELECT id, kind, text, meta, quote FROM entities WHERE meeting_id = ? AND user_id = ? ORDER BY rowid',
  ).all(m.id, userId).map((e) => ({
    id: e.id,
    kind: e.kind,
    text: e.text,
    quote: e.quote,
    meta: safeParseMeta(e.meta),
  }));
  return {
    id: m.id,
    title: m.title,
    date: m.date,
    durationSec: m.duration_sec,
    language: m.language,
    participants: safeParseMeta(m.participants) || [],
    entities,
  };
}

// Read-only listing used by /kb/export-all. Returns one DB row per
// meeting in date-desc order, optionally paged via the opaque
// `cursor` (last seen meeting id from the prior page).
export function listMeetings(userId, cursor, limit) {
  requireUser(userId);
  const db = getDb();
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  // (date, id) order is total — id breaks ties so the cursor advances.
  const sql = cursor
    ? `SELECT id, user_id, title, date, duration_sec, language, participants, transcript
       FROM meetings
       WHERE user_id = ?
         AND (date, id) < (
           SELECT date, id FROM meetings WHERE id = ? AND user_id = ?
         )
       ORDER BY date DESC, id DESC
       LIMIT ?`
    : `SELECT id, user_id, title, date, duration_sec, language, participants, transcript
       FROM meetings
       WHERE user_id = ?
       ORDER BY date DESC, id DESC
       LIMIT ?`;
  const rows = cursor
    ? lazyPrepare(db, sql).all(userId, String(cursor), userId, cap)
    : lazyPrepare(db, sql).all(userId, cap);
  return rows.map((m) => ({
    ...m,
    participants: safeParseMeta(m.participants) || [],
  }));
}

export function listEntities(userId, meetingId) {
  requireUser(userId);
  const db = getDb();
  return lazyPrepare(db,
    'SELECT id, meeting_id, kind, text, meta, quote FROM entities WHERE meeting_id = ? AND user_id = ? ORDER BY rowid',
  ).all(String(meetingId), userId).map((e) => ({
    ...e,
    meta: safeParseMeta(e.meta) || {},
  }));
}

// Bulk variant: fetch entities for many meetings in ONE query, grouped by
// meeting id. Used by the exporter to avoid an N+1 (one SELECT per meeting)
// that monopolized the single SQLite connection on large accounts. The
// placeholder list is built from the (validated) id count, never user text.
export function listEntitiesForMeetings(userId, meetingIds) {
  requireUser(userId);
  const ids = (meetingIds || []).map(String);
  const out = {};
  if (ids.length === 0) return out;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, meeting_id, kind, text, meta, quote FROM entities
     WHERE user_id = ? AND meeting_id IN (${placeholders}) ORDER BY meeting_id, rowid`,
  ).all(userId, ...ids);
  for (const e of rows) {
    const row = { ...e, meta: safeParseMeta(e.meta) || {} };
    (out[e.meeting_id] ||= []).push(row);
  }
  return out;
}

export function getEntity(userId, entityId) {
  requireUser(userId);
  const db = getDb();
  const e = lazyPrepare(db, `
    SELECT e.id, e.meeting_id, e.kind, e.text, e.meta, e.quote, m.title AS meeting_title, m.date
    FROM entities e LEFT JOIN meetings m ON m.id = e.meeting_id
    WHERE e.id = ? AND e.user_id = ?
  `).get(String(entityId), userId);
  if (!e) return null;
  return {
    id: e.id,
    meetingId: e.meeting_id,
    meetingTitle: e.meeting_title,
    date: e.date,
    kind: e.kind,
    text: e.text,
    quote: e.quote,
    meta: safeParseMeta(e.meta),
  };
}

// ── Stats ─────────────────────────────────────────────────────────

// `stats()` runs ~9 COUNT/GROUP-BY scans and is hit repeatedly — /kb/stats and
// /kb/system/status both call it, often back-to-back and on a poll. A tiny
// per-user TTL cache collapses those bursts into one scan set. The window is
// short enough that dashboard counts stay effectively live; single-process +
// single-writer means there's no cross-process coherence to worry about.
const STATS_TTL_MS = 2_000;
// Bound the per-user cache so it can't grow without limit on a multi-tenant
// server (mirrors the rate-limiter's capped bucket map). With a 2s TTL almost
// every entry is already expired at any sweep, so this stays tiny.
const STATS_CACHE_MAX = 2_000;
const _statsCache = new Map(); // userId -> { at, value }

export function stats(userId) {
  requireUser(userId);
  const now = Date.now();
  const cached = _statsCache.get(userId);
  if (cached && now - cached.at < STATS_TTL_MS) return cached.value;
  const value = computeStats(userId);
  // Opportunistic eviction: when the map hits the cap, drop expired entries
  // before inserting (keeps memory bounded without a background timer).
  if (_statsCache.size >= STATS_CACHE_MAX) {
    for (const [k, v] of _statsCache) {
      if (now - v.at >= STATS_TTL_MS) _statsCache.delete(k);
    }
  }
  _statsCache.set(userId, { at: now, value });
  return value;
}

function computeStats(userId) {
  const db = getDb();
  const m = lazyPrepare(db, 'SELECT COUNT(*) AS n FROM meetings WHERE user_id = ?').get(userId).n;
  const e = lazyPrepare(db, 'SELECT COUNT(*) AS n FROM entities WHERE user_id = ?').get(userId).n;
  const sourceRows = lazyPrepare(db,
    'SELECT kind, COUNT(*) AS n, MAX(indexed_at) AS last_indexed FROM sources WHERE user_id = ? GROUP BY kind'
  ).all(userId);
  const sources = { code: 0, ticket: 0, qa: 0, lastIndexed: {} };
  for (const r of sourceRows) {
    sources[r.kind] = r.n;
    sources.lastIndexed[r.kind] = r.last_indexed;
  }
  const plans = lazyPrepare(db, 'SELECT COUNT(*) AS n FROM plans WHERE user_id = ?').get(userId).n;
  const tasks = lazyPrepare(db, 'SELECT COUNT(*) AS n FROM plan_tasks WHERE user_id = ?').get(userId).n;
  const reviewRows = lazyPrepare(db,
    'SELECT status, COUNT(*) AS n FROM review_items WHERE user_id = ? GROUP BY status'
  ).all(userId);
  const reviews = { pending: 0, approved: 0, rejected: 0, executed: 0, failed: 0, expired: 0 };
  for (const r of reviewRows) reviews[r.status] = r.n;
  const outcomes = outcomeStatsImpl(userId);
  return { meetings: m, entities: e, sources, plans, tasks, reviews, outcomes };
}

// Cluster-wide stats for the admin dashboard / Prometheus metrics.
// Does NOT include per-tenant data — only counts.
export function statsAdmin() {
  const db = getDb();
  return {
    users:    lazyPrepare(db, "SELECT COUNT(*) AS n FROM users WHERE id != 'legacy'").get().n,
    meetings: lazyPrepare(db, 'SELECT COUNT(*) AS n FROM meetings').get().n,
    entities: lazyPrepare(db, 'SELECT COUNT(*) AS n FROM entities').get().n,
    sources:  lazyPrepare(db, 'SELECT COUNT(*) AS n FROM sources').get().n,
    plans:    lazyPrepare(db, 'SELECT COUNT(*) AS n FROM plans').get().n,
    tasks:    lazyPrepare(db, 'SELECT COUNT(*) AS n FROM plan_tasks').get().n,
    reviews:  lazyPrepare(db, 'SELECT COUNT(*) AS n FROM review_items').get().n,
    outcomes: lazyPrepare(db, 'SELECT COUNT(*) AS n FROM outcomes').get().n,
    audit:    lazyPrepare(db, 'SELECT COUNT(*) AS n FROM audit_log').get().n,
  };
}
