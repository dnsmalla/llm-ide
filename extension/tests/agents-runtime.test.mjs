// Tests for agents/runtime.mjs — specifically the "user-scoped key
// must not silently fall back to the operator CLI on HTTP failure"
// guarantee.  Without it, a 401 from a user's own Anthropic key
// would cause runClaude to spawn `claude -p ...` under the operator's
// CLI auth, charging the wrong account and bypassing the user's
// quota/rate-limits.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.MEETNOTES_JWT_SECRET = 'a'.repeat(48);
process.env.MEETNOTES_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agents-runtime-test.db');
process.env.MEETNOTES_DB_PATH = tmpDb;

// Make sure nothing falls back to a real operator CLI accidentally.
delete process.env.ANTHROPIC_API_KEY;

const db = await import('../kb/db.mjs');
const vault = await import('../server/vault.mjs');
const users = await import('../server/users.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

// Spy on child_process.execFile so a leak — runClaude falling back to
// the operator CLI — fails the test loudly.
import childProcess from 'node:child_process';

test('runClaude does NOT fall back to operator CLI when user-scoped key returns 401', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `runtime-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'r',
  });
  vault.setSecret(db.getDb(), u.id, 'claude.apiKey', 'sk-user-scoped-xyz');

  // Force a 401 from the Anthropic API.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() { return '{"error":"unauthorized"}'; },
  });
  const execSpy = mock.method(childProcess, 'execFile', () => {
    throw new Error('execFile MUST NOT be called when user-scoped key fails');
  });

  // Re-import runtime to pick up the spied execFile (it captures the
  // import binding at evaluation time, so it should already see
  // childProcess.execFile via the module reference).
  const { runClaude } = await import('../agents/runtime.mjs');

  try {
    await assert.rejects(
      () => runClaude('hello', { userId: u.id }),
      /401|user-scoped/i,
    );
    assert.equal(execSpy.mock.callCount(), 0,
      'execFile must not be invoked when a user-scoped key was used');
  } finally {
    globalThis.fetch = originalFetch;
    execSpy.mock.restore();
  }
});
