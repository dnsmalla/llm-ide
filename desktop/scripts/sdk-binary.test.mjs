import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeSdkBinaryPackages, verifyNoSdkBinary } from './sdk-binary.mjs';

function fakeCore(withBinary) {
  const core = mkdtempSync(join(tmpdir(), 'llmide-sdkbin-'));
  const nm = join(core, 'root', 'extension', 'node_modules', '@anthropic-ai');
  mkdirSync(join(nm, 'claude-agent-sdk'), { recursive: true });
  writeFileSync(join(nm, 'claude-agent-sdk', 'index.js'), '');
  if (withBinary) {
    mkdirSync(join(nm, 'claude-agent-sdk-darwin-arm64'), { recursive: true });
    writeFileSync(join(nm, 'claude-agent-sdk-darwin-arm64', 'claude'), '');
  }
  return { core, nm: join(core, 'root', 'extension', 'node_modules') };
}

test('verify flags a staged SDK platform package and its binary', () => {
  const { core } = fakeCore(true);
  const problems = verifyNoSdkBinary(core);
  assert.equal(problems.length, 2);
});

test('removal clears the platform package but keeps the SDK itself', () => {
  const { core, nm } = fakeCore(true);
  const removed = removeSdkBinaryPackages(nm);
  assert.equal(removed.length, 1);
  assert.deepEqual(verifyNoSdkBinary(core), []);
});

test('a clean core passes', () => assert.deepEqual(verifyNoSdkBinary(fakeCore(false).core), []));
