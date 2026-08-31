// Pending-approval registry for the v2 chat engine.
//
// The SDK's `canUseTool` callback is an in-process async function that may
// legitimately block for minutes while a human decides. HTTP, by contrast,
// answers later from a separate request. This module is the bridge: it parks
// the tool-approval promise under a `requestId` the engine can surface on
// the SSE stream, and the decision route later resolves it via
// `answerDecision` (or the registry itself resolves `expired`/`aborted`).
//
// Deliberately dependency-free (no SDK import, no DB): pure Node state — a
// module-level Map plus per-entry timers. Every resolution path (answer,
// timeout, session abort) clears the timer and removes the entry, so the
// registry never leaks settled decisions. A timed-out requestId leaves a
// short-lived tombstone so a late answer still hears `expired` instead of
// `unknown` — the client was showing the approval, it deserves the truth.

import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 900_000;
const EXPIRED_TOMBSTONE_MS = 60_000;

// requestId -> { sdkSessionId, userId, resolve, timer }
const pending = new Map();

// requestId -> epoch ms at which it expired (insertion-ordered, oldest first)
const expiredAt = new Map();

// Resolve one entry exactly once: clear its timer, drop it from the map,
// then release the awaiting canUseTool caller.
function settle(requestId, entry, value) {
  if (pending.get(requestId) !== entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(value);
}

// Remember an expiry just long enough for a straggling client answer, then
// forget it — the tombstone map is pruned on insert, so it stays bounded.
function rememberExpired(requestId) {
  const now = Date.now();
  expiredAt.set(requestId, now);
  const cutoff = now - EXPIRED_TOMBSTONE_MS;
  for (const [id, ts] of expiredAt) {
    if (ts >= cutoff) break; // insertion-ordered: everything after is fresher
    expiredAt.delete(id);
  }
}

/**
 * Park a decision. The engine calls this inside `canUseTool` and awaits the
 * returned promise; it resolves with `{ action: 'answer', answers }` (or,
 * for a `ToolApproval` decision, `{ action: 'allow' | 'deny' | 'always-allow' }`),
 * `{ action: 'expired' }` (timeout), or `{ action: 'aborted' }` (session
 * dropped). Callers also pass `questions` (the approval prompts) — accepted
 * but not retained here: the engine streams them to the client, and the
 * registry only needs to know how to resolve. `kind` distinguishes the two
 * decision shapes this registry now parks (`'AskUserQuestion'`, the default,
 * back-compat with the original single-kind registry, vs `'ToolApproval'`
 * for act-tool gating) — stored for bookkeeping only; the registry itself
 * resolves identically either way.
 */
export function registerDecision({ sdkSessionId, userId, kind = 'AskUserQuestion', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const requestId = randomUUID();
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const entry = { sdkSessionId, userId, kind, resolve, timer: null };
  entry.timer = setTimeout(() => {
    settle(requestId, entry, { action: 'expired' });
    rememberExpired(requestId);
  }, timeoutMs);
  // A parked decision must not pin the event loop for the whole TTL — the
  // HTTP server keeps the process alive; this timer is only a deadline.
  entry.timer.unref?.();
  pending.set(requestId, entry);
  return { requestId, promise };
}

/**
 * Answer a parked decision (decision route). Tenancy is checked against
 * both the owning user and session before the answer is released. Reasons:
 * `unknown` (no such pending request), `tenancy` (caller is not the owner),
 * `expired` (it timed out — the promise already resolved as such),
 * `invalid_action` (neither `action` nor `answers` names a valid outcome).
 *
 * `action` is one of `'answer' | 'allow' | 'deny' | 'always-allow'`; when
 * omitted it defaults to `'answer'` if `answers` is present — back-compat
 * with the original AskUserQuestion-only call site, which never passed
 * `action` at all.
 */
export function answerDecision({ requestId, sdkSessionId, userId, action, answers } = {}) {
  const entry = pending.get(requestId);
  if (!entry) {
    return expiredAt.has(requestId)
      ? { ok: false, reason: 'expired' }
      : { ok: false, reason: 'unknown' };
  }
  if (entry.sdkSessionId !== sdkSessionId || entry.userId !== userId) {
    return { ok: false, reason: 'tenancy' };
  }
  const resolvedAction = action || (answers !== undefined ? 'answer' : undefined);
  if (!['answer', 'allow', 'deny', 'always-allow'].includes(resolvedAction)) {
    return { ok: false, reason: 'invalid_action' };
  }
  settle(requestId, entry, resolvedAction === 'answer' ? { action: 'answer', answers } : { action: resolvedAction });
  return { ok: true };
}

/**
 * Deny everything pending for a session — called when the SSE stream drops,
 * so a reconnecting client never answers stale approvals. Returns how many
 * decisions were aborted.
 */
export function abortDecisionsForSession(sdkSessionId) {
  let aborted = 0;
  for (const [requestId, entry] of pending) {
    if (entry.sdkSessionId !== sdkSessionId) continue;
    settle(requestId, entry, { action: 'aborted' });
    aborted += 1;
  }
  return aborted;
}
