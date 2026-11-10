// Usage-ledger rows for one agent run. The task route and the bus review both meter through here.
import { getDb } from '../../kb/db.mjs';
import { recordUsage, pickMainModelRow } from '../../kb/usage.mjs';

/**
 * One row per model the run used, with the run's cost, turns and stop reason on the primary model's row only, so a
 * helper model cannot count the round trips twice. Only the claude engine reports usage, so the provider is anthropic.
 * Best effort: a failed write never reaches the caller. A run with no usage writes nothing.
 */
export function meterAgentRun({ userId, run, source, endpoint, projectId = null, requestId }) {
  const usage = run?.usage;
  if (!usage) return;
  try {
    const rows = Array.isArray(run.byModel) && run.byModel.length ? run.byModel : [{ model: run.model ?? 'unknown', ...usage }];
    const primary = Math.max(0, rows.indexOf(pickMainModelRow(rows, run.model)));
    const runCost = Number(usage.costUsd);
    const turns = Number(usage.numTurns) > 0 ? Number(usage.numTurns) : null;
    rows.forEach((row, index) => recordUsage(getDb(), {
      userId, provider: 'anthropic', model: row.model, source, endpoint, requestId,
      inputTokens: row.inputTokens, outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens, cacheCreationTokens: row.cacheCreationTokens,
      projectId,
      ...(index === primary ? { turns, stopReason: run.stopReason ?? null, costUsd: runCost > 0 ? runCost : null } : {}),
    }));
  } catch { /* metering is best-effort */ }
}
