// Task outcome polling — recordOutcome, listOutcomesForTask,
// listDispatchedTasks, outcomeStats. The outcome watcher polls
// GitLab / GitHub / Slack for the state of dispatched tasks and
// writes one row per state change; the planner / risk-analyzer
// read recent outcomes to weight similar future tasks.
//
// Extracted from kb/db.mjs as part of the modularization sweep.

import {
  getDb,
  lazyPrepare,
  safeJSONStringify,
  safeParseMeta,
  requireUser,
} from './db.mjs';
import { logger } from '../core/logger.mjs';
import { recordActivity } from './activity.mjs';

// ── Outcome → task-status auto-sync ──────────────────────────────────────
//
// When a terminal outcome is recorded we automatically advance the
// plan_task.status so the plan board reflects reality without the user
// having to manually tick each ticket:
//
//   merged   → done
//   closed   → done
//   cancelled→ cancelled
//   reverted → blocked  (something went wrong; surface it)
//
// After syncing we check if any sibling tasks were waiting on this task
// (depends_on contains this id, status='blocked') and, if all of their
// dependencies are now done/cancelled, we unblock them automatically.

const OUTCOME_TO_STATUS = {
  merged:    'done',
  closed:    'done',
  cancelled: 'cancelled',
  reverted:  'blocked',
};

function autoSyncTaskStatus(db, userId, taskId, outcomeState) {
  const newStatus = OUTCOME_TO_STATUS[outcomeState];
  if (!newStatus) return; // non-terminal or unknown — nothing to sync

  // 1. Update the task itself (only when the status actually needs to change
  //    to avoid spurious updated_at bumps).
  lazyPrepare(db, `
    UPDATE plan_tasks SET status = ?
    WHERE id = ? AND user_id = ? AND status != ?
  `).run(newStatus, String(taskId), userId, newStatus);

  // 2. Find blocked siblings in the same plan that list this task as a dep.
  const row = lazyPrepare(db,
    'SELECT plan_id FROM plan_tasks WHERE id = ? AND user_id = ?',
  ).get(String(taskId), userId);
  if (!row) return;

  const blocked = lazyPrepare(db, `
    SELECT id, depends_on FROM plan_tasks
    WHERE plan_id = ? AND user_id = ? AND status = 'blocked'
  `).all(row.plan_id, userId);

  // Collect the union of all dependency IDs across blocked siblings so we
  // can resolve their statuses in a single IN-query instead of one query
  // per dep (N+1 → 1).
  const allDepIds = new Set();
  const siblingDeps = new Map(); // sibling.id → string[] of depIds
  for (const sibling of blocked) {
    const deps = safeParseMeta(sibling.depends_on);
    if (!Array.isArray(deps)) continue;
    const strDeps = deps.map(String);
    if (!strDeps.includes(String(taskId))) continue;
    siblingDeps.set(sibling.id, strDeps);
    for (const d of strDeps) allDepIds.add(d);
  }

  if (allDepIds.size > 0) {
    // Single batch query for all dep statuses.
    // IMPORTANT: better-sqlite3's .all() binds positional args — we must
    // spread the dep-id array as individual args, then append userId.
    // Passing the array as a single first argument would bind it as a BLOB
    // and silently produce wrong results / miss tenant isolation.
    const placeholders = [...allDepIds].map(() => '?').join(', ');
    const depRows = db.prepare(
      `SELECT id, status FROM plan_tasks WHERE id IN (${placeholders}) AND user_id = ?`,
    ).all(...[...allDepIds], userId);
    const depStatus = new Map(depRows.map((r) => [String(r.id), r.status]));

    for (const [siblingId, deps] of siblingDeps) {
      const allResolved = deps.every((depId) => {
        const s = depStatus.get(String(depId));
        return s === 'done' || s === 'cancelled';
      });
      if (allResolved) {
        lazyPrepare(db, `
          UPDATE plan_tasks SET status = 'planned'
          WHERE id = ? AND user_id = ?
        `).run(siblingId, userId);
      }
    }
  }
}

