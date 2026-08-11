// The central-skills-repo discovery catalog for the chat "/" menu:
// resolveCentralSkillsRepo + listSkillLibrary read the `skills/` and `runtime/`
// families' SKILL.md frontmatter (name + description), best-effort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

// Isolate the skills-sources registry to a temp dir so tests never touch the
// real ~/Library/.../skills-sources.json. Required once listSkillLibrary()
// seeds the builtin source into the registry on first call.
const tmpRegRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sl-reg-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmpRegRoot, 'plugins');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(__dirname, `_skill-library-repo-${process.pid}`);

function writeSkill(family, id, name, description) {
  const dir = path.join(repo, family, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nbody\n`);
}

// Build a fake central repo BEFORE importing the module (it reads env lazily,
// but set up first to be safe).
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, 'registry.yaml'), 'registryVersion: "3.0.0"\n'); // resolution marker
writeSkill('skills', 'systematic-debugging', 'systematic-debugging', 'Use when encountering any bug.');
writeSkill('skills', 'code-review', 'code-review', 'Review a PR.');
writeSkill('runtime', 'atomize-text', 'atomize-text', 'Split text into atomic units.');
// A junk dir with no SKILL.md must be skipped.
fs.mkdirSync(path.join(repo, 'skills', 'broken'), { recursive: true });
// agent-tools is NOT a library family — must be ignored even if present.
writeSkill('agent-tools', 'search-kb', 'search-kb', 'should be ignored');

process.env.SKILLS_REPO = repo;
const { listSkillLibrary, readSkillInstructions, resolveCentralSkillsRepo, _resetSkillLibraryCache } =
  await import('../llm_agent/skills/skill-library.mjs');
const { writeRegistry, addSource, seedBuiltinOnce, BUILTIN_ID } =
  await import('../skills-sources/registry.mjs');
const { setEnabled } = await import('../skills-sources/state.mjs');

test('resolveCentralSkillsRepo finds the repo via $SKILLS_REPO', () => {
  assert.equal(resolveCentralSkillsRepo(), repo);
});

test('listSkillLibrary reads skills/ + runtime/ SKILL.md, skips junk and non-library families', () => {
  _resetSkillLibraryCache();
  const { repo: r, skills } = listSkillLibrary();
  assert.equal(r, repo);
  const ids = skills.map((s) => s.id).sort();
  assert.deepEqual(ids, ['runtime/atomize-text', 'skills/code-review', 'skills/systematic-debugging']);
  const dbg = skills.find((s) => s.id === 'skills/systematic-debugging');
  assert.equal(dbg.name, 'systematic-debugging');
  assert.equal(dbg.family, 'skills');
  assert.match(dbg.description, /encountering any bug/);
  assert.ok(dbg.path.endsWith('skills/systematic-debugging/SKILL.md'));
  // agent-tools must NOT leak in (it's surfaced via /kb/agent/catalog already).
  assert.ok(!ids.some((i) => i.startsWith('agent-tools/')));
});

test('listSkillLibrary parses a folded (block-scalar) description like the loader does', () => {
  // A YAML folded description spanning multiple lines — the hand-rolled regex
  // reader captured just ">" (the block indicator) instead of the folded text;
  // js-yaml (what the loader uses) folds it correctly. This pins catalog/library
  // parse consistency.
  const dir = path.join(repo, 'skills', 'folded-desc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    '---\nname: folded-desc\ndescription: >\n  A multi-line description\n  that folds onto one line.\n---\n\n# folded-desc\nbody\n');
  _resetSkillLibraryCache();
  const { skills } = listSkillLibrary();
  const s = skills.find((x) => x.id === 'skills/folded-desc');
  assert.ok(s, 'folded-desc skill must be catalogued');
  assert.match(s.description, /multi-line description that folds onto one line/);
  assert.ok(!s.description.startsWith('>'), 'must not capture the YAML block indicator');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a repo with the marker but no library families yields an empty catalog (no throw)', () => {
  // (Can't test the truly-no-repo path here: the resolver correctly falls back
  // to ~/skills, which exists on dev machines. Instead point at a marker-only
  // repo to exercise the empty-but-resolved path.)
  const empty = path.join(__dirname, `_skill-library-empty-${process.pid}`);
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
  process.env.SKILLS_REPO = empty;
  // The builtin source is seeded idempotently (won't re-resolve on its own);
  // reset the registry so seedBuiltinOnce re-points at the new SKILLS_REPO.
  writeRegistry([]);
  _resetSkillLibraryCache();
  const out = listSkillLibrary();
  assert.equal(out.repo, empty);
  assert.deepEqual(out.skills, []);
  fs.rmSync(empty, { recursive: true, force: true });
  process.env.SKILLS_REPO = repo; // restore
  writeRegistry([]); // re-seed builtin at repo for subsequent tests
  _resetSkillLibraryCache();
});

test('readSkillInstructions returns name + SKILL.md body for a catalogued id', () => {
  process.env.SKILLS_REPO = repo;
  _resetSkillLibraryCache();
  const sk = readSkillInstructions('runtime/atomize-text');
  assert.ok(sk, 'expected a result for a known id');
  assert.equal(sk.id, 'runtime/atomize-text');
  assert.equal(sk.name, 'atomize-text');
  // The full SKILL.md content (frontmatter + body) is returned for the agent to follow.
  assert.match(sk.content, /Split text into atomic units|atomize-text/);
});

test('readSkillInstructions refuses an unknown id and never reads an arbitrary path', () => {
  _resetSkillLibraryCache();
  // Not in the catalog → null (no read of a client-named file/path).
  assert.equal(readSkillInstructions('skills/does-not-exist'), null);
  // A real absolute path that is NOT a catalogued id must also be refused —
  // the gate is the catalog, not the filesystem, so a client can't smuggle a
  // path through this channel.
  assert.equal(readSkillInstructions('/etc/passwd'), null);
  assert.equal(readSkillInstructions(''), null);
  assert.equal(readSkillInstructions(null), null);
});

// Multi-source: a registered local source contributes its discovery skills,
// tagged with sourceId/sourceName. Disable it (per-user) and it disappears.
test('listSkillLibrary(userId) unions enabled sources and tags each skill', () => {
  // Isolate registry/state to a temp dir so the real skills-sources.json is untouched.
  const tmpReg = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sl-'));
  process.env.LLMIDE_PLUGIN_DIR = path.join(tmpReg, 'plugins');
  // A second source repo alongside the existing fixture `repo` (= the builtin).
  const other = path.join(__dirname, `_skill-library-other-${process.pid}`);
  fs.mkdirSync(path.join(other, 'skills', 'extra'), { recursive: true });
  fs.writeFileSync(path.join(other, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
  fs.writeFileSync(path.join(other, 'skills', 'extra', 'SKILL.md'),
    '---\nname: extra\ndescription: from another source\n---\n\n# extra\n');
  writeRegistry([]);
  seedBuiltinOnce();
  addSource({ path: other, name: 'other' });
  const enabledUser = 'multi-1';
  setEnabled(enabledUser, BUILTIN_ID, true);
  setEnabled(enabledUser, 'other', true);
  _resetSkillLibraryCache();
  const { skills } = listSkillLibrary(enabledUser);
  const ids = skills.map((s) => s.id).sort();
  assert.ok(ids.includes('skills/extra'), 'second source contributed');
  const ex = skills.find((s) => s.id === 'skills/extra');
  assert.equal(ex.sourceName, 'other');
  assert.ok(ex.sourceId);
  // Disable the second source for this user → its skill disappears.
  setEnabled(enabledUser, 'other', false);
  _resetSkillLibraryCache();
  const after = listSkillLibrary(enabledUser).skills.map((s) => s.id);
  assert.ok(!after.includes('skills/extra'));
  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(tmpReg, { recursive: true, force: true });
  delete process.env.LLMIDE_PLUGIN_DIR;
});

test('cleanup', () => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpRegRoot, { recursive: true, force: true });
});
