// Opt-in per-route handler timeout budgets.
//
// A budget here returns a clean 504 JSON envelope when a route's handler
// overruns, instead of holding the slot. It is the right tool for a route whose
// work is a QUICK, BOUNDED interaction with something external — a provider
// credential check, an outbound dispatch — where a slow answer means the
// dependency is unhealthy.
//
// It is the WRONG tool for a route that does AI generation or scales with the
// user's data, and those budgets have been removed. `server.requestTimeout` is
// now 0 (see server.mjs) and the agent loop has no deadline, so these were the
// last remaining clock over that work — and they cut it off in exactly the cases
// that need time most: `/kb/summarize` 504'd at 240 s on a long transcript, so
// the Mac summarizer discarded the real AI summary and wrote its local fallback,
// which is precisely the failure removing the client-side 5-minute race was
// meant to fix. Generation routes are bounded by the agent's iteration budget and
// by client cancellation; indexing routes are bounded by their own input caps.
//
// OPT-IN ONLY: a route absent from the map has no handler budget.
// Streaming routes (SSE: /kb/live/:id/stream, /code-assist, agent
// dispatch) must NEVER be listed — they are long-lived by design.
//
// Do NOT add a budget for an LLM route. See
// docs/explanation/invariants.md ("Do NOT reintroduce a wall-clock deadline on
// agent work").
import { AppError, sendError } from '../core/errors.mjs';

const BUDGETS_POST = new Map([
  // Outbound provider REST calls: creating an issue/PR is a short API round
  // trip, so a minute of silence means the provider is unhealthy, not busy.
  ['/kb/dispatch',            60_000],
  // Credential/model liveness probes — a slow answer IS the answer.
  ['/kb/providers/verify',    30_000],
  ['/kb/providers/models',    30_000],
  // A KB delete is a bounded set of indexed DELETEs, not a scaling workload.
  ['/kb/delete',              30_000],
  // Removed (were 60 s–240 s): /kb/ingest and /kb/connect-box scale with how
  // much data the user is indexing; /kb/ingest-scip is already bounded by
  // loadScipIndex's own subprocess kill timer; and /kb/generate-plan,
  // /kb/analyze-risks, /kb/summarize, /kb/conflict-questions and
  // /kb/generate-code are all LLM generation.
]);

export function routeTimeoutMs(url, method) {
  const path = String(url || '').split('?')[0];
  // /kb/delete is the one route the router accepts on both DELETE and POST;
  // every other budgeted route below is POST-only.
  if (path === '/kb/delete' && (method === 'DELETE' || method === 'POST')) {
    return BUDGETS_POST.get(path) ?? null;
  }
  if (method !== 'POST') return null;
  return BUDGETS_POST.get(path) ?? null;
}

export function errTimeout(ms) {
  return new AppError('TIMEOUT', `Request exceeded the ${Math.round(ms / 1000)}s budget for this route`, { status: 504 });
}

const TIMED_OUT = Symbol('route-timeout');

// Race `fn` against the budget. On timeout: log, send the 504 envelope
// (sendError no-ops when the handler already wrote headers) and return
// true ("handled") so the dispatcher stops. The abandoned handler keeps
// running to completion; its late writes are swallowed by the
// headersSent guards in sendJSON/sendError/auth-routes send().
export async function withRouteTimeout(req, res, ms, fn) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const result = await Promise.race([fn(), timeout]);
    if (result === TIMED_OUT) {
      req.log?.error('route_timeout', { url: req.url, budgetMs: ms });
      sendError(res, errTimeout(ms), { logger: req.log });
      return true;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
