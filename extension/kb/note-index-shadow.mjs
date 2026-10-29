// Note-index shadow compare (live-then-archive Phase 2, plan T2.2, redesigned for
// the Phase 2 review).
//
// Compares the legacy meeting search with the derived note index, one (user,
// project) pair at a time, over a fixed daily query set. Only meetings that have a
// note in the index are compared (the scope). Per query, the two top-10 lists are
// compared by overlap; a query fails below NOTE_SHADOW_MIN_MEAN_OVERLAP only when
// the MEAN over the run falls below it, so one reordered hit cannot fail the run.
//
// Read-only for both stores. It writes only its result into agent.db store_meta.
// It runs in time slices (one pair at a time, NOTE_SHADOW_SLICE_MS per slice) so it
// never holds the event loop for long, and it skips a pair whose index has had no
// upsert in NOTE_SHADOW_STALE_MS. Query text is never stored or logged.
import { getDb, lazyPrepare, buildSearchFilter, searchFilterSql } from './db.mjs';
import { getAgentDb, readMeta, writeMeta } from './agent-db.mjs';
import { noteIndexHits, indexStatus, lastReconciledAt } from './note-index.mjs';

/** A pair whose orphan notes (no legacy meeting) exceed this share of its notes fails the run. */
export const NOTE_SHADOW_MAX_ORPHAN_SHARE = 0.02;

export const NOTE_SHADOW_META_KEY = 'last_note_index_compare';
/** Top-K used for the overlap metric. */
export const NOTE_SHADOW_K = 10;
/** A run is a mismatch when the mean per-query overlap of a pair is below this. */
export const NOTE_SHADOW_MIN_MEAN_OVERLAP = 0.8;
/** A pair whose index has had no upsert this long is skipped, not compared. */
export const NOTE_SHADOW_STALE_MS = 7 * 86400000;
/** Time budget per slice (the run yields to the event loop between slices). */
export const NOTE_SHADOW_SLICE_MS = 100;
export const NOTE_SHADOW_MAX_QUERIES = 20;
const SAMPLE_CAP = 10;

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
 * The query set for one (user, project): sampled note titles and words of three or
 * more characters. Only queries with an FTS MATCH term are kept: a LIKE-only query
 * (two characters, for example CJK) would scan the whole search table, so it is
 * never run here. `seed` changes daily, so the set rotates.
 */
export function buildNoteShadowQueries(db, userId, projectId, seed, { max = NOTE_SHADOW_MAX_QUERIES } = {}) {
  const titles = lazyPrepare(db,
    'SELECT title FROM note_index WHERE user_id = ? AND project_id = ? ORDER BY date DESC LIMIT 200',
  ).all(userId, projectId).map((r) => String(r.title || '')).filter(Boolean);
  const rand = seededRandom(seed);
  const words = [...new Set(titles.flatMap((t) => t.split(/[^\p{L}\p{N}_]+/u)).filter((w) => [...w].length >= 3))];
  const candidates = [
    ...shuffled(titles, rand).slice(0, Math.ceil(max * 0.6)).map((q) => ({ kind: 'title', q })),
    ...shuffled(words, rand).slice(0, Math.floor(max * 0.4)).map((q) => ({ kind: 'term', q })),
  ];
  return candidates.filter((c) => buildSearchFilter(c.q)?.match).slice(0, max);
}

/**
 * Top-K overlap: shared ids over the longer top-K list. Two empty lists agree (1).
 * Below K hits on both sides the lists are compared as sets (shared over union).
 */
export function topKOverlap(a, b, k = NOTE_SHADOW_K) {
  const left = a.slice(0, k);
  const right = b.slice(0, k);
  if (left.length === 0 && right.length === 0) return 1;
  const set = new Set(left);
  const shared = right.filter((id) => set.has(id)).length;
  if (Math.max(left.length, right.length) < k) return shared / new Set([...left, ...right]).size;
  return shared / k;
}

/** Legacy meeting hits for one (user, project): the same FTS query, restricted to the owner in SQL. */
export function legacyMeetingHits(db, userId, projectId, q, limit = NOTE_SHADOW_K) {
  const filter = buildSearchFilter(q);
  if (!filter?.match) return [];
  const where = searchFilterSql(filter);
  return lazyPrepare(db, `
    SELECT meeting_id FROM search
     WHERE ${where.where} AND kind = 'meeting'
       AND meeting_id IN (SELECT id FROM meetings
                           WHERE user_id = ? AND COALESCE(json_extract(meta, '$.projectId'), '') = ?)
     ORDER BY ${where.rank} LIMIT ?`).all(...where.params, userId, projectId, limit).map((r) => r.meeting_id);
}

/**
 * One (user, project) pair as a generator: it yields after building the scope and after each
 * query, so the caller can spend a slice budget on it. Returns the pair's result.
 */
