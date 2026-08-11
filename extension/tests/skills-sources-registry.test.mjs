import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-reg-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmpRoot, 'plugins');
// A fake "builtin" skills repo so seeding resolves without the real submodule.
const fakeRepo = path.join(tmpRoot, 'fake-skills');
fs.mkdirSync(path.join(fakeRepo, 'skills', 'demo'), { recursive: true });
fs.writeFileSync(path.join(fakeRepo, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
fs.writeFileSync(path.join(fakeRepo, 'skills', 'demo', 'SKILL.md'),
  '---\nname: demo\ndescription: d\n---\n\n# demo\n');
process.env.SKILLS_REPO = fakeRepo;

const { readRegistry, writeRegistry, isValidSkillsSource, seedBuiltinOnce,
  listSources, getSource, BUILTIN_ID, countDiscoverySkills } =
  await import('../skills-sources/registry.mjs');

test('isValidSkillsSource accepts registry.yaml or plugin.json+skills/', () => {
  assert.ok(isValidSkillsSource(fakeRepo));
  const cp = path.join(tmpRoot, 'cp');
  fs.mkdirSync(path.join(cp, 'skills', 'x'), { recursive: true });
  fs.mkdirSync(path.join(cp, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(cp, '.claude-plugin', 'plugin.json'), '{"name":"x"}');
  assert.ok(isValidSkillsSource(cp));
  assert.ok(!isValidSkillsSource(tmpRoot)); // no markers
});

test('seedBuiltinOnce adds exactly one builtin source pointing at the resolved repo', () => {
  writeRegistry([]); // start clean
  seedBuiltinOnce();
  const src = getSource(BUILTIN_ID);
  assert.ok(src, 'builtin source must exist');
  assert.equal(src.origin, 'builtin');
  assert.equal(src.builtin, true);
  assert.equal(src.location, fakeRepo);
  // Idempotent.
  seedBuiltinOnce();
  const builtins = readRegistry().filter((s) => s.id === BUILTIN_ID);
  assert.equal(builtins.length, 1);
});

test('listSources returns the registered sources', () => {
  seedBuiltinOnce();
  const ids = listSources().map((s) => s.id);
  assert.ok(ids.includes(BUILTIN_ID));
});

test('countDiscoverySkills counts skills/ + runtime/ SKILL.md', () => {
  fs.mkdirSync(path.join(fakeRepo, 'runtime', 'rt'), { recursive: true });
  fs.writeFileSync(path.join(fakeRepo, 'runtime', 'rt', 'SKILL.md'),
    '---\nname: rt\ndescription: r\n---\n\n# rt\n');
  assert.equal(countDiscoverySkills(fakeRepo), 2);
});

import { normalizeGitUrl, addSource, removeSource, updateSource, syncBuiltin } from '../skills-sources/registry.mjs';

test('normalizeGitUrl rejects unsafe schemes and localhost, accepts https', () => {
  assert.ok(normalizeGitUrl('https://github.com/o/r.git').ok);
  assert.ok(normalizeGitUrl('https://github.com/o/r').ok);
  assert.ok(!normalizeGitUrl('file:///etc/passwd').ok);
  assert.ok(!normalizeGitUrl('ssh://git@host/o/r').ok);
  assert.ok(!normalizeGitUrl('http://127.0.0.1/x').ok);
  assert.ok(!normalizeGitUrl('http://example.local/x').ok);
  assert.ok(!normalizeGitUrl('not a url').ok);
});

test('addSource rejects a non-valid directory at a local path', () => {
  const res = addSource({ path: tmpRoot }); // no markers
  assert.ok(!res.source, 'no source created');
  assert.ok(res.error);
  assert.equal(res.status, 400);
});

test('addSource registers a local valid source and removeSource deletes it', () => {
  const res = addSource({ path: fakeRepo, name: 'fake-local' });
  assert.ok(res.source, 'source created');
  assert.equal(res.source.origin, 'local');
  assert.ok(res.source.location);
  const id = res.source.id;
  assert.ok(getSource(id), 'present in registry');
  // builtin not removable; arbitrary source is.
  const bad = removeSource(BUILTIN_ID);
  assert.ok(bad.error && bad.status === 400);
  const good = removeSource(id);
  assert.ok(good.ok);
  assert.equal(getSource(id), null);
});

test('cleanup', () => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
