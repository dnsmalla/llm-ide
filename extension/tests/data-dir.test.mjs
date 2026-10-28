// Config precedence for the global data locations (core/data-dir.mjs):
// individual env vars > test isolation > LLMIDE_DATA_DIR > repo kb default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDataLayout } from '../core/data-dir.mjs';

const ROOT = '/repo';
const LOG = '/repo/extension/kb/server.log';
const DATA = '/home/u/Library/Application Support/llm-ide/system';
const base = { root: ROOT, legacyLogFile: LOG };
const layout = (env, extra = {}) => resolveDataLayout({ ...base, env, ...extra });

test('defaults: no env → repo kb for every location (dev and repo runs unchanged)', () => {
  const l = layout({});
  assert.equal(l.location, 'repo-kb');
  assert.equal(l.dataDir, null);
  assert.equal(l.dbPath, path.join(ROOT, 'kb', 'data.db'));
  assert.equal(l.dbSource, 'default');
  assert.equal(l.agentDbPath, path.join(ROOT, 'kb', 'agent.db'));
  assert.equal(l.backupDir, path.join(ROOT, 'kb', 'backups'));
  assert.equal(l.agentSdkDir, path.join(ROOT, 'kb', 'agent-sdk'));
  assert.equal(l.logFile, LOG);
});

test('LLMIDE_DATA_DIR is the base for data.db, agent.db, backups, agent-sdk and server.log', () => {
  const l = layout({ LLMIDE_DATA_DIR: DATA });
  assert.equal(l.location, 'system');
  assert.equal(l.dataDir, DATA);
  assert.equal(l.dbPath, path.join(DATA, 'data.db'));
  assert.equal(l.dbSource, 'data-dir');
  assert.equal(l.agentDbPath, path.join(DATA, 'agent.db'));
  assert.equal(l.backupDir, path.join(DATA, 'backups'));
  assert.equal(l.agentSdkDir, path.join(DATA, 'agent-sdk'));
  assert.equal(l.logFile, path.join(DATA, 'server.log'));
});

test('individual env vars win over LLMIDE_DATA_DIR', () => {
  const l = layout({
    LLMIDE_DATA_DIR: DATA,
    LLMIDE_DB_PATH: '/x/main.db',
    LLMIDE_AGENT_DB_PATH: '/x/agent.db',
    LLMIDE_BACKUP_DIR: '/x/bk',
    LLMIDE_LOG_FILE: '/x/log.txt',
  });
  assert.equal(l.dbPath, '/x/main.db');
  assert.equal(l.dbSource, 'env');
  assert.equal(l.agentDbPath, '/x/agent.db');
  assert.equal(l.backupDir, '/x/bk');
  assert.equal(l.logFile, '/x/log.txt');
  // agent-sdk is not individually overridable: it follows the data dir.
  assert.equal(l.agentSdkDir, path.join(DATA, 'agent-sdk'));
});

test('LLMIDE_DB_PATH alone keeps agent.db beside the explicit DB (old behaviour)', () => {
  const l = layout({ LLMIDE_DB_PATH: '/elsewhere/main.db' });
  assert.equal(l.agentDbPath, path.join('/elsewhere', 'agent.db'));
  assert.equal(l.backupDir, path.join('/elsewhere', 'backups'));
});

test('empty LLMIDE_LOG_FILE disables the file sink; none does too', () => {
  assert.equal(layout({ LLMIDE_DATA_DIR: DATA, LLMIDE_LOG_FILE: '' }).logFile, null);
  assert.equal(layout({ LLMIDE_LOG_FILE: 'NONE' }).logFile, null);
});

test('empty LLMIDE_DATA_DIR is the same as unset', () => {
  assert.equal(layout({ LLMIDE_DATA_DIR: '   ' }).location, 'repo-kb');
});

test('test isolation: under the test runner the temp DB and its agent.db win; DATA_DIR is ignored', () => {
  const tmp = '/tmp/llmide-test-42.db';
  const l = layout({ NODE_TEST_CONTEXT: '1', LLMIDE_DATA_DIR: DATA }, { isTest: true, testDbPath: tmp });
  assert.equal(l.dataDir, null);
  assert.equal(l.location, 'repo-kb');
  assert.equal(l.dbPath, tmp);
  assert.equal(l.dbSource, 'test');
  assert.equal(l.agentDbPath, `${tmp}.agent.db`);
  assert.equal(l.agentSdkDir, path.join('/tmp', 'agent-sdk'));
  assert.ok(!l.dbPath.startsWith(DATA) && !l.agentDbPath.startsWith(DATA));
});

test('test isolation: an explicit LLMIDE_DB_PATH still wins under the runner', () => {
  const l = layout({ LLMIDE_DB_PATH: '/x/main.db' }, { isTest: true, testDbPath: null });
  assert.equal(l.dbPath, '/x/main.db');
});

test('a migration decision overrides the env: null forces the repo kb fallback', () => {
  const env = { LLMIDE_DATA_DIR: DATA };
  const fallback = layout(env, { dataDirOverride: null });
  assert.equal(fallback.location, 'repo-kb');
  assert.equal(fallback.dbPath, path.join(ROOT, 'kb', 'data.db'));
  const settled = layout({}, { dataDirOverride: DATA });
  assert.equal(settled.dbPath, path.join(DATA, 'data.db'));
});
