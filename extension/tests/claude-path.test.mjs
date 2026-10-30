import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveClaudeExecutable, requireClaudeExecutable, invalidateClaudePath,
  validateClaudeExecutable, ClaudeNotFoundError, CLAUDE_NOT_FOUND,
} from '../providers/claude-path.mjs';
import { formatCliSpawnError } from '../providers/providers.mjs';

const KEYS = ['PATH', 'HOME', 'LLMIDE_CLAUDE_PATH', 'LLMIDE_CLAUDE_BIN_DISABLED'];
let saved; let tmp;

function fake(dir, { name = 'claude', body = 'echo "2.0.0 (Claude Code)"', mode = 0o755 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode });
  fs.chmodSync(f, mode);
  return f;
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-path-')));
  fs.chmodSync(tmp, 0o755);
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  delete process.env.LLMIDE_CLAUDE_PATH;
  delete process.env.LLMIDE_CLAUDE_BIN_DISABLED;
  invalidateClaudePath();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  invalidateClaudePath();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('env override wins and is validated', { skip: process.platform === 'win32' }, () => {
  const f = fake(path.join(tmp, 'x'));
  process.env.LLMIDE_CLAUDE_PATH = f;
  process.env.PATH = '';
  assert.deepEqual(resolveClaudeExecutable({ purpose: 'sdk' }).path, f);
  assert.equal(resolveClaudeExecutable({ purpose: 'sdk' }).source, 'env');
});

test('a broken env override does not fall through to PATH', { skip: process.platform === 'win32' }, () => {
  const good = fake(path.join(tmp, 'bin'));
  process.env.PATH = path.dirname(good);
  process.env.LLMIDE_CLAUDE_PATH = path.join(tmp, 'nope');
  assert.equal(resolveClaudeExecutable({ purpose: 'cli' }).path, null);
});

test('PATH search finds an installed claude (cli purpose)', { skip: process.platform === 'win32' }, () => {
  const f = fake(path.join(tmp, 'bin'));
  process.env.PATH = path.dirname(f);
  const r = resolveClaudeExecutable({ purpose: 'cli' });
  assert.equal(r.path, f);
  assert.equal(r.source, 'installed');
});

test('well-known location under HOME is searched', { skip: process.platform === 'win32' }, () => {
  const f = fake(path.join(process.env.HOME, '.local', 'bin'));
  process.env.PATH = path.join(tmp, 'empty');
  assert.equal(resolveClaudeExecutable({ purpose: 'cli' }).path, f);
});

test('candidates failing --version, non-executable, or in a world-writable dir are rejected', { skip: process.platform === 'win32' }, () => {
  const bad = fake(path.join(tmp, 'b1'), { body: 'exit 1' });
  const noexec = fake(path.join(tmp, 'b2'), { mode: 0o644 });
  const ww = fake(path.join(tmp, 'b3'));
  fs.chmodSync(path.dirname(ww), 0o777);
  assert.equal(validateClaudeExecutable(bad), false);
  assert.equal(validateClaudeExecutable(noexec), false);
  assert.equal(validateClaudeExecutable(ww), false);
  assert.equal(validateClaudeExecutable(path.join(tmp, 'missing')), false);
  assert.equal(validateClaudeExecutable('claude'), false); // relative never accepted
});

test('a hanging --version is cut off by the timeout', { skip: process.platform === 'win32', timeout: 10_000 }, () => {
  const slow = fake(path.join(tmp, 'slow'), { body: 'sleep 30' });
  const t0 = Date.now();
  assert.equal(validateClaudeExecutable(slow), false);
  assert.ok(Date.now() - t0 < 6000);
});

test('unresolved: requireClaudeExecutable throws typed error with the install message', () => {
  process.env.PATH = path.join(tmp, 'empty');
  process.env.LLMIDE_CLAUDE_BIN_DISABLED = '1';
  assert.throws(() => requireClaudeExecutable({ purpose: 'cli' }), (e) => {
    assert.ok(e instanceof ClaudeNotFoundError);
    assert.equal(e.code, CLAUDE_NOT_FOUND);
    assert.match(e.message, /Install Claude Code/);
    assert.match(e.message, /claude login/);
    return true;
  });
});

test('memoised, and re-resolved after invalidate (failure TTL does not stick)', { skip: process.platform === 'win32' }, () => {
  process.env.PATH = path.join(tmp, 'late');
  process.env.LLMIDE_CLAUDE_BIN_DISABLED = '1';
  assert.equal(resolveClaudeExecutable({ purpose: 'cli' }).path, null);
  delete process.env.LLMIDE_CLAUDE_BIN_DISABLED;
  const f = fake(path.join(tmp, 'late'));
  invalidateClaudePath();
  assert.equal(resolveClaudeExecutable({ purpose: 'cli' }).path, f);
  fs.rmSync(f); // memoised: still the old answer within the TTL
  assert.equal(resolveClaudeExecutable({ purpose: 'cli' }).path, f);
  invalidateClaudePath();
  assert.notEqual(resolveClaudeExecutable({ purpose: 'cli' }).path, f);
});

test('formatCliSpawnError names the install step and never echoes a resolved path', () => {
  const msg = formatCliSpawnError(Object.assign(new Error('x'), { code: 'ENOENT' }), { bin: '/opt/secret/dir/claude' });
  assert.match(msg, /Install Claude Code/);
  assert.doesNotMatch(msg, /secret/);
});
