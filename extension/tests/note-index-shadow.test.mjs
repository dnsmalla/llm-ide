// Note-index shadow compare (live-then-archive Phase 2, T2.2): the legacy meeting
// search and the derived note index agree on a synthetic corpus, an injected
// mismatch is reported (and logged, without query text), an empty index writes
// nothing, and the daily job runs its own day key. Temp DBs only.
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
const U = users.registerUser(conn, { email: `shadow-${Date.now()}@example.test`, password: pass, displayName: 'u' }).id;

test.after(() => {
  db.closeDb();
  agent.closeAgentDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`, tmpAgent, `${tmpAgent}-wal`, `${tmpAgent}-shm`]) {
    fs.rmSync(f, { force: true });
  }
});

// Synthetic corpus: the same titles and bodies go to the legacy meetings table
// and to the note index, so a correct index must agree with the legacy search.
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
const NOW = new Date('2026-10-29T12:00:00.000Z');

function seed() {
  for (const [id, title, date] of CORPUS) {
    meetings.ingestMeeting(U, {
      id, title, date, duration: 60, language: 'en', participants: ['Ana'],
      transcript: `${title} transcript`, entities: [],
    });
  }
  ni.upsertNotes(U, CORPUS.map(([id, title, date]) => ({
    noteKey: `meetings/${id}.md`, title, date, durationSec: 60, participants: ['Ana'],
    body: `${title} transcript`, contentHash: `h-${id}`, mtimeMs: 1, meta: { meetingId: id },
  })), { projectId: '' });
}

test('topKOverlap: shared ids over the longer list, two empty lists agree', () => {
  assert.equal(shadow.topKOverlap(['a', 'b', 'c'], ['c', 'b', 'a']), 1);
  assert.equal(shadow.topKOverlap(['a', 'b'], ['c', 'd']), 0);
  assert.equal(shadow.topKOverlap([], []), 1);
  assert.equal(shadow.topKOverlap(['a', 'b', 'c', 'd'], ['a', 'b']), 0.5);
  assert.equal(shadow.topKOverlap(['a'], []), 0);
});

test('the query set is deterministic per seed and mixes title, term and CJK queries', () => {
  seed();
  const a = shadow.buildNoteShadowQueries(conn, U, 20000);
  const b = shadow.buildNoteShadowQueries(conn, U, 20000);
  assert.deepEqual(a, b);
  const kinds = new Set(a.map((x) => x.kind));
  assert.ok(kinds.has('title') && kinds.has('term') && kinds.has('cjk'));
});

test('a synthetic corpus agrees: overlap 1, no count delta, consistent index', () => {
  seed();
  const r = shadow.compareNoteIndexShadow(null, { agentDb, mainDb: conn, now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.sample));
  assert.equal(r.scope, 'all');
  assert.equal(r.users, 1);
  assert.ok(r.queries > 0);
  assert.equal(r.mismatchedQueries, 0);
  assert.equal(r.meanOverlap, 1);
  assert.equal(r.countDelta, 0);
  assert.equal(r.drift, 0);
  assert.equal(r.inconsistentIndexes, 0);
  const stored = shadow.lastNoteIndexCompare(agentDb);
  assert.equal(stored.ok, true);
  assert.equal(stored.queries, r.queries);
});

test('the stored and logged result never carries query text', () => {
  seed();
  const logged = [];
  const logger = { warn: (event, fields) => logged.push({ event, fields }) };
  ni.deleteNote(U, { projectId: '', noteKey: 'meetings/m-rollback.md' });
  const r = shadow.compareNoteIndexShadow(null, { agentDb, mainDb: conn, now: NOW, logger });
  const stored = agentDb.prepare("SELECT value FROM store_meta WHERE key = ?").get(shadow.NOTE_SHADOW_META_KEY).value;
  for (const title of CORPUS.map((c) => c[1])) {
    assert.ok(!stored.includes(title), `stored result must not contain "${title}"`);
    assert.ok(!JSON.stringify(logged).includes(title), `log must not contain "${title}"`);
  }
  assert.ok(!JSON.stringify(r.sample).includes('Rollback'));
});

test('an injected mismatch is reported, counted, sampled and logged as a warning', () => {
  seed();
  const logged = [];
  const logger = { warn: (event, fields) => logged.push({ event, fields }) };
  // A note the legacy table still has and the index lost: count delta 1, the
  // rollback queries disagree.
  ni.deleteNote(U, { projectId: '', noteKey: 'meetings/m-rollback.md' });
  const r = shadow.compareNoteIndexShadow(null, { agentDb, mainDb: conn, now: NOW, logger });
  assert.equal(r.ok, false);
  assert.equal(r.countDelta, 1);
  assert.ok(r.mismatchedQueries > 0);
  assert.equal(r.mismatchedUsers, 1);
  assert.ok(r.sample.length > 0 && r.sample.every((s) => s.overlap < 1));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'note_index_shadow_mismatch');
  assert.equal(logged[0].fields.countDelta, 1);
  // Restore so later tests start from the synthetic corpus.
  ni.upsertNotes(U, [{ noteKey: 'meetings/m-rollback.md', title: 'Rollback plan for the release',
    date: '2026-01-06T10:00:00.000Z', body: 'Rollback plan for the release transcript',
    contentHash: 'h-m-rollback', mtimeMs: 1, meta: { meetingId: 'm-rollback' } }], { projectId: '' });
});

test('an empty note index writes nothing (lta.mode off leaves the store untouched)', () => {
  seed();
  shadow.compareNoteIndexShadow(null, { agentDb, mainDb: conn, now: NOW });
  const before = agentDb.prepare("SELECT value FROM store_meta WHERE key = ?").get(shadow.NOTE_SHADOW_META_KEY).value;
  conn.prepare('DELETE FROM note_index WHERE user_id = ?').run(U);
  const r = shadow.compareNoteIndexShadow(null, { agentDb, mainDb: conn, now: new Date('2026-10-30T12:00:00.000Z') });
  assert.deepEqual(r, { ok: true, scope: 'none', users: 0 });
  const after = agentDb.prepare("SELECT value FROM store_meta WHERE key = ?").get(shadow.NOTE_SHADOW_META_KEY).value;
  assert.equal(after, before);
});

test('the daily job runs the compare once per local day on its own key', () => {
  seed();
  jobs.runDailyNoteIndexShadow(agentDb, NOW, null);
  const day = agent.readMeta(agentDb, 'last_daily_note_index_shadow_day');
  assert.equal(day, agent.localDay(NOW));
  assert.ok(shadow.lastNoteIndexCompare(agentDb));
});
