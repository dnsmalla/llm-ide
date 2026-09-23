// Japanese / CJK text must be searchable.
//
// Regression (2026-09 review): the FTS index used the `unicode61` tokenizer,
// which splits only on spaces and punctuation — and CJK has neither between
// words, so a whole sentence was ONE token and searching any word inside it
// (議事録 in 「今日の会議で議事録を作成しました」) matched nothing. Migration 0033
// moves to the trigram tokenizer; 2-character terms, which a trigram MATCH
// can't take, fall back to LIKE (kb/db.mjs buildSearchFilter).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-search-cjk-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function provision(name) {
  return users.registerUser(db.getDb(), {
    email: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: name,
  }).id;
}

function meeting(userId, id, title, transcript, date = '2026-05-01') {
  db.ingestMeeting(userId, { id, title, date, duration: 60, transcript, entities: [] });
}

const ids = (hits) => hits.map((h) => h.meetingId).sort();

test('a Japanese word inside a sentence is found (3+ characters → trigram MATCH)', () => {
  reset();
  const u = provision('ja');
  meeting(u, 'm1', '定例', '今日の会議で議事録を作成しました。');
  meeting(u, 'm2', '週次', '予算の見直しについて話しました。');
  assert.deepEqual(ids(db.search(u, { q: '議事録', kind: 'meeting' })), ['m1']);
  assert.deepEqual(ids(db.search(u, { q: '見直し', kind: 'meeting' })), ['m2']);
});

test('a 2-character Japanese word is found (LIKE fallback), alone or with a longer term', () => {
  reset();
  const u = provision('ja2');
  meeting(u, 'm1', '定例', '今日の会議で議事録を作成しました。', '2026-05-01');
  meeting(u, 'm2', '週次', '会議の資料を共有します。', '2026-05-02');
  meeting(u, 'm3', '雑談', '天気の話だけ。', '2026-05-03');
  assert.deepEqual(ids(db.search(u, { q: '会議', kind: 'meeting' })), ['m1', 'm2']);
  assert.deepEqual(ids(db.search(u, { q: '会議 議事録', kind: 'meeting' })), ['m1'], 'AND: both terms');
  assert.deepEqual(ids(db.search(u, { q: '資料', kind: 'meeting' })), ['m2']);
});

test('LIKE wildcards in a short term are literal, not patterns', () => {
  reset();
  const u = provision('esc');
  meeting(u, 'm1', 'plain', 'nothing special here at all');
  // "a_" would match "at" / "al" as a LIKE pattern if `_` were not escaped.
  assert.deepEqual(ids(db.search(u, { q: 'a_', kind: 'meeting' })), []);
});

test('English search still works, case- and diacritic-insensitively', () => {
  reset();
  const u = provision('en');
  meeting(u, 'm1', 'Roadmap', 'We reviewed the Café budget and the roadmap.');
  meeting(u, 'm2', 'Other', 'Unrelated discussion.');
  assert.deepEqual(ids(db.search(u, { q: 'ROADMAP', kind: 'meeting' })), ['m1']);
  assert.deepEqual(ids(db.search(u, { q: 'cafe budget', kind: 'meeting' })), ['m1']);
  assert.deepEqual(ids(db.search(u, { q: 'roadmap unrelated', kind: 'meeting' })), [], 'AND semantics kept');
});

test('findContext (OR retrieval) finds Japanese meetings too', () => {
  reset();
  const u = provision('ctx');
  meeting(u, 'm1', '定例', '今日の会議で議事録を作成しました。');
  const ctx = db.findContext(u, '議事録 レビュー', 5);
  assert.deepEqual(ctx.meetings.map((h) => h.meeting_id), ['m1']);
  const short = db.findContext(u, '会議', 5);
  assert.deepEqual(short.meetings.map((h) => h.meeting_id), ['m1'], 'OR with only short terms uses LIKE');
});

test('migration 0033 carries existing rows over and the old triggers keep writing', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'kb', 'migrations', '0033_search_trigram.sql'), 'utf8');
  const mem = new Database(':memory:');
  mem.exec(`
    CREATE TABLE m (id TEXT, title TEXT, body TEXT);
    CREATE VIRTUAL TABLE search USING fts5(
      meeting_id UNINDEXED, entity_id UNINDEXED, kind UNINDEXED, title, body,
      tokenize = 'unicode61 remove_diacritics 2');
    CREATE TRIGGER t AFTER INSERT ON m BEGIN
      INSERT INTO search (meeting_id, entity_id, kind, title, body)
      VALUES (NEW.id, NULL, 'meeting', NEW.title, NEW.body);
    END;
  `);
  mem.prepare('INSERT INTO m VALUES (?, ?, ?)').run('old', '定例', '今日の議事録');
  mem.transaction(() => mem.exec(sql))();
  mem.prepare('INSERT INTO m VALUES (?, ?, ?)').run('new', '週次', '新しい議事録メモ');
  const hits = mem.prepare(`SELECT meeting_id FROM search WHERE search MATCH '"議事録"' ORDER BY meeting_id`).all();
  assert.deepEqual(hits.map((r) => r.meeting_id), ['new', 'old']);
  const def = mem.prepare(`SELECT sql FROM sqlite_master WHERE name = 'search'`).get().sql;
  assert.match(def, /trigram/);
  mem.close();
});

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});
