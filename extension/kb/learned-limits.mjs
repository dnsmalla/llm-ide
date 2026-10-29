// Learned per-key limits (K1 Phase 6b, plan 14.7). `getLimits` in kb/usage.mjs knows only the built-in
// provider ids, so a catalog connection (custom:cat-*) had no limit at all. This table fills the gap from
// what the provider itself tells us: rate-limit header snapshots and 429s.
//
// Rules, each pinned by tests/learned-limits.test.mjs:
//   - A value the user set (source 'user') always wins and never expires.
//   - A learned value expires 24 h after its last observation.
//   - Nothing here is read unless LLMIDE_ROUTER_LEARN=on (core/router-flags.mjs); the writers are no-ops
//     with it off, so a default install stores nothing.
//   - It only ever marks a key as "near its limit" so the NEXT turn can pick another entry of the user's own
//     ordered fallback list. No rotation across accounts, nothing mid-stream.

import { requireUser, lazyPrepare, getDb } from './db.mjs';
import { routerLearnEnabled } from '../core/router-flags.mjs';

export const LEARNED_TTL_MS = 24 * 60 * 60 * 1000;
export const NEAR_RATIO = 0.9;
const FIELDS = ['rpm', 'rpd', 'tpm', 'tpd'];
const MAX_LIMIT = 1_000_000_000_000;

const pad = (n) => String(n).padStart(2, '0');
// usage_ledger.ts is SQLite local time ('YYYY-MM-DD HH:MM:SS'), same format as kb/usage.mjs toSqliteLocal.
const sqliteLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const whole = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(Math.trunc(Number(v)), MAX_LIMIT) : null);

/**
 * Store what was learned about one key. Only positive whole numbers are kept. A 'user' row is never
 * overwritten by a learned value. Returns true when a row was written.
 */
export function upsertLearned(db, userId, { provider, model = '', rpm, rpd, tpm, tpd, source = 'header', now = new Date(), force = false } = {}) {
  requireUser(userId);
  if (!force && !routerLearnEnabled()) return false;
  if (typeof provider !== 'string' || !provider || !['header', '429', 'user'].includes(source)) return false;
  const incoming = { rpm: whole(rpm), rpd: whole(rpd), tpm: whole(tpm), tpd: whole(tpd) };
  if (!FIELDS.some((f) => incoming[f] !== null)) return false;
  const m = typeof model === 'string' ? model.slice(0, 200) : '';
  return db.transaction(() => {
    const cur = lazyPrepare(db, 'SELECT * FROM provider_learned_limits WHERE user_id = ? AND provider = ? AND model = ?').get(userId, provider, m);
    if (cur?.source === 'user' && source !== 'user') return false;
    // A 429 observed a ceiling: keep the lower of what we believed and what we hit.
    const pick = (f) => {
      if (incoming[f] === null) return source === 'user' ? null : (cur?.[f] ?? null);
      if (source === '429' && cur?.[f]) return Math.min(cur[f], incoming[f]);
      return incoming[f];
    };
    lazyPrepare(db, `
      INSERT INTO provider_learned_limits (user_id, provider, model, rpm, rpd, tpm, tpd, source, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider, model) DO UPDATE SET
        rpm = excluded.rpm, rpd = excluded.rpd, tpm = excluded.tpm, tpd = excluded.tpd,
        source = excluded.source, observed_at = excluded.observed_at
    `).run(userId, provider, m, pick('rpm'), pick('rpd'), pick('tpm'), pick('tpd'), source, now.toISOString());
    // Expired learned rows are dead weight; drop them here instead of running a job.
    lazyPrepare(db, `DELETE FROM provider_learned_limits WHERE user_id = ? AND source <> 'user' AND observed_at < ?`)
      .run(userId, new Date(now.getTime() - LEARNED_TTL_MS).toISOString());
    return true;
  })();
}

