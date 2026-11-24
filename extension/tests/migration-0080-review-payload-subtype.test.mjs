// 0080 repairs review_items.payload sections that 0043 double-encoded on SQLite >= 3.54
// (a JSON string holding the object's text instead of the object). The SQL part is run
// against a minimal table with hand-built rows so it is independent of the SQLite version;
// the secret-scrub ordering is covered in review-secrets.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

// ---------------------------------------------------------------------------------------------
// Static guard: no migration may pass a bare `(SELECT ...)` as an argument of a JSON constructor.
// The test above shows the wrapped form works; this part makes the rule fail loudly in CI.
// Scope: .sql migrations only. JS data steps and runtime SQL are not scanned because their SQL is
// assembled in template strings, where a reliable static parse is not cheap.
// ---------------------------------------------------------------------------------------------

const MIGRATIONS_DIR = new URL('../kb/migrations/', import.meta.url);
// 0043 legitimately contains the old bare-subquery pattern and is applied history (migrations are
// checksummed and immutable), so every migration below this number is excluded. 0080 fixes it forward.
const GUARD_FIRST_VERSION = 80;
const JSON_CALL_RE = /\bjsonb?_(?:set|insert|replace|object|array|patch)\s*\(/gi;
const BARE_SUBQUERY_RE = /^\(\s*SELECT\b/i;

// Replaces comments and string literals so parentheses, commas and the word SELECT inside them
// cannot confuse the argument walk. Quoted text is blanked to an empty literal; length is irrelevant.
function stripCommentsAndStrings(sql) {
  let out = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      // A doubled quote is an escaped quote inside the literal.
      i += 1;
      while (i < sql.length && !(sql[i] === ch && sql[i + 1] !== ch)) i += sql[i] === ch ? 2 : 1;
      out += ch + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

// Returns the top-level arguments of the call whose '(' is at `open`, tracking nested parentheses.
function callArguments(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) { args.push(text.slice(start, i)); return args; }
    } else if (text[i] === ',' && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

// Returns the JSON-constructor calls (name + argument) that receive a bare scalar subquery.
export function findBareSubqueryJsonArgs(sql) {
  const text = stripCommentsAndStrings(sql);
  const found = [];
  for (const match of text.matchAll(JSON_CALL_RE)) {
    const open = match.index + match[0].length - 1;
    for (const arg of callArguments(text, open)) {
      if (BARE_SUBQUERY_RE.test(arg.trim())) found.push({ fn: match[0].replace(/\s*\($/, ''), arg: arg.trim() });
    }
  }
  return found;
}

test('guard: flags a bare (SELECT ...) argument of a JSON constructor', () => {
  assert.equal(findBareSubqueryJsonArgs("UPDATE t SET p = json_set(p, '$.c', (SELECT json_object('a', 1)))").length, 1);
  assert.equal(findBareSubqueryJsonArgs('SELECT json_object(\'k\', ( select 1 ))').length, 1);
  for (const fn of ['json_insert', 'json_replace', 'json_array', 'json_patch']) {
    assert.equal(findBareSubqueryJsonArgs(`SELECT ${fn} (x, (SELECT 1))`).length, 1, fn);
  }
});

test('guard: accepts the json((SELECT ...)) wrapper', () => {
  assert.deepEqual(findBareSubqueryJsonArgs("UPDATE t SET p = json_set(p, '$.c', json((SELECT json_object('a', 1))))"), []);
});

test('guard: ignores (SELECT ...) inside string literals and comments', () => {
  assert.deepEqual(findBareSubqueryJsonArgs("SELECT json_set(p, '$.c', '(SELECT 1)')"), []);
  assert.deepEqual(findBareSubqueryJsonArgs("SELECT json_set(p, '$.c', 'it''s (SELECT 1)')"), []);
  assert.deepEqual(findBareSubqueryJsonArgs("SELECT json_set(p, '$.c', 1) -- json_set(p, '$.c', (SELECT 1))"), []);
  assert.deepEqual(findBareSubqueryJsonArgs("/* json_object('a', (SELECT 1)) */ SELECT 1"), []);
});

test('guard: handles nested calls and multi-line formatting', () => {
  const nestedBare = `UPDATE t SET p = json_set(
      json_set(p, '$.a', json_extract(p, '$.b')),
      '$.c',
      (
        SELECT json_object('x', json_array(1, 2))
          FROM u
      )
    )`;
  assert.equal(findBareSubqueryJsonArgs(nestedBare).length, 1);
  const nestedWrapped = `UPDATE t SET p = json_set(
      json_set(p, '$.a', json_extract(p, '$.b')),
      '$.c',
      json(
        (SELECT json_object('x', json_array(1, 2)) FROM u)
      )
    )`;
  assert.deepEqual(findBareSubqueryJsonArgs(nestedWrapped), []);
  // A bare subquery inside an inner constructor is still caught.
  assert.equal(findBareSubqueryJsonArgs("SELECT json_set(p, '$.c', json_object('k', (SELECT 1)))").length, 1);
});

test('guard: ignores a subquery outside any JSON constructor call', () => {
  assert.deepEqual(findBareSubqueryJsonArgs('DELETE FROM a WHERE x IN (SELECT id FROM b)'), []);
  assert.deepEqual(
    findBareSubqueryJsonArgs("UPDATE a SET n = (SELECT 1), p = json_set(p, '$.c', 2) WHERE x IN (SELECT id FROM b)"), []);
});

test('guard: no migration from 0080 on passes a bare subquery as a JSON value', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)
    && Number.parseInt(f, 10) >= GUARD_FIRST_VERSION);
  assert.ok(files.some((f) => f.startsWith('0080_')), 'the guard must cover 0080 itself');
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR.pathname, file), 'utf8');
    assert.deepEqual(findBareSubqueryJsonArgs(sql), [],
      `${file}: wrap a subquery used as a JSON value in json(...) (SQLite >= 3.54 drops the subtype)`);
  }
});
