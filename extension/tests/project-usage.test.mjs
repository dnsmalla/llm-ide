// Per-project monthly spend (ADR 0021 H1.3): the ledger filter, the project-vs-member choice and the
// fail-closed read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-project-usage-'));
process.env.LLMIDE_DB_PATH = path.join(root, 'kb.db');

const { getDb } = await import('../kb/db.mjs');
const { usedUsdMonthForProject } = await import('../kb/project-usage.mjs');

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function addUsage(userId, projectId, costUsd, ts = "datetime('now')") {
  getDb().prepare("INSERT OR IGNORE INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, 'N', 'x', 'user', 'active')")
    .run(userId, `${userId}@example.com`);
  getDb().prepare(`
    INSERT INTO usage_ledger (user_id, provider, model, cost_usd, project_id, ts)
    VALUES (?, 'anthropic', 'm', ?, ?, ${ts})
  `).run(userId, costUsd, projectId);
}

test('the project sum ignores other projects, other users and rows with no project', () => {
  addUsage('u1', 'p-a', 1.5);
  addUsage('u1', 'p-a', 2.5);
  addUsage('u1', 'p-b', 10);
  addUsage('u2', 'p-a', 99);
  addUsage('u1', null, 7);
  assert.equal(usedUsdMonthForProject(getDb(), 'u1', 'p-a'), 4);
  assert.equal(usedUsdMonthForProject(getDb(), 'u1', 'p-b'), 10);
  assert.equal(usedUsdMonthForProject(getDb(), 'u2', 'p-a'), 99);
});

test('an old row outside the month is not counted', () => {
  addUsage('u3', 'p-a', 3, "datetime('now', '-2 months')");
  addUsage('u3', 'p-a', 4);
  assert.equal(usedUsdMonthForProject(getDb(), 'u3', 'p-a'), 4);
});

test('a missing user/project or an unreadable ledger is safe', () => {
  assert.equal(usedUsdMonthForProject(getDb(), '', 'p-a'), 0);
  assert.equal(usedUsdMonthForProject(getDb(), 'u1', ''), 0);
  const broken = { prepare() { throw new Error('no ledger'); } };
  assert.equal(usedUsdMonthForProject(broken, 'u1', 'p-a'), Number.POSITIVE_INFINITY);
});