export function* comparePairSteps(db, userId, projectId, seed) {
  const indexMeetings = lazyPrepare(db,
    "SELECT json_extract(meta, '$.meetingId') AS mid FROM note_index WHERE user_id = ? AND project_id = ? AND kind = 'meeting'",
  ).all(userId, projectId).map((r) => r.mid).filter((m) => typeof m === 'string' && m !== '');
  yield 'scope-index';   // each heavy statement is its own unit, so a slice never holds two of them
  const legacyIds = new Set(lazyPrepare(db,
    "SELECT id FROM meetings WHERE user_id = ? AND COALESCE(json_extract(meta, '$.projectId'), '') = ?",
  ).all(userId, projectId).map((r) => r.id));
  yield 'scope-legacy';
  const scope = new Set(indexMeetings.filter((m) => legacyIds.has(m)));
  const matchedRows = indexMeetings.filter((m) => legacyIds.has(m)).length;
  yield 'scope';

  const queries = buildNoteShadowQueries(db, userId, projectId, seed);
  const overlaps = [];
  const sample = [];
  for (const { kind, q } of queries) {
    const legacy = legacyMeetingHits(db, userId, projectId, q, 2 * NOTE_SHADOW_K)
      .filter((id) => scope.has(id)).slice(0, NOTE_SHADOW_K);
    const index = noteIndexHits(userId, { q, limit: 2 * NOTE_SHADOW_K, projectId, db })
      .map((h) => h.meetingId).filter((id) => id && scope.has(id)).slice(0, NOTE_SHADOW_K);
    if (legacy.length !== 0 || index.length !== 0) {   // no hits on either side: not a comparison
      const overlap = topKOverlap(legacy, index);
      overlaps.push(overlap);
      if (overlap < 1 && sample.length < SAMPLE_CAP) {
        sample.push({ kind, overlap, legacyHits: legacy.length, indexHits: index.length });
      }
    }
    yield 'query';
  }
  yield 'status';
  const status = indexStatus(userId, { projectId });
  const mean = overlaps.length ? overlaps.reduce((s2, o) => s2 + o, 0) / overlaps.length : 1;
  return {
    queries: queries.length,
    scoredQueries: overlaps.length,
    meanOverlap: mean,
    minOverlap: overlaps.length ? Math.min(...overlaps) : 1,
    mismatchedQueries: overlaps.filter((o) => o < NOTE_SHADOW_MIN_MEAN_OVERLAP).length,
    matched: scope.size,
    // Index rows naming a matched meeting, minus the distinct meetings: duplicates show here.
    countDelta: matchedRows - scope.size,
    orphanNotes: indexMeetings.length - matchedRows,             // a note with no legacy meeting (reported)
    unindexedMeetings: legacyIds.size - scope.size,              // a meeting with no note (out of scope)
    indexNotes: status.notes,
    indexConsistent: status.consistent,
    drift: Math.abs(status.notes - status.ftsRows),
    sample,
  };
}

/**
 * The time-sliced run over every (user, project) pair with note rows (or one user's).
 * `step()` compares pairs until a slice's budget is spent (at least one pair per slice)
 * and returns { done }. When the last pair is done the result is stored and returned.
 */
