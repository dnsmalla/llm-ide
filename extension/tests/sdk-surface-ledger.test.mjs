// The SDK adoption gate: every top-level surface item of the INSTALLED Claude
// Agent SDK must be classified in llm_agent/sdk/sdk-surface.json. A bump that
// adds or removes one turns this red until someone (or the sdk-adoption loop)
// decides adopted / ignored / needs-human.
//
// The ledger's `sdkVersion` is informational only (the last version the
// ledger was reviewed against). It is deliberately NOT checked against the
// installed SDK: a bump that adds no top-level surface would turn the gate red
// with nothing to classify, and tests/dependency-pins.test.mjs already ties
// the package.json pin to the installed version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSurface, diffSurface } from '../scripts/sdk-surface.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'llm_agent/sdk/sdk-surface.json'), 'utf8'));
const surface = extractSurface(path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk'));

test('every installed SDK surface item is classified, and none is stale', () => {
  const { added, removed } = diffSurface(surface.items, ledger);
  assert.deepEqual({ added, removed }, { added: [], removed: [] },
    'run the sdk-adoption loop, or classify by hand — docs/explanation/claude-linker.md "Adopt"');
});

test('every entry has a valid status, and non-adopted entries say why', () => {
  for (const [key, e] of Object.entries(ledger.items)) {
    assert.ok(['adopted', 'ignored', 'needs-human'].includes(e.status), `${key}: bad status ${e.status}`);
    if (e.status !== 'adopted') assert.ok(e.reason?.trim(), `${key}: ${e.status} needs a reason`);
  }
});

test('every adopted entry names the file that uses it', () => {
  for (const [key, e] of Object.entries(ledger.items)) {
    if (e.status === 'adopted') assert.ok(e.where?.trim(), `${key}: adopted needs a where`);
  }
});
