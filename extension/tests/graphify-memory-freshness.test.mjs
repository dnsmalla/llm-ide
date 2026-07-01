// Freshness signal: relativeAge (pure) + the age header / absence marker that
// renderGraphifyMemory now surfaces so the agent can weigh repo memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_graphify-freshness-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { renderGraphifyMemory, relativeAge } = await import('../graphkit/memory.mjs');
const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function freshUser(tag) {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  return users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('relativeAge buckets by elapsed time with an injected now', () => {
  const now = 1_000 * DAY; // arbitrary fixed clock
  assert.equal(relativeAge(now - 30_000, now), 'just now');        // < 60s
  assert.equal(relativeAge(now - 5 * MIN, now), '~5 minutes ago');
  assert.equal(relativeAge(now - 1 * MIN, now), '~1 minute ago');  // singular
  assert.equal(relativeAge(now - 3 * HOUR, now), '~3 hours ago');
  assert.equal(relativeAge(now - 1 * HOUR, now), '~1 hour ago');   // singular
  assert.equal(relativeAge(now - 3 * DAY, now), '~3 days ago');
  assert.equal(relativeAge(now - 1 * DAY, now), '~1 day ago');     // singular
});

test('relativeAge treats future / non-finite timestamps as just now', () => {
  const now = 1_000 * DAY;
  assert.equal(relativeAge(now + 5 * MIN, now), 'just now'); // clock skew
  assert.equal(relativeAge(NaN, now), 'just now');
});

test('renderGraphifyMemory annotates present memory with its age', () => {
  const U = freshUser('fresh');
  const repoAbs = path.join(__dirname, `_gm-fresh-repo-${Date.now()}`);
  const memDir = path.join(repoAbs, 'graphify-out', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const repoMd = path.join(memDir, 'repo.md');
  fs.writeFileSync(repoMd, '# Repo summary\nHello memory.');
  // Backdate the file mtime to ~3 days ago so the age phrase is deterministic.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(repoMd, threeDaysAgo, threeDaysAgo);
  try {
    db.addUserRepo(U, repoAbs);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'fresh' }] }, U);
    assert.match(out, /Hello memory/);
    assert.match(out, /updated ~3 days ago/);
  } finally {
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});

test('renderGraphifyMemory emits an absence marker for an indexed repo with no memory', () => {
  const U = freshUser('empty');
  const repoAbs = path.join(__dirname, `_gm-empty-repo-${Date.now()}`);
  fs.mkdirSync(repoAbs, { recursive: true }); // repo dir exists, but NO graphify-out/memory/
  try {
    db.addUserRepo(U, repoAbs);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'empty' }] }, U);
    assert.match(out, /Repository memory \(Graphify\)/);
    assert.match(out, /No code-graph memory generated for this repo yet\./);
  } finally {
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});

test('renderGraphifyMemory stays silent (no marker) for a non-allow-listed repo', () => {
  const U = freshUser('notallowed');
  const repoAbs = path.join(__dirname, `_gm-notallowed-repo-${Date.now()}`);
  fs.mkdirSync(repoAbs, { recursive: true });
  try {
    // NOTE: deliberately NOT calling db.addUserRepo — repo is not allow-listed.
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'notallowed' }] }, U);
    assert.equal(out, ''); // tenancy gate → silent, no absence marker
    assert.doesNotMatch(out, /No code-graph memory/);
  } finally {
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});

test('renderGraphifyMemory returns empty string at the unchanged boundaries', () => {
  const U = freshUser('bounds');
  assert.equal(renderGraphifyMemory({ indexedRepos: [] }, U), '');           // no repos
  assert.equal(renderGraphifyMemory({ indexedRepos: [{ path: '/x', name: 'x' }] }, null), ''); // no userId
});
