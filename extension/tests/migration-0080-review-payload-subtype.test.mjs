// 0080 repairs review_items.payload sections that 0043 double-encoded on SQLite >= 3.54
// (a JSON string holding the object's text instead of the object). The SQL part is run
// against a minimal table with hand-built rows so it is independent of the SQLite version;
// the secret-scrub ordering is covered in review-secrets.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const SQL = fs.readFileSync(
  new URL('../kb/migrations/0080_repair_review_payload_json_subtype.sql', import.meta.url), 'utf8');

function makeDb(rows) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE review_items (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO review_items (id, payload) VALUES (?, ?)');
  for (const [id, payload] of Object.entries(rows)) ins.run(id, payload);
  return db;
}
const payloadOf = (db, id) => db.prepare('SELECT payload FROM review_items WHERE id = ?').get(id).payload;

test('0080 re-types double-encoded config and pr into objects with the same content', () => {
  const config = { repo: 'a/b', draft: true, labels: ['x'], nested: { n: 1 } };
  const pr = { ghRepo: 'a/b', baseBranch: 'main' };
  const db = makeDb({
    broken: JSON.stringify({ target: 'github', config: JSON.stringify(config), pr: JSON.stringify(pr) }),
  });
  db.exec(SQL);
  assert.deepEqual(JSON.parse(payloadOf(db, 'broken')), { target: 'github', config, pr });
});

test('0080 leaves correct rows, absent keys, null, arrays and non-object values byte-identical', () => {
  const rows = {
    good: JSON.stringify({ config: { repo: 'a/b' }, pr: { ghRepo: 'a/b' } }),
    absent: JSON.stringify({ target: 'github' }),
    nulls: JSON.stringify({ config: null, pr: null }),
    arrays: JSON.stringify({ config: ['a'], pr: [1] }),
    plainString: JSON.stringify({ config: 'just text', pr: 'not json {' }),
    jsonArrayString: JSON.stringify({ config: '["a","b"]', pr: '[]' }),
    jsonNumberString: JSON.stringify({ config: '42', pr: 'true' }),
    jsonNullString: JSON.stringify({ config: 'null', pr: '"quoted"' }),
    numbers: JSON.stringify({ config: 5, pr: false }),
  };
  const db = makeDb(rows);
  db.exec(SQL);
  for (const [id, before] of Object.entries(rows)) assert.equal(payloadOf(db, id), before, id);
});

test('0080 does not throw on a payload that is not valid JSON and leaves it unchanged', () => {
  const rows = { bad: '{not json', empty: '', scalar: '"config"', top: '[1,2]' };
  const db = makeDb(rows);
  assert.doesNotThrow(() => db.exec(SQL));
  for (const [id, before] of Object.entries(rows)) assert.equal(payloadOf(db, id), before, id);
});

test('0080 is idempotent: a second run changes nothing', () => {
  const db = makeDb({
    broken: JSON.stringify({ config: JSON.stringify({ a: 1 }), pr: JSON.stringify({ b: 2 }) }),
    good: JSON.stringify({ config: { a: 1 } }),
  });
  db.exec(SQL);
  const first = [payloadOf(db, 'broken'), payloadOf(db, 'good')];
  db.exec(SQL);
  assert.deepEqual([payloadOf(db, 'broken'), payloadOf(db, 'good')], first);
  assert.equal(JSON.parse(first[0]).config.a, 1);
});

test('SQLite pitfall: a (SELECT json_object(...)) result is only an object when wrapped in json()', () => {
  // Since SQLite 3.54 the JSON subtype no longer crosses a scalar-subquery boundary, so passing the
  // bare subquery to json_set/json_insert/json_replace/json_object/json_array stores a JSON string
  // (the 0043 bug). The json(...) wrapper is correct on every version; migrations must use it.
  const db = new Database(':memory:');
  const wrapped = db.prepare(
    "SELECT json_type(json_set('{}', '$.c', json((SELECT json_object('a', 1)))), '$.c') AS t").get();
  assert.equal(wrapped.t, 'object');
});
