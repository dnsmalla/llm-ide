// Plan + task CRUD. A plan is a small JSON-modeled object with a
// flat list of tasks attached; the planner / risk-analyzer /
// code-sync pipeline produces it, the meeting agent reads it for
// follow-up questions, and the user edits it via the Plan tab.
//
// Extracted from kb/db.mjs as part of the modularization sweep.
// db.mjs re-exports every public function so call sites keep
// working unchanged.

import { getDb, genId, safeJSONStringify, safeParseMeta, lazyPrepare, requireUser } from './db.mjs';

const ALLOWED_TASK_STATUS = new Set(['planned', 'in_progress', 'done', 'blocked', 'cancelled']);
const ALLOWED_RISK = new Set(['low', 'med', 'high']);

// Persist or replace a plan along with its tasks. Atomic: either every
// task gets stored or none, so a partial write can't leave a half-
// rendered plan behind in the UI.
export function savePlan(userId, plan) {
  requireUser(userId);
  const db = getDb();
  const id = String(plan.id || genId('plan'));
  const meetingId = plan.meetingId ? String(plan.meetingId) : null;

  const title = String(plan.title || 'Untitled plan').slice(0, 500);
  const goal = plan.goal ? String(plan.goal).slice(0, 5000) : null;
  const language = plan.language ? String(plan.language).slice(0, 16) : null;
  const meta = safeJSONStringify(plan.meta || {});

  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];

  const tx = db.transaction(() => {
    // Ownership check on update path: if a plan with this id already
    // exists, refuse to clobber a row owned by another user.
    // Done INSIDE the transaction so check+upsert are atomic.
    const owner = db.prepare('SELECT user_id FROM plans WHERE id = ?').get(id);
    if (owner && owner.user_id !== userId) {
      throw new Error('Plan id is owned by another user');
    }

    // ── Plan snapshot (version history) ────────────────────────────
    // Before replacing tasks, read the current state and append it to
    // meta.snapshots (last 3 versions). This gives lightweight rollback
    // and an audit trail without a separate table or migration.
    const SNAPSHOT_KEEP = 3;
    let metaParsed = {};
    try { metaParsed = JSON.parse(meta) || {}; } catch { /* empty */ }

    const existing = db.prepare(
      'SELECT meta FROM plans WHERE id = ? AND user_id = ?',
    ).get(id, userId);
    if (existing) {
      const prevMeta = safeParseMeta(existing.meta) || {};
      const prevTasks = db.prepare(
        'SELECT id, title, status, risk, position FROM plan_tasks WHERE plan_id = ? AND user_id = ? ORDER BY position',
      ).all(id, userId);
      const snap = {
        savedAt: new Date().toISOString(),
        taskCount: prevTasks.length,
        tasks: prevTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, risk: t.risk })),
      };
      const prevSnaps = Array.isArray(prevMeta.snapshots) ? prevMeta.snapshots : [];
      metaParsed.snapshots = [snap, ...prevSnaps].slice(0, SNAPSHOT_KEEP);
    }
    // Re-serialise meta with snapshots merged in.
    const metaFinal = safeJSONStringify(metaParsed);

    db.prepare(`
      INSERT INTO plans (id, user_id, meeting_id, title, goal, language, meta)
      VALUES (@id, @user_id, @meeting_id, @title, @goal, @language, @meta)
      ON CONFLICT(id) DO UPDATE SET
        meeting_id = excluded.meeting_id,
        title = excluded.title,
        goal = excluded.goal,
        language = excluded.language,
        meta = excluded.meta,
        updated_at = datetime('now')
    `).run({ id, user_id: userId, meeting_id: meetingId, title, goal, language, meta: metaFinal });

    // Replace tasks wholesale — the planner re-emits the full list on
    // every run, and we want stale tasks (removed during a re-plan) to
    // disappear instead of accumulating.
    db.prepare('DELETE FROM plan_tasks WHERE plan_id = ? AND user_id = ?').run(id, userId);

    const insTask = db.prepare(`
      INSERT INTO plan_tasks (
        id, plan_id, user_id, position, milestone, title, description, owner, due,
        estimate_days, depends_on, status, risk, risk_reason, files, meta
      ) VALUES (
        @id, @plan_id, @user_id, @position, @milestone, @title, @description, @owner, @due,
        @estimate_days, @depends_on, @status, @risk, @risk_reason, @files, @meta
      )
    `);
    tasks.forEach((t, idx) => {
      const taskId = String(t.id || genId('t'));
      const status = ALLOWED_TASK_STATUS.has(t.status) ? t.status : 'planned';
      const risk = t.risk && ALLOWED_RISK.has(t.risk) ? t.risk : null;
      const due = typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : null;
      insTask.run({
        id: taskId,
        plan_id: id,
        user_id: userId,
        position: idx,
        milestone: t.milestone ? String(t.milestone).slice(0, 200) : null,
        title: String(t.title || 'Task').slice(0, 500),
        description: t.description ? String(t.description).slice(0, 5000) : null,
        owner: t.owner ? String(t.owner).slice(0, 80) : null,
        due,
        estimate_days: Number.isFinite(t.estimateDays) ? t.estimateDays : null,
        depends_on: safeJSONStringify(Array.isArray(t.dependsOn) ? t.dependsOn : []),
        status,
        risk,
        risk_reason: t.riskReason ? String(t.riskReason).slice(0, 1000) : null,
        files: safeJSONStringify(Array.isArray(t.files) ? t.files : []),
        meta: safeJSONStringify(t.meta || {}),
      });
    });
  });

  tx();
  return getPlan(userId, id);
}

