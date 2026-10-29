// Note-index shadow compare (live-then-archive Phase 2, T2.2, redesigned after the
// Phase 2 review): the legacy meeting search and the note index agree on a synthetic
// corpus; a real mismatch fails; a different bm25 ordering still passes; a stale
// index is skipped; an empty index writes nothing; the run is sliced; and the owner
// filter applies before LIMIT. Temp DBs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_note-index-shadow-test.db');
const tmpAgent = path.join(__dirname, '_note-index-shadow-agent-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
process.env.LLMIDE_AGENT_DB_PATH = tmpAgent;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`, tmpAgent, `${tmpAgent}-wal`, `${tmpAgent}-shm`]) {
  fs.rmSync(f, { force: true });
}

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const meetings = await import('../kb/meetings.mjs');
const ni = await import('../kb/note-index.mjs');
const agent = await import('../kb/agent-db.mjs');
const shadow = await import('../kb/note-index-shadow.mjs');
const jobs = await import('../kb/agent-jobs.mjs');
const conn = db.getDb();
const agentDb = agent.getAgentDb();

const pass = 'CorrectHorseBattery';
let seq = 0;
const newUser = () => users.registerUser(conn, { email: `shadow-${seq += 1}-${Date.now()}@example.test`, password: pass, displayName: 'u' }).id;
const NOW = new Date('2026-10-29T12:00:00.000Z');

test.after(() => {
  db.closeDb();
  agent.closeAgentDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`, tmpAgent, `${tmpAgent}-wal`, `${tmpAgent}-shm`]) {
    fs.rmSync(f, { force: true });
  }
});

// Synthetic corpus: the same titles and transcripts go to the legacy meetings table and
// to the note index, so a correct index agrees with the legacy search.
const CORPUS = [
  ['m-budget', 'Budget review with Acme', '2026-01-05T10:00:00.000Z'],
  ['m-rollback', 'Rollback plan for the release', '2026-01-06T10:00:00.000Z'],
  ['m-ja1', '予算レビューと設計見積もり', '2026-01-07T10:00:00.000Z'],
  ['m-ja2', '設計の見積もり会議', '2026-01-08T10:00:00.000Z'],
  ['m-plan', 'Quarterly planning roadmap', '2026-01-09T10:00:00.000Z'],
  ['m-security', 'Security incident review', '2026-01-10T10:00:00.000Z'],
  ['m-hiring', 'Hiring panel debrief', '2026-01-11T10:00:00.000Z'],
  ['m-retro', 'Sprint retro and actions', '2026-01-12T10:00:00.000Z'],
];

// Meeting ids are unique across users, so each user's corpus gets its own prefix.
function seed(user, corpus = CORPUS, { pad = '' } = {}) {
  const prefix = user.replace(/[^a-z0-9]/gi, '').slice(-10);
  corpus = corpus.map(([id, title, date]) => [`${prefix}-${id}`, title, date]);
  for (const [id, title, date] of corpus) {
    meetings.ingestMeeting(user, {
      id, title, date, duration: 60, language: 'en', participants: ['Ana'],
      transcript: `${title} transcript`, entities: [],
    });
  }
  ni.upsertNotes(user, corpus.map(([id, title, date]) => ({
    noteKey: `meetings/${id}.md`, title, date, durationSec: 60, participants: ['Ana'],
    body: `${title} transcript${pad}`, contentHash: `h-${id}${pad ? '-pad' : ''}`, mtimeMs: 1, meta: { meetingId: id },
  })), { projectId: '' });
  // A complete pass (a reconcile) is what staleness is judged from.
  ni.recordReconciledPass(user, '', NOW);
}

test('topKOverlap: shared ids over the longer list, below K as sets, two empty lists agree', () => {
  assert.equal(shadow.topKOverlap(['a', 'b', 'c'], ['c', 'b', 'a']), 1);
  assert.equal(shadow.topKOverlap(['a', 'b'], ['c', 'd']), 0);
  assert.equal(shadow.topKOverlap([], []), 1);
  assert.equal(shadow.topKOverlap(['a', 'b', 'c', 'd'], ['a', 'b']), 0.5);
  assert.equal(shadow.topKOverlap(['a'], []), 0);
});

test('the query set is deterministic per seed, has FTS terms only, and never a LIKE-only query', () => {
  const u = newUser();
  seed(u);
  const a = shadow.buildNoteShadowQueries(conn, u, '', 20000);
  const b = shadow.buildNoteShadowQueries(conn, u, '', 20000);
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
  for (const { q } of a) assert.ok(db.buildSearchFilter(q)?.match, `"${q}" must have an FTS term`);
  assert.ok(!a.some((x) => x.kind === 'cjk'));
});