// Return all distinct user IDs that have at least one dispatched task.
// Used by the server-side background outcome poller to know which
// users to poll without requiring each user to be online.
// Cap at 500 users — prevents a full table-scan from blocking the
// event loop when the DB grows large. The outcome poller will cycle
// through all users over successive runs.
const MAX_POLLED_USERS = 500;

// The dispatcher claims a task by writing this sentinel into
// `meta.dispatched.url` before the real network call, then overwrites it
// with the real ticket URL on success (or releases the claim on failure —
// see claimTaskForDispatch / releaseTaskDispatchClaim in kb/plans.mjs). It
// is a non-null string, so a naive "IS NOT NULL" filter also matches an
// in-flight claim — every dispatched-task query here must explicitly
// exclude it, or the outcome watcher will poll a task mid-dispatch (before
// it has a real ticket URL) and record a spurious "unknown" outcome.
const DISPATCH_SENTINEL = '__dispatching__';

export function listUsersWithDispatchedTasks() {
  const db = getDb();
  return lazyPrepare(db, `
    SELECT DISTINCT user_id FROM plan_tasks
    WHERE json_extract(meta, '$.dispatched.url') IS NOT NULL
      AND json_extract(meta, '$.dispatched.url') != ?
    LIMIT ?
  `).all(DISPATCH_SENTINEL, MAX_POLLED_USERS).map((r) => r.user_id);
}

const TERMINAL_STATES = new Set(['closed', 'merged', 'cancelled', 'reverted']);

