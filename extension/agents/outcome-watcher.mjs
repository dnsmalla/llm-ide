// Phase 8 — outcome watcher.  Coordinates a poll across every dispatched
// task in the KB, deduplicating no-change observations.  The client
// passes whatever credentials it has in chrome.storage; tasks whose
// provider has no creds get a state='unknown' (with the reason).  This
// keeps tokens off disk on the server side — they live for the duration
// of one HTTP call and nothing more.

import { listDispatchedTasks, recordOutcome, listUsersWithDispatchedTasks } from '../kb/db.mjs';
import { pollOne } from './outcome-providers.mjs';
import { pMap } from '../core/p-map.mjs';
import { getDb } from '../kb/db.mjs';
import { getSecrets } from '../server/vault.mjs';
import { logger as _bgLogger } from '../core/logger.mjs';

// Tunable concurrency — we keep it small to be polite to free-tier
// rate limits on the trackers' APIs.  GitHub gives 5000 req/hour
// authenticated, Linear ~1500/hour, Backlog ~10/sec — 4 concurrent
// requests stays well under all three.
const CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Per-provider circuit breaker
// ---------------------------------------------------------------------------
//
// If a provider returns consecutive errors (network failure, 401, 429)
// we open the circuit for an exponentially increasing cooldown so we
// don't burn the user's rate-limit quota hammering a dead endpoint on
// every poll click.
//
//   CLOSED  → normal operation
//   OPEN    → skip all requests until cooldown expires
//   HALF-OPEN → allow one probe; success → CLOSED, failure → OPEN (longer)
//
// State is in-process / in-memory so it resets on server restart.
// That's intentional: a fresh start re-probes rather than staying stuck.

const CB_FAILURE_THRESHOLD = 3;    // consecutive failures → open
const CB_MAX_COOLDOWN_MS   = 5 * 60 * 1000;  // cap at 5 min
const CB_BASE_COOLDOWN_MS  = 15_000;          // first open: 15 s

const circuitBreakers = new Map(); // providerKey → { failures, openUntil }

function cbKey(provider, userId) { return `${provider}::${userId}`; }

function isCircuitOpen(provider, userId) {
  const k = cbKey(provider, userId);
  const cb = circuitBreakers.get(k);
  if (!cb || cb.openUntil === 0) return false;
  if (Date.now() < cb.openUntil) return true;
  // Cooldown expired — enter half-open (allow one probe).
  cb.openUntil = 0;
  return false;
}

function recordCbSuccess(provider, userId) {
  circuitBreakers.delete(cbKey(provider, userId));
}

// Hard cap on the number of circuit-breaker entries kept in memory.
// Each entry is a small object (~40 bytes), so 10k entries ≈ 400 KB —
// well within budget.  Evict the oldest entry (FIFO) when full.
const MAX_CB_ENTRIES = 10_000;

function recordCbFailure(provider, userId) {
  const k = cbKey(provider, userId);
  const cb = circuitBreakers.get(k) || { failures: 0, openUntil: 0 };
  cb.failures += 1;
  if (cb.failures >= CB_FAILURE_THRESHOLD) {
    // Exponential backoff: 15 s, 30 s, 60 s, … capped at 5 min.
    const exp = Math.min(cb.failures - CB_FAILURE_THRESHOLD, 5);
    cb.openUntil = Date.now() + Math.min(CB_BASE_COOLDOWN_MS * (2 ** exp), CB_MAX_COOLDOWN_MS);
  }
  if (!circuitBreakers.has(k) && circuitBreakers.size >= MAX_CB_ENTRIES) {
    // Evict the oldest (first-inserted) entry to bound memory.
    const oldest = circuitBreakers.keys().next().value;
    if (oldest !== undefined) circuitBreakers.delete(oldest);
  }
  circuitBreakers.set(k, cb);
}

// Test/utility hook — used by the test suite.
export function _resetCircuitBreakersForTests() { circuitBreakers.clear(); }

// Provider APIs sometimes echo the offending credential back into the
// error body (e.g. "Bad credentials for ghp_abc...").  Strip the most
// common token shapes before bubbling the message back to the client so
// they can't end up in browser DevTools, log shippers, or screenshots.
const TOKEN_REDACTIONS = [
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /apiKey=[A-Za-z0-9_-]+/gi,
];
function redactTokens(msg) {
  let s = typeof msg === 'string' ? msg : String(msg);
  for (const re of TOKEN_REDACTIONS) s = s.replace(re, '[REDACTED]');
  return s.slice(0, 400);
}