export function createNoteShadowRun({
  db = getDb(), agentDb = getAgentDb(), userId = null, now = new Date(), logger = null,
  sliceMs = NOTE_SHADOW_SLICE_MS, clock = () => performance.now(),
} = {}) {
  const pairs = userId
    ? lazyPrepare(db, 'SELECT DISTINCT user_id, project_id FROM note_index WHERE user_id = ? ORDER BY project_id').all(userId)
    : lazyPrepare(db, 'SELECT DISTINCT user_id, project_id FROM note_index ORDER BY user_id, project_id').all();
  const seed = Math.floor(now.getTime() / 86400000);
  const cutoff = new Date(now.getTime() - NOTE_SHADOW_STALE_MS).toISOString();
  const results = [];
  const slices = [];
  let next = 0;
  let current = null;
  let result = null;

  // Staleness is judged from the last COMPLETE pass (reconcile or final scan), not from row
  // changes: a stable library that is reconciled every interval is never stale.
  function staleAt(p) {
    const last = lastReconciledAt(p.user_id, p.project_id);
    return !last || String(last) < cutoff;
  }

  function finish() {
    const scored = results.filter((r) => !r.error && !r.stale);
    const sumQueries = scored.reduce((s, r) => s + r.scoredQueries, 0);
    const weighted = scored.reduce((s, r) => s + r.meanOverlap * r.scoredQueries, 0);
    const orphanHeavy = (r) => !r.stale && r.indexNotes > 0
      && r.orphanNotes / r.indexNotes > NOTE_SHADOW_MAX_ORPHAN_SHARE;
    const mismatchedPairs = results.filter((r) => r.error || (!r.stale && (
      r.countDelta !== 0 || !r.indexConsistent || orphanHeavy(r)
      || (r.scoredQueries > 0 && r.meanOverlap < NOTE_SHADOW_MIN_MEAN_OVERLAP)))).length;
    // Nothing compared is not a pass: a non-empty index with zero scored queries is not evaluated.
    const notEvaluatedPairs = results.filter((r) => !r.error && !r.stale && r.indexNotes > 0 && r.scoredQueries === 0).length;
    const stalePairs = results.filter((r) => r.stale).length;
    const state = mismatchedPairs > 0 ? 'mismatch'
      : notEvaluatedPairs > 0 ? 'not-evaluated'
        : stalePairs > 0 && scored.length === 0 ? 'stale'
          : 'ok';
    const sorted = [...slices].sort((a, b) => a - b);
    const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
    result = {
      ok: state === 'ok',
      state,
      at: now.toISOString(),
      notEvaluatedPairs,
      scope: userId ? 'user' : 'all',
      pairs: results.length,
      stalePairs: results.filter((r) => r.stale).length,
      errors: results.filter((r) => r.error).length,
      scoredQueries: sumQueries,
      meanOverlap: sumQueries ? weighted / sumQueries : 1,
      minOverlap: scored.length ? Math.min(...scored.map((r) => r.minOverlap)) : 1,
      mismatchedQueries: results.reduce((s, r) => s + (r.mismatchedQueries || 0), 0),
      mismatchedPairs,
      matched: results.reduce((s, r) => s + (r.matched || 0), 0),
      countDelta: results.reduce((s, r) => s + (r.countDelta || 0), 0),
      orphanNotes: results.reduce((s, r) => s + (r.orphanNotes || 0), 0),
      unindexedMeetings: results.reduce((s, r) => s + (r.unindexedMeetings || 0), 0),
      drift: results.reduce((s, r) => s + (r.drift || 0), 0),
      inconsistentIndexes: results.filter((r) => r.indexConsistent === false).length,
      slices: { count: slices.length, p50Ms: round(pct(0.5)), p95Ms: round(pct(0.95)), maxMs: round(sorted[sorted.length - 1] ?? 0) },
      sample: results.flatMap((r) => r.sample || []).slice(0, SAMPLE_CAP),
    };
    if (agentDb) {
      try { writeMeta(agentDb, NOTE_SHADOW_META_KEY, JSON.stringify(result)); } catch { /* best effort */ }
    }
    if (!result.ok) {
      try {
        logger?.warn?.('note_index_shadow_mismatch', {
          mismatchedPairs, mismatchedQueries: result.mismatchedQueries, countDelta: result.countDelta,
          drift: result.drift, errors: result.errors, pairs: result.pairs,
        });
      } catch { /* logging is best effort */ }
    }
    return result;
  }

  return {
    /** No note rows at all: nothing to compare, nothing to store. */
    get empty() { return pairs.length === 0; },
    get done() { return !current && next >= pairs.length; },
    get result() { return result; },
    slices,
    /**
     * Spends one slice: units (a pair's scope, one query, or a stale check) until the budget
     * is spent. At least one unit runs per slice, so the run always progresses.
     */
    step() {
      const t0 = clock();
      do {
        if (!current) {
          if (next >= pairs.length) break;
          const p = pairs[next];
          next += 1;
          current = { p, it: null };
          if (staleAt(p)) {
            results.push({ stale: true });
            current = null;
          } else {
            current.it = comparePairSteps(db, p.user_id, p.project_id, seed);
          }
        } else {
          try {
            const r = current.it.next();
            if (r.done) {
              results.push(r.value);
              current = null;
            }
          } catch (err) {
            results.push({ error: String(err?.message || err).slice(0, 200) });
            current = null;
          }
        }
      } while ((current || next < pairs.length) && clock() - t0 < sliceMs);
      slices.push(clock() - t0);
      const done = !current && next >= pairs.length;
      if (done && !result) finish();
      return { done };
    },
  };
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}

/** Runs the whole compare now (tests, and one-off callers). Returns the stored result, or a none-result. */
export function compareNoteIndexShadow(userId = null, { mainDb = getDb(), agentDb = getAgentDb(), now = new Date(), logger = null, sliceMs } = {}) {
  if (!agentDb) return { ok: false, reason: 'unavailable' };
  const run = createNoteShadowRun({ db: mainDb, agentDb, userId, now, logger, sliceMs });
  if (run.empty) return { ok: true, scope: 'none', pairs: 0 };
  while (!run.step().done) { /* synchronous: the caller accepts the full cost */ }
  return run.result;
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

