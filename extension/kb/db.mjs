// KB storage layer.  better-sqlite3 is synchronous and ~4× faster than
// node-sqlite3 for our access pattern (small reads, tiny writes), and
// keeps the server.mjs HTTP layer dependency-free of Promise plumbing.

import crypto from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyMigrations } from './migrations.mjs';
import { config } from '../core/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = config.dbPath || path.join(__dirname, 'data.db');

let _db = null;

// Lazy prepared-statement cache keyed by (db, sql).  better-sqlite3's
// `db.prepare(sql)` still parses + hits an internal lookup on every
// call — for SQL strings invoked per-row or per-request in hot paths
// (search SELECTs, planner context retrieval, JTI checks) reusing the
// Statement object avoids that work entirely.  WeakMap so the cache
// drops automatically when the db connection is closed/replaced.
const _stmtCache = new WeakMap();   // db → Map<sql, Statement>
// Module-public so extracted helper modules (personas, reviews,
// plans, …) can share the prepared-statement cache instead of
// each going through `db.prepare(sql)` from scratch.
export function lazyPrepare(db, sql) {
  let m = _stmtCache.get(db);
  if (!m) { m = new Map(); _stmtCache.set(db, m); }
  let s = m.get(sql);
  if (!s) { s = db.prepare(sql); m.set(sql, s); }
  return s;
}

// Multi-tenant guard — every state-mutating function below MUST be
// invoked with a userId.  `requireUser` exists so callers can fail loud
// rather than silently writing to the legacy fallback row.
// Exported so all kb/ sub-modules can import a single canonical copy
// instead of each maintaining a local duplicate.
export function requireUser(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId is required for tenanted operations');
  }
  return userId;
}

// Production-grade SQLite settings.  WAL mode lets readers run
// concurrently with a writer; synchronous=NORMAL is the right balance
// for a single-user app (FULL is overkill, OFF risks corruption);
// foreign_keys must be turned on per-connection.  busy_timeout gives
// concurrent transactions 5s to back off rather than failing
// immediately with SQLITE_BUSY.  wal_autocheckpoint truncates the WAL
// every ~4 MB so it doesn't grow unbounded on a long-running server.
const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA wal_autocheckpoint = 1000',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA mmap_size = 67108864',         // 64 MB; safe on every modern system
];

// Module-level logger captured on first getDb() call. Functions like
// safeParseMeta have no convenient way to receive the structured
// logger through their call chain (deep inside search hydration), so
// we stash it here and let them write via the same JSON channel
// everything else uses.
let _logger = null;

export function getDb({ logger } = {}) {
  if (logger) _logger = logger;
  if (_db) return _db;
  _db = new Database(DB_PATH);
  for (const p of PRAGMAS) _db.pragma(p.replace(/^PRAGMA\s+/i, ''));
  applyMigrations(_db, { logger });
  return _db;
}

// Graceful shutdown — call from the HTTP server's SIGTERM handler so
// in-flight writes finish and the WAL checkpoint flushes to the main
// db file.  Safe to call multiple times.
export function closeDb({ logger } = {}) {
  if (!_db) return;
  try {
    _db.pragma('wal_checkpoint(TRUNCATE)');
    _db.close();
    if (logger) logger.info('db_closed');
  } catch (err) {
    if (logger) logger.error('db_close_failed', { error: err.message });
  } finally {
    _db = null;
  }
}

// --- helpers --------------------------------------------------------------

// Exported so the extracted helper modules (personas.mjs,
// feedback.mjs, reviews.mjs, …) can share the same JSON encode
// strategy without redefining it. Not part of the public KB
// surface — these are db-internal but module-public.
export function safeJSONStringify(v) {
  try { return JSON.stringify(v); } catch { return '{}'; }
}

// FTS5 MATCH does not accept arbitrary user input — punctuation is
// interpreted as operators ("foo.bar" → syntax error).  We tokenize on
// non-word chars, drop empties, and quote each remaining term.  The
// `mode` argument controls how the terms are combined:
//   'and' (default) — every term must appear (precise search box use)
//   'or'            — any term may appear (fuzzy retrieval, ranked by bm25)
function buildMatchExpr(raw, mode = 'and') {
  if (typeof raw !== 'string') return null;
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2 && t.length <= 64)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  const joiner = mode === 'or' ? ' OR ' : ' ';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(joiner);
}

