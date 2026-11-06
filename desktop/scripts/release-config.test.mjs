// desktop/scripts/release-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseConfig, windowsSignArgs } from './release-config.mjs';

const W = { signtool: 'C:\\sdk\\x64\\signtool.exe', dlib: 'C:\\as\\bin\\x64\\Azure.CodeSigning.Dlib.dll', metadata: 'C:\\t\\metadata.json' };

test('empty overlay when nothing is asked', () => {
  assert.deepEqual(releaseConfig({}), {});
});

test('windows signCommand: object form, SHA-256, Microsoft timestamp, dlib + metadata, %1 last', () => {
  const c = releaseConfig({ windowsSign: W });
  const sc = c.bundle.windows.signCommand;
  assert.equal(sc.cmd, W.signtool);
  assert.deepEqual(sc.args, ['sign', ...windowsSignArgs(W), '%1']);
  assert.deepEqual(windowsSignArgs(W), ['/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256', '/dlib', W.dlib, '/dmdf', W.metadata]);
});

test('missing windows inputs throw instead of producing an unsigned config', () => {
  assert.throws(() => releaseConfig({ windowsSign: { ...W, dlib: '' } }), /dlib/);
});
