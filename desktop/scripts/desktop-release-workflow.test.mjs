// desktop/scripts/desktop-release-workflow.test.mjs
// Text asserts on the desktop release workflows (house pattern: extension/tests/scripts-build-number.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WF = join(import.meta.dirname, '..', '..', '.github', 'workflows');
const rel = () => readFileSync(join(WF, 'desktop-release.yml'), 'utf8');

test('dry run: manual dispatch with a signed input defaulting to false', () => {
  const wf = rel();
  assert.match(wf, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+signed:/);
  assert.match(wf, /default: false/);
});

test('the bundle matrix covers four targets and stages each on a native runner', () => {
  const wf = rel();
  for (const t of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']) assert.match(wf, new RegExp(`target: ${t}`));
  assert.match(wf, /LLMIDE_STAGE_RELEASE: '1'/);
  assert.doesNotMatch(wf, /LLMIDE_STAGE_ALLOW_SDK_BINARY/);
});

test('the frontend build has what desktop-ci gives it', () => {
  const wf = rel();
  assert.match(wf, /git submodule update --init mac\/LocalPackages\/graph-kit/);
  for (const d of ['ui/kit', 'web', 'mac/LocalPackages/graph-kit/web']) assert.match(wf, new RegExp(`npm ci --prefix ${d.replaceAll('/', '\\/')}`));
});

test('every bundle is collected, re-checked for the SDK claude binary and smoked as a packaged app', () => {
  const wf = rel();
  assert.match(wf, /collect-release\.mjs --target \$\{\{ matrix\.target \}\}/);
  assert.match(wf, /smoke-app\.mjs/);
  assert.match(wf, /xvfb-run/);
  assert.match(wf, /verify-bundle\.mjs/);
});

test('permissions default to read; nothing but publish can write', () => {
  const wf = rel();
  assert.match(wf, /^permissions:\s*\n\s+contents: read/m);
});

test('the Windows step re-checks the installed core for the SDK binary before smoke-app', () => {
  const wf = rel();
  const i = wf.indexOf('verify-installed-core.mjs');
  assert.ok(i > 0);
  assert.ok(i < wf.indexOf('smoke-app.mjs', wf.indexOf('(Windows)')));
});
