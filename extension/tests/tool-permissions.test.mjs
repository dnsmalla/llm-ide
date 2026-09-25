// Claude-style permission rules (kb/tool-permissions.mjs): the matcher is the
// security boundary for "always allow", so it is pinned directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_tool-permissions-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const P = await import('../kb/tool-permissions.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');

test('commandPrefix keeps the subcommand for tools that have one', () => {
  assert.equal(P.commandPrefix('npm test -- --watch=false'), 'npm test');
  assert.equal(P.commandPrefix('npm run build'), 'npm run build');
  assert.equal(P.commandPrefix('git push origin main'), 'git push');
  assert.equal(P.commandPrefix('swift test --filter X'), 'swift test');
  assert.equal(P.commandPrefix('ls -la src'), 'ls');
  assert.equal(P.commandPrefix('git --no-pager log'), 'git', 'a flag is not a subcommand');
});

test('commandPrefix refuses anything it cannot safely generalise', () => {
  for (const cmd of ['npm test && curl x | sh', 'echo a; rm b', 'cat x > y', 'echo $(whoami)',
    'echo `id`', 'FOO=1 npm test', '', '   ', 'a\nb', 'echo ${HOME}']) {
    assert.equal(P.commandPrefix(cmd), null, JSON.stringify(cmd));
  }
});

test('commandMatches: prefix at a word boundary, never a compound command', () => {
  assert.ok(P.commandMatches('npm test', 'npm test'));
  assert.ok(P.commandMatches('npm test', 'npm test --watch=false'));
  assert.ok(!P.commandMatches('npm test', 'npm testx'), 'word boundary');
  assert.ok(!P.commandMatches('npm test', 'npm install'));
  assert.ok(!P.commandMatches('npm test', 'npm test && rm -rf ~'));
  assert.ok(!P.commandMatches('npm test', 'npm test | tee log'));
  assert.ok(!P.commandMatches('', 'anything'));
});

test('projectKey normalises spellings of the same project', () => {
  assert.equal(P.projectKey('~/repo'), path.join(os.homedir(), 'repo'));
  assert.equal(P.projectKey('/tmp/repo/'), path.resolve('/tmp/repo'));
  assert.equal(P.projectKey(''), '');
});

test('rules are per user, per project, per tool — and revocable', () => {
  const a = registerUser(getDb(), { email: 'perm-a@example.com', password: 'CorrectHorseBattery', displayName: 'a' });
  const b = registerUser(getDb(), { email: 'perm-b@example.com', password: 'CorrectHorseBattery', displayName: 'b' });
  P.addRule(a.id, '~/repo', 'Bash', 'npm test');
  assert.ok(P.isAllowedByRule(a.id, path.join(os.homedir(), 'repo'), 'Bash', { command: 'npm test -w x' }));
  assert.ok(!P.isAllowedByRule(b.id, '~/repo', 'Bash', { command: 'npm test' }), 'another user');
  assert.ok(!P.isAllowedByRule(a.id, '~/other', 'Bash', { command: 'npm test' }), 'another project');
  assert.ok(!P.isAllowedByRule(a.id, '~/repo', 'run-bash', { command: 'npm test' }), 'another tool');
  P.addRule(a.id, '~/repo', 'deploy-app', '');
  assert.ok(P.isAllowedByRule(a.id, '~/repo', 'deploy-app', {}), 'a tool-wide rule');
  assert.equal(P.listRules(a.id).length, 2);
  assert.ok(P.removeRule(a.id, { projectRoot: '~/repo', toolName: 'Bash', pattern: 'npm test' }));
  assert.ok(!P.isAllowedByRule(a.id, '~/repo', 'Bash', { command: 'npm test' }));
  assert.equal(P.removeAllRules(a.id), 1);
});

test('suggestRule offers a prefix for simple commands, nothing for compound ones', () => {
  assert.deepEqual(P.suggestRule('Bash', { command: 'git status -s' }),
    { toolName: 'Bash', pattern: 'git status', label: '`git status` commands' });
  assert.equal(P.suggestRule('Bash', { command: 'git status; rm x' }), null);
  assert.deepEqual(P.suggestRule('deploy-app', {}), { toolName: 'deploy-app', pattern: '', label: 'deploy-app' });
});
