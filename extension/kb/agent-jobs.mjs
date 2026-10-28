// Agent store lifecycle (Stage 1b): what runs at boot, after listen, on a
// timer, and at shutdown. Everything here is best-effort: a failure is logged,
// never thrown into boot or a request.
//
//   openAgentStoreAtBoot  sync, before listen: open agent.db, raise the id
//                         sequences (prepareHistoryCopy), replay pending user
//                         purges, close stale running rows.
//   startAgentStoreJobs   after listen: quick_check, the one-time history copy
//                         (batched, yielding to the event loop), a rollup, then
//                         a 60 s tick that runs the daily rollup at 03:10 local
//                         and any rollup the size watchdog requested.
//   stopAgentStoreJobs    shutdown: stop the tick. The caller then calls
//                         closeAgentDb(), which flushes the queue.

import { agentStoreStatus, getAgentDb, openAgentDb, takeRollupRequest, verifyAgentDb, localDay, readMeta, writeMeta, checkStorageSize } from './agent-db.mjs';
import { prepareHistoryCopy, copyHistoryStep, historyCopyDone } from './agent-history-copy.mjs';
import { abortStaleRuns, replayPendingPurges, rollupAll } from './agent-store.mjs';

export const TICK_MS = 60 * 1000;
export const DAILY_ROLLUP_HOUR = 3;
export const DAILY_ROLLUP_MINUTE = 10;
const LAST_DAILY_KEY = 'last_daily_rollup_day';

let timer = null;

const log = (logger, level, event, data) => {
  try { logger?.[level]?.(event, data); } catch { /* logging is best effort */ }
};

/** True when the 03:10 local rollup is due and has not run yet today. */
export function dailyRollupDue(lastDay, now = new Date()) {
  const due = now.getHours() > DAILY_ROLLUP_HOUR
    || (now.getHours() === DAILY_ROLLUP_HOUR && now.getMinutes() >= DAILY_ROLLUP_MINUTE);
  return due && lastDay !== localDay(now);
}

/** Sync boot step. Never throws; returns the store status it reached. */
export function openAgentStoreAtBoot({ logger } = {}) {
  try {
    const db = openAgentDb({ logger });
    if (!db) return { ok: false };
    prepareHistoryCopy({ agentDb: db });
    const purged = replayPendingPurges({ db });
    const aborted = abortStaleRuns({ db });
    if (purged.length) log(logger, 'info', 'agent_db_pending_purges_replayed', { count: purged.length });
    if (aborted) log(logger, 'info', 'agent_db_stale_runs_aborted', { count: aborted });
    return { ok: true };
  } catch (err) {
    log(logger, 'error', 'agent_db_boot_failed', { error: err?.message });
    return { ok: false };
  }
}

/** One tick: a requested or due rollup, and the size watchdog. Exported for tests. */
export function agentStoreTick(now = new Date(), { logger } = {}) {
  try {
    const db = getAgentDb();
    if (!db) return { ran: false };
    // A rollup is requested on a TRANSITION into soft or hard, not on every
    // tick while the store stays over the threshold (that would be a full
    // rollup every 60 s). The size refresh itself never sets the flag.
    const before = agentStoreStatus().sizeState;
    const size = checkStorageSize(now.getTime(), { requestRollup: false });
    const transitioned = size.state !== 'ok' && size.state !== before;
    const requested = takeRollupRequest() || transitioned;
    const due = dailyRollupDue(readMeta(db, LAST_DAILY_KEY), now);
    if (!requested && !due) return { ran: false };
    const result = rollupAll({ db, now });
    if (due) writeMeta(db, LAST_DAILY_KEY, localDay(now));
    log(logger, 'info', 'agent_db_rollup', { requested, daily: due, users: result.users?.length ?? 0 });
    return { ran: true, requested, daily: due };
  } catch (err) {
    log(logger, 'error', 'agent_db_rollup_failed', { error: err?.message });
    return { ran: false };
  }
}

/**
 * After listen. Returns a promise that resolves when the history copy has
 * finished (tests await it; the server does not).
 */
export function startAgentStoreJobs({ logger } = {}) {
  if (timer) return { copyDone: Promise.resolve(historyCopyDone()) };
  try {
    const verdict = verifyAgentDb();
    if (!verdict.ok) log(logger, 'error', 'agent_db_integrity', { reason: verdict.reason });
  } catch { /* best effort */ }

  const copyDone = new Promise((resolve) => {
    const step = () => {
      try {
        const r = copyHistoryStep();
        if (!r.ok || r.done) { resolve(historyCopyDone()); return; }
        setImmediate(step);     // yield to the event loop between batches
      } catch (err) {
        log(logger, 'error', 'agent_db_copy_failed', { error: err?.message });
        resolve(false);
      }
    };
    setImmediate(step);
  });

  timer = setInterval(() => agentStoreTick(new Date(), { logger }), TICK_MS);
  timer.unref?.();
  return { copyDone };
}

/** Shutdown: stop the tick. The caller closes the store (closeAgentDb flushes). */
export function stopAgentStoreJobs() {
  if (timer) clearInterval(timer);
  timer = null;
}

