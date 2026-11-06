// desktop/scripts/smoke-app.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHostCore, coreProcesses, coreProcessesWin, CORE_PORTS } from './smoke-app.mjs';

const NONCE = 'a'.repeat(64);
test('probes the same ports the host spawns on, :3456 first', () => {
  assert.deepEqual(CORE_PORTS, [3456, 3457, 3458, 3459]);
});

test('only a 200 /health with a 64-hex launch nonce is the app-spawned core', () => {
  assert.equal(isHostCore(200, { 'x-llmide-nonce': NONCE }), true);
  assert.equal(isHostCore(200, {}), false);
  assert.equal(isHostCore(200, { 'x-llmide-nonce': 'short' }), false);
  assert.equal(isHostCore(503, { 'x-llmide-nonce': NONCE }), false);
  assert.equal(isHostCore(200, new Headers({ 'x-llmide-nonce': NONCE })), true);
});

test('unix ps: the bundled node running server.mjs, nothing else', () => {
  const ps = [
    '  101 /Applications/LLM-IDE.app/Contents/Resources/core/node/node /Applications/LLM-IDE.app/Contents/Resources/core/root/extension/server.mjs',
    '  102 /usr/local/bin/node server.mjs',
    '  103 /tmp/.mount_LLMxyz/usr/lib/LLM-IDE/core/node/node /tmp/.mount_LLMxyz/usr/lib/LLM-IDE/core/root/extension/server.mjs',
    '  104 /Applications/LLM-IDE.app/Contents/Resources/core/node/node --version',
  ].join('\n');
  assert.deepEqual(coreProcesses(ps), [101, 103]);
});

test('windows: CommandLine with \\core\\node\\node.exe and server.mjs', () => {
  const json = JSON.stringify([
    { ProcessId: 7, CommandLine: '"C:\\Users\\r\\AppData\\Local\\LLM-IDE\\core\\node\\node.exe" "C:\\Users\\r\\AppData\\Local\\LLM-IDE\\core\\root\\extension\\server.mjs"' },
    { ProcessId: 8, CommandLine: 'node.exe server.mjs' },
    { ProcessId: 9, CommandLine: null },
  ]);
  assert.deepEqual(coreProcessesWin(json), [7]);
  assert.deepEqual(coreProcessesWin(JSON.stringify({ ProcessId: 7, CommandLine: 'x\\core\\node\\node.exe y\\server.mjs' })), [7]);
  assert.deepEqual(coreProcessesWin(''), []);
});
