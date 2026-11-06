// desktop/scripts/release-version.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagVersion, cargoVersion, versionProblems } from './release-version.mjs';

test('tagVersion accepts desktop-vX.Y.Z only', () => {
  assert.equal(tagVersion('desktop-v1.2.3'), '1.2.3');
  for (const t of ['v1.2.3', 'mac-v1.2.3', 'desktop-v1.2', 'desktop-v1.2.3-rc1', '', undefined]) assert.equal(tagVersion(t), null);
});

test('cargoVersion reads [package] only, not a dependency version', () => {
  const toml = '[package]\nname = "x"\nversion = "0.4.0"\n\n[dependencies]\nserde = { version = "=1.0.228" }\nversion = "9.9.9"\n';
  assert.equal(cargoVersion(toml), '0.4.0');
  assert.equal(cargoVersion('[dependencies]\nversion = "1"\n'), null);
});

test('versionProblems: all three must agree and 0.0.0 is refused', () => {
  assert.deepEqual(versionProblems({ tag: 'desktop-v0.1.0', conf: '0.1.0', cargo: '0.1.0' }), []);
  assert.match(versionProblems({ tag: 'desktop-v0.1.0', conf: '0.1.0', cargo: '0.0.9' }).join(), /Cargo\.toml/);
  assert.match(versionProblems({ tag: 'desktop-v0.2.0', conf: '0.1.0', cargo: '0.1.0' }).join(), /tag/);
  assert.match(versionProblems({ tag: 'desktop-v0.0.0', conf: '0.0.0', cargo: '0.0.0' }).join(), /placeholder/);
  assert.match(versionProblems({ tag: 'v0.1.0', conf: '0.1.0', cargo: '0.1.0' }).join(), /desktop-vX\.Y\.Z/);
});

test('the repo files parse today', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const t = join(import.meta.dirname, '..', 'src-tauri');
  assert.ok(cargoVersion(readFileSync(join(t, 'Cargo.toml'), 'utf8')));
  assert.ok(JSON.parse(readFileSync(join(t, 'tauri.conf.json'), 'utf8')).version);
});
