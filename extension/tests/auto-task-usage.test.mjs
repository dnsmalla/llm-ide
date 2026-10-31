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
  assert.match(formatReport(s), /not found/);
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
  assert.equal(resolveDbPath({ env: {}, root: '/r' }), path.join('/r', 'kb', 'data.db'));
  assert.deepEqual(parseArgs(['--json', '--db', 'x']), { json: true, db: 'x' });
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});
