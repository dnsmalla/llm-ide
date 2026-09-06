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

// Isolate the llm-sources registry to a temp dir so tests never touch the
// real ~/Library/.../llm-sources.json. Required once listSkillLibrary()
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
const { listSkillLibrary, readSkillInstructions, _resetSkillLibraryCache } =
  await import('../llm_agent/skills/skill-library.mjs');
const { resolveCentralSkillsRepo } = await import('../core/skills-repo.mjs');
const { writeRegistry, addSource, seedBuiltinOnce, BUILTIN_ID } =
  await import('../llm-sources/registry.mjs');
const { setEnabled } = await import('../llm-sources/state.mjs');

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
test('listSkillLibrary(userId) unions enabled sources and tags each skill', async () => {
  // Isolate registry/state to a temp dir so the real llm-sources.json is untouched.
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
  await addSource({ path: other, name: 'other' });
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

// Regression: _cache used to be a single process-wide slot keyed by nothing,
// so the FIRST caller's catalog (including which private sources they'd
// enabled) leaked to every OTHER user's next request until an unrelated
// add/update/remove/toggle happened to reset it. Now keyed per userId.
test('listSkillLibrary caches per-user, not globally — one user cannot see another user\'s catalog', async () => {
  const tmpReg = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sl-cache-'));
  process.env.LLMIDE_PLUGIN_DIR = path.join(tmpReg, 'plugins');
  const other = path.join(__dirname, `_skill-library-cachecheck-${process.pid}`);
  fs.mkdirSync(path.join(other, 'skills', 'private-skill'), { recursive: true });
  fs.writeFileSync(path.join(other, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
  fs.writeFileSync(path.join(other, 'skills', 'private-skill', 'SKILL.md'),
    '---\nname: private-skill\ndescription: only alice enabled this\n---\n\n# private-skill\n');
  writeRegistry([]);
  seedBuiltinOnce();
  await addSource({ path: other, name: 'private' });

  _resetSkillLibraryCache();
  setEnabled('alice', BUILTIN_ID, true);
  setEnabled('alice', 'private', true);
  setEnabled('bob', BUILTIN_ID, true);
  // bob never enables 'private'.

  const aliceCatalog = listSkillLibrary('alice');
  assert.ok(aliceCatalog.skills.some((s) => s.id === 'skills/private-skill'),
    'alice sees the source she enabled');

  // Calling for bob AFTER alice's call must not reuse alice's cached entry —
  // this is exactly what a single unkeyed `_cache` slot would do.
  const bobCatalog = listSkillLibrary('bob');
  assert.ok(!bobCatalog.skills.some((s) => s.id === 'skills/private-skill'),
    'bob must not see a source only alice enabled, even from a warm cache');

  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(tmpReg, { recursive: true, force: true });
  delete process.env.LLMIDE_PLUGIN_DIR;
  _resetSkillLibraryCache();
});

test('readSkillInstructions(id, userId) reads from that user\'s own catalog', async () => {
  const tmpReg = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sl-rsi-'));
  process.env.LLMIDE_PLUGIN_DIR = path.join(tmpReg, 'plugins');
  writeRegistry([]);
  seedBuiltinOnce();
  process.env.SKILLS_REPO = repo;
  _resetSkillLibraryCache();
  setEnabled('carol', BUILTIN_ID, true);
  const sk = readSkillInstructions('runtime/atomize-text', 'carol');
  assert.ok(sk, 'expected a result when the user has the builtin source enabled');
  assert.equal(sk.id, 'runtime/atomize-text');
  fs.rmSync(tmpReg, { recursive: true, force: true });
  delete process.env.LLMIDE_PLUGIN_DIR;
  _resetSkillLibraryCache();
});

test('cleanup', () => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpRegRoot, { recursive: true, force: true });
});


// ── Cross-source dedup: same skill id from two enabled sources → ONE entry ──
test('listSkillLibrary dedups identical skill ids across enabled sources', async () => {
  // Self-contained: the 'cleanup' test above already removed tmpRegRoot and
  // several earlier tests `delete` LLMIDE_PLUGIN_DIR instead of restoring it,
  // so this must not rely on either — it needs its own temp registry dir.
  const tmpReg = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sl-dedup-'));
  process.env.LLMIDE_PLUGIN_DIR = path.join(tmpReg, 'plugins');
  writeRegistry([]);
  _resetSkillLibraryCache();
  const srcA = path.join(tmpReg, 'a');
  const srcB = path.join(tmpReg, 'b');
  for (const [root, tag] of [[srcA, 'A'], [srcB, 'B']]) {
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true }); // makes the dir a valid LLM source
    fs.mkdirSync(path.join(root, 'skills', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'shared', 'SKILL.md'),
      `---\nname: shared\ndescription: copy ${tag}\n---\n\n# shared\n`);
    fs.mkdirSync(path.join(root, 'skills', `only-${tag.toLowerCase()}`), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', `only-${tag.toLowerCase()}`, 'SKILL.md'),
      `---\nname: only-${tag.toLowerCase()}\ndescription: ${tag}\n---\n\n# x\n`);
  }
  const { addSource } = await import('../llm-sources/registry.mjs');
  const { setEnabled } = await import('../llm-sources/state.mjs');
  const addA = await addSource({ path: srcA, name: 'Source A' });
  const addB = await addSource({ path: srcB, name: 'Source B' });
  assert.ok(addA.source && addB.source, 'fixtures must register as valid sources');
  const uid = 'dedup-user';
  setEnabled(uid, 'source-a', true);
  setEnabled(uid, 'source-b', true);

  const { skills } = listSkillLibrary(uid);
  const shared = skills.filter((s) => s.id === 'skills/shared');
  assert.equal(shared.length, 1, 'duplicate skill id must appear once');
  assert.equal(shared[0].sourceId, 'source-a', 'first enabled source (registry order) wins');
  assert.ok(skills.some((s) => s.id === 'skills/only-a'));
  assert.ok(skills.some((s) => s.id === 'skills/only-b'), 'non-duplicates unaffected');

  fs.rmSync(tmpReg, { recursive: true, force: true });
  delete process.env.LLMIDE_PLUGIN_DIR;
  _resetSkillLibraryCache();
});
