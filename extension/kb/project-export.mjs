// Project-scoped data export.
//
// Returns every meeting (with entities) and every plan (with tasks) that
// belong to a given projectId.  Meetings are scoped by meta.projectId;
// plans are scoped by their parent meeting OR by meta.projectId if the
// plan was created without a meeting.
//
// Performance: uses two batch queries (entities, tasks) instead of N+1
// per-meeting / per-plan round-trips.

import { getDb, safeParseMeta, requireUser } from './db.mjs';

// projectId max length matches the Swift model (Project.id = RandomID ~26 chars,
// but we accept up to 128 to be forward-compatible).
const PROJECT_ID_MAX = 128;

/**
 * Export all KB data for a single project in ≤ 4 DB round-trips.
 *
 * Round-trips:
 *   1. Fetch all matching meetings
 *   2. Batch-fetch all entities for those meetings  (NOT N+1)
 *   3. Fetch all matching plans
 *   4. Batch-fetch all tasks for those plans         (NOT N+1)
 *
 * @param {string} userId
 * @param {string} projectId
 */
export function exportProject(userId, projectId) {
  requireUser(userId);
  if (!projectId || typeof projectId !== 'string'
      || projectId.length === 0 || projectId.length > PROJECT_ID_MAX) {
    throw new Error(`projectId must be a non-empty string (max ${PROJECT_ID_MAX} chars)`);
  }

  const db = getDb();

  // ── 1. Meetings ───────────────────────────────────────────────────────────
  const meetingRows = db.prepare(`
    SELECT id, title, date, duration_sec, language, participants, transcript, meta
    FROM   meetings
    WHERE  user_id = ?
      AND  json_extract(meta, '$.projectId') = ?
    ORDER  BY date ASC
  `).all(userId, projectId);

  // ── 2. Entities — one batch query, grouped in memory ─────────────────────
  const entityByMeeting = new Map();   // meetingId → Entity[]
  if (meetingRows.length > 0) {
    const meetingIds = meetingRows.map((m) => m.id);
    const ph = meetingIds.map(() => '?').join(',');
    const entityRows = db.prepare(`
      SELECT id, meeting_id, kind, text, quote, meta, created_at
      FROM   entities
      WHERE  user_id = ?
        AND  meeting_id IN (${ph})
      ORDER  BY meeting_id, rowid ASC
    `).all(userId, ...meetingIds);

    for (const e of entityRows) {
      if (!entityByMeeting.has(e.meeting_id)) entityByMeeting.set(e.meeting_id, []);
      entityByMeeting.get(e.meeting_id).push({
        id:        e.id,
        kind:      e.kind,
        text:      e.text,
        quote:     e.quote || null,
        createdAt: e.created_at || null,
        meta:      safeParseMeta(e.meta),
      });
    }
  }

  const meetings = meetingRows.map((m) => {
    const participants = safeParseMeta(m.participants) || [];
    return {
      id:           m.id,
      title:        m.title || '(untitled)',
      date:         m.date || null,
      durationSec:  m.duration_sec ?? null,
      language:     m.language || 'en',
      participants,
      transcript:   m.transcript || '',
      createdAt:    m.created_at || null,
      meta:         safeParseMeta(m.meta) || {},
      entities:     entityByMeeting.get(m.id) || [],
    };
  });

  // ── 3. Plans — scoped by meeting membership OR direct projectId tag ───────
  const meetingIds = meetingRows.map((m) => m.id);
  let planRows = [];
  if (meetingIds.length > 0) {
    const ph = meetingIds.map(() => '?').join(',');
    planRows = db.prepare(`
      SELECT p.id, p.meeting_id, p.title, p.goal, p.language,
             p.meta, p.created_at, p.updated_at
      FROM   plans p
      WHERE  p.user_id = ?
        AND  (p.meeting_id IN (${ph})
              OR json_extract(p.meta, '$.projectId') = ?)
      ORDER  BY p.created_at ASC
    `).all(userId, ...meetingIds, projectId);
  } else {
    // No meetings — check for plans tagged directly with this projectId
    planRows = db.prepare(`
      SELECT p.id, p.meeting_id, p.title, p.goal, p.language,
             p.meta, p.created_at, p.updated_at
      FROM   plans p
      WHERE  p.user_id = ?
        AND  json_extract(p.meta, '$.projectId') = ?
      ORDER  BY p.created_at ASC
    `).all(userId, projectId);
  }

  // ── 4. Tasks — one batch query for all plans, grouped in memory ───────────
  const tasksByPlan = new Map();   // planId → Task[]
  if (planRows.length > 0) {
    const planIds = planRows.map((p) => p.id);
    const ph = planIds.map(() => '?').join(',');
    const taskRows = db.prepare(`
      SELECT id, plan_id, position, milestone, title, description, owner, due,
             estimate_days, depends_on, status, risk, risk_reason, files, meta
      FROM   plan_tasks
      WHERE  user_id = ?
        AND  plan_id IN (${ph})
      ORDER  BY plan_id, position ASC
    `).all(userId, ...planIds);

    for (const t of taskRows) {
      if (!tasksByPlan.has(t.plan_id)) tasksByPlan.set(t.plan_id, []);
      const dependsOn = safeParseMeta(t.depends_on) || [];
      const files     = safeParseMeta(t.files)      || [];
      tasksByPlan.get(t.plan_id).push({
        id:           t.id,
        position:     t.position ?? 0,
        milestone:    t.milestone || null,
        title:        t.title,
        description:  t.description || null,
        owner:        t.owner || null,
        due:          t.due || null,
        estimateDays: t.estimate_days ?? null,
        dependsOn,
        status:       t.status || 'planned',
        risk:         t.risk || null,
        riskReason:   t.risk_reason || null,
        files,
        meta:         safeParseMeta(t.meta),
      });
    }
  }

  const plans = planRows.map((p) => ({
    id:        p.id,
    meetingId: p.meeting_id || null,
    title:     p.title || '(untitled plan)',
    goal:      p.goal || '',
    language:  p.language || 'en',
    meta:      safeParseMeta(p.meta) || {},
    createdAt: p.created_at || null,
    updatedAt: p.updated_at || null,
    tasks:     tasksByPlan.get(p.id) || [],
  }));

  return {
    projectId,
    exportedAt:   new Date().toISOString(),
    meetingCount: meetings.length,
    planCount:    plans.length,
    meetings,
    plans,
  };
}
