// Run recording for agent.db (Stage 1b, plan section 2.5). A run is one
// user-visible unit of agent work: a chat turn, a Loop step, a meeting-agent
// session. `beginAgentRun` opens the row now (so the Agents hub sees a run that
// is still going); `finish` closes it once, with the run's totals. Both are
// best-effort and never throw into the turn that owns the run.
//
// Token totals here are a display copy. Budget enforcement never reads
// agent_runs; the metered usage ledger (kb/usage.mjs) stays the source of truth.
import { enqueueRunClose, openRun } from './agent-store.mjs';

/** Map a usage object (inputTokens, outputTokens, ...) to close fields. */
export function runTotals(usage) {
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheCreationTokens: usage?.cacheCreationTokens,
  };
}

// Runs begun and not yet finished in this process: the compact guard reads it.
// Every run that begins here (chat v2, legacy code-assist, Loop, meeting agent)
// finishes exactly once, so the count returns to zero when nothing is running.
let openRuns = 0;

/** Runs in flight in this process (any source). The compact guard reads it. */
export function agentRunsInFlight() {
  return openRuns;
}

/**
 * Open a run. Returns { finish(close) }. `finish` is idempotent: only the
 * first call writes, so a path that closes twice cannot double-count.
 */
export function beginAgentRun(userId, { runId, source, engine = null, mode = null, provider = null, model = null } = {}) {
  const startedMs = Date.now();
  openRuns += 1;
  try {
    openRun(userId, { runId, source, engine, mode, provider, model }, {});
  } catch { /* best effort */ }
  let done = false;
  return {
    runId,
    finish(close = {}) {
      if (done) return false;
      done = true;
      openRuns = Math.max(0, openRuns - 1);
      try {
        return enqueueRunClose(userId, runId, { ...close, durationMs: Date.now() - startedMs });
      } catch {
        return false;
      }
    },
  };
}

/**
 * Record a unit of work that is already over (or whose only observable moment
 * is its end) as one open-then-close run. Best-effort: never throws, returns
 * whether the close was queued. A repeated runId is a no-op (INSERT OR IGNORE
 * plus close-only-if-running), so a retried report cannot double count.
 */
export function recordFinishedRun(userId, { runId, source, engine = null, mode = null, provider = null, model = null, startedMs = null, ...close } = {}) {
  try {
    const run = beginAgentRun(userId, { runId, source, engine, mode, provider, model });
    return run.finish({ ...close, durationMs: close.durationMs ?? (startedMs ? Date.now() - startedMs : undefined) });
  } catch {
    return false;
  }
}

/**
 * Run `fn` as an agent run (open now, close once with the outcome). The run
 * never changes the result: `fn`'s value or error passes through untouched.
 * `totals(result)` may return close fields (tokens) and `status(result)` an
 * override such as 'error' for a result that failed without throwing.
 */
export async function withAgentRun(userId, begin, fn, { totals, status } = {}) {
  let run = null;
  try { run = beginAgentRun(userId, begin); } catch { /* best effort */ }
  try {
    const out = await fn();
    try { run?.finish({ status: status?.(out) || 'ok', ...(totals?.(out) || {}) }); } catch { /* best effort */ }
    return out;
  } catch (err) {
    try { run?.finish({ status: 'error', errorCode: err?.code || 'RUN_ERROR' }); } catch { /* best effort */ }
    throw err;
  }
}
