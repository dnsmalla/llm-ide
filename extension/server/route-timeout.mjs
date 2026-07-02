// Opt-in per-route handler timeout budgets.
//
// The socket layer already caps every request end-to-end at
// server.requestTimeout (300 s, see server.mjs). This module adds a
// TIGHTER, per-route budget for known-bounded POST handlers so a stuck
// dependency (DB lock, wedged CLI subprocess) returns a clean 504 JSON
// envelope early instead of holding the slot until the socket cap.
//
// OPT-IN ONLY: a route absent from the map has no handler budget.
// Streaming routes (SSE: /kb/live/:id/stream, /code-assist, agent
// dispatch) must NEVER be listed — they are long-lived by design.
import { AppError, sendError } from '../core/errors.mjs';

const BUDGETS_POST = new Map([
  ['/kb/ingest',              60_000],
  ['/kb/search',              30_000],
  ['/kb/delete',              30_000],
  ['/kb/dispatch',            60_000],
  ['/kb/providers/verify',    30_000],
  ['/kb/providers/models',    30_000],
  ['/kb/generate-plan',      180_000],
  ['/kb/analyze-risks',      180_000],
  ['/kb/summarize',          240_000],  // runClaude has its own 3-min ceiling; budget sits above it
  ['/kb/conflict-questions', 240_000],
  ['/kb/generate-code',      240_000],
]);

export function routeTimeoutMs(url, method) {
  if (method !== 'POST') return null;
  const path = String(url || '').split('?')[0];
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
