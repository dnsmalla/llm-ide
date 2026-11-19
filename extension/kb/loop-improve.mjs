// Loop self-improvement storage (migration 0078): signals, reviewed proposals, cross-project offers and
// the before/after outcome check. Every helper takes the db handle first, then `userId`, as kb helpers do;
// every row is user-scoped so one user never reads another's signals, proposals or offers.
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.mjs';

export const SIGNAL_KINDS = Object.freeze([
  'run_finished', 'loop_edited', 'sent_back', 'human_review', 'output_edited', 'improvement_outcome',
]);
export const USER_SIGNAL_KINDS = Object.freeze(['loop_edited', 'sent_back', 'human_review', 'output_edited']);

const MAX_STRING = 20_000;
const BASELINE_RUNS = 10;
const OUTCOME_RUNS = 5;
const MIN_RUNS = 3;
const RATE_STEP = 0.2;
const COST_STEP = 0.25;
const EPS = 1e-9;

const err = (code, message, status = 400) => new AppError(code, message, { status });

// A payload comes from a client; one runaway string must not bloat the table or a later review prompt.
function clampStrings(value) {
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  if (Array.isArray(value)) return value.map(clampStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, clampStrings(val)]));
  }
  return value;
}

function parseJson(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Stores one signal. A repeated `run_finished` for the same run is a duplicate and stores nothing. */
export function recordSignal(db, userId, {
  projectId, loopId, stageKey = null, kind, runId = null, payload,
}) {
  if (!SIGNAL_KINDS.includes(kind)) throw err('VALIDATION', `Unknown signal kind: ${kind}`);
  const text = JSON.stringify(clampStrings(payload ?? {}));
  if (kind === 'output_edited' && runId != null) {
    // The desktop dedupes in memory only, so a restart or remount re-posts; dedupe here on the newest foreign commit.
    return db.transaction(() => {
      const newest = (value) => { try { const list = JSON.parse(value)?.extraCommits; return Array.isArray(list) ? list[list.length - 1] ?? null : null; } catch { return null; } };
      const last = db.prepare(
        `SELECT id, payload FROM loop_signals WHERE user_id = ? AND loop_id = ? AND run_id = ? AND kind = 'output_edited'
         ORDER BY id DESC LIMIT 1`,
      ).get(userId, loopId, runId);
      const incoming = newest(text);
      if (last && incoming !== null && newest(last.payload) === incoming) return { id: last.id, duplicate: true };
      const info = db.prepare(
        `INSERT INTO loop_signals (user_id, project_id, loop_id, stage_key, kind, run_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, projectId, loopId, stageKey, kind, runId, text);
      return { id: Number(info.lastInsertRowid), duplicate: false };
    })();
  }
  try {
    const info = db.prepare(
      `INSERT INTO loop_signals (user_id, project_id, loop_id, stage_key, kind, run_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, projectId, loopId, stageKey, kind, runId, text);
    return { id: Number(info.lastInsertRowid), duplicate: false };
  } catch (error) {
    if (kind === 'run_finished' && runId != null && String(error?.code).startsWith('SQLITE_CONSTRAINT')) {
      const row = db.prepare(
        "SELECT id FROM loop_signals WHERE user_id = ? AND loop_id = ? AND run_id = ? AND kind = 'run_finished'",
      ).get(userId, loopId, runId);
      return { id: row.id, duplicate: true };
    }
    throw error;
  }
}

function storedCursor(db, userId, projectId, loopId) {
  const row = db.prepare(
    'SELECT cursor FROM loop_improve_cursor WHERE user_id = ? AND project_id = ? AND loop_id = ?',
  ).get(userId, projectId, loopId);
  return row ? row.cursor : 0;
}

const toSignal = (row) => ({
  id: row.id, kind: row.kind, stageKey: row.stage_key, runId: row.run_id,
  payload: parseJson(row.payload), createdAt: row.created_at,
});

/**
 * What the next review reads. `cursor` is the stored position (pass it back as `expectedCursor`);
 * `lastId` is the highest signal id returned (pass it as the new `cursor`). Only signals after the
 * cursor are returned; an old outcome is never carried over (the panel highlights a "worse" one with Undo).
 */
export function signalsSinceReview(db, userId, projectId, loopId, { limit = 200 } = {}) {
  const cursor = storedCursor(db, userId, projectId, loopId);
  const fresh = db.prepare(
    `SELECT * FROM loop_signals WHERE user_id = ? AND project_id = ? AND loop_id = ? AND id > ?
     ORDER BY id LIMIT ?`,
  ).all(userId, projectId, loopId, cursor, limit).map(toSignal);

  const finishedRuns = db.prepare(
    `SELECT COUNT(*) AS n FROM loop_signals
     WHERE user_id = ? AND project_id = ? AND loop_id = ? AND id > ? AND kind = 'run_finished'`,
  ).get(userId, projectId, loopId, cursor).n;
  const lastId = fresh.length ? fresh[fresh.length - 1].id : cursor;
  return { cursor, lastId, signals: fresh, finishedRuns };
}

/**
 * Stores a review's proposals and advances the cursor in one transaction. Two reviews of the same loop
 * can overlap; the loser sees a moved cursor and must not store a second, stale batch.
 */
export function saveProposals(db, userId, { projectId, loopId, cursor, expectedCursor, proposals }) {
  return db.transaction(() => {
    if (storedCursor(db, userId, projectId, loopId) !== expectedCursor) {
      throw err('REVIEW_RACE', 'Another review already moved this loop forward', 409);
    }
    // An empty save (a review that found nothing) must not wipe suggestions the user has not decided on yet.
    if ((proposals ?? []).length > 0) {
      db.prepare(
        `UPDATE loop_improvements SET status = 'superseded'
         WHERE user_id = ? AND project_id = ? AND loop_id = ? AND status = 'proposed'`,
      ).run(userId, projectId, loopId);
    }
    const insert = db.prepare(
      `INSERT INTO loop_improvements
         (id, user_id, project_id, loop_id, template_key, stage_key, change, rationale, evidence,
          suggested_scope, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
    );
    const ids = [];
    for (const item of proposals ?? []) {
      const id = randomUUID();
      insert.run(
        id, userId, projectId, loopId, item.templateKey ?? null, item.stageKey ?? null,
        JSON.stringify(item.change ?? {}), String(item.rationale ?? ''), JSON.stringify(item.evidence ?? []),
        item.suggestedScope ?? null,
      );
      ids.push(id);
    }
    db.prepare(
      `INSERT INTO loop_improve_cursor (user_id, project_id, loop_id, cursor) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, project_id, loop_id) DO UPDATE SET cursor = excluded.cursor`,
    ).run(userId, projectId, loopId, cursor);
    return { ids };
  })();
}

const toRow = (row) => (row ? {
  id: row.id, projectId: row.project_id, loopId: row.loop_id, templateKey: row.template_key,
  stageKey: row.stage_key, change: parseJson(row.change), rationale: row.rationale,
  evidence: parseJson(row.evidence), suggestedScope: row.suggested_scope, status: row.status,
  scope: row.scope, origin: row.origin, baseline: parseJson(row.baseline), outcome: parseJson(row.outcome),
  createdAt: row.created_at, decidedAt: row.decided_at,
} : null);

// A decided change whose record is in the project's system/self-improvement/changes.jsonl (the client says so with
// `logged: true`) keeps no text here: the file is the one copy of what was learned (plan 2026-11-19). The row keeps
// the bookkeeping (status, scope, origin, baseline, outcome); `textFor` (from the route) reads the text back.
const LOGGED = { change: 'null', rationale: '', evidence: 'null' };
const isLogged = (row) => row?.change === LOGGED.change;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The row for the UI with its text filled from the log. A logged row whose record is gone from the log stays listed
 * with `change: null` and `recordMissing: true` (its status, scope and outcome are still true), so it never silently
 * disappears; it just cannot be shown, undone or offered.
 */
function withText(row, textFor) {
  if (!isLogged(row)) return toRow(row);
  const text = textFor?.(row) ?? null;
  if (!text) return { ...toRow(row), change: null, rationale: '', evidence: null, recordMissing: true };
  return { ...toRow(row), change: text.change, rationale: text.rationale ?? '', evidence: text.evidence ?? null };
}

const getRow = (db, userId, id) => db.prepare(
  'SELECT * FROM loop_improvements WHERE id = ? AND user_id = ?',
).get(id, userId);

// The "before" picture an accepted change is later judged against. `sinceId` pins where "after" starts
// by signal id, because created_at has one-second resolution and would blur the boundary.
function baselineFor(db, userId, row) {
  const recent = db.prepare(
    `SELECT id, payload FROM loop_signals
     WHERE user_id = ? AND project_id = ? AND loop_id = ? AND kind = 'run_finished'
     ORDER BY id DESC LIMIT ?`,
  ).all(userId, row.project_id, row.loop_id, BASELINE_RUNS);
  const stageName = parseJson(row.change)?.stageName;
  const sinceId = db.prepare(
    'SELECT COALESCE(MAX(id), 0) AS id FROM loop_signals WHERE user_id = ? AND project_id = ? AND loop_id = ?',
  ).get(userId, row.project_id, row.loop_id).id;
  return JSON.stringify({
    ...runStats(recent.map((r) => parseJson(r.payload) ?? {}), stageName), sinceId, stageName: stageName ?? null,
  });
}

/**
 * Accepts, rejects or reverts one improvement. Accept fixes its scope and snapshots the baseline.
 * `projectId` is the project the caller was authorized for: an improvement of another project is NOT_FOUND,
 * so a grant on project A cannot decide project B's rows.
 */
export function decide(db, userId, { projectId, id, action, scope, logged = false, textFor = null }) {
  return db.transaction(() => {
    const row = getRow(db, userId, id);
    if (!row || row.project_id !== projectId) throw err('NOT_FOUND', 'Improvement not found', 404);
    if (action === 'accept') {
      if (row.status !== 'proposed') throw err('CONFLICT', 'Only a proposed improvement can be accepted', 409);
      const finalScope = scope ?? row.suggested_scope ?? 'project';
      if (!['project', 'general'].includes(finalScope)) throw err('VALIDATION', 'Invalid scope');
      db.prepare(
        `UPDATE loop_improvements SET status = 'accepted', scope = ?, baseline = ?, decided_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
      ).run(finalScope, baselineFor(db, userId, row), id, userId);
    } else if (action === 'reject') {
      if (row.status !== 'proposed') throw err('CONFLICT', 'Only a proposed improvement can be rejected', 409);
      db.prepare("UPDATE loop_improvements SET status = 'rejected', decided_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(id, userId);
    } else if (action === 'revert') {
      if (row.status !== 'accepted') throw err('CONFLICT', 'Only an accepted improvement can be reverted', 409);
      db.prepare("UPDATE loop_improvements SET status = 'reverted', decided_at = datetime('now') WHERE id = ? AND user_id = ?")
        .run(id, userId);
    } else {
      throw err('VALIDATION', `Unknown action: ${action}`);
    }
    // Accepted or reverted with its record in the project's log: the text lives only there now. The log is checked,
    // never taken on the client's word: without the line, the DB keeps its copy.
    if (logged && action !== 'reject' && textFor?.(row)) {
      db.prepare('UPDATE loop_improvements SET change = ?, rationale = ?, evidence = ? WHERE id = ? AND user_id = ?')
        .run(LOGGED.change, LOGGED.rationale, LOGGED.evidence, id, userId);
    }
    return toRow(getRow(db, userId, id));
  })();
}

/**
 * Takes a general improvement from another project as a new accepted, project-scoped one here. A logged source's text
 * comes from its project's log (`textFor`); `newId` lets the client log the adoption under the row's own id first.
 */
export function adoptOffer(db, userId, { projectId, loopId, offerId, newId = null, logged = false, textFor = null }) {
  // The adopted row's own line (under newId) must be in this project's log before its text may live only there.
  const inLog = logged && newId !== null && !!textFor?.({ project_id: projectId, id: newId });
  return db.transaction(() => {
    const src = getRow(db, userId, offerId);
    if (!src || src.status !== 'accepted' || src.scope !== 'general' || src.project_id === projectId) {
      throw err('NOT_FOUND', 'Offer not found', 404);
    }
    let text = { change: src.change, rationale: src.rationale, evidence: src.evidence };
    if (isLogged(src)) {
      const t = textFor?.(src);
      if (!t) throw err('NOT_FOUND', "The offer's record is no longer in its project's changes.jsonl", 404);
      text = { change: JSON.stringify(t.change), rationale: t.rationale ?? '', evidence: JSON.stringify(t.evidence ?? null) };
    }
    if (newId !== null && (!UUID_RE.test(newId) || getRow(db, userId, newId))) throw err('VALIDATION', 'newId must be a new uuid');
    const id = newId ?? randomUUID();
    const draft = { ...src, change: text.change, project_id: projectId, loop_id: loopId };
    db.prepare(
      `INSERT INTO loop_improvements
         (id, user_id, project_id, loop_id, template_key, stage_key, change, rationale, evidence,
          suggested_scope, status, scope, origin, baseline, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 'project', ?, ?, datetime('now'))`,
    ).run(
      id, userId, projectId, loopId, src.template_key, src.stage_key,
      ...(inLog ? [LOGGED.change, LOGGED.rationale, LOGGED.evidence] : [text.change, text.rationale, text.evidence]),
      src.suggested_scope, `shared:${offerId}`, baselineFor(db, userId, draft),
    );
    return toRow(getRow(db, userId, id));
  })();
}

/** Hides an offer in this project. Only a real offer qualifies, so junk ids never reach the table. */
export function dismissOffer(db, userId, { projectId, offerId }) {
  const src = getRow(db, userId, offerId);
  if (!src || src.status !== 'accepted' || src.scope !== 'general' || src.project_id === projectId) {
    throw err('NOT_FOUND', 'Offer not found', 404);
  }
  db.prepare(
    'INSERT OR IGNORE INTO loop_improve_dismissals (user_id, project_id, improvement_id) VALUES (?, ?, ?)',
  ).run(userId, projectId, offerId);
}

const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

/** Aggregates run_finished payloads. A null costUsd is left out of the cost average, not counted as 0. */
export function runStats(payloads, stageName) {
  const runs = payloads.length;
  const numbers = (key) => payloads.map((p) => p?.[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  let stageFailRate = null;
  if (stageName) {
    const seen = payloads
      .map((p) => (Array.isArray(p?.stages) ? p.stages.find((s) => s?.name === stageName) : null))
      .filter(Boolean);
    if (seen.length) stageFailRate = seen.filter((s) => !s.ok).length / seen.length;
  }
  return {
    runs,
    passRate: runs ? payloads.filter((p) => p?.passed === true).length / runs : null,
    avgCostUsd: mean(numbers('costUsd')),
    avgIterations: mean(numbers('iterations')),
    stageFailRate,
  };
}

const delta = (before, after) => (typeof before === 'number' && typeof after === 'number' ? after - before : null);

/** Judges a change by comparing run stats before and after it. Thresholds are deliberately coarse. */
export function compareOutcome(baseline, after) {
  if (!baseline || !after || baseline.runs < MIN_RUNS || after.runs < MIN_RUNS) return 'not_enough_data';
  const pass = delta(baseline.passRate, after.passRate) ?? 0;
  const stage = delta(baseline.stageFailRate, after.stageFailRate);
  const cost = baseline.avgCostUsd > 0 && typeof after.avgCostUsd === 'number'
    ? after.avgCostUsd / baseline.avgCostUsd - 1 : null;
  if (pass <= -RATE_STEP + EPS) return 'worse';
  if (stage !== null && stage >= RATE_STEP - EPS) return 'worse';
  if (cost !== null && cost >= COST_STEP - EPS && pass <= EPS) return 'worse';
  if (pass >= RATE_STEP - EPS) return 'better';
  if (stage !== null && stage <= -RATE_STEP + EPS) return 'better';
  if (cost !== null && cost <= -COST_STEP + EPS && pass >= -EPS) return 'better';
  return 'same';
}

// Judges each accepted improvement once, when OUTCOME_RUNS runs have finished since it was accepted.
function evaluateOutcomes(db, userId, projectId, loopId) {
  const due = db.prepare(
    `SELECT * FROM loop_improvements
     WHERE user_id = ? AND project_id = ? AND loop_id = ? AND status = 'accepted' AND outcome IS NULL`,
  ).all(userId, projectId, loopId);
  for (const row of due) {
    const baseline = parseJson(row.baseline);
    if (!baseline) continue;
    const after = db.prepare(
      `SELECT payload FROM loop_signals
       WHERE user_id = ? AND project_id = ? AND loop_id = ? AND kind = 'run_finished' AND id > ?
       ORDER BY id LIMIT ?`,
    ).all(userId, projectId, loopId, baseline.sinceId ?? 0, OUTCOME_RUNS);
    if (after.length < OUTCOME_RUNS) continue;
    const afterStats = runStats(after.map((r) => parseJson(r.payload) ?? {}), baseline.stageName);
    const verdict = compareOutcome(baseline, afterStats);
    db.transaction(() => {
      const claimed = db.prepare(
        'UPDATE loop_improvements SET outcome = ? WHERE id = ? AND outcome IS NULL',
      ).run(JSON.stringify({ verdict, after: afterStats }), row.id);
      if (claimed.changes) {
        recordSignal(db, userId, {
          projectId, loopId, stageKey: row.stage_key, kind: 'improvement_outcome',
          payload: { improvementId: row.id, verdict, baseline, after: afterStats },
        });
      }
    })();
  }
}

function offersFor(db, userId, projectId, loops, textFor) {
  const stageToLoop = new Map();
  const templateToLoop = new Map();
  for (const loop of loops) {
    for (const key of loop.stageKeys ?? []) if (!stageToLoop.has(key)) stageToLoop.set(key, loop.loopId);
    if (loop.templateKey && !templateToLoop.has(loop.templateKey)) templateToLoop.set(loop.templateKey, loop.loopId);
  }
  const rows = db.prepare(
    `SELECT i.*, p.name AS from_project_name FROM loop_improvements i
     LEFT JOIN projects p ON p.id = i.project_id
     WHERE i.user_id = ? AND i.status = 'accepted' AND i.scope = 'general' AND i.project_id != ?
       AND NOT EXISTS (SELECT 1 FROM loop_improve_dismissals d
                       WHERE d.user_id = i.user_id AND d.project_id = ? AND d.improvement_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM loop_improvements a
                       WHERE a.user_id = i.user_id AND a.project_id = ? AND a.origin = 'shared:' || i.id)
     ORDER BY i.created_at, i.id`,
  ).all(userId, projectId, projectId, projectId);
  const offers = [];
  for (const row of rows) {
    const forLoopId = row.stage_key != null
      ? stageToLoop.get(row.stage_key)
      : (row.template_key != null ? templateToLoop.get(row.template_key) : undefined);
    if (forLoopId === undefined) continue;
    const shown = withText(row, textFor);
    if (shown.change === null) continue; // its record left the source project's log: nothing left to offer
    offers.push({ ...shown, fromProjectName: row.from_project_name ?? row.project_id, forLoopId });
  }
  return offers;
}

/** The per-project snapshot the UI renders: pending proposals, history and offers. Also settles due outcomes. */
export function loopState(db, userId, { projectId, loops }, { textFor = null } = {}) {
  const result = {};
  for (const loop of loops) {
    evaluateOutcomes(db, userId, projectId, loop.loopId);
    const cursor = storedCursor(db, userId, projectId, loop.loopId);
    const rows = db.prepare(
      `SELECT * FROM loop_improvements WHERE user_id = ? AND project_id = ? AND loop_id = ?
       ORDER BY created_at DESC, rowid DESC`,
    ).all(userId, projectId, loop.loopId).map((r) => withText(r, textFor));
    result[loop.loopId] = {
      finishedRunsSinceReview: db.prepare(
        `SELECT COUNT(*) AS n FROM loop_signals
         WHERE user_id = ? AND project_id = ? AND loop_id = ? AND id > ? AND kind = 'run_finished'`,
      ).get(userId, projectId, loop.loopId, cursor).n,
      proposals: rows.filter((r) => r.status === 'proposed'),
      history: rows.filter((r) => r.status !== 'proposed' && r.status !== 'superseded'),
    };
  }
  return { loops: result, offers: offersFor(db, userId, projectId, loops, textFor) };
}
