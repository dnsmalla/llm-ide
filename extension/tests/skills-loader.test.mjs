// Tests for extension/llm_agent/skills/loader.mjs — the strict skill
// loader. Focus: the nested vendor skill layout `skills/<name>/SKILL.md`
// used by Claude Code and Codex plugins, alongside llm-ide's flat files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills } from '../llm_agent/skills/loader.mjs';

function newDir() {
  return mkdtempSync(join(tmpdir(), 'skills-loader-'));
}

const FLAT = `---
name: flat-skill
kind: read
description: a flat skill
---
Body of flat skill.`;

const NESTED = `---
name: nested-skill
description: A nested vendor skill.
---
Body of nested skill.`;

test('nested <name>/SKILL.md is loaded with kind defaulting to read', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'nested-skill'), { recursive: true });
  writeFileSync(join(dir, 'nested-skill', 'SKILL.md'), NESTED, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills, warnings } = loadSkills(dir);
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  const s = skills.get('nested-skill');
  assert.ok(s, 'nested skill missing');
  assert.equal(s.kind, 'read', 'kind defaults to read when frontmatter omits it');
  assert.equal(s.description, 'A nested vendor skill.');
  assert.match(s.body, /Body of nested skill/);
  rmSync(dir, { recursive: true, force: true });
});

test('nested skill missing frontmatter name falls back to directory name', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'anon-skill'), { recursive: true });
  writeFileSync(join(dir, 'anon-skill', 'SKILL.md'),
    `---\ndescription: no name field\n---\nBody.`, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills } = loadSkills(dir);
  assert.ok(skills.get('anon-skill'), 'dirname should become the skill name');
  rmSync(dir, { recursive: true, force: true });
});

test('nested skill whose name does not match its directory is rejected', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'honest-name'), { recursive: true });
  writeFileSync(join(dir, 'honest-name', 'SKILL.md'),
    `---\nname: ask-internal\ndescription: shadow attempt\n---\nBody.`, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills, warnings } = loadSkills(dir);
  assert.equal(skills.size, 0);
  assert.ok(warnings.some((w) => w.includes('does not match directory name')), warnings.join(', '));
  rmSync(dir, { recursive: true, force: true });
});

test('nested and flat skills coexist; flat behavior unchanged', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'nested-skill'), { recursive: true });
  writeFileSync(join(dir, 'nested-skill', 'SKILL.md'), NESTED, 'utf8');
  writeFileSync(join(dir, 'flat-skill.md'), FLAT, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills } = loadSkills(dir);
  assert.ok(skills.get('nested-skill'));
  assert.ok(skills.get('flat-skill'));
  rmSync(dir, { recursive: true, force: true });
});

test('a plain subdirectory without SKILL.md is ignored silently', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'references', 'notes.md'), 'not a skill', 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills, warnings } = loadSkills(dir);
  assert.equal(skills.size, 0);
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  rmSync(dir, { recursive: true, force: true });
});

test('symlinked skill file is rejected', () => {
  const dir = newDir();
  const outside = newDir();
  writeFileSync(join(outside, 'evil.md'), `---\nname: evil\nkind: read\n---\nx`, 'utf8');
  symlinkSync(join(outside, 'evil.md'), join(dir, 'evil.md'));
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills } = loadSkills(dir);
  assert.equal(skills.get('evil'), undefined);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('symlinked nested SKILL.md is rejected with a warning', () => {
  const dir = newDir();
  const outside = newDir();
  writeFileSync(join(outside, 'SKILL.md'), `---\nname: evil\nkind: read\n---\nx`, 'utf8');
  mkdirSync(join(dir, 'evil'), { recursive: true });
  symlinkSync(join(outside, 'SKILL.md'), join(dir, 'evil', 'SKILL.md'));
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills, warnings } = loadSkills(dir);
  assert.equal(skills.get('evil'), undefined);
  assert.ok(warnings.some((w) => w.includes('symbolic link')), warnings.join(', '));
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
