// desktop/scripts/stage-hub-core.test.mjs
// Tests for where the staged hub bundle is written by default. The staging run itself downloads hundreds of MB,
// so these tests cover only the output-folder resolution the script uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { HUB_OUT_FOLDER, resolveHubOut } from './hub-out.mjs';

const DESKTOP = '/repo/desktop';

test('the default output is desktop/hub-dist, not Vite\'s desktop/dist', () => {
  assert.equal(HUB_OUT_FOLDER, 'hub-dist');
  assert.equal(resolveHubOut([], DESKTOP), join(DESKTOP, 'hub-dist'));
  assert.equal(resolveHubOut(['--version', '1.2.3'], DESKTOP), join(DESKTOP, 'hub-dist'));
});

test('--out still overrides the default', () => {
  assert.equal(resolveHubOut(['--out', '/srv/bundles'], DESKTOP), '/srv/bundles');
  assert.equal(resolveHubOut(['--compat-sqlite', '/x/module.node', '--out', '/srv/out'], DESKTOP), '/srv/out');
});

test('a --out without a value, or followed by another flag, falls back to the default', () => {
  assert.equal(resolveHubOut(['--out'], DESKTOP), join(DESKTOP, 'hub-dist'));
  assert.equal(resolveHubOut(['--out', '--version', '1.2.3'], DESKTOP), join(DESKTOP, 'hub-dist'));
});
