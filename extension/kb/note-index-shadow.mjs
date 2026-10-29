// Note-index shadow compare (live-then-archive Phase 2, plan T2.2).
//
// Compares the legacy meeting search (`meetings` + FTS, the path users see today)
// with the derived note index (`note_index` + FTS rows of kind 'note') over a
// fixed query set, and reports the index's own consistency and drift. Read-only
// for both stores: it writes only its result into agent.db's store_meta, so it
// can never change what the legacy path returns. Same shape as compareLedgerShadow
// (kb/agent-usage.mjs): one compare per call, stored, and a warning on mismatch.
//
// Query text is never stored or logged (it can be a meeting title); the stored
// sample holds only counts and overlap numbers.
import { getDb, search, lazyPrepare } from './db.mjs';
import { getAgentDb, readMeta, writeMeta } from './agent-db.mjs';
import { searchNoteIndex, indexStatus } from './note-index.mjs';

export const NOTE_SHADOW_META_KEY = 'last_note_index_compare';
/** Top-K used for the overlap metric (plan: topKOverlap(10)). */
export const NOTE_SHADOW_K = 10;
const SAMPLE_CAP = 10;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Deterministic PRNG (mulberry32) so one day's query set is reproducible. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rand) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The fixed query set for one user: sampled meeting titles, random words from
 * those titles (FTS path, length >= 3), and CJK 2-character terms (LIKE path).
 * `seed` changes daily, so the set rotates instead of always comparing the same rows.
 */
export function buildNoteShadowQueries(mainDb, userId, seed, { sample = 10, terms = 5, cjk = 5 } = {}) {
  const titles = lazyPrepare(mainDb,
    'SELECT title FROM meetings WHERE user_id = ? ORDER BY date DESC LIMIT 500',
  ).all(userId).map((r) => String(r.title || '')).filter(Boolean);
  const rand = seededRandom(seed);
  const words = [...new Set(titles.flatMap((t) => t.split(/[^\p{L}\p{N}_]+/u)).filter((w) => [...w].length >= 3))];
  const bigrams = new Set();
  for (const t of titles) {
    const chars = [...t];
    for (let i = 0; i + 1 < chars.length; i += 1) {
      if (CJK.test(chars[i]) && CJK.test(chars[i + 1])) bigrams.add(chars[i] + chars[i + 1]);
    }
  }
  const out = [];
  for (const q of shuffled(titles, rand).slice(0, sample)) out.push({ kind: 'title', q });
  for (const q of shuffled(words, rand).slice(0, terms)) out.push({ kind: 'term', q });
  for (const q of shuffled([...bigrams], rand).slice(0, cjk)) out.push({ kind: 'cjk', q });
  return out;
}

/** Top-K overlap: shared ids over the longer list. Two empty lists agree (1). */
export function topKOverlap(a, b, k = NOTE_SHADOW_K) {
  const left = a.slice(0, k);
  const right = b.slice(0, k);
  if (left.length === 0 && right.length === 0) return 1;
  const set = new Set(left);
  const shared = right.filter((id) => set.has(id)).length;
  return shared / Math.max(left.length, right.length);
}

function countOf(db, sql, ...args) {
  return Number(lazyPrepare(db, sql).get(...args).n) || 0;
}