test('a synthetic corpus agrees: the run passes with overlap 1 and no count delta', () => {
  const u = newUser();
  seed(u);
  const r = shadow.compareNoteIndexShadow(u, { agentDb, mainDb: conn, now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.sample));
  assert.equal(r.scope, 'user');
  assert.equal(r.pairs, 1);
  assert.ok(r.scoredQueries > 0);
  assert.equal(r.meanOverlap, 1);
  assert.equal(r.countDelta, 0);
  assert.equal(r.orphanNotes, 0);
  assert.equal(r.inconsistentIndexes, 0);
  assert.equal(shadow.lastNoteIndexCompare(agentDb).ok, true);
});

test('a different bm25 ordering still passes: the same hits in another rank order are the same set', () => {
  const u = newUser();
  seed(u);
  // Longer indexed bodies change the bm25 length normalisation, so the ranks move; the hits do not.
  seed(u, CORPUS, { pad: ' '.repeat(3) + 'filler words '.repeat(40) });
  const r = shadow.compareNoteIndexShadow(u, { agentDb, mainDb: conn, now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.sample));
  assert.equal(r.meanOverlap, 1);
});

test('a real mismatch fails the run and is logged as a warning without query text', () => {
  const u = newUser();
  seed(u);
  const logged = [];
  const logger = { warn: (event, fields) => logged.push({ event, fields }) };
  // The index lost its full-text rows for every note: searches disagree on every query.
  conn.prepare("DELETE FROM search WHERE kind = 'note'").run();
  const r = shadow.compareNoteIndexShadow(u, { agentDb, mainDb: conn, now: NOW, logger });
  ni.rebuildNoteIndexSearch(conn);
  assert.equal(r.ok, false);
  assert.equal(r.mismatchedPairs, 1);
  assert.ok(r.mismatchedQueries > 0);
  assert.ok(r.sample.length > 0 && r.sample.every((s) => s.overlap < 1));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'note_index_shadow_mismatch');
  for (const [, title] of CORPUS) {
    assert.ok(!JSON.stringify(logged).includes(title), 'the log holds counts only');
    assert.ok(!JSON.stringify(r).includes(title), 'the stored result holds no query text');
  }
});

test('a stale index (no complete pass in seven days) is skipped and the run is not ok', () => {
  const u = newUser();
  seed(u);
  conn.prepare('DELETE FROM note_index_pass WHERE user_id = ?').run(u);
  const r = shadow.compareNoteIndexShadow(u, { agentDb, mainDb: conn, now: NOW });
  assert.equal(r.stalePairs, 1);
  assert.equal(r.scoredQueries, 0);
  assert.equal(r.state, 'stale');
  assert.equal(r.ok, false);
});

test('a stable library reconciled every interval is NOT stale, even if no row changed for eight days', () => {
  const u = newUser();
  seed(u);
  // indexed_at is the real write time; the library then sits unchanged for eight days, but a
  // complete pass runs each interval, so the last pass is recent.
  const later = new Date(NOW.getTime() + 8 * 86400000);
  ni.recordReconciledPass(u, '', new Date(later.getTime() - 3600000));
  const r = shadow.compareNoteIndexShadow(u, { agentDb, mainDb: conn, now: later });
  assert.equal(r.stalePairs, 0);
  assert.ok(r.scoredQueries > 0);
  assert.equal(r.state, 'ok');
});

test('zero scored queries on a non-empty index is not-evaluated, never ok', () => {
  const u = newUser();
  // titles with no searchable token (two-character words): nothing can be compared. The meeting
  // exists on both sides, so the orphan rule does not fire.
  const id = `nse-${u.replace(/[^a-z0-9]/gi, '').slice(-10)}`;
  meetings.ingestMeeting(u, { id, title: 'a b', date: '2026-01-05T10:00:00.000Z', duration: 60, language: 'en',
    participants: ['Ana'], transcript: 'a b', entities: [] });
  ni.upsertNotes(u, [{ noteKey: 'x/1.md', title: 'a b', date: '2026-01-05T10:00:00.000Z', body: 'a b',
    contentHash: 'x1', mtimeMs: 1, meta: { meetingId: id } }], { projectId: '' });
  ni.recordReconciledPass(u, '', NOW);
  const r = shadow.compareNoteIndexShadow(u, { agentDb, mainDb: conn, now: NOW });
  assert.equal(r.scoredQueries, 0);
  assert.equal(r.notEvaluatedPairs, 1);
  assert.equal(r.state, 'not-evaluated');
  assert.equal(r.ok, false);
});

