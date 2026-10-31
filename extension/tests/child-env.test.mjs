// Helper children (git/npm/skills scripts) must not inherit the server's secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scrubbedChildEnv } from '../core/child-env.mjs';

const SRC = { PATH: '/usr/bin', HOME: '/h', HTTPS_PROXY: 'http://p', LANG: 'C',
  LLMIDE_JWT_SECRET: 's', LLMIDE_VAULT_KEY: 'v', MEETNOTES_X: '1',
  ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', OPENAI_API_KEY: 'o' };

test('secrets and provider keys are dropped, PATH/HOME/proxy kept', () => {
  const env = scrubbedChildEnv({ GIT_TERMINAL_PROMPT: '0' }, SRC);
  for (const k of ['LLMIDE_JWT_SECRET', 'LLMIDE_VAULT_KEY', 'MEETNOTES_X', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) {
    assert.equal(k in env, false, k);
  }
  assert.equal(env.PATH, '/usr/bin'); assert.equal(env.HOME, '/h');
  assert.equal(env.HTTPS_PROXY, 'http://p'); assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(SRC.LLMIDE_JWT_SECRET, 's', 'source untouched');
});

test('a real child sees no server secrets', () => {
  process.env.LLMIDE_JWT_SECRET = 'leak-me'; process.env.ANTHROPIC_API_KEY = 'leak-me';
  const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'],
    { env: scrubbedChildEnv() });
  const keys = JSON.parse(out);
  assert.ok(!keys.includes('LLMIDE_JWT_SECRET') && !keys.includes('ANTHROPIC_API_KEY'));
});

test('the git/npm/skills spawn sites use the scrubbed env, never process.env', () => {
  for (const f of ['../llm-sources/registry.mjs', '../kb/install-project-skills.mjs', '../llm_agent/sdk/updater.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/\.\.\.process\.env|env:\s*process\.env/.test(src), `${f} passes process.env to a child`);
    assert.ok(src.includes('scrubbedChildEnv'), f);
  }
});
