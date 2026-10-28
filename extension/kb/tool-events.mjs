// Per-turn tool accounting. The rows live in agent.db (Stage 1b): one row per
// tool call, keyed by run_id (= the chat turn id). Best-effort by contract: a
// telemetry write must never break a model turn. Writes go through the agent
// store's queue (kb/agent-store.mjs enqueueToolEvents).
import { flushAgentQueue, getAgentDb } from './agent-db.mjs';
import { enqueueToolEvents } from './agent-store.mjs';
import { getDb, requireUser } from './db.mjs';
import { summarizeToolEventsOn } from './tool-events-summary.mjs';

export function recordToolEvents(userId, { turnId, engine, mode = null, events } = {}) {
  try {
    requireUser(userId);
    return enqueueToolEvents(userId, turnId, { engine, mode, events });
  } catch {
    return 0;
  }
}

/**
 * Summary over agent.db. The per-turn token averages join usage_ledger, which
 * stays in the main DB, so the main handle is passed as `ledgerDb` (null =
 * no token averages). userId null = every user (operator report only).
 */
export function summarizeToolEvents(userId, opts = {}) {
  if (userId !== null) requireUser(userId);
  flushAgentQueue();
  const agent = getAgentDb();
  if (!agent) return null;
  return summarizeToolEventsOn(agent, userId, { ledgerDb: getDb(), ...opts });
}

export { summarizeToolEventsOn };
