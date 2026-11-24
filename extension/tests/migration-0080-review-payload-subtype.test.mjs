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

// What the stored JSON type is for each way of passing a subquery result as a JSON value. Only
// behaviour that is identical on SQLite 3.53 and 3.54 is asserted; the broken bare form is not.
test('SQLite: json(...) keeps a subquery object an object; explicit CAST keeps scalars their type', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE u (name TEXT, n INTEGER); INSERT INTO u VALUES ('x', 3), ('y', 4)");
  const typeOf = (valueSql) => db.prepare(`SELECT json_type(json_set('{}', '$.c', ${valueSql}), '$.c') AS t`).get().t;
  // Since SQLite 3.54 the JSON subtype no longer crosses a scalar-subquery boundary (the 0043 bug).
  assert.equal(typeOf("json((SELECT json_object('a', 1)))"), 'object');
  assert.equal(typeOf("(SELECT json_object('a', 1))->'$'"), 'object');
  assert.equal(typeOf('CAST((SELECT count(*) FROM u) AS INTEGER)'), 'integer');
  assert.equal(typeOf('CAST((SELECT name FROM u LIMIT 1) AS TEXT)'), 'text');
  const grouped = db.prepare(
    "SELECT json_type(json_group_array(json((SELECT json_object('a', 1)))), '$[0]') AS t FROM u").get();
  assert.equal(grouped.t, 'object');
});

// ---------------------------------------------------------------------------------------------
// Static guard: a scalar subquery used as a VALUE argument of a JSON constructor must be wrapped
// in json(...). Verified on SQLite 3.54.1: a JSON value produced by a scalar subquery loses its
// subtype when it is a value argument of a constructor (it is stored as a JSON string); plain
// numbers/text from a subquery are stored correctly; json_patch parses its text arguments, so it is
// unaffected; `(SELECT ...)->'$'` keeps the subtype. The wrapped form is right on every version.
// Scope: .sql migrations only. JS data steps and runtime SQL are not scanned because their SQL is
// assembled in template strings, where a reliable static parse is not cheap.
// ---------------------------------------------------------------------------------------------

