// Phase-6 review queue — user-approval gate for guardrailed
// actions (dispatch, codegen-apply). Routes call these helpers via
// the re-exports in db.mjs; the HTTP layer lives in routes/review.mjs.
//
// Extracted from kb/db.mjs as part of the modularization sweep.

import { getDb, lazyPrepare, genId, safeJSONStringify, safeParseMeta, requireUser } from './db.mjs';

const ALLOWED_REVIEW_KINDS = new Set(['dispatch', 'codegen-apply']);
const ALLOWED_REVIEW_STATUS = new Set(['pending', 'approved', 'rejected', 'executed', 'failed', 'expired']);

export function submitReview(userId, input) {
  requireUser(userId);
  const db = getDb();
  if (!ALLOWED_REVIEW_KINDS.has(input?.kind)) {
    throw new Error(`Unknown review kind: ${input?.kind}`);
  }
  // If a planId is supplied, verify the user owns that plan; same for
  // taskId. This stops a malicious caller from queueing a review item
  // referencing somebody else's resource.
  if (input.planId) {
    const ok = lazyPrepare(db, 'SELECT 1 FROM plans WHERE id = ? AND user_id = ?')
      .get(String(input.planId), userId);
    if (!ok) throw new Error('Referenced plan not found or not owned');
  }
  if (input.taskId) {
    const ok = lazyPrepare(db, 'SELECT 1 FROM plan_tasks WHERE id = ? AND user_id = ?')
      .get(String(input.taskId), userId);
    if (!ok) throw new Error('Referenced task not found or not owned');
  }
  const id = genId('rev');
  const guardrails = input.guardrails || {};
  lazyPrepare(db, `
    INSERT INTO review_items (id, user_id, kind, plan_id, task_id, title, payload, guardrails, status)
    VALUES (@id, @user_id, @kind, @plan_id, @task_id, @title, @payload, @guardrails, @status)
  `).run({
    id,
    user_id: userId,
    kind: input.kind,
    plan_id: input.planId ? String(input.planId) : null,
    task_id: input.taskId ? String(input.taskId) : null,
    title: String(input.title || `${input.kind} review`).slice(0, 500),
    payload: safeJSONStringify(input.payload || {}),
    guardrails: safeJSONStringify(guardrails),
    status: 'pending',
  });
  return getReview(userId, id);
}

export function listReviews(userId, { status, limit = 50 } = {}) {
  requireUser(userId);
  const db = getDb();
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  let rows;
  if (status && ALLOWED_REVIEW_STATUS.has(status)) {
    rows = lazyPrepare(db, `
      SELECT id, kind, plan_id, task_id, title, status, created_at, decided_at
      FROM review_items WHERE user_id = ? AND status = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, status, cap);
  } else {
    rows = lazyPrepare(db, `
      SELECT id, kind, plan_id, task_id, title, status, created_at, decided_at
      FROM review_items WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, cap);
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    planId: r.plan_id,
    taskId: r.task_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }));
}

export function getReview(userId, id) {
  requireUser(userId);
  const db = getDb();
  const r = lazyPrepare(db,
    'SELECT * FROM review_items WHERE id = ? AND user_id = ?'
  ).get(String(id), userId);
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    planId: r.plan_id,
    taskId: r.task_id,
    title: r.title,
    payload: safeParseMeta(r.payload) || {},
    guardrails: safeParseMeta(r.guardrails) || {},
    status: r.status,
    reviewerNote: r.reviewer_note,
    result: safeParseMeta(r.result),
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export function setReviewStatus(userId, id, { status, reviewerNote, result, expectedStatus } = {}) {
  requireUser(userId);
  if (!ALLOWED_REVIEW_STATUS.has(status)) throw new Error(`Bad status: ${status}`);
  const db = getDb();
  // Optional compare-and-swap: when `expectedStatus` is provided, the
  // UPDATE only fires if the row is still in that state. Used by the
  // approve path to make pending→approved atomic — two concurrent
  // double-clicks no longer both pass the "is pending?" check and
  // both dispatch. Returns null when the swap loses.
  const cas = typeof expectedStatus === 'string';
  const sql = cas
    ? `UPDATE review_items SET
         status = ?,
         reviewer_note = COALESCE(?, reviewer_note),
         result = COALESCE(?, result),
         decided_at = CASE WHEN ? IN ('approved','rejected','executed','failed','expired')
                           THEN datetime('now') ELSE decided_at END
       WHERE id = ? AND user_id = ? AND status = ?`
    : `UPDATE review_items SET
         status = ?,
         reviewer_note = COALESCE(?, reviewer_note),
         result = COALESCE(?, result),
         decided_at = CASE WHEN ? IN ('approved','rejected','executed','failed','expired')
                           THEN datetime('now') ELSE decided_at END
       WHERE id = ? AND user_id = ?`;
  const args = cas
    ? [status, reviewerNote ?? null, result !== undefined ? safeJSONStringify(result) : null, status, String(id), userId, expectedStatus]
    : [status, reviewerNote ?? null, result !== undefined ? safeJSONStringify(result) : null, status, String(id), userId];
  const info = lazyPrepare(db, sql).run(...args);
  if (info.changes === 0) return null;
  return getReview(userId, id);
}

export function deleteReview(userId, id) {
  requireUser(userId);
  const db = getDb();
  lazyPrepare(db, 'DELETE FROM review_items WHERE id = ? AND user_id = ?')
    .run(String(id), userId);
}
