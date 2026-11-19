import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validGitPluginUrl, validGitPluginRef } from '../plugins/git-install.mjs';

test('git plugin URLs: public https/scp only, no credentials, query, local or private hosts', () => {
  for (const ok of ['https://github.com/owner/repo', 'https://gitlab.com/a/b.git', 'git@github.com:owner/repo.git']) {
    assert.equal(validGitPluginUrl(ok), true, ok);
  }
  for (const bad of ['http://github.com/a/b', 'https://user:pass@github.com/a/b', 'https://github.com/a/b?x=1', 'https://127.0.0.1/a/b', 'https://localhost/a', 'git@localhost:a/b', 'git@192.168.1.2:a/b', 'not a url', '']) {
    assert.equal(validGitPluginUrl(bad), false, bad);
  }
});

test('git plugin refs: safe branch/tag names only', () => {
  assert.equal(validGitPluginRef('main'), true);
  assert.equal(validGitPluginRef('v1.2.3'), true);
  assert.equal(validGitPluginRef('feature/x'), true);
  assert.equal(validGitPluginRef(null), true);
  for (const bad of ['--upload-pack=evil', 'a b', '..', 'a;b']) assert.equal(validGitPluginRef(bad), false, bad);
});

test('the clone never sees the core\'s secrets', async () => {
  const { clonePluginZip } = await import('../plugins/git-install.mjs');
  process.env.LLMIDE_JWT_SECRET = 'jwt-secret-value';
  process.env.LLMIDE_VAULT_KEY = 'vault-key-value';
  let seen = null;
  const runCommand = async (cmd, args, opts) => { if (cmd === 'git' && args[0] === 'clone') { seen = opts.env; throw new Error('stop after the clone call'); } return { stdout: '' }; };
  await assert.rejects(clonePluginZip({ url: 'https://github.com/owner/repo', ref: null, runCommand }));
  assert.ok(seen, 'the clone was attempted');
  assert.equal(seen.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!Object.keys(seen).some((k) => k.startsWith('LLMIDE_')), 'no LLMIDE_* variable reaches git');
  assert.ok(seen.PATH, 'git still gets PATH');
});
