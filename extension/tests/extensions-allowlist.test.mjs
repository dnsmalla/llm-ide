// Per-user install allowlist: merge with the operator list, the ceiling, validation, per-user isolation,
// and the install gate. Fixtures only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_extensions-allowlist-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
delete process.env.LLMIDE_EXT_ALLOWED_SOURCES;
delete process.env.LLMIDE_EXT_ALLOWED_SOURCES_CEILING;

const main = await import('../kb/db.mjs');
const al = await import('../llm_agent/extensions/allowlist.mjs');
const users = await import('../server/users.mjs');
const mk = (e) => users.registerUser(main.getDb(), { email: e, password: 'CorrectHorseBattery', displayName: e }).id;
const A = mk('al-a@example.test');
const B = mk('al-b@example.test');
const withEnv = (vars, fn) => {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
test.after(() => { main.closeDb(); for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true }); });

test('default: operator list only; a user addition adds one repo for that user only', () => {
  assert.equal(al.sourceAllowedFor(A, 'acme', 'tools'), false);
  const v = al.setAllowlist(A, ['Acme/Tools']);
  assert.deepEqual(v.user, ['acme/tools']);
  assert.deepEqual(v.effective, ['anthropics/*', 'modelcontextprotocol/*', 'acme/tools']);
  assert.equal(al.sourceAllowedFor(A, 'acme', 'tools'), true);
  assert.equal(al.sourceAllowedFor(A, 'ACME', 'Tools'), true, 'case-insensitive');
  assert.equal(al.sourceAllowedFor(A, 'acme', 'other'), false);
  assert.equal(al.sourceAllowedFor(B, 'acme', 'tools'), false, 'per user');
  assert.equal(al.sourceAllowedFor(B, 'anthropics', 'skills'), true, 'operator list still applies to everyone');
});

test('owner/* is allowed; owner wildcards and other globs need the operator ceiling', () => {
  assert.deepEqual(al.validateUserSources(['acme/*', 'https://github.com/Foo/Bar.git']), ['acme/*', 'foo/bar']);
  for (const bad of ['*/*', '*/repo', 'ac*/x', 'a*/*', 'acme/to*ls']) {
    assert.throws(() => al.validateUserSources([bad]), (e) => e.code === 'source_exceeds_ceiling', bad);
  }
});

test('malformed entries, non-arrays and too many entries are refused', () => {
  for (const bad of ['', 'owner', 'a/b/c', '/x', 'a b/c', 5, null]) {
    assert.throws(() => al.validateUserSources([bad]), (e) => e.code === 'invalid_source', String(bad));
  }
  assert.throws(() => al.validateUserSources('acme/x'), (e) => e.code === 'invalid_source');
  assert.throws(() => al.validateUserSources(Array.from({ length: 51 }, (_, i) => `o${i}/r`)), (e) => e.code === 'too_many_sources');
  assert.equal(al.validateUserSources([]).length, 0);
  assert.deepEqual(al.validateUserSources(['a/b', 'A/B']), ['a/b'], 'duplicates collapse');
});

test('ceiling: users may only add what the ceiling covers; wildcards inside it are allowed', () => {
  withEnv({ LLMIDE_EXT_ALLOWED_SOURCES_CEILING: 'acme/*,obra/superpowers' }, () => {
    assert.deepEqual(al.validateUserSources(['acme/x', 'acme/*', 'obra/superpowers']), ['acme/x', 'acme/*', 'obra/superpowers']);
    assert.throws(() => al.validateUserSources(['evil/x']), (e) => e.code === 'source_exceeds_ceiling' && e.extra.entry === 'evil/x');
    assert.throws(() => al.validateUserSources(['obra/*']), (e) => e.code === 'source_exceeds_ceiling');
    assert.throws(() => al.validateUserSources(['*/*']), (e) => e.code === 'source_exceeds_ceiling');
  });
  withEnv({ LLMIDE_EXT_ALLOWED_SOURCES_CEILING: '*/*' }, () => {
    assert.deepEqual(al.validateUserSources(['*/*']), ['*/*']);
    al.setAllowlist(B, ['*/*']);
    assert.equal(al.sourceAllowedFor(B, 'anyone', 'anything'), true);
  });
});

test('tightening the ceiling later takes effect on read: earlier entries are ignored, not deleted', () => {
  withEnv({ LLMIDE_EXT_ALLOWED_SOURCES_CEILING: '*/*' }, () => al.setAllowlist(A, ['zed/tool', '*/*']));
  withEnv({ LLMIDE_EXT_ALLOWED_SOURCES_CEILING: 'zed/*' }, () => {
    assert.equal(al.sourceAllowedFor(A, 'zed', 'tool'), true);
    assert.equal(al.sourceAllowedFor(A, 'other', 'thing'), false);
    const v = al.allowlistView(A);
    assert.deepEqual(v.ignored, ['*/*']);
    assert.deepEqual(v.user, ['zed/tool', '*/*']);
    assert.ok(!v.effective.includes('*/*'));
  });
});

test('an empty replacement clears the user list; the operator list is untouched', () => {
  al.setAllowlist(A, ['acme/tools']);
  const v = al.setAllowlist(A, []);
  assert.deepEqual(v.user, []);
  assert.equal(al.sourceAllowedFor(A, 'acme', 'tools'), false);
  assert.equal(al.sourceAllowedFor(A, 'anthropics', 'x'), true);
});

test('operator wildcard still wins for everyone', () => {
  withEnv({ LLMIDE_EXT_ALLOWED_SOURCES: '*/*' }, () => assert.equal(al.sourceAllowedFor(B, 'any', 'thing'), true));
});

test('user delete cascades the allowlist row', () => {
  const U = mk('al-del@example.test');
  al.setAllowlist(U, ['a/b']);
  main.getDb().prepare('DELETE FROM users WHERE id = ?').run(U);
  assert.equal(main.getDb().prepare('SELECT COUNT(*) AS n FROM ext_source_allowlist WHERE user_id = ?').get(U).n, 0);
});

test('LOW: normalizeEntry strips the trailing slash before .git', async () => {
  const { normalizeEntry } = await import('../llm_agent/extensions/allowlist.mjs');
  for (const raw of ['x/y.git/', 'X/Y.git', 'https://github.com/x/y.git/', 'github.com/x/y//', ' x/y ']) assert.equal(normalizeEntry(raw), 'x/y', raw);
});