/** The compare for one user. Never throws: an error is reported in `error`. */
export function compareUserNoteIndex(userId, { mainDb, seed }) {
  try {
    const queries = buildNoteShadowQueries(mainDb, userId, seed);
    const overlaps = [];
    const sample = [];
    for (const { kind, q } of queries) {
      const legacy = search(userId, { q, kind: 'meeting', limit: NOTE_SHADOW_K })
        .map((h) => h.meetingId).filter(Boolean);
      const index = searchNoteIndex(userId, { q, limit: NOTE_SHADOW_K })
        .map((h) => h.meetingId).filter(Boolean);
      const overlap = topKOverlap(legacy, index);
      overlaps.push(overlap);
      if (overlap < 1 && sample.length < SAMPLE_CAP) {
        sample.push({ kind, overlap, legacyHits: legacy.length, indexHits: index.length });
      }
    }
    const legacyRows = countOf(mainDb, "SELECT COUNT(*) AS n FROM meetings WHERE user_id = ?", userId);
    const indexRows = countOf(mainDb,
      "SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND kind = 'meeting'", userId);
    const status = indexStatus(userId);
    const mismatchedQueries = overlaps.filter((o) => o < 1).length;
    return {
      queries: queries.length,
      meanOverlap: overlaps.length ? overlaps.reduce((s, o) => s + o, 0) / overlaps.length : 1,
      minOverlap: overlaps.length ? Math.min(...overlaps) : 1,
      mismatchedQueries,
      legacyRows,
      indexRows,
      countDelta: legacyRows - indexRows,
      indexNotes: status.notes,
      indexFtsRows: status.ftsRows,
      indexConsistent: status.consistent,
      drift: Math.abs(status.notes - status.ftsRows),
      sample,
    };
  } catch (err) {
    return { error: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * Compare the legacy search with the note index. Pass `userId` for one user,
 * or leave it null to compare every user that has note rows (a user with no rows
 * is not compared, so with lta.mode off nothing is written at all).
 */
export function compareNoteIndexShadow(userId = null, {
  mainDb = getDb(), agentDb = getAgentDb(), now = new Date(), logger = null,
} = {}) {
  if (!agentDb) return { ok: false, reason: 'unavailable' };
  const users = userId
    ? [userId]
    : lazyPrepare(mainDb, 'SELECT DISTINCT user_id FROM note_index').all().map((r) => r.user_id);
  if (users.length === 0) return { ok: true, scope: 'none', users: 0 };
  const seed = Math.floor(now.getTime() / 86400000);
  const per = users.map((uid) => compareUserNoteIndex(uid, { mainDb, seed }));
  const sum = (key) => per.reduce((s, p) => s + (Number(p[key]) || 0), 0);
  const errors = per.filter((p) => p.error).length;
  const mismatchedUsers = per.filter((p) => !p.error && (p.mismatchedQueries > 0 || p.countDelta !== 0 || !p.indexConsistent)).length;
  const scored = per.filter((p) => !p.error);
  const result = {
    ok: mismatchedUsers === 0 && errors === 0,
    at: now.toISOString(),
    scope: userId ? 'user' : 'all',
    users: users.length,
    errors,
    queries: sum('queries'),
    meanOverlap: scored.length ? scored.reduce((s, p) => s + p.meanOverlap, 0) / scored.length : 1,
    minOverlap: scored.length ? Math.min(...scored.map((p) => p.minOverlap)) : 1,
    mismatchedQueries: sum('mismatchedQueries'),
    mismatchedUsers,
    legacyRows: sum('legacyRows'),
    indexRows: sum('indexRows'),
    countDelta: sum('countDelta'),
    drift: sum('drift'),
    inconsistentIndexes: scored.filter((p) => !p.indexConsistent).length,
    sample: per.flatMap((p) => p.sample || []).slice(0, SAMPLE_CAP),
  };
  try {
    writeMeta(agentDb, NOTE_SHADOW_META_KEY, JSON.stringify(result));
  } catch { /* best effort: the compare result is still returned and logged */ }
  if (!result.ok) {
    try {
      logger?.warn?.('note_index_shadow_mismatch', {
        users: result.users, mismatchedUsers: result.mismatchedUsers, mismatchedQueries: result.mismatchedQueries,
        countDelta: result.countDelta, drift: result.drift, errors: result.errors,
      });
    } catch { /* logging is best effort */ }
  }
  return result;
}

/** The last stored note-index compare, or null. Safe on any handle. */
export function lastNoteIndexCompare(agentDb = getAgentDb()) {
  if (!agentDb) return null;
  try {
    const raw = readMeta(agentDb, NOTE_SHADOW_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
