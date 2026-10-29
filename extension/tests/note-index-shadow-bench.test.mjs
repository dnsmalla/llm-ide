// Opt-in bench (plan Phase 2 review item 6): the note-index shadow compare on a
// seeded 50 000-note temp DB, reporting the slice times (p50, p95, max) and the total.
// Run with: LLMIDE_NOTE_SHADOW_BENCH=1 node --test --experimental-strip-types tests/note-index-shadow-bench.test.mjs
// Skipped in the normal suite (it seeds 50 000 meetings and notes, about a minute).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.LLMIDE_NOTE_SHADOW_BENCH === '1';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_note-index-shadow-bench.db');
const tmpAgent = path.join(__dirname, '_note-index-shadow-bench-agent.db');
process.env.LLMIDE_DB_PATH = tmpDb;
process.env.LLMIDE_AGENT_DB_PATH = tmpAgent;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`, tmpAgent, `${tmpAgent}-wal`, `${tmpAgent}-shm`]) fs.rmSync(f, { force: true });

test('50 000 notes: slice times of the shadow compare', { skip: !ENABLED }, async () => {
  const db = await import('../kb/db.mjs');
  const users = await import('../server/users.mjs');
  const meetings = await import('../kb/meetings.mjs');
  const ni = await import('../kb/note-index.mjs');
  const agent = await import('../kb/agent-db.mjs');
  const shadow = await import('../kb/note-index-shadow.mjs');
  const conn = db.getDb();
  const agentDb = agent.getAgentDb();
  const U = users.registerUser(conn, { email: `bench-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'b' }).id;
  const WORDS = ['budget', 'review', 'rollback', 'release', 'planning', 'security', 'hiring', 'sprint', 'design', 'estimate', 'roadmap', 'incident'];
  const N = 50_000;
  const t0 = Date.now();
  const batch = [];
  for (let i = 0; i < N; i += 1) {
    const title = `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} meeting ${i}`;
    const body = `${title} transcript ${'lorem ipsum dolor sit amet '.repeat(60)}`;
    const id = `bench-${i}`;
    meetings.ingestMeeting(U, { id, title, date: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
      duration: 60, language: 'en', participants: ['Ana'], transcript: body, entities: [] });
    batch.push({ noteKey: `meetings/${id}.md`, title, date: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
      durationSec: 60, participants: ['Ana'], body, contentHash: `h-${i}`, mtimeMs: 1, meta: { meetingId: id } });
    if (batch.length === 50) { ni.upsertNotes(U, batch.splice(0), { projectId: '' }); }
  }
  if (batch.length) ni.upsertNotes(U, batch.splice(0), { projectId: '' });
  const seeded = Date.now() - t0;

  const start = Date.now();
  const run = shadow.createNoteShadowRun({ db: conn, agentDb, now: new Date(), sliceMs: shadow.NOTE_SHADOW_SLICE_MS });
  while (!run.step().done) { /* one slice per turn; the real job yields with setImmediate */ }
  const total = Date.now() - start;
  const r = run.result;
  console.log(`bench: seeded ${N} notes in ${seeded} ms; compare ${total} ms; slices ${JSON.stringify(r.slices)}; ` +
    `scoredQueries ${r.scoredQueries} meanOverlap ${r.meanOverlap.toFixed(3)} ok ${r.ok}`);
  assert.equal(r.ok, true);
  assert.ok(r.slices.count >= 1);
  db.closeDb();
  agent.closeAgentDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`, tmpAgent, `${tmpAgent}-wal`, `${tmpAgent}-shm`]) fs.rmSync(f, { force: true });
});