/** The limits for a key: the model's own row, else the provider-wide row. Expired learned rows are absent. */
export function getLearned(db, userId, provider, model = '', now = new Date()) {
  requireUser(userId);
  const cutoff = now.getTime() - LEARNED_TTL_MS;
  const rows = lazyPrepare(db, 'SELECT * FROM provider_learned_limits WHERE user_id = ? AND provider = ? AND model IN (?, \'\')')
    .all(userId, provider, model ?? '');
  const live = rows.filter((r) => r.source === 'user' || Date.parse(r.observed_at) >= cutoff);
  const exact = live.find((r) => r.model === (model ?? '') && r.model !== '') ?? live.find((r) => r.model === '');
  return exact ?? null;
}

/** Requests and billable tokens this key spent since `since`, from the user's own ledger. */
export function usageSince(db, userId, provider, model, since) {
  const row = lazyPrepare(db, `
    SELECT COALESCE(SUM(runs), 0) AS requests,
           COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_creation_tokens,0)), 0) AS tokens
      FROM usage_ledger
     WHERE user_id = ? AND provider = ? AND (? = '' OR model = ?) AND ts >= ?
       AND (endpoint IS NULL OR endpoint NOT LIKE '%:internal')
  `).get(userId, provider, model ?? '', model ?? '', sqliteLocal(since));
  return { requests: Number(row?.requests) || 0, tokens: Number(row?.tokens) || 0 };
}

/**
 * Is this key at 90 percent of a learned limit right now? Off (false) unless LLMIDE_ROUTER_LEARN=on.
 * @returns {{ near: boolean, which?: string, used?: number, limit?: number }}
 */
export function limitNear(db, userId, provider, model, now = new Date()) {
  if (!routerLearnEnabled()) return { near: false };
  try {
    const l = getLearned(db, userId, provider, model, now);
    if (!l) return { near: false };
    const minute = usageSince(db, userId, provider, model, new Date(now.getTime() - 60_000));
    const checks = [['rpm', minute.requests, l.rpm], ['tpm', minute.tokens, l.tpm]];
    if (l.rpd || l.tpd) {
      const day = usageSince(db, userId, provider, model, new Date(now.getTime() - 24 * 3600_000));
      checks.push(['rpd', day.requests, l.rpd], ['tpd', day.tokens, l.tpd]);
    }
    for (const [which, used, limit] of checks) {
      if (limit && used >= limit * NEAR_RATIO) return { near: true, which, used, limit };
    }
    return { near: false };
  } catch {
    return { near: false };   // a learned hint must never break a pick
  }
}

// "6m0s", "1s", "20ms", "2m", or an ISO instant -> ms from now (null when unparseable).
function msUntilReset(reset, now) {
  if (reset == null) return null;
  const t = Date.parse(reset);
  if (Number.isFinite(t)) return t - now.getTime();
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(String(reset).trim());
  if (!m || !m[0]) return null;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + (+m[4] || 0);
}

/**
 * Learn from a header snapshot (the shape kb/usage.mjs recordRateLimits stores). A bucket whose reset is
 * within two minutes is a per-minute window, otherwise per-day; a bucket with no usable reset is skipped
 * (an unknown window would be a wrong limit).
 */
export function learnFromSnapshot(db, userId, provider, model, snapshot, now = new Date()) {
  if (!routerLearnEnabled() || !snapshot) return false;
  try {
    db = db ?? getDb();
    const out = { provider, model: model ?? '', source: 'header', now };
    for (const [bucket, minuteKey, dayKey] of [[snapshot.requests, 'rpm', 'rpd'], [snapshot.tokens, 'tpm', 'tpd']]) {
      const limit = whole(bucket?.limit);
      const ms = msUntilReset(bucket?.reset, now);
      if (!limit || ms == null || ms < 0) continue;
      out[ms <= 120_000 ? minuteKey : dayKey] = limit;
    }
    return upsertLearned(db, userId, out);
  } catch {
    return false;
  }
}

/** A 429 is a hit ceiling: this minute's request count is a per-minute limit for the key. */
export function learnFrom429(db, userId, provider, model, now = new Date()) {
  if (!routerLearnEnabled()) return false;
  try {
    const { requests } = usageSince(db, userId, provider, model, new Date(now.getTime() - 60_000));
    return upsertLearned(db, userId, { provider, model: model ?? '', rpm: Math.max(1, requests), source: '429', now });
  } catch {
    return false;
  }
}
