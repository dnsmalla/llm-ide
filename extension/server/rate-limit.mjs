// Tiny in-memory rate limiter.  Token bucket per route name.  Designed
// to protect:
//   - LLM endpoints from a runaway client looping faster than Claude
//     can respond, which would queue up subprocesses unbounded
//   - Dispatch endpoints from accidentally creating duplicate tickets
//     during a panic-clicked retry storm
//   - The KB ingest path from chrome.storage write loops
//
// Single-process, single-host: this is fine for a localhost server.
// Each bucket holds `capacity` tokens, refilled at `refillRate` per
// second.  A request consumes one token; if none available, the
// limiter returns the seconds the caller should wait.

// Bounded bucket cache.  Without a cap, a hostile or just churn-heavy
// scope key (random userIds, IPs from a botnet) would let the Map
// grow unbounded.  We use a simple FIFO cap — when full, the oldest
// inserted bucket is evicted.  This is fine because an evicted
// scope's next request gets a fresh full bucket, which is more
// permissive than ideal but never less safe.
const MAX_BUCKETS = 50_000;
const buckets = new Map();
// Track which unknown profile names we've already warned about so the
// log doesn't spam on every request to an unconfigured endpoint.
const _warnedProfiles = new Set();

function getBucket(name, capacity, refillRate) {
  const now = Date.now();
  let b = buckets.get(name);
  if (!b) {
    b = { tokens: capacity, capacity, refillRate, lastRefill: now };
    if (buckets.size >= MAX_BUCKETS) {
      // Map iteration is insertion-ordered → first key is the LRU entry
      // (we re-insert on every access, see below, so insertion order ==
      // recency order).  Evicting the first key removes the least-recently-
      // used scope rather than an arbitrary old one — prevents an attacker
      // from evicting a targeted user's bucket by flooding with unique keys.
      const lru = buckets.keys().next().value;
      if (lru !== undefined) buckets.delete(lru);
    }
    buckets.set(name, b);
    return b;
  }
  // Refill based on time since last access.
  const elapsedSec = (now - b.lastRefill) / 1000;
  if (elapsedSec > 0) {
    b.tokens = Math.min(b.capacity, b.tokens + elapsedSec * b.refillRate);
    b.lastRefill = now;
  }
  // Re-insert to move this key to the end of insertion order (= MRU).
  // This makes the Map behave as an LRU cache: eviction always removes
  // the least-recently-used scope, not just the oldest-created one.
  buckets.delete(name);
  buckets.set(name, b);
  return b;
}

// Pre-defined buckets per route family.  Keep these conservative —
// the user can ask faster from the UI but the buckets give back-pressure.
const PROFILES = {
  // Big LLM jobs — generate-plan, generate-code, analyze-risks,
  // extract-entities.  Claude CLI is the bottleneck anyway; the bucket
  // exists to reject obvious mashing.
  llm:        { capacity: 3, refillRate: 1 / 30 }, // ~1 every 30s, burst 3

  // Cheap LLM jobs — chat, generate-questions, generate-notes.
  llmFast:    { capacity: 6, refillRate: 1 / 5 },  // ~1 every 5s, burst 6

  // External-API write paths — dispatch + PR + Slack.  Slow + bursty.
  dispatch:   { capacity: 4, refillRate: 1 / 10 }, // ~1 every 10s, burst 4

  // Read paths against external APIs (outcome polling).  Higher cap
  // because they're idempotent.
  outcomePoll:{ capacity: 6, refillRate: 1 / 30 }, // ~1 every 30s, burst 6

  // KB writes from the local UI (ingest, review, plan-task update).
  kbWrite:    { capacity: 30, refillRate: 5 },     // 5/sec, burst 30

  // Live caption appends — the Chrome extension posts captions in small
  // batches every ~2 s.  The cap is generous enough for a fast speaker
  // (30-burst, then 5/sec steady) but still stops a runaway loop from
  // filling the in-memory ring buffer faster than it can be consumed.
  liveAppend: { capacity: 30, refillRate: 5 },     // 5/sec, burst 30

  // Bulk export reads (GET /kb/export-all). Each call streams an entire
  // user's meeting corpus out of SQLite, so it's far heavier than a normal
  // read. Cap it so a script can't hammer the endpoint and turn it into a
  // DB-amplification DoS, while still allowing legitimate paged exports
  // (burst 5, then ~1 every 10s for follow-up cursor pages).
  kbExport:   { capacity: 5, refillRate: 1 / 10 },
};