export function getPlan(userId, planId) {
  requireUser(userId);
  const db = getDb();
  const p = db.prepare(
    'SELECT * FROM plans WHERE id = ? AND user_id = ?'
  ).get(String(planId), userId);
  if (!p) return null;
  const tasks = db.prepare(`
    SELECT * FROM plan_tasks WHERE plan_id = ? AND user_id = ? ORDER BY position, milestone
  `).all(p.id, userId).map((t) => ({
    id: t.id,
    planId: t.plan_id,
    position: t.position,
    milestone: t.milestone,
    title: t.title,
    description: t.description,
    owner: t.owner,
    due: t.due,
    estimateDays: t.estimate_days,
    dependsOn: safeParseMeta(t.depends_on) || [],
    status: t.status,
    risk: t.risk,
    riskReason: t.risk_reason,
    files: safeParseMeta(t.files) || [],
    meta: safeParseMeta(t.meta),
  }));
  return {
    id: p.id,
    meetingId: p.meeting_id,
    title: p.title,
    goal: p.goal,
    language: p.language,
    meta: safeParseMeta(p.meta),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    tasks,
  };
}

export function listPlans(userId, limit = 50) {
  requireUser(userId);
  const db = getDb();
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  // Use LEFT JOIN + GROUP BY instead of a correlated subquery — for N plans
  // a correlated COUNT(*) fires N extra queries, the JOIN version fires one.
  return db.prepare(`
    SELECT p.id, p.title, p.meeting_id, p.created_at, p.updated_at,
           COUNT(t.id) AS task_count
    FROM plans p
    LEFT JOIN plan_tasks t ON t.plan_id = p.id AND t.user_id = p.user_id
    WHERE p.user_id = ?
    GROUP BY p.id
    ORDER BY p.updated_at DESC LIMIT ?
  `).all(userId, cap).map((r) => ({
    id: r.id,
    title: r.title,
    meetingId: r.meeting_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    taskCount: r.task_count,
  }));
}

export function deletePlan(userId, planId) {
  requireUser(userId);
  const db = getDb();
  db.prepare('DELETE FROM plans WHERE id = ? AND user_id = ?')
    .run(String(planId), userId);
}

// ── Task-level CRUD ──────────────────────────────────────────────

export function updateTask(userId, taskId, patch) {
  requireUser(userId);
  const db = getDb();
  // Wrap the SELECT + UPDATE in a transaction so two concurrent callers
  // (e.g. the outcome-watcher and the user tapping "done" in the UI)
  // can't produce a lost-update.  better-sqlite3 serialises all writes;
  // the transaction is the critical section that ties the read to the
  // subsequent write atomically.
  return db.transaction(() => {
    const cur = db.prepare(
      'SELECT * FROM plan_tasks WHERE id = ? AND user_id = ?'
    ).get(String(taskId), userId);
    if (!cur) return null;

    const status = patch.status && ALLOWED_TASK_STATUS.has(patch.status) ? patch.status : cur.status;
    const risk = patch.risk === null
      ? null
      : (patch.risk && ALLOWED_RISK.has(patch.risk) ? patch.risk : cur.risk);

    db.prepare(`
      UPDATE plan_tasks SET
        status = ?,
        risk = ?,
        risk_reason = COALESCE(?, risk_reason),
        owner = COALESCE(?, owner),
        due = COALESCE(?, due),
        files = COALESCE(?, files)
      WHERE id = ? AND user_id = ?
    `).run(
      status,
      risk,
      patch.riskReason !== undefined ? patch.riskReason : null,
      patch.owner !== undefined ? patch.owner : null,
      patch.due !== undefined ? patch.due : null,
      patch.files !== undefined ? safeJSONStringify(patch.files) : null,
      String(taskId),
      userId,
    );
    return getTaskById(userId, String(taskId));
  })();
}

/// Shallow-merge a partial object into a task's meta JSON. Used by
/// the dispatcher / codegen to record outcomes (ticket urls,
/// generated artifact lists) without overwriting unrelated meta
/// keys.
///
/// The SELECT + UPDATE is wrapped in a transaction so two concurrent
/// calls (e.g. the dispatcher and the outcome-watcher running in
/// overlapping event-loop ticks) can't produce a lost-update — one
/// will block until the other commits, then read the merged result.
/// better-sqlite3 serialises all writers, so the transaction is the
/// critical section we need.
export function mergeTaskMeta(userId, taskId, partial) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare(
      'SELECT meta FROM plan_tasks WHERE id = ? AND user_id = ?'
    ).get(String(taskId), userId);
    if (!cur) return null;
    const next = { ...(safeParseMeta(cur.meta) || {}), ...(partial || {}) };
    db.prepare(
      'UPDATE plan_tasks SET meta = ? WHERE id = ? AND user_id = ?'
    ).run(safeJSONStringify(next), String(taskId), userId);
    return getTaskById(userId, String(taskId));
  })();
}

export function getTaskById(userId, taskId) {
  requireUser(userId);
  const db = getDb();
  const t = lazyPrepare(db,
    'SELECT * FROM plan_tasks WHERE id = ? AND user_id = ?'
  ).get(String(taskId), userId);
  if (!t) return null;
  return {
    id: t.id,
    planId: t.plan_id,
    position: t.position,
    milestone: t.milestone,
    title: t.title,
    description: t.description,
    owner: t.owner,
    due: t.due,
    estimateDays: t.estimate_days,
    dependsOn: safeParseMeta(t.depends_on) || [],
    status: t.status,
    risk: t.risk,
    riskReason: t.risk_reason,
    files: safeParseMeta(t.files) || [],
    meta: safeParseMeta(t.meta),
  };
}