export async function refreshAllOutcomes(userId, { creds = {}, taskIds } = {}) {
  let tasks = listDispatchedTasks(userId);
  if (Array.isArray(taskIds) && taskIds.length > 0) {
    const set = new Set(taskIds.map(String));
    tasks = tasks.filter((t) => set.has(t.id));
  }

  const startedAt = Date.now();
  const polled = await pMap(tasks, async (t) => {
    try {
      return await pollTask(t, userId, creds);
    } catch (err) {
      // Unexpected throw from pollTask (should not happen — all paths return).
      return {
        taskId: t.id, planId: t.planId, title: t.title,
        provider: t.dispatched?.provider, url: t.dispatched?.url,
        state: 'unknown', meta: { error: redactTokens(err?.message || String(err)) },
        changed: false,
      };
    }
  }, CONCURRENCY);
  const counts = polled.reduce((acc, p) => {
    acc[p.state] = (acc[p.state] || 0) + 1;
    return acc;
  }, {});
  return {
    pollErroredCount: polled.filter((p) => p.state === 'unknown').length,
    pollCount: polled.length,
    changedCount: polled.filter((p) => p.changed).length,
    durationMs: Date.now() - startedAt,
    byState: counts,
    polled,
  };
}

async function pollTask(t, userId, creds) {
    const provider = t.dispatched?.provider;

    // Circuit breaker: if this provider has been consecutively failing,
    // skip the poll and return a synthetic 'unknown' so we don't burn the
    // user's rate-limit quota on a broken endpoint.
    if (isCircuitOpen(provider, userId)) {
      return {
        taskId: t.id,
        planId: t.planId,
        title: t.title,
        provider,
        url: t.dispatched.url,
        state: 'unknown',
        meta: { error: 'Circuit open — provider temporarily skipped after repeated failures' },
        changed: false,
        circuitOpen: true,
      };
    }

    const obs = await pollOne(t, creds);
    const isError = !obs || obs.state === 'unknown';
    if (isError) {
      recordCbFailure(provider, userId);
    } else {
      recordCbSuccess(provider, userId);
    }

    let recorded = null;
    if (obs && obs.state) {
      const r = recordOutcome(userId, {
        taskId: t.id,
        provider,
        ref: t.dispatched.url,
        state: obs.state,
        meta: obs.meta || {},
      });
      recorded = r;
    }
    return {
      taskId: t.id,
      planId: t.planId,
      title: t.title,
      provider,
      url: t.dispatched.url,
      state: obs?.state || 'unknown',
      meta: obs?.meta || {},
      changed: !!recorded,
    };
}

// ── Server-side background outcome poller ─────────────────────────────────
//
// Runs on the server every OUTCOME_POLL_INTERVAL_MS (default 5 min).
// For each user that has dispatched tasks it reads their tracker
// credentials out of the encrypted vault and polls all their tasks —
// no client connection required.
//
// This closes the "user must have the extension open to get status
// updates" gap. Terminal outcomes are still processed synchronously
// inside recordOutcome (status sync + dependency unlock happen
// regardless of whether the poll was triggered server-side or client-side).

const log = _bgLogger.child ? _bgLogger.child({ component: 'outcome-bg-poller' }) : _bgLogger;

// How often the background poller wakes up (env override: LLMIDE_OUTCOME_POLL_MS).
const OUTCOME_POLL_INTERVAL_MS = (() => {
  const v = Number(process.env.LLMIDE_OUTCOME_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : 5 * 60_000;  // default 5 min
})();

let _bgTimer = null;

async function runBackgroundPoll() {
  const db = getDb();
  let userIds;
  try {
    userIds = listUsersWithDispatchedTasks();
  } catch (err) {
    log.error('outcome_bg_poll_list_failed', { error: err.message });
    return;
  }
  if (userIds.length === 0) return;

  log.info('outcome_bg_poll_start', { users: userIds.length });
  let totalChanged = 0;

  for (const userId of userIds) {
    try {
      // Read vault credentials for this user — all three providers in one
      // DB round-trip using getSecrets() batch helper.
      const secrets = getSecrets(db, userId, ['github.token', 'linear.apiKey', 'backlog.apiKey']);
      const creds = {};
      if (secrets['github.token'])   creds.github  = { token:  secrets['github.token'] };
      if (secrets['linear.apiKey'])  creds.linear  = { apiKey: secrets['linear.apiKey'] };
      if (secrets['backlog.apiKey']) creds.backlog = { apiKey: secrets['backlog.apiKey'] };

      const result = await refreshAllOutcomes(userId, { creds });
      totalChanged += result.changedCount || 0;

      if (result.changedCount > 0) {
        log.info('outcome_bg_poll_changes', {
          userId,
          changed: result.changedCount,
          byState: result.byState,
        });
      }
    } catch (err) {
      log.error('outcome_bg_poll_user_failed', { userId, error: err.message });
    }
  }
  log.info('outcome_bg_poll_done', { users: userIds.length, totalChanged });
}

export function startBackgroundOutcomePoller() {
  if (_bgTimer) return; // already running
  // First poll after one full interval so server boot isn't slowed.
  _bgTimer = setInterval(runBackgroundPoll, OUTCOME_POLL_INTERVAL_MS);
  if (typeof _bgTimer.unref === 'function') _bgTimer.unref(); // don't block shutdown
  log.info('outcome_bg_poller_started', { intervalMs: OUTCOME_POLL_INTERVAL_MS });
}

export function stopBackgroundOutcomePoller() {
  if (_bgTimer) { clearInterval(_bgTimer); _bgTimer = null; }
}
