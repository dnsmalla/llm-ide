// A test that forgets to set LLMIDE_DB_PATH must never open the live
// repo-root kb/data.db. One did (agent-global-internal: handleCodeAssist as
// `user-1`): every full `npm test` wrote a turn_tool_events row into the live
// DB, and its first getDb() applied pending migrations to it — a second
// writer process on the database the server owns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.resolve(EXT, '..', 'kb', 'data.db');

function dbPathWith(env) {
  const clean = { ...process.env, LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48) };
  delete clean.LLMIDE_DB_PATH;
  delete clean.NODE_TEST_CONTEXT;
  return execFileSync(process.execPath, ['--input-type=module', '-e',
    "const { config } = await import('./core/config.mjs'); process.stdout.write(config.dbPath);"],
  { cwd: EXT, env: { ...clean, ...env }, encoding: 'utf8' });
}

test('under the test runner, an unset LLMIDE_DB_PATH resolves to a temp DB, never the live one', () => {
  const p = dbPathWith({ NODE_TEST_CONTEXT: 'child-v8' });
  assert.notEqual(path.resolve(p), LIVE);
  assert.ok(path.resolve(p).startsWith(path.resolve(os.tmpdir())), `expected a tmpdir path, got ${p}`);
});

test('outside the test runner the default is still the repo-root kb/data.db', () => {
  assert.equal(path.resolve(dbPathWith({})), LIVE);
});

test('an explicit LLMIDE_DB_PATH always wins', () => {
  const want = path.join(os.tmpdir(), 'explicit-choice.db');
  assert.equal(dbPathWith({ NODE_TEST_CONTEXT: 'child-v8', LLMIDE_DB_PATH: want }), want);
});
