import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

// runClaude's CLI fallback calls spawnCli('anthropic', prompt, { args, ... }).
// We capture the argsOverride by mocking spawnCli via the providers module's
// exported indirection. providers.mjs calls execFile directly inside spawnCli,
// so instead we unit-test the integration at the seam runClaude already has:
// it imports spawnCli from providers.mjs. Use node:test mock.method on the
// module namespace is NOT supported (non-configurable), so we assert behavior
// through buildAnthropicCliArgs (Task 4) + a structural check that runClaude
// threads mcpConfig into spawnCli's `args`.
//
// This test therefore documents the contract: read the source and confirm
// runClaude's spawnCli call uses buildAnthropicCliArgs(prompt, mcpConfig).
test('runClaude threads mcpConfig into the spawnCli argsOverride (source-level contract)', () => {
  const src = readFileSync(join(__dirname, '..', 'providers', 'runtime.mjs'), 'utf8');
  assert.match(src, /buildAnthropicCliArgs/, 'runtime.mjs must import + use buildAnthropicCliArgs');
  assert.match(src, /mcpConfig/, 'runClaude must accept an mcpConfig option');
  assert.match(src, /args:\s*buildAnthropicCliArgs\(prompt,\s*mcpConfig\)/,
    'the spawnCli CLI-fallback call must pass args: buildAnthropicCliArgs(prompt, mcpConfig)');
});
