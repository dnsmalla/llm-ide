// desktop/scripts/collect-release.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCollect, budgetProblems, BUDGET_BYTES } from './collect-release.mjs';

const V = '0.1.0';
test('macOS arm64: dmg kept, the arch-less app.tar.gz renamed, sig follows when signed', () => {
  const files = ['dmg/LLM-IDE_0.1.0_aarch64.dmg', 'macos/LLM-IDE.app.tar.gz', 'macos/LLM-IDE.app.tar.gz.sig', 'macos/LLM-IDE.app/Contents/Info.plist'];
  const r = planCollect({ target: 'darwin-arm64', version: V, files, signed: true });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.copies.map((c) => c.to).sort(), ['LLM-IDE_0.1.0_aarch64.app.tar.gz', 'LLM-IDE_0.1.0_aarch64.app.tar.gz.sig', 'LLM-IDE_0.1.0_aarch64.dmg']);
});

test('an unsigned dry run needs only the installers', () => {
  const r = planCollect({ target: 'win32-x64', version: V, files: ['nsis/LLM-IDE_0.1.0_x64-setup.exe'], signed: false });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.copies.map((c) => c.to), ['LLM-IDE_0.1.0_x64-setup.exe']);
});

test('a signed run without the updater sig fails', () => {
  const r = planCollect({ target: 'linux-x64', version: V, files: ['appimage/LLM-IDE_0.1.0_amd64.AppImage', 'deb/LLM-IDE_0.1.0_amd64.deb'], signed: true });
  assert.match(r.problems.join(), /AppImage\.sig/);
});

test('a missing installer is named, together with what was found', () => {
  const r = planCollect({ target: 'darwin-x64', version: V, files: ['dmg/Other.dmg'], signed: false });
  assert.match(r.problems.join(), /LLM-IDE_0\.1\.0_x64\.dmg.*found: dmg\/Other\.dmg/s);
});

test('unknown target is refused', () => {
  assert.match(planCollect({ target: 'linux-arm64', version: V, files: [], signed: false }).problems.join(), /unknown target/);
});

test('budget applies to installers only, not to .sig files', () => {
  assert.deepEqual(budgetProblems([{ name: 'a.dmg', size: BUDGET_BYTES }, { name: 'a.sig', size: 1 }]), []);
  assert.match(budgetProblems([{ name: 'big.AppImage', size: BUDGET_BYTES + 1 }]).join(), /big\.AppImage.*150 MB/);
});
