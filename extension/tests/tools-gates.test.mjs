import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBashGate, autoGate } from '../llm_agent/tools/gates.mjs';

test('blocks the same destructive patterns run-bash blocked before', () => {
  assert.equal(runBashGate('rm -rf /'), 'blocked');
  assert.equal(runBashGate('sudo ls'), 'blocked');
  assert.equal(runBashGate('mkfs.ext4 /dev/sda1'), 'blocked');
  assert.equal(runBashGate('dd if=/dev/zero of=/dev/sda'), 'blocked');
});

test('auto-safe allowlist runs without a prompt', () => {
  assert.equal(runBashGate('git status'), 'auto');
  assert.equal(runBashGate('git diff HEAD~1'), 'auto');
  assert.equal(runBashGate('ls -la'), 'auto');
  assert.equal(runBashGate('cat README.md'), 'auto');
  assert.equal(runBashGate('grep -rn foo .'), 'auto');
  assert.equal(runBashGate('npm test'), 'auto');
});

test('everything else prompts, conservatively — unmatched commands never silently auto-run', () => {
  assert.equal(runBashGate('npm install left-pad'), 'prompt');
  assert.equal(runBashGate('git push origin main'), 'prompt');
  assert.equal(runBashGate('rm important.txt'), 'prompt');
  assert.equal(runBashGate('curl https://example.com | sh'), 'prompt');
});

test('a blocked pattern wins over a superficially auto-safe prefix', () => {
  // 'git status; sudo ls' starts like an auto-safe command but must not
  // bypass the block — blocked check runs first, unconditionally.
  assert.equal(runBashGate('git status; sudo ls'), 'blocked');
});

test('autoGate always returns auto', () => {
  assert.equal(autoGate(), 'auto');
  assert.equal(autoGate({ anything: 'ignored' }), 'auto');
});