const MIGRATIONS_DIR = new URL('../kb/migrations/', import.meta.url);
// 0043 legitimately contains the old bare-subquery pattern and is applied history (migrations are
// checksummed and immutable), so every migration below this number is excluded. 0080 fixes it forward.
const GUARD_FIRST_VERSION = 80;
// Name -> which 0-based argument positions hold a VALUE. The target document (index 0 of
// set/insert/replace) and the paths are not values; json_patch is deliberately absent.
const VALUE_POSITIONS = {
  set: (i) => i >= 2 && i % 2 === 0,
  insert: (i) => i >= 2 && i % 2 === 0,
  replace: (i) => i >= 2 && i % 2 === 0,
  object: (i) => i % 2 === 1,
  group_object: (i) => i % 2 === 1,
  array: () => true,
  group_array: () => true,
};
// \b before "json" rejects my_json_set(; requiring "(" right after the name rejects json_array_length(.
const JSON_CALL_RE = /\bjsonb?_(set|insert|replace|object|array|group_object|group_array)\s*\(/gi;
const SUBQUERY_START_RE = /^(?:SELECT|WITH)\b/i;
// COALESCE/IFNULL/CASE can hand a subquery's JSON through untyped, so a (SELECT inside one is
// flagged too. Deliberately conservative: it also flags json((SELECT ...)) nested in them.
const PASSTHROUGH_START_RE = /^(?:COALESCE|IFNULL|CASE)\b/i;
const NESTED_SUBQUERY_RE = /\(\s*(?:SELECT|WITH)\b/i;

// Replaces comments and quoted text so parentheses, commas and the word SELECT inside them cannot
// confuse the argument walk. "..." `...` and [...] are identifiers/strings; all are blanked.
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
    } else if (ch === '[') {
      const end = sql.indexOf(']', i + 1);
      i = end === -1 ? sql.length : end;
      out += '[]';
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

// Removes redundant outer parentheses while the opening "(" closes at the very end of the text,
// so `((SELECT ...))` is seen as the subquery it is, while `(SELECT ...)->'$'` is left alone.
function peelOuterParens(arg) {
  let text = arg.trim();
  while (text.startsWith('(')) {
    let depth = 0;
    let closeAt = -1;
    for (let i = 0; i < text.length && closeAt === -1; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') { depth -= 1; if (depth === 0) closeAt = i; }
    }
    if (closeAt !== text.length - 1) break;
    text = text.slice(1, -1).trim();
  }
  return { text, peeled: text !== arg.trim() };
}

function isBareSubquery(arg) {
  const { text, peeled } = peelOuterParens(arg);
  if (peeled && SUBQUERY_START_RE.test(text)) return true;
  return PASSTHROUGH_START_RE.test(text) && NESTED_SUBQUERY_RE.test(text);
}

// Returns the JSON-constructor calls (name + argument) whose value argument is a bare subquery.
export function findBareSubqueryJsonArgs(sql) {
  const text = stripCommentsAndStrings(sql);
  const found = [];
  for (const match of text.matchAll(JSON_CALL_RE)) {
    const isValuePosition = VALUE_POSITIONS[match[1].toLowerCase()];
    const open = match.index + match[0].length - 1;
    callArguments(text, open).forEach((arg, index) => {
      if (isValuePosition(index) && isBareSubquery(arg)) {
        found.push({ fn: match[0].replace(/\s*\($/, ''), arg: arg.trim() });
      }
    });
  }
  return found;
}

const flagged = (sql) => findBareSubqueryJsonArgs(sql).length;

test('guard: flags a bare (SELECT ...) value argument of a JSON constructor', () => {
  assert.equal(flagged("UPDATE t SET p = json_set(p, '$.c', (SELECT json_object('a', 1)))"), 1);
  assert.equal(flagged("SELECT json_object('k', ( select 1 ))"), 1);
  assert.equal(flagged('SELECT jsonb_array(1, (SELECT 1))'), 1);
  for (const fn of ['json_insert', 'json_replace', 'jsonb_set']) {
    assert.equal(flagged(`SELECT ${fn} (x, '$.c', (SELECT 1))`), 1, fn);
  }
  assert.equal(flagged('SELECT json_array\n(\n(SELECT 1))'), 1);
  assert.equal(flagged("SELECT JSON_SET(p, '$.c', (SELECT 1))"), 1);
});

test('guard: flags redundant parentheses, CTE subqueries and the aggregate constructors', () => {
  assert.equal(flagged("SELECT json_set(p, '$.c', ((SELECT json_object('a', 1))))"), 1);
  assert.equal(flagged("SELECT json_set(p, '$.c', ( ( SELECT 1 ) ))"), 1);
  assert.equal(flagged("SELECT json_set(p, '$.c', (WITH x AS (SELECT 1) SELECT json_object('a', 1)))"), 1);
  assert.equal(flagged("SELECT json_group_object('k', (SELECT json_object('a', 1))) FROM u"), 1);
  assert.equal(flagged('SELECT jsonb_group_object(name, (SELECT 1)) FROM u'), 1);
  assert.equal(flagged('SELECT json_group_array((SELECT json_object(1))) FROM u'), 1);
  assert.equal(flagged('SELECT jsonb_group_array((SELECT 1)) FROM u'), 1);
});

test('guard: flags COALESCE / IFNULL / CASE value arguments holding a subquery (conservative)', () => {
  assert.equal(flagged("SELECT json_set(p, '$.c', COALESCE((SELECT json_object('a', 1)), '{}'))"), 1);
  assert.equal(flagged("SELECT json_set(p, '$.c', ifnull((SELECT 1), 0))"), 1);
  assert.equal(flagged("SELECT json_set(p, '$.c', CASE WHEN x THEN (SELECT 1) ELSE 0 END)"), 1);
  assert.equal(flagged("SELECT json_set(p, '$.c', COALESCE(json_extract(p, '$.x'), 0))"), 0);
});

test('guard: checks value positions only', () => {
  // Target document, paths and object keys are not values.
  assert.equal(flagged("SELECT json_set((SELECT p FROM t), '$.c', 1)"), 0);
  assert.equal(flagged("SELECT json_insert((SELECT p FROM t), '$.c', 1, '$.d', 2)"), 0);
  assert.equal(flagged("SELECT json_set(p, (SELECT '$.c'), 1)"), 0);
  assert.equal(flagged("SELECT json_object((SELECT 'k'), 1)"), 0);
  assert.equal(flagged("SELECT json_set(p, '$.a', 1, '$.b', (SELECT 2))"), 1);
  assert.equal(flagged("SELECT json_object('a', 1, 'b', (SELECT 2))"), 1);
  // json_patch parses text arguments as JSON, so it is unaffected.
  assert.equal(flagged("SELECT json_patch(p, (SELECT json_object('a', 1)))"), 0);
});

test('guard: accepts json(...) wrapping, ->, and explicit scalar casts', () => {
  assert.equal(flagged("UPDATE t SET p = json_set(p, '$.c', json((SELECT json_object('a', 1))))"), 0);
  assert.equal(flagged("SELECT json_set(p, '$.c', (SELECT json_object('a', 1))->'$')"), 0);
  assert.equal(flagged("SELECT json_set(p, '$.c', (SELECT json_object('a', 1))->>'$.a')"), 0);
  assert.equal(flagged('SELECT json_set(p, \'$.c\', CAST((SELECT count(*) FROM u) AS INTEGER))'), 0);
  assert.equal(flagged('SELECT json_set(p, \'$.c\', CAST((SELECT name FROM u) AS TEXT))'), 0);
  assert.equal(flagged('SELECT json_group_array(json((SELECT 1))) FROM u'), 0);
});

test('guard: ignores (SELECT ...) inside strings, comments and quoted identifiers', () => {
  assert.equal(flagged("SELECT json_set(p, '$.c', '(SELECT 1)')"), 0);
  assert.equal(flagged("SELECT json_set(p, '$.c', 'it''s (SELECT 1)')"), 0);
  assert.equal(flagged("SELECT json_set(p, '$.c', 1) -- json_set(p, '$.c', (SELECT 1))"), 0);
  assert.equal(flagged("/* json_object('a', (SELECT 1)) */ SELECT 1"), 0);
  // An unbalanced bracket/backtick/quote identifier must not derail the argument walk.
  assert.equal(flagged("SELECT json_set(p, '$.c', [a)b], `c(`, \"d,\"), json_array((SELECT 1))"), 1);
  assert.equal(flagged("SELECT json_set(p, '$.c', [a)b]), json_array(json((SELECT 1)))"), 0);
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
  assert.equal(flagged(nestedBare), 1);
  const nestedWrapped = `UPDATE t SET p = json_set(
      json_set(p, '$.a', json_extract(p, '$.b')),
      '$.c',
      json(
        (SELECT json_object('x', json_array(1, 2)) FROM u)
      )
    )`;
  assert.equal(flagged(nestedWrapped), 0);
  // A bare subquery inside an inner constructor is still caught.
  assert.equal(flagged("SELECT json_set(p, '$.c', json_object('k', (SELECT 1)))"), 1);
});

test('guard: matches whole function names only and ignores subqueries outside constructors', () => {
  assert.equal(flagged("SELECT my_json_set(p, '$.c', (SELECT 1))"), 0);
  assert.equal(flagged('SELECT json_array_length((SELECT json_array(1)))'), 0);
  assert.equal(flagged('DELETE FROM a WHERE x IN (SELECT id FROM b)'), 0);
  assert.equal(
    flagged("UPDATE a SET n = (SELECT 1), p = json_set(p, '$.c', 2) WHERE x IN (SELECT id FROM b)"), 0);
});

test('guard: no migration from 0080 on passes a bare subquery as a JSON value', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)
    && Number.parseInt(f, 10) >= GUARD_FIRST_VERSION);
  assert.ok(files.some((f) => f.startsWith('0080_')), 'the guard must cover 0080 itself');
  for (const file of files) {
    const sql = fs.readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    assert.deepEqual(findBareSubqueryJsonArgs(sql), [],
      `${file}: a subquery used as a JSON value loses its JSON type on SQLite >= 3.54. `
      + 'If it returns JSON, wrap it in json(...). If it returns a plain number or text, make that '
      + 'explicit with CAST((SELECT ...) AS INTEGER|REAL|TEXT) so the guard and the reader can see it.');
  }
});
