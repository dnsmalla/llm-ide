// scripts/auto-task-usage.mjs against a synthetic temp DB and run-history file.
// Never touches a real data directory; asserts nothing but counts is printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  formatReport, parseArgs, resolveDbPath, summarize, taskFromEndpoint,
} from '../../scripts/auto-task-usage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', '..', 'scripts', 'auto-task-usage.mjs');
const Database = createRequire(import.meta.url)('better-sqlite3');
const SECRET = 'SECRET-SUMMARY-TEXT';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atu-'));
  const history = path.join(dir, 'auto-task-runs.json');
  const rec = (taskId, status, trigger, finishedAt) => ({
    id: `${taskId}-${finishedAt}`, taskId, taskLabel: SECRET, trigger, startedAt: finishedAt,
    finishedAt, status, summary: SECRET, logFileName: null, projectId: SECRET,
  });
  fs.writeFileSync(history, JSON.stringify({
    storeVersion: 1,
    records: [
      rec('reviewCode', 'success', 'cron', '2026-10-30T10:00:00Z'),
      rec('reviewCode', 'failed', 'manual', '2026-10-29T10:00:00Z'),
      rec('reviewCode', 'skipped', 'cron', '2026-10-28T10:00:00Z'),
      rec('regression', 'success', 'phone', '2026-10-27T10:00:00Z'),
      rec('custom-abc', 'success', 'manual', '2026-10-26T10:00:00Z'),
    ],
  }));
  const dbPath = path.join(dir, 'data.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY, user_id TEXT, ts TEXT, provider TEXT,
    model TEXT, source TEXT, endpoint TEXT, runs INTEGER DEFAULT 1)`);
  const ins = db.prepare('INSERT INTO usage_ledger (user_id, ts, provider, model, source, endpoint) VALUES (?,?,?,?,?,?)');
  ins.run('u1', '2026-10-30 09:00:00', 'anthropic', 'm', 'auto-task', 'auto-task:review-code');
  ins.run('u1', '2026-10-25 09:00:00', 'anthropic', 'm', 'auto-task', 'auto-task:review-code');
  ins.run('u1', '2026-10-24 09:00:00', 'anthropic', 'm', 'auto-task', 'auto-task:issue-42');
  ins.run('u1', '2026-10-23 09:00:00', 'anthropic', 'm', 'api', 'auto-task:generate-doc');
  db.close();
  return { dir, history, dbPath };
}

test('taskFromEndpoint maps log suffixes, issue runs and custom tasks', () => {
  assert.equal(taskFromEndpoint('auto-task:review-code'), 'reviewCode');
  assert.equal(taskFromEndpoint('auto-task:issue-7'), 'implementIssues');
  assert.equal(taskFromEndpoint('auto-task:my-task'), 'custom:my-task');
  assert.equal(taskFromEndpoint('chat'), null);
});

test('summarize counts runs, last date and success rate from both sources', () => {
  const { dir, history, dbPath } = fixture();
  try {
    const s = summarize({ historyPath: history, dbPath });
    assert.equal(s.historyFound, true);
    assert.equal(s.ledgerFound, true);
    const rc = s.rows.find((r) => r.task === 'reviewCode');
    assert.equal(rc.historyRuns, 3);
    assert.equal(rc.lastRun, '2026-10-30');
    assert.equal(rc.successRate, 50); // skipped is not a finished run
    assert.equal(rc.cronRuns, 2);
    assert.equal(rc.ledgerRuns, 2);
    assert.equal(rc.ledgerLast, '2026-10-30');
    assert.equal(s.rows.find((r) => r.task === 'regression').phoneRuns, 1);
    assert.equal(s.rows.find((r) => r.task === 'implementIssues').ledgerRuns, 1);
    assert.equal(s.rows.find((r) => r.task === 'generateDoc').ledgerRuns, 0); // source != auto-task
    assert.equal(s.rows.find((r) => r.task === 'reviewMerge').historyRuns, 0); // never-run built-in listed
    assert.ok(s.rows.some((r) => r.task === 'custom-abc'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing sources are reported, not thrown', () => {
  const s = summarize({ historyPath: '/nonexistent/h.json', dbPath: '/nonexistent/data.db' });
  assert.equal(s.historyFound, false);
  assert.equal(s.ledgerFound, false);
  assert.match(formatReport(s), /does not exist/);
});

test('the CLI prints counts only and leaves the database untouched', () => {
  const { dir, history, dbPath } = fixture();
  try {
    const before = fs.readFileSync(dbPath);
    const out = execFileSync(process.execPath, [SCRIPT, '--history', history, '--db', dbPath], { encoding: 'utf8' });
    assert.match(out, /reviewCode/);
    assert.ok(!out.includes(SECRET), 'no summary, label or project text may be printed');
    assert.deepEqual(fs.readFileSync(dbPath), before);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['auto-task-runs.json', 'data.db']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db path precedence and argument parsing', () => {
  assert.equal(resolveDbPath({ db: '/a.db', env: { LLMIDE_DB_PATH: '/b.db' } }), '/a.db');
  assert.equal(resolveDbPath({ env: { LLMIDE_DB_PATH: '/b.db', LLMIDE_DATA_DIR: '/d' } }), '/b.db');
  assert.equal(resolveDbPath({ env: { LLMIDE_DATA_DIR: '/d' } }), path.join('/d', 'data.db'));
  assert.equal(resolveDbPath({ env: {}, root: '/r', home: '/nonexistent-home' }), path.join('/r', 'kb', 'data.db'));
  assert.deepEqual(parseArgs(['--json', '--db', 'x']), { json: true, db: 'x' });
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

// ---- security review LOW items ------------------------------------------------------------------------------------

const withTmp = (fn) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atu-')); try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };

test('a hostile history record cannot corrupt the counters (own-property checks, fixed status set)', () => withTmp((dir) => {
  const history = path.join(dir, 'h.json');
  const rec = (taskId, status, trigger) => ({ taskId, status, trigger, finishedAt: '2026-10-30T10:00:00Z' });
  fs.writeFileSync(history, JSON.stringify([
    rec('a', 'last', 'byTrigger'), rec('a', 'runs', 'constructor'), rec('a', 'toString', '__proto__'), rec('a', 'success', 'cron'),
    rec('__proto__', 'success', 'manual'), rec('constructor', 'failed', 'phone'),
  ]));
  const s = summarize({ historyPath: history, dbPath: path.join(dir, 'none.db') });
  const a = s.rows.find((r) => r.task === 'a');
  assert.equal(a.historyRuns, 4, 'runs counts records, not a status named runs');
  assert.equal(a.lastRun, '2026-10-30', 'a status named last never clobbers the date');
  assert.equal(a.successRate, 100);
  assert.equal(a.cronRuns, 1);
  assert.equal(s.rows.find((r) => r.task === '__proto__').historyRuns, 1);
  assert.equal(s.rows.find((r) => r.task === 'constructor').phoneRuns, 1);
  assert.equal(Object.keys(Object.prototype).length, 0, 'Object.prototype untouched');
}));

test('control characters and bidi marks in a task id are stripped before anything is printed', () => withTmp((dir) => {
  const history = path.join(dir, 'h.json');
  fs.writeFileSync(history, JSON.stringify([{ taskId: '\u001b[31mred\u0007\nINJECTED\u202Etxt', status: 'success', trigger: 'manual', finishedAt: '2026-10-30T10:00:00Z' }]));
  const s = summarize({ historyPath: history, dbPath: path.join(dir, 'none.db') });
  const report = formatReport(s);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(report), 'no control character in the report');
  assert.ok(!/[\u202a-\u202e\u2066-\u2069\u200b-\u200f]/.test(report), 'no bidi or zero-width mark');
  assert.ok(!report.includes('\u001b'));
  assert.ok(s.rows.some((r) => r.task.includes('red') && !r.task.includes('\n')));
  // a ledger endpoint is cleaned the same way
  const dbPath = path.join(dir, 'data.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY, ts TEXT, source TEXT, endpoint TEXT)');
  db.prepare('INSERT INTO usage_ledger (ts, source, endpoint) VALUES (?,?,?)').run('2026-10-30 09:00:00', 'auto-task', 'auto-task:x\u001b[2Jy\u0007');
  db.close();
  const s2 = summarize({ historyPath: history, dbPath });
  assert.ok(!formatReport(s2).includes('\u001b'));
}));

test('every failure prints its reason, not a bare "not found"', () => withTmp((dir) => {
  const write = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
  const none = path.join(dir, 'missing');
  const cases = [
    [{ historyPath: none, dbPath: none }, [/does not exist/, /does not exist/]],
    [{ historyPath: write('bad.json', '{not json'), dbPath: write('junk.db', 'this is not a sqlite file at all, just text') }, [/not valid JSON/, /(not a SQLite database|sqlite error)/i]],
    [{ historyPath: write('shape.json', '{"x":1}'), dbPath: write('empty.db', '') }, [/no records array/, /(no usage_ledger table|empty)/]],
  ];
  for (const [args, wants] of cases) {
    const report = formatReport(summarize(args));
    assert.ok(!/not found/.test(report), report);
    for (const w of wants) assert.match(report, w, report);
    assert.ok(report.includes(args.dbPath), 'the path that was tried is printed');
  }
  // a DB without the ledger table
  const noTable = path.join(dir, 'notable.db');
  new Database(noTable).close();
  assert.match(formatReport(summarize({ historyPath: none, dbPath: noTable })), /no usage_ledger table/);
}));

test('default DB path: the app\'s system/data.db when it exists, else the repo kb/data.db; the path used is printed', () => withTmp((home) => {
  const appDb = path.join(home, 'Library', 'Application Support', 'llm-ide', 'system', 'data.db');
  assert.equal(resolveDbPath({ env: {}, root: '/r', home }), path.join('/r', 'kb', 'data.db'), 'absent: the repo fallback');
  fs.mkdirSync(path.dirname(appDb), { recursive: true });
  new Database(appDb).close();
  assert.equal(resolveDbPath({ env: {}, root: '/r', home }), appDb);
  assert.equal(resolveDbPath({ env: { LLMIDE_DB_PATH: '/b.db' }, root: '/r', home }), '/b.db', 'env still wins');
  const s = summarize({ historyPath: path.join(home, 'none'), dbPath: appDb });
  assert.ok(formatReport(s).includes(appDb), 'the report names the path it read');
  assert.equal(s.dbPath, appDb);
}));

test('a long path is printed whole (a truncated path would name nothing)', () => {
  const long = `/${'d'.repeat(60)}/${'e'.repeat(60)}/data.db`;
  const report = formatReport(summarize({ historyPath: long, dbPath: long }));
  assert.ok(report.split(long).length >= 3, 'both lines carry the full path');
});
