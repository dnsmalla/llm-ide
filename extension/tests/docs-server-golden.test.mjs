// docs-kit K1b: the Node side of the server/Swift parity golden. The Swift
// test DocGenServerStoreParityTests decodes the same file, so this test fails
// when the checked-in golden is stale. Regenerate with
// `node scripts/docs-kit-parity-golden.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GOLDEN_PATH, buildGolden, goldenText } from '../../scripts/docs-kit-parity-golden.mjs';

test('the checked-in server-scan golden matches the Node scan of the K1a fixtures', () => {
  assert.equal(fs.readFileSync(GOLDEN_PATH, 'utf8'), goldenText(),
    'stale golden: run `node scripts/docs-kit-parity-golden.mjs`');
});

test('the golden lists the two templates in name order and skips auto_task', () => {
  const { templates, commands } = buildGolden();
  // "Retro" sorts before "Sprint Review"; the auto_task folder is not listed.
  assert.deepEqual(templates.templates.map((t) => t.folderName), ['v0-bare', 'v2-visual']);
  assert.equal(templates.count, 2);
  assert.equal(templates.truncated, false);
  assert.equal(commands.count, 1);
  assert.equal(commands.commands[0].folderName, 'v0-bare');
  assert.equal(commands.commands[0].surface, 'doc');
});