test('an orphan share above the documented threshold fails the run', () => {
  const u = newUser();
  seed(u);
  // 30 notes of the index name meetings that do not exist in the legacy table: far above 2 %
  ni.upsertNotes(u, Array.from({ length: 30 }, (_, i) => ({ noteKey: `o/${i}.md`, title: `Orphan review ${i}`,
    date: '2026-01-05T10:00:00.000Z', body: 'orphan', contentHash: `o${i}`, mtimeMs: 1, meta: { meetingId: `ghost-${i}` } })), { projectId: '' });
  ni.recordReconciledPass(u, '', NOW);
  const r = shadow.compareNoteIndexShadow(u, { agentDb, mainDb: conn, now: NOW });
  assert.ok(r.orphanNotes >= 30);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'mismatch');
});

test('an empty note index writes nothing: no store key, no day key (lta.mode off)', () => {
  const before = agentDb.prepare('SELECT COUNT(*) AS n FROM store_meta').get().n;
  conn.prepare('DELETE FROM note_index').run();
  const r = shadow.compareNoteIndexShadow(null, { agentDb, mainDb: conn, now: NOW });
  assert.deepEqual(r, { ok: true, scope: 'none', pairs: 0 });
  assert.equal(jobs.runDailyNoteIndexShadowNow(agentDb, NOW, null), null);
  assert.equal(agent.readMeta(agentDb, 'last_daily_note_index_shadow_day'), null);
  assert.equal(agentDb.prepare('SELECT COUNT(*) AS n FROM store_meta').get().n, before);
});

test('the run is sliced: a zero budget spends one unit per slice, and every slice is timed', () => {
  const a = newUser();
  const b = newUser();
  const c = newUser();
  seed(a); seed(b); seed(c);
  const run = shadow.createNoteShadowRun({ db: conn, agentDb, now: NOW, sliceMs: 0 });
  let steps = 0;
  while (!run.step().done) steps += 1;
  steps += 1;
  assert.equal(run.result.pairs, 3);
  assert.equal(run.slices.length, steps);
  assert.ok(steps > 3, 'a pair takes several units (scope, then one per query)');
  assert.equal(run.result.slices.count, run.slices.length);
});

test('the daily job writes its own day key only when a run finishes', () => {
  const u = newUser();
  seed(u);
  jobs.runDailyNoteIndexShadowNow(agentDb, NOW, null);
  assert.equal(agent.readMeta(agentDb, 'last_daily_note_index_shadow_day'), agent.localDay(NOW));
  assert.ok(shadow.lastNoteIndexCompare(agentDb));
});

test('the owner filter applies before LIMIT: a user with few matches is not starved by another', () => {
  const quiet = newUser();
  const busy = newUser();
  ni.upsertNotes(quiet, [0, 1, 2].map((i) => ({ noteKey: `q/${i}.md`, title: `Budget plan ${i}`,
    date: '2026-01-05T10:00:00.000Z', body: 'budget', contentHash: `q${i}`, mtimeMs: 1, meta: { meetingId: `q${i}` } })), { projectId: '' });
  const many = Array.from({ length: 60 }, (_, i) => ({ noteKey: `b/${i}.md`, title: `Budget review ${i}`,
    date: '2026-02-05T10:00:00.000Z', body: 'budget budget', contentHash: `b${i}`, mtimeMs: 1, meta: { meetingId: `b${i}` } }));
  ni.upsertNotes(busy, many.slice(0, 50), { projectId: '' });
  ni.upsertNotes(busy, many.slice(50), { projectId: '' });
  const hits = ni.noteIndexHits(quiet, { q: 'budget', limit: 3 });
  assert.equal(hits.length, 3, 'all three of the quiet user\'s notes are returned');
  assert.ok(hits.every((h) => h.meetingId.startsWith('q')));
});

const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

test('a slice that throws writes no day key and backs off; the retry succeeds and resets the failures', async () => {
  seed(newUser());
  agentDb.prepare("DELETE FROM store_meta WHERE key = 'last_daily_note_index_shadow_day'").run();
  jobs.resetNoteShadowFailureState();
  jobs.setNoteShadowRunFactory(() => ({
    empty: false, result: null, step() { throw new Error('boom'); },
  }));
  jobs.runDailyNoteIndexShadow(agentDb, NOW, null);
  await settle();
  assert.equal(jobs.noteShadowFailureState().failures, 1);
  assert.equal(agent.readMeta(agentDb, 'last_daily_note_index_shadow_day'), null, 'no day key after a throw');
  assert.equal(jobs.noteShadowRetryDue(NOW), false, 'the first retry waits a minute');
  assert.equal(jobs.noteShadowRetryDue(new Date(NOW.getTime() + 61_000)), true);

  jobs.setNoteShadowRunFactory(null);
  jobs.runDailyNoteIndexShadow(agentDb, new Date(NOW.getTime() + 61_000), null);
  await settle();
  assert.equal(jobs.noteShadowFailureState().failures, 0);
  assert.equal(agent.readMeta(agentDb, 'last_daily_note_index_shadow_day'), agent.localDay(new Date(NOW.getTime() + 61_000)));
  jobs.resetNoteShadowFailureState();
});
