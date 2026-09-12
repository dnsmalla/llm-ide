// The kit's `templates/` and `commands/` families, as the Mac app's Doc Gen
// and Visual menus see them.
//
// These defaults used to be Swift constants, so adding a template meant an
// app change and a release. They live in the kit now — which makes the
// PARSING here the contract: a file whose `surface` is misread lands in the
// wrong menu, and a file whose body is mangled is written into the user's
// project that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_generation-library-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { parseEntry, normalizeSurface, listGenerationLibrary, DEFAULT_SURFACE } =
  await import('../llm_agent/skills/generation-library.mjs');

test('surface defaults to doc, and an unrecognised value does not lose the file', () => {
  assert.equal(DEFAULT_SURFACE, 'doc');
  assert.equal(normalizeSurface('visual'), 'visual');
  assert.equal(normalizeSurface(' visual '), 'visual');
  assert.equal(normalizeSurface(undefined), 'doc', 'omitted — every entry written before the field existed');
  // A typo must not hide the template from every menu; Doc Gen is the fallback.
  assert.equal(normalizeSurface('vsual'), 'doc');
  assert.equal(normalizeSurface(42), 'doc');
});

test('parseEntry reads name, description and surface, and keeps the body verbatim', () => {
  const raw = [
    '---',
    'name: image-analysis',
    'description: >',
    '  Structure for reading an image.',
    'surface: visual',
    '---',
    '',
    '# Image Analysis',
    '',
    '## What It Shows',
    '',
  ].join('\n');
  const e = parseEntry(raw);
  assert.equal(e.name, 'image-analysis');
  assert.equal(e.description, 'Structure for reading an image.', 'a folded (>) description reads as text, not ">"');
  assert.equal(e.surface, 'visual');
  assert.equal(e.body, '# Image Analysis\n\n## What It Shows\n',
    'the body is what gets written into the user\'s project — it must survive exactly');
});

test('parseEntry refuses a file that is not an entry', () => {
  assert.equal(parseEntry('# Just a document\n\nNo frontmatter.\n'), null, 'no frontmatter');
  assert.equal(parseEntry('---\ndescription: no name\n---\n\nbody\n'), null, 'a name is required');
  assert.equal(parseEntry('---\n: : bad yaml :\n---\n'), null, 'unparseable frontmatter');
  assert.equal(parseEntry(''), null);
  assert.equal(parseEntry(null), null);
});

test('a `---` inside a value does not end the frontmatter early', () => {
  const e = parseEntry('---\nname: x\ndescription: "a --- b"\n---\n\nbody\n');
  assert.equal(e.name, 'x');
  assert.equal(e.body, 'body\n');
});

// Reads the real kit checked out at `.skills`. Skipped rather than failed when
// the submodule isn't initialised — the same rule plan-pipeline.test.mjs uses,
// because a clone without `git submodule update` is a setup state, not a bug.
const kitTemplates = path.join(__dirname, '../../.skills/templates');
const haveKit = fs.existsSync(kitTemplates);

test('the real kit divides templates and commands across both menus', { skip: !haveKit }, () => {
  const lib = listGenerationLibrary('kit-user');
  for (const key of ['templates', 'commands']) {
    assert.ok(lib[key].length > 0, `${key} must be discovered from the kit`);
    assert.ok(lib[key].some((e) => e.surface === 'doc'), `${key} must have Doc Gen entries`);
    assert.ok(lib[key].some((e) => e.surface === 'visual'),
      `${key} must have Visual entries — an empty Visual menu is not a fix`);
    for (const e of lib[key]) {
      assert.match(e.id, /^(templates|commands)\/[a-z0-9-]+$/, `${e.id} should be <family>/<stem>`);
      assert.ok(e.name, `${e.id} must carry a name`);
      assert.ok(e.body.trim().length > 0, `${e.id} must carry a body`);
    }
  }
  // The family READMEs document the convention for humans; they are not entries.
  assert.ok(!lib.templates.some((e) => e.id.endsWith('/README')), 'README.md is not a template');
  assert.ok(!lib.commands.some((e) => e.id.endsWith('/README')), 'README.md is not a command');
});

test('every kit template offers sections and every command offers an instruction', { skip: !haveKit }, () => {
  const lib = listGenerationLibrary('kit-user2');
  for (const t of lib.templates) {
    assert.match(t.body, /^## .+/m, `template ${t.id} must define at least one ## section`);
  }
  for (const c of lib.commands) {
    // A command is prose under its title — sections would make it a template.
    const withoutTitle = c.body.replace(/^#\s.*$/m, '').trim();
    assert.ok(withoutTitle.length > 0, `command ${c.id} must carry an instruction`);
  }
});
