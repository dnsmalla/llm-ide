// Per-item selection inside an LLM source: an item a user unchecks must
// disappear from every consumer (chat "/" skill library, Doc Gen / Visual
// generation menus) while its source stays enabled, and the Library's
// discovery listing must say which items are on and which are new.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-items-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmpRoot, 'plugins');

// A fake central kit: two skills, one command, one template, one agent.
const kit = path.join(tmpRoot, 'kit');
function write(rel, name, extra = '') {
  const file = path.join(kit, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} description\n${extra}---\n\n# ${name}\nbody\n`);
}
fs.mkdirSync(kit, { recursive: true });
fs.writeFileSync(path.join(kit, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
write('skills/alpha/SKILL.md', 'alpha');
write('skills/beta/SKILL.md', 'beta');
write('commands/doc/summarize.md', 'summarize');
write('templates/doc/report.md', 'report');
write('agents/reviewer.md', 'reviewer');
process.env.SKILLS_REPO = kit;

const { listSkillLibrary, _resetSkillLibraryCache } = await import('../llm_agent/skills/skill-library.mjs');
const { listGenerationLibrary } = await import('../llm_agent/skills/generation-library.mjs');
const { seedBuiltinOnce, sourceDiscoveryDetail, listSourcesWithState, readRegistry, writeRegistry, BUILTIN_ID } =
  await import('../llm-sources/registry.mjs');
const { setItemsEnabled } = await import('../llm-sources/state.mjs');

seedBuiltinOnce();

test('an unchecked skill leaves the skill library; its siblings stay', () => {
  setItemsEnabled('u1', BUILTIN_ID, 'skill', ['alpha'], false);
  _resetSkillLibraryCache();
  const names = listSkillLibrary('u1').skills.map((s) => s.name);
  assert.deepEqual(names, ['beta']);
  assert.deepEqual(listSkillLibrary('u2').skills.map((s) => s.name), ['alpha', 'beta'],
    'another user still sees both');
});

test('an unchecked command or template leaves the generation menus', () => {
  setItemsEnabled('u1', BUILTIN_ID, 'command', ['summarize'], false);
  setItemsEnabled('u1', BUILTIN_ID, 'template', ['report'], false);
  const lib = listGenerationLibrary('u1');
  assert.deepEqual(lib.commands.map((c) => c.name), []);
  assert.deepEqual(lib.templates.map((t) => t.name), []);
  const other = listGenerationLibrary('u2');
  assert.deepEqual(other.commands.map((c) => c.name), ['summarize']);
  assert.deepEqual(other.templates.map((t) => t.name), ['report']);
});

test('discovery marks each item enabled for this user', () => {
  const d = sourceDiscoveryDetail(BUILTIN_ID, 'u1');
  const on = (list) => Object.fromEntries(list.map((i) => [i.name, i.enabled]));
  assert.deepEqual(on(d.skills), { alpha: false, beta: true });
  assert.deepEqual(on(d.commands), { summarize: false });
  assert.deepEqual(on(d.templates), { report: false });
  assert.deepEqual(on(d.agents), { reviewer: true });
  const d2 = sourceDiscoveryDetail(BUILTIN_ID, 'u2');
  assert.ok(d2.skills.every((s) => s.enabled === true));
});

test('discovery flags items the last update added as new', () => {
  const list = readRegistry();
  const i = list.findIndex((s) => s.id === BUILTIN_ID);
  list[i].lastUpdate = { at: new Date().toISOString(), added: ['skill:beta'], removed: [] };
  writeRegistry(list);
  const d = sourceDiscoveryDetail(BUILTIN_ID, 'u2');
  const isNew = Object.fromEntries(d.skills.map((s) => [s.name, s.isNew]));
  assert.deepEqual(isNew, { alpha: false, beta: true });
});

test('the source list reports how many items this user unchecked', () => {
  const row = (u) => listSourcesWithState(u).sources.find((s) => s.id === BUILTIN_ID);
  assert.equal(row('u1').disabledItemCount, 3);
  assert.equal(row('u2').disabledItemCount, 0);
});

test('cleanup', () => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