// Meeting + entity CRUD + stats live in meetings.mjs. Re-exported
// here for backward compat: server.mjs imports statsAdmin from
// './kb/db.mjs' directly, and every route handler is happy with
// `kb.ingestMeeting(...)` resolving the same way as before.
export {
  ingestMeeting,
  deleteMeeting,
  getMeetingTranscript,
  getMeeting,
  listMeetings,
  listEntities,
  listEntitiesForMeetings,
  getEntity,
  stats,
  statsAdmin,
} from './meetings.mjs';

// --- reads ----------------------------------------------------------------

// Tenant-aware unified search.  Every result row is filtered by the
// caller's userId — both the empty-query fast path and the FTS
// branch.  We hydrate via lookups against scoped tables (meetings,
// entities, sources, plans, plan_tasks, outcomes) so an FTS hit that
// matches the index but belongs to another user won't survive
// hydration.
export function search(userId, { q, kind, limit = 20, projectId } = {}) {
  requireUser(userId);
  const db = getDb();
  const cap = Math.max(1, Math.min(100, Number(limit) || 20));

  // Plain "list everything" path — used by the History pane when the search
  // box is empty.  We don't hit FTS at all so empty queries are O(rows).
  if (!q || !buildMatchExpr(q)) {
    if (kind === 'meeting' || !kind) {
      const rows = lazyPrepare(db, `
        SELECT id, title, date, duration_sec, meta FROM meetings
        WHERE user_id = ?
        ORDER BY date DESC LIMIT ?
      `).all(userId, cap);
      return rows
        .filter((r) => !projectId || safeParseMeta(r.meta)?.projectId === projectId)
        .map((r) => ({
          kind: 'meeting',
          meetingId: r.id,
          entityId: null,
          title: r.title,
          body: '',
          date: r.date,
          durationSec: r.duration_sec,
        }));
    }
    // Phase-1 entity kinds live in the `entities` table.
    if (kind === 'action' || kind === 'decision' || kind === 'blocker') {
      const rows = lazyPrepare(db, `
        SELECT e.id, e.meeting_id, e.kind, e.text, e.quote, e.meta, m.title, m.date, m.meta AS m_meta
        FROM entities e JOIN meetings m ON m.id = e.meeting_id
        WHERE e.kind = ? AND e.user_id = ?
        ORDER BY m.date DESC LIMIT ?
      `).all(kind, userId, cap);
      return rows
        .filter((r) => !projectId || safeParseMeta(r.m_meta)?.projectId === projectId)
        .map((r) => ({
          kind: r.kind,
          meetingId: r.meeting_id,
          entityId: r.id,
          title: r.text,
          body: r.quote || '',
          meta: safeParseMeta(r.meta),
          meetingTitle: r.title,
          date: r.date,
        }));
    }
    // Phase-8 outcomes live in their own table.
    if (kind === 'outcome') {
      // Outcomes aren't tagged with a projectId, so a project-scoped search
      // returns none — matching the FTS path, which drops outcome rows when a
      // projectId filter is in effect rather than leaking cross-project context.
      if (projectId) return [];
      const rows = lazyPrepare(db, `
        SELECT id, task_id, provider, ref, state, meta, observed_at FROM outcomes
        WHERE user_id = ?
        ORDER BY observed_at DESC LIMIT ?
      `).all(userId, cap);
      return rows.map((r) => ({
        kind: 'outcome',
        meetingId: r.task_id,
        entityId: String(r.id),
        ref: r.ref,
        title: `${r.state} — ${r.provider}`,
        body: '',
        meta: safeParseMeta(r.meta),
        date: r.observed_at,
      }));
    }
    // Phase-3 external sources live in the `sources` table.
    const rows = lazyPrepare(db, `
      SELECT id, kind, ref, title, body, meta, indexed_at FROM sources
      WHERE kind = ? AND user_id = ?
      ORDER BY indexed_at DESC LIMIT ?
    `).all(kind, userId, cap);
    return rows
      .filter((r) => !projectId || safeParseMeta(r.meta)?.projectId === projectId)
      .map((r) => ({
      kind: r.kind,
      meetingId: null,
      entityId: String(r.id),
      ref: r.ref,
      title: r.title,
      body: r.body,
      meta: safeParseMeta(r.meta),
      date: r.indexed_at,
    }));
  }

  const match = buildMatchExpr(q);
  const params = [match];
  let where = 'search MATCH ?';
  if (kind) {
    where += ' AND kind = ?';
    params.push(kind);
  }
  // bm25() ranks more relevant rows first; lower is better.
  const rows = lazyPrepare(db, `
    SELECT meeting_id, entity_id, kind, title, body, bm25(search) AS rank
    FROM search
    WHERE ${where}
    ORDER BY rank LIMIT ?
  `).all(...params, cap);

  // Per-kind hydration.  Tenancy enforcement: build an
  // owned-by-this-user allow-set per backing table, then drop any FTS
  // row whose hydration came up empty.
  //
  // FTS triggers (see migrations/0001_initial.sql) store DIFFERENT
  // things in `meeting_id` depending on kind:
  //   - meeting / action / decision / blocker → real meetings.id
  //   - plan                                  → COALESCE(meeting_id,'')
  //   - task                                  → plan_id (NOT a meeting)
  //   - outcome                               → task_id (NOT a meeting)
  //   - code / ticket / qa / doc              → kind string (sources)
  // So we cannot use a single meetingMap gate for the non-source kinds.
  // We hydrate plans/tasks/outcomes against THEIR own user-scoped tables
  // by `entity_id`.
  const SOURCE_KINDS = new Set(['code', 'ticket', 'qa', 'doc']);
  const ENTITY_KINDS = new Set(['meeting', 'action', 'decision', 'blocker']);

  const meetingRows = rows.filter((r) => ENTITY_KINDS.has(r.kind));
  const sourceRows  = rows.filter((r) => SOURCE_KINDS.has(r.kind));
  const planRows    = rows.filter((r) => r.kind === 'plan');
  const taskRows    = rows.filter((r) => r.kind === 'task');
  const outcomeRows = rows.filter((r) => r.kind === 'outcome');

  // Meetings — used for both 'meeting' rows and the entity sub-kinds
  // (action/decision/blocker), which trace back via meeting_id.
  const meetingMap = new Map();
  const meetingIds = [...new Set(meetingRows.map((r) => r.meeting_id))];
  if (meetingIds.length > 0) {
    const placeholders = meetingIds.map(() => '?').join(',');
    const meetings = db.prepare(
      `SELECT id, title, date, meta FROM meetings WHERE user_id = ? AND id IN (${placeholders})`,
    ).all(userId, ...meetingIds);
    for (const m of meetings) meetingMap.set(m.id, m);
  }

  const sourceMap = new Map();
  if (sourceRows.length > 0) {
    const sourceIds = sourceRows.map((r) => Number(r.entity_id)).filter(Number.isFinite);
    if (sourceIds.length > 0) {
      const placeholders = sourceIds.map(() => '?').join(',');
      const srcs = db.prepare(
        `SELECT id, ref, meta, indexed_at FROM sources WHERE user_id = ? AND id IN (${placeholders})`,
      ).all(userId, ...sourceIds);
      for (const s of srcs) sourceMap.set(String(s.id), s);
    }
  }

  function buildIdSet(kindRows, table) {
    if (kindRows.length === 0) return new Set();
    const ids = [...new Set(kindRows.map((r) => r.entity_id).filter(Boolean))];
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT id FROM ${table} WHERE user_id = ? AND id IN (${placeholders})`,
    ).all(userId, ...ids);
    return new Set(found.map((r) => String(r.id)));
  }
  const planIdSet    = buildIdSet(planRows,    'plans');
  const taskIdSet    = buildIdSet(taskRows,    'plan_tasks');
  const outcomeIdSet = buildIdSet(outcomeRows, 'outcomes');

  // Action/decision/blocker rows are entities — gate them on the ENTITY's own
  // owner (entities.user_id), not transitively on the meeting owner, so tenant
  // isolation never depends on the un-enforced "entity.user_id == meeting.user_id"
  // invariant. ('meeting' rows are the meeting itself; they stay gated on the
  // meeting owner via meetingMap below.)
  const subEntityRows = meetingRows.filter((r) => r.kind !== 'meeting');
  const entityIdSet   = buildIdSet(subEntityRows, 'entities');

  // Drop any FTS row whose hydration came up empty — that means the
  // row belongs to another tenant or has been deleted between FTS
  // index time and now.  Either way, don't surface it to this user.
  return rows.map((r) => {
    // projectId gate: meeting/entity rows trace to a meeting's meta;
    // source rows have meta on the source row itself.  Plan/task/
    // outcome rows aren't yet tagged with a projectId, so they're
    // dropped entirely when a projectId filter is in effect (the
    // alternative — passing them through unfiltered — would leak
    // cross-project context into a project-scoped search).
    if (projectId) {
      let rowMeta = null;
      if (SOURCE_KINDS.has(r.kind)) {
        rowMeta = sourceMap.get(r.entity_id)?.meta;
      } else if (ENTITY_KINDS.has(r.kind)) {
        rowMeta = meetingMap.get(r.meeting_id)?.meta;
      } else {
        return null;
      }
      const parsed = typeof rowMeta === 'string' ? safeParseMeta(rowMeta) : (rowMeta || {});
      if (parsed?.projectId !== projectId) return null;
    }
    if (SOURCE_KINDS.has(r.kind)) {
      const s = sourceMap.get(r.entity_id);
      if (!s) return null;
      return {
        kind: r.kind,
        meetingId: null,
        entityId: r.entity_id,
        title: r.title,
        body: r.body,
        rank: r.rank,
        ref: s.ref,
        meta: safeParseMeta(s.meta),
        date: s.indexed_at,
      };
    }
    // Entity kinds: 'meeting' traces to a caller-owned meeting; the entity
    // sub-kinds (action/decision/blocker) are gated on their OWN owner.
    if (ENTITY_KINDS.has(r.kind)) {
      if (r.kind === 'meeting') {
        if (!meetingMap.has(r.meeting_id)) return null;
      } else if (!entityIdSet.has(String(r.entity_id))) {
        return null;
      }
      return {
        kind: r.kind,
        meetingId: r.meeting_id,
        entityId: r.entity_id,
        title: r.title,
        body: r.body,
        rank: r.rank,
        meetingTitle: meetingMap.get(r.meeting_id)?.title,
        date: meetingMap.get(r.meeting_id)?.date,
      };
    }
    // Plan / task / outcome — gated by their own owned-id sets.
    const ownsByKind = {
      plan: planIdSet,
      task: taskIdSet,
      outcome: outcomeIdSet,
    };
    const set = ownsByKind[r.kind];
    if (!set || !set.has(String(r.entity_id))) return null;
    return {
      kind: r.kind,
      meetingId: r.meeting_id || null,
      entityId: r.entity_id,
      title: r.title,
      body: r.body,
      rank: r.rank,
    };
  }).filter(Boolean);
}

export function safeParseMeta(s) {
  if (!s) return {};
  try { return JSON.parse(s); }
  catch (err) {
    // Log via the structured logger so the diagnostic carries the
    // standard JSON envelope (timestamp, level, msg) and lands in
    // the same channel as everything else. Direct stderr.write
    // bypassed that and made grepping logs noisy. Fallback to
    // stderr only if no logger was captured yet (very early boot).
    const detail = {
      error: (err?.message || 'unknown').slice(0, 200),
      sample: String(s).slice(0, 40),
    };
    if (_logger?.warn) {
      try { _logger.warn('kb_safe_parse_meta_failed', detail); }
      catch { /* never block on a logging failure */ }
    } else {
      try { process.stderr.write(`[db] safeParseMeta failed: ${detail.error}\n`); }
      catch { /* */ }
    }
    return {};
  }
}


// Phase-3 external source ingestion lives in sources.mjs.
export { ingestSources, deleteSourcesByPrefix } from './sources.mjs';

// Random id helper. Exported so the extracted helper modules
// (reviews.mjs, plans.mjs) can mint plan/task/review ids without
// duplicating the CSPRNG + base64url plumbing.
export function genId(prefix) {
  // 12 bytes of CSPRNG → 16 base64url chars. Math.random gives ~30
  // bits of effective entropy after slice(2,8); a timestamp-prefixed
  // ID with 30 bits of randomness lets a same-second attacker brute-
  // force the suffix in ~1 B tries, which is feasible against an
  // online enumeration probe. CSPRNG removes that class of attack.
  // Timestamp prefix is kept so IDs remain roughly sortable.
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(12).toString('base64url')}`;
}

// Phase 4 plan + task CRUD moved into plans.mjs. Re-exported here
// for backward compat with `kb.savePlan(...)` etc.
export {
  savePlan,
  getPlan,
  listPlans,
  deletePlan,
  updateTask,
  mergeTaskMeta,
  claimTaskForDispatch,
  releaseTaskDispatchClaim,
  getTaskById,
} from './plans.mjs';

// Per-user issue scheduling overlay (gantt) — migration 0020.
export {
  listIssueSchedules,
  upsertIssueSchedule,
  deleteIssueSchedule,
} from './issue-schedule.mjs';

// Per-user metadata (repo allow-list, UI prefs, JWT revocation list)
// lives in user.mjs.
export {
  listUserRepos,
  addUserRepo,
  removeUserRepo,
  userRepoAllowlist,
  getUserPrefs,
  setUserPrefs,
  revokeJti,
  isJtiRevoked,
  tokensValidAfter,
  purgeExpiredJti,
} from './user.mjs';


// Meeting-agent personas + Ask-the-Agent history live in personas.mjs.
// Re-exported here so existing callers (`kb.getAgentPersona(...)`,
// `kb.appendAgentAskMessage(...)`, etc.) keep working unchanged.
export {
  getAgentPersona,
  setAgentPersona,
  listAgentPersonas,
  createAgentPersona,
  updateAgentPersona,
  deleteAgentPersona,
  setActiveAgentPersona,
  appendAgentAskMessage,
  listAgentAskMessages,
  clearAgentAskMessages,
} from './personas.mjs';

export {
  createChatSession,
  listChatSessions,
  getChatSession,
  updateChatSession,
  deleteChatSession,
  clearChatMessages,
  appendChatMessage,
} from './chat-sessions.mjs';


// Meeting-agent question feedback (verdicts + stats) lives in
// feedback.mjs. Re-exported here for backward compat with existing
// `kb.recordAgentFeedback(...)` etc. call sites.
export {
  recordAgentFeedback,
  agentFeedbackByTask,
  agentFeedbackStats,
} from './feedback.mjs';


// Phase-8 outcome polling helpers live in outcomes.mjs.
export {
  recordOutcome,
  listOutcomesForTask,
  listDispatchedTasks,
  listDispatchedTasksForRetry,
  listUsersWithDispatchedTasks,
  outcomeStats,
} from './outcomes.mjs';

// Phase-6 review-queue helpers live in reviews.mjs. Re-exported here
// for backward compat with `kb.submitReview(...)` etc.
export {
  submitReview,
  listReviews,
  getReview,
  setReviewStatus,
  deleteReview,
} from './reviews.mjs';

// Project-scoped full export — used by GET /kb/project/:id/export and
// the Swift ProjectExporter (writes canonical folder tree on close).
export { exportProject } from './project-export.mjs';

// Used by the planning agent to assemble grounding context.  Returns up
// to N similar past meetings, similar past tasks, and matching code/
// ticket sources for a free-form query (typically the meeting goal +
// salient action texts).
// Retrieval helper for the planner / risk / code-sync agents.  Uses OR
// semantics so a multi-word task title still produces ranked candidates
// even when no single chunk contains every term — the agent layer can
// always filter further on rank, but a strict-AND no-match starves it.
export function findContext(userId, query, limit = 5) {
  requireUser(userId);
  const expr = buildMatchExpr(query, 'or');
  if (!expr) return { meetings: [], tasks: [], code: [], tickets: [], blockers: [] };
  const db = getDb();
  const cap = Math.max(1, Math.min(20, Number(limit) || 5));

  // FTS5 indexes hits regardless of tenant, so we hydrate every match
  // through the owning table with WHERE user_id = ? — non-owned hits
  // are dropped during hydration.
  //
  // Overshoot strategy: first pass fetches cap*4 ranked hits. In a
  // multi-tenant DB, other users' rows can dominate the top of the
  // global ranking and starve the requesting user even when they have
  // matches deeper down — so if the filtered result comes up short AND
  // the first pass hit its LIMIT (i.e. more rows exist), re-fetch once
  // with a deeper, hard-bounded window. Both passes are LIMIT-bounded;
  // worst case is two indexed FTS queries, never a full scan.
  const OVERSHOOT_DEEP_LIMIT = 400;
  const fetchRanked = (sql, binds, filterOwned) => {
    const shallow = cap * 4;
    let hits = lazyPrepare(db, sql).all(...binds, shallow);
    if (hits.length === 0) return [];
    let owned = filterOwned(hits);
    if (owned.length < cap && hits.length === shallow) {
      hits = lazyPrepare(db, sql).all(...binds, OVERSHOOT_DEEP_LIMIT);
      owned = filterOwned(hits);
    }
    return owned.slice(0, cap);
  };

  const RANKED_SQL_BY_KIND = `
      SELECT meeting_id, entity_id, kind, title, body, bm25(search) AS rank
      FROM search WHERE search MATCH ? AND kind = ?
      ORDER BY rank LIMIT ?
    `;

  const sliceMeetings = (k) => fetchRanked(RANKED_SQL_BY_KIND, [expr, k], (hits) => {
    const ids = [...new Set(hits.map((h) => h.meeting_id))];
    const ph = ids.map(() => '?').join(',');
    const owned = new Set(
      db.prepare(`SELECT id FROM meetings WHERE user_id = ? AND id IN (${ph})`)
        .all(userId, ...ids).map((r) => r.id),
    );
    return hits.filter((h) => owned.has(h.meeting_id));
  });

  const sliceEntities = (kind) => fetchRanked(RANKED_SQL_BY_KIND, [expr, kind], (hits) => {
    const ids = [...new Set(hits.map((h) => h.entity_id))];
    const ph = ids.map(() => '?').join(',');
    const owned = new Set(
      db.prepare(`SELECT id FROM entities WHERE user_id = ? AND id IN (${ph})`)
        .all(userId, ...ids).map((r) => r.id),
    );
    return hits.filter((h) => owned.has(h.entity_id));
  });

  const sliceTasks = () => fetchRanked(RANKED_SQL_BY_KIND, [expr, 'task'], (hits) => {
    const ids = [...new Set(hits.map((h) => h.entity_id))];
    const ph = ids.map(() => '?').join(',');
    const owned = new Set(
      db.prepare(`SELECT id FROM plan_tasks WHERE user_id = ? AND id IN (${ph})`)
        .all(userId, ...ids).map((r) => r.id),
    );
    return hits.filter((h) => owned.has(h.entity_id));
  });

  const sliceCode = () => fetchRanked(RANKED_SQL_BY_KIND, [expr, 'code'], (hits) => {
    const ids = [...new Set(hits.map((h) => Number(h.entity_id)).filter(Number.isFinite))];
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    const refByOwnedId = new Map(
      db.prepare(`SELECT id, ref FROM sources WHERE user_id = ? AND id IN (${ph})`)
        .all(userId, ...ids).map((r) => [String(r.id), r.ref]),
    );
    return hits
      .filter((h) => refByOwnedId.has(h.entity_id))
      .map((h) => ({ ...h, ref: refByOwnedId.get(h.entity_id) }));
  });

  const sliceTickets = () => fetchRanked(RANKED_SQL_BY_KIND, [expr, 'ticket'], (hits) => {
    const ids = [...new Set(hits.map((h) => Number(h.entity_id)).filter(Number.isFinite))];
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    const owned = new Set(
      db.prepare(`SELECT id FROM sources WHERE user_id = ? AND id IN (${ph})`)
        .all(userId, ...ids).map((r) => String(r.id)),
    );
    return hits.filter((h) => owned.has(h.entity_id));
  });

  return {
    meetings: sliceMeetings('meeting'),
    tasks:    sliceTasks(),
    code:     sliceCode(),
    tickets:  sliceTickets(),
    blockers: sliceEntities('blocker'),
  };
}



// --- email dedup + high-water (migration 0013) ----------------------------
//
// These replace the Mac client's per-device UserDefaults ledger. Keeping the
// seen-set and the forward-only fetch boundary per-USER (not per-device) means
// a second device doesn't re-import mail the first already turned into notes.
// The message-id rule MUST stay in lockstep with email-source.mjs's
// normalizeParsed (`messageId || email-uid-<uid>`) or the seen-set won't match.

// Cap on how many ids we'll INSERT in one markEmailSeen call. A single fetch
// is already bounded to MAX_MESSAGES (200) upstream, so this is purely a
// defensive ceiling against a malformed/abusive client body — we never want an
// unbounded array to fan out into one giant transaction.
const EMAIL_SEEN_MAX_PER_CALL = 1000;

// Mirror of EMAIL_SEEN_MAX_PER_CALL for the Slack seen-ledger.
const SLACK_SEEN_MAX_PER_CALL = 1000;

// The forward-only fetch lower bound for this user, or null if never fetched.
export function getEmailHighWater(userId) {
  requireUser(userId);
  const db = getDb();
  const row = lazyPrepare(db,
    'SELECT last_fetched_at FROM email_state WHERE user_id = ?',
  ).get(userId);
  return row?.last_fetched_at ?? null;
}

// Upsert the user's high-water mark. Caller validates that `iso` is a real
// date; we just persist the string.
export function setEmailHighWater(userId, iso) {
  requireUser(userId);
  const db = getDb();
  lazyPrepare(db, `
    INSERT INTO email_state (user_id, last_fetched_at) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_fetched_at = excluded.last_fetched_at
  `).run(userId, typeof iso === 'string' ? iso : null);
}

// Every message-id this user has already imported. Returned as a plain array;
// the caller builds a Set from it for O(1) membership tests during fetch.
export function getEmailSeenIds(userId) {
  requireUser(userId);
  const db = getDb();
  return lazyPrepare(db,
    'SELECT message_id FROM email_seen WHERE user_id = ?',
  ).all(userId).map((r) => r.message_id);
}

// Record message-ids as seen for this user. INSERT OR IGNORE makes re-marking
// an id a harmless no-op (the composite PK dedups). We filter to non-empty
// strings and cap the batch defensively, then run the whole batch in one
// transaction like the other bulk inserts in this module.
export function markEmailSeen(userId, messageIds) {
  requireUser(userId);
  if (!Array.isArray(messageIds)) return;
  const ids = messageIds
    .filter((x) => typeof x === 'string' && x)
    .slice(0, EMAIL_SEEN_MAX_PER_CALL);
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = lazyPrepare(db,
    'INSERT OR IGNORE INTO email_seen (user_id, message_id) VALUES (?, ?)',
  );
  const tx = db.transaction((rows) => {
    for (const mid of rows) stmt.run(userId, mid);
  });
  tx(ids);
}

// ---------------------------------------------------------------------------
// Slack state helpers (twin of email helpers above).
// High-water is per-channel because Slack `ts` ordering is per-conversation.
// ---------------------------------------------------------------------------

// The forward-only fetch lower bound for this user+channel, or null if never
// fetched.
export function getSlackHighWater(userId, channelId) {
  requireUser(userId);
  const db = getDb();
  const row = lazyPrepare(db,
    'SELECT last_ts FROM slack_state WHERE user_id = ? AND channel_id = ?',
  ).get(userId, channelId);
  return row?.last_ts ?? null;
}

// Upsert the channel's high-water mark. Caller validates that `ts` is a real
// Slack timestamp string; we just persist it.
export function setSlackHighWater(userId, channelId, ts) {
  requireUser(userId);
  const db = getDb();
  lazyPrepare(db, `
    INSERT INTO slack_state (user_id, channel_id, last_ts) VALUES (?, ?, ?)
    ON CONFLICT(user_id, channel_id) DO UPDATE SET last_ts = excluded.last_ts
  `).run(userId, channelId, typeof ts === 'string' ? ts : null);
}

// Every message ts this user has already imported. Returned as a plain array;
// the caller builds a Set from it for O(1) membership tests during fetch.
export function getSlackSeenTs(userId) {
  requireUser(userId);
  const db = getDb();
  return lazyPrepare(db,
    'SELECT message_ts FROM slack_seen WHERE user_id = ?',
  ).all(userId).map((r) => r.message_ts);
}

// Record message timestamps as seen for this user. INSERT OR IGNORE makes
// re-marking a ts a harmless no-op (the composite PK dedups). We filter to
// non-empty strings and cap the batch defensively, then run the whole batch
// in one transaction like the other bulk inserts in this module.
export function markSlackSeen(userId, tsList) {
  requireUser(userId);
  if (!Array.isArray(tsList)) return;
  const ids = tsList.filter((x) => typeof x === 'string' && x).slice(0, SLACK_SEEN_MAX_PER_CALL);
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = lazyPrepare(db, 'INSERT OR IGNORE INTO slack_seen (user_id, message_ts) VALUES (?, ?)');
  const tx = db.transaction((rows) => { for (const ts of rows) stmt.run(userId, ts); });
  tx(ids);
}


/**
 * Wipe every row owned by `userId` across every user-scoped table,
 * then delete the user row. Runs in a single transaction so a
 * mid-deletion failure leaves the database consistent.
 *
 * Older tables (meetings/entities/sources/plans/plan_tasks/review_items/
 * outcomes) were added user_id via ALTER TABLE in migration 0002 and
 * do NOT have ON DELETE CASCADE on the FK. We delete them explicitly
 * in child-first order so the FTS triggers fire correctly and FK
 * enforcement (if enabled) is satisfied.
 *
 * audit_log is treated specially: rows aren't deleted, they're
 * anonymized (user_id → NULL). This preserves the audit trail for
 * compliance (e.g. "show me every login attempt before this account
 * was deleted") without leaving the deleted user identifiable.
 *
 * Returns counts of rows touched per table for the audit log.
 */
export function deleteUserCascade(userId) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction(() => {
    const counts = {};
    const del = (sql) => db.prepare(sql).run(userId).changes;

    // Children-first to avoid FK constraint violations under
    // foreign_keys=ON, even though most of these don't have
    // declared FKs to each other.
    counts.outcomes        = del('DELETE FROM outcomes      WHERE user_id = ?');
    counts.plan_tasks      = del('DELETE FROM plan_tasks    WHERE user_id = ?');
    counts.plans           = del('DELETE FROM plans         WHERE user_id = ?');
    counts.review_items    = del('DELETE FROM review_items  WHERE user_id = ?');
    counts.entities        = del('DELETE FROM entities      WHERE user_id = ?');
    counts.sources         = del('DELETE FROM sources       WHERE user_id = ?');
    counts.meetings        = del('DELETE FROM meetings      WHERE user_id = ?');

    // These have ON DELETE CASCADE on the users FK; explicit deletes
    // here so we get a count in the receipt and so we don't rely on
    // FK-cascade being enabled.
    counts.user_repos      = del('DELETE FROM user_repos    WHERE user_id = ?');
    counts.user_secrets    = del('DELETE FROM user_secrets  WHERE user_id = ?');
    counts.user_settings   = del('DELETE FROM user_settings WHERE user_id = ?');
    counts.agent_feedback  = del('DELETE FROM agent_feedback WHERE user_id = ?');
    // migration 0007 — agent ask/chat transcript. No FK cascade declared, so
    // a deleted user's conversation history survived account deletion (PII
    // leak, KB-1).  Explicit delete here closes the gap.
    counts.agent_ask_messages = del('DELETE FROM agent_ask_messages WHERE user_id = ?');
    counts.chat_messages = del('DELETE FROM chat_messages WHERE user_id = ?');
    counts.chat_sessions = del('DELETE FROM chat_sessions WHERE user_id = ?');
    counts.refresh_tokens  = del('DELETE FROM refresh_tokens WHERE user_id = ?');
    // migration 0008 — password-reset tokens are tied to a user; if we
    // skip these the column hangs as a dangling reference after the
    // users row is gone (FK enforcement would block the user delete if
    // FK cascades were active — explicit delete avoids the assumption).
    counts.password_reset_tokens = del('DELETE FROM password_reset_tokens WHERE user_id = ?');
    // migration 0013 — per-user email dedup + high-water state. No FK, so
    // delete explicitly or the seen-set/high-water would outlive the account.
    counts.email_seen      = del('DELETE FROM email_seen   WHERE user_id = ?');
    counts.email_state     = del('DELETE FROM email_state  WHERE user_id = ?');
    // migration 0017 — per-user Slack dedup + high-water state. Same pattern as
    // email: no FK cascade, so explicit deletes are required to avoid PII surviving
    // account deletion.
    counts.slack_seen      = del('DELETE FROM slack_seen   WHERE user_id = ?');
    counts.slack_state     = del('DELETE FROM slack_state  WHERE user_id = ?');
    // migration 0018 — activity feed + read cursor. Both have ON DELETE CASCADE
    // on the users FK, but we delete explicitly so the count appears in the
    // receipt and so the contract holds regardless of FK enforcement.
    counts.activity        = del('DELETE FROM activity      WHERE user_id = ?');
    counts.activity_seen   = del('DELETE FROM activity_seen WHERE user_id = ?');
    // migration 0019 — usage ledger + model limits + reactive quota flags. All
    // have ON DELETE CASCADE on the users FK; explicit deletes keep the receipt
    // complete and don't rely on FK enforcement being on.
    counts.usage_ledger    = del('DELETE FROM usage_ledger  WHERE user_id = ?');
    counts.model_limits    = del('DELETE FROM model_limits  WHERE user_id = ?');
    counts.quota_state     = del('DELETE FROM quota_state   WHERE user_id = ?');
    // migration 0020 — per-user issue scheduling overlay (gantt). ON DELETE
    // CASCADE on the users FK; explicit delete keeps the receipt complete.
    counts.issue_schedule  = del('DELETE FROM issue_schedule WHERE user_id = ?');
    // migration 0009 — rate_limit_buckets has no user_id column; the key
    // column stores "<profile>::<scope>" where scope == userId for
    // authenticated KB routes.  We match by suffix so all per-user
    // buckets are pruned without touching IP-keyed buckets for other users.
    counts.rate_limit_buckets = db.prepare(
      "DELETE FROM rate_limit_buckets WHERE key LIKE '%::' || ?"
    ).run(userId).changes;

    // Anonymise audit log rather than deleting so the operator can
    // still answer "what happened with this account before delete".
    counts.audit_anonymised = db.prepare(
      'UPDATE audit_log SET user_id = NULL WHERE user_id = ?'
    ).run(userId).changes;

    counts.user = del('DELETE FROM users WHERE id = ?');
    return counts;
  });
  return tx();
}

// Self-consistent hot backup (works on a live DB without locking it).
// The filename is a BOUND PARAMETER — SQLite handles quoting, so no
// string interpolation / manual `'` escaping in SQL (2026-07 hardening).
export function backupTo(targetPath) {
  getDb().prepare('VACUUM INTO ?').run(String(targetPath));
}
