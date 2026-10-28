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

/**
 * Open a run. Returns { finish(close) }. `finish` is idempotent: only the
 * first call writes, so a path that closes twice cannot double-count.
 */
export function beginAgentRun(userId, { runId, source, engine = null, mode = null, provider = null, model = null } = {}) {
  const startedMs = Date.now();
  try {
    openRun(userId, { runId, source, engine, mode, provider, model }, {});
  } catch { /* best effort */ }
  let done = false;
  return {
    runId,
    finish(close = {}) {
      if (done) return false;
      done = true;
      try {
        return enqueueRunClose(userId, runId, { ...close, durationMs: Date.now() - startedMs });
      } catch {
        return false;
      }
    },
  };
}
