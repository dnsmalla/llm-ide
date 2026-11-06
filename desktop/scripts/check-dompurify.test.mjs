import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, MIN_SAFE } from './check-dompurify.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const good = () => ({
  pkg: { dependencies: { dompurify: MIN_SAFE }, overrides: { dompurify: MIN_SAFE } },
  lock: { packages: { 'node_modules/dompurify': { version: MIN_SAFE } } },
});

test('pinned safe version passes', () => assert.deepEqual(check(good()), []));
test('range or old version fails', () => {
  const a = good(); a.pkg.dependencies.dompurify = '^3.4.17';
  assert.ok(check(a).length);
  const b = good(); b.pkg.dependencies.dompurify = '3.4.16'; b.pkg.overrides.dompurify = '3.4.16';
  assert.ok(check(b).some((p) => p.includes('<')));
});
test('missing override fails', () => {
  const a = good(); delete a.pkg.overrides;
  assert.ok(check(a).length);
});
test('nested vulnerable copy in the lock fails', () => {
  const a = good(); a.lock.packages['node_modules/monaco-editor/node_modules/dompurify'] = { version: '3.4.15' };
  assert.ok(check(a).some((p) => p.includes('3.4.15')));
});
test('dist embedding the vendored version fails', () => {
  const a = { ...good(), vendoredVersion: '3.4.15', distTexts: [`x="${MIN_SAFE}"; /*! DOMPurify 3.4.15 */`] };
  assert.ok(check(a).some((p) => p.includes('vendored')));
});
test('dist without the pinned version fails; with it passes', () => {
  assert.ok(check({ ...good(), distTexts: ['nothing'] }).length);
  assert.deepEqual(check({ ...good(), vendoredVersion: '3.4.15', distTexts: [`v="${MIN_SAFE}"`] }), []);
});

test('run as a script from a path with a space: the main guard still runs', () => {
  const d = mkdtempSync(join(tmpdir(), 'dompurify main '));
  mkdirSync(join(d, 'scripts'));
  writeFileSync(join(d, 'scripts', 'check-dompurify.mjs'), readFileSync(join(HERE, 'check-dompurify.mjs')));
  // Its root is the folder above scripts/, which has no package.json here, so a run fails loudly; a skipped run exits 0.
  const r = spawnSync(process.execPath, [join(d, 'scripts', 'check-dompurify.mjs'), join(d, 'missing.app')], { encoding: 'utf8' });
  rmSync(d, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /package\.json/);
});
