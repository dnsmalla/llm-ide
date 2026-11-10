// The `plan.status` core task: refresh the user's dispatched outcomes through the same poller the
// /kb/outcomes/refresh route uses. It owns no polling logic and makes no model call.
import { refreshAllOutcomes as poller } from '../outcome-watcher.mjs';

export async function runPlanStatus({ userId, creds = {}, deps = {} }) {
  const refresh = deps.refreshAllOutcomes ?? poller;
  const summary = await refresh(userId, { creds });
  const count = Number.isInteger(summary?.refreshed) ? summary.refreshed : 0;
  return { ok: true, summary: `Refreshed ${count} outcome(s).`, output: JSON.stringify(summary), result: summary };
}