// Append a state observation to the outcomes table — but only if it
// differs from the most recent observation for this task. Polling
// can fire many times per minute; without dedupe the table would
// balloon and the planner's "past outcome" lookups would slow down
// for no gain.
export function recordOutcome(userId, { taskId, provider, ref, state, meta = {} }) {
  requireUser(userId);
  if (!taskId || !state) throw new Error('taskId and state required');
  const db = getDb();

  // Reject attempts to record outcomes against tasks the caller doesn't own.
  const owner = lazyPrepare(db, 'SELECT user_id FROM plan_tasks WHERE id = ?').get(String(taskId));
  if (!owner || owner.user_id !== userId) {
    throw new Error('Task not found or not owned by user');
  }

  // Wrap the dedup-check, INSERT, and mergeTaskMeta in a single transaction
  // so two concurrent outcome arrivals for the same task can't produce a
  // lost-update: one will block until the other commits, then read the
  // deduplicated state.  autoSyncTaskStatus runs inside the same
  // transaction so the plan_tasks.status flip is also atomic.
  return db.transaction(() => {
    const last = lazyPrepare(db, `
      SELECT state, meta FROM outcomes
      WHERE task_id = ? AND user_id = ? ORDER BY observed_at DESC LIMIT 1
    `).get(String(taskId), userId);
    if (last && last.state === state) {
      const prev = JSON.stringify(safeParseMeta(last.meta) || {});
      const next = safeJSONStringify(meta || {});
      if (prev === next) return null;
    }
    const fromState = last?.state || null;
    const isTerminal = TERMINAL_STATES.has(state) ? 1 : 0;
    const info = lazyPrepare(db, `
      INSERT INTO outcomes (task_id, user_id, provider, ref, state, is_terminal, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(taskId),
      userId,
      String(provider || 'unknown'),
      String(ref || ''),
      String(state),
      isTerminal,
      safeJSONStringify(meta || {}),
    );

    // Update task meta within the same transaction (inline to avoid a
    // nested db.transaction() call, which would be a no-op under
    // better-sqlite3 but is cleaner to express explicitly here).
    const cur = lazyPrepare(db,
      'SELECT meta FROM plan_tasks WHERE id = ? AND user_id = ?',
    ).get(String(taskId), userId);
    if (cur) {
      const next = {
        ...(safeParseMeta(cur.meta) || {}),
        outcome: { state, observedAt: new Date().toISOString(), ref, provider, meta },
      };
      lazyPrepare(db,
        'UPDATE plan_tasks SET meta = ? WHERE id = ? AND user_id = ?',
      ).run(safeJSONStringify(next), String(taskId), userId);
    }

    // Autonomous side-effect: when a terminal state arrives, advance the
    // plan_task status and unblock any tasks that were waiting on this one.
    if (isTerminal) {
      try {
        autoSyncTaskStatus(db, userId, taskId, state);
      } catch (syncErr) {
        // Non-fatal — outcome row and meta are already recorded atomically
        // above.  Errors here are typically a task-not-found edge-case on
        // a race; log so they are visible in the server log.
        logger.warn('outcomes.autoSyncTaskStatus failed', {
          taskId: String(taskId),
          error: syncErr?.message || String(syncErr),
        });
      }
    }

    if (fromState !== state) {
      try {
        recordActivity(db, {
          userId,
          kind: 'outcome_changed',
          title: `${ref} ${state}`,
          detail: { resource: ref, fromState, toState: state },
        });
      } catch {}
    }

    return { id: info.lastInsertRowid, state, isTerminal: Boolean(isTerminal) };
  })();
}

export function listOutcomesForTask(userId, taskId, limit = 20) {
  requireUser(userId);
  const db = getDb();
  return lazyPrepare(db, `
    SELECT id, provider, ref, state, is_terminal, meta, observed_at
    FROM outcomes WHERE task_id = ? AND user_id = ?
    ORDER BY observed_at DESC LIMIT ?
  `).all(String(taskId), userId, Math.min(100, Math.max(1, Number(limit) || 20)))
    .map((r) => ({
      id: r.id,
      provider: r.provider,
      ref: r.ref,
      state: r.state,
      isTerminal: !!r.is_terminal,
      meta: safeParseMeta(r.meta),
      observedAt: r.observed_at,
    }));
}

// Used by the outcome watcher — every task that has been dispatched
// has `meta.dispatched.{provider, url, number}` and is fair game to
// poll.
//
// Capped at 1 000 rows: a user with thousands of dispatched tasks would
// otherwise serialize the entire table in one response, both slowing
// the watcher and allocating unbounded memory.  The watcher polls every
// OUTCOME_POLL_INTERVAL_MS (default 5 min; env override
// LLMIDE_OUTCOME_POLL_MS) and will eventually cycle through all tasks
// over multiple passes.
const MAX_DISPATCHED_ROWS = 1_000;

export function listDispatchedTasks(userId) {
  requireUser(userId);
  const db = getDb();
  const rows = lazyPrepare(db, `
    SELECT id, plan_id, title, meta FROM plan_tasks
    WHERE user_id = ?
      AND json_extract(meta, '$.dispatched.url') IS NOT NULL
      AND json_extract(meta, '$.dispatched.url') != ?
    LIMIT ?
  `).all(userId, DISPATCH_SENTINEL, MAX_DISPATCHED_ROWS);
  return rows.map((r) => {
    const meta = safeParseMeta(r.meta) || {};
    return {
      id: r.id,
      planId: r.plan_id,
      title: r.title,
      dispatched: meta.dispatched,
      lastOutcome: meta.outcome || null,
    };
  });
}

// Aggregate stats for the History UI.
export function outcomeStats(userId) {
  requireUser(userId);
  const db = getDb();
  const rows = lazyPrepare(db,
    'SELECT state, COUNT(*) AS n FROM outcomes WHERE user_id = ? GROUP BY state'
  ).all(userId);
  const stats = {};
  let total = 0;
  for (const r of rows) { stats[r.state] = r.n; total += r.n; }
  return { total, byState: stats };
}

// All dispatched tasks that have a pending retry (dispatchRetry.nextRetryAt set).
// Used by retryFailedDispatches() in the dispatcher to find due retries.
export function listDispatchedTasksForRetry(userId) {
  requireUser(userId);
  const db = getDb();
  const rows = lazyPrepare(db, `
    SELECT id, plan_id, title, meta FROM plan_tasks
    WHERE user_id = ?
      AND json_extract(meta, '$.dispatchRetry.nextRetryAt') IS NOT NULL
    LIMIT 200
  `).all(userId);
  return rows.map((r) => ({
    id: r.id,
    planId: r.plan_id,
    title: r.title,
    meta: safeParseMeta(r.meta) || {},
  }));
}
