// The central-skills-repo discovery catalog for the chat "/" menu:
// resolveCentralSkillsRepo + listSkillLibrary read the `skills/` and `runtime/`
// families' SKILL.md frontmatter (name + description), best-effort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

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
const { listSkillLibrary, resolveCentralSkillsRepo, _resetSkillLibraryCache } =
  await import('../llm_agent/skills/skill-library.mjs');

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

test('a repo with the marker but no library families yields an empty catalog (no throw)', () => {
  // (Can't test the truly-no-repo path here: the resolver correctly falls back
  // to ~/skills, which exists on dev machines. Instead point at a marker-only
  // repo to exercise the empty-but-resolved path.)
  const empty = path.join(__dirname, `_skill-library-empty-${process.pid}`);
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
  process.env.SKILLS_REPO = empty;
  _resetSkillLibraryCache();
  const out = listSkillLibrary();
  assert.equal(out.repo, empty);
  assert.deepEqual(out.skills, []);
  fs.rmSync(empty, { recursive: true, force: true });
  process.env.SKILLS_REPO = repo; // restore
});

test('cleanup', () => {
  fs.rmSync(repo, { recursive: true, force: true });
});
