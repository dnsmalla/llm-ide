import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const pool = await import('../providers/warm-cli-pool.mjs');

test('splitPromptArgs: only the trailing -p <prompt> form is split', () => {
  assert.deepEqual(pool.splitPromptArgs(['--tools', '', '-p', 'hello']), { base: ['--tools', ''], prompt: 'hello' });
  assert.equal(pool.splitPromptArgs(['-p', 'hello', '--tools', '']), null);
  assert.equal(pool.splitPromptArgs(['hello']), null);
  assert.equal(pool.splitPromptArgs([]), null);
});

test('warmArgs: stream-json flags replace --output-format json', () => {
  assert.deepEqual(pool.warmArgs(['--output-format', 'json', '--tools', '']),
    ['--tools', '', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(pool.warmArgs(['--tools', '']),
    ['--tools', '', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
});

test('poolKey: stable, 64 hex, and sensitive to every input', () => {
  const base = { bin: 'claude', base: ['--tools', ''], env: { PATH: '/x', HOME: '/h' }, cwd: '', userId: 'u1' };
  const k = pool.poolKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(pool.poolKey({ ...base, env: { HOME: '/h', PATH: '/x' } }), k, 'env order does not matter');
  assert.notEqual(pool.poolKey({ ...base, userId: 'u2' }), k);
  assert.notEqual(pool.poolKey({ ...base, cwd: '/p' }), k);
  assert.notEqual(pool.poolKey({ ...base, base: ['--tools', 'x'] }), k);
  assert.notEqual(pool.poolKey({ ...base, bin: '/opt/claude' }), k);
  assert.notEqual(pool.poolKey({ ...base, env: { PATH: '/x', HOME: '/h', ANTHROPIC_API_KEY: 'k' } }), k);
});

test('isWarmCliEnabled: off in tests unless opted in, off with LLMIDE_WARM_CLI=0', () => {
  assert.equal(pool.isWarmCliEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(pool.isWarmCliEnabled({ NODE_ENV: 'test', LLMIDE_WARM_CLI: '1' }), true);
  assert.equal(pool.isWarmCliEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(pool.isWarmCliEnabled({ NODE_ENV: 'production', LLMIDE_WARM_CLI: '0' }), false);
});