// Rate limits are scoped to (profile, scope) — the scope is typically a
// userId so user A bursting on /generate-plan doesn't starve user B.
// For unauthenticated routes (login/register) callers can pass the
// remote IP as the scope to limit drive-by abuse.
export function tryConsume(profileName, scope = 'global', tokens = 1) {
  const profile = PROFILES[profileName];
  if (!profile) {
    // Unknown profile — log once so a newly-added endpoint that forgot
    // its rate-limit entry is visible in the server logs rather than
    // silently unlimited.  We still allow the request so a config gap
    // doesn't hard-break functionality.
    if (!_warnedProfiles.has(profileName)) {
      _warnedProfiles.add(profileName);
      process.stderr.write(JSON.stringify({ level: 'warn', msg: 'rate_limit_unknown_profile', profile: profileName, note: 'request allowed but unthrottled — add it to PROFILES' }) + '\n');
    }
    return { ok: true };
  }
  const key = `${profileName}::${scope}`;
  const b = getBucket(key, profile.capacity, profile.refillRate);
  if (b.tokens >= tokens) {
    b.tokens -= tokens;
    return { ok: true, remaining: Math.floor(b.tokens) };
  }
  const need = tokens - b.tokens;
  const retryAfterSec = Math.ceil(need / b.refillRate);
  return { ok: false, retryAfterSec };
}

// Shared bucket for login + refresh — keyed by remote IP.
// 10-burst then 1/sec to absorb a password-manager fill without
// blocking the UI, but still stop credential-stuffing loops.
PROFILES.authPublic = { capacity: 10, refillRate: 1 };

// Tighter dedicated bucket for account registration.
// 3 burst (covers a mistype/retry flow) then 1 per 60 s per IP.
// Registration is infrequent by design; spam registrations create
// real DB rows so the cost of being too permissive is higher here.
PROFILES.authRegister = { capacity: 3, refillRate: 1 / 60 };

// Test/utility hook — used by the test suite to reset state between
// scenarios.  Production never calls this.
export function _resetForTests() {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Persistence — save / load bucket state to SQLite so a server restart
// doesn't give every client a free full-burst window.
// ---------------------------------------------------------------------------

// Buckets older than this are considered stale and dropped on load.
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Persist the current in-memory bucket state to the database.
 * Called on the auth-GC interval and on graceful shutdown.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function saveBuckets(db) {
  if (!db || buckets.size === 0) return;
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO rate_limit_buckets (key, tokens, capacity, refill_rate, last_refill, saved_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      tokens      = excluded.tokens,
      capacity    = excluded.capacity,
      refill_rate = excluded.refill_rate,
      last_refill = excluded.last_refill,
      saved_at    = excluded.saved_at
  `);
  const tx = db.transaction(() => {
    for (const [key, b] of buckets) {
      upsert.run(key, b.tokens, b.capacity, b.refillRate, b.lastRefill, now);
    }
  });
  tx();
}

/**
 * Restore bucket state from the database on server startup.
 * Stale rows (> 24 h old) are discarded so a long-offline server
 * doesn't restore a cache full of exhausted buckets.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function loadBuckets(db) {
  if (!db) return;
  const cutoff = Date.now() - STALE_MS;
  // Prune stale rows first.
  try {
    db.prepare('DELETE FROM rate_limit_buckets WHERE saved_at < ?').run(cutoff);
  } catch { /* table may not exist yet on very first boot — migration handles it */ }
  let rows;
  try {
    rows = db.prepare('SELECT * FROM rate_limit_buckets').all();
  } catch {
    return; // table doesn't exist yet
  }
  const now = Date.now();
  for (const row of rows) {
    // Re-compute elapsed time since the row was saved and add any
    // tokens that would have accumulated — so a server that was down
    // for 30 minutes doesn't resume with a fully drained bucket.
    const elapsedSinceSave = (now - row.saved_at) / 1000;
    const refilled = Math.min(
      row.capacity,
      row.tokens + elapsedSinceSave * row.refill_rate,
    );
    buckets.set(row.key, {
      tokens:     refilled,
      capacity:   row.capacity,
      refillRate: row.refill_rate,
      lastRefill: now,
    });
  }
}
