// Unit tests for POST /kb/project/install-skills helpers.
// Uses a temp project dir + the real .skills kit when present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const {
  assertInstallableProjectPath,
  stacksForLanguage,
  installProjectSkills,
} = await import('../kb/install-project-skills.mjs');

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KIT = path.join(REPO_ROOT, '.skills');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-skills-'));
  fs.mkdirSync(path.join(dir, 'system'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'system', 'project.json'), JSON.stringify({
    id: 'test', displayName: 'Test', settings: { language: 'en' },
  }));
  return dir;
}

test('stacksForLanguage defaults for UI locales', () => {
  assert.equal(stacksForLanguage('en'), 'typescript,swift');
  assert.equal(stacksForLanguage('ja'), 'typescript,swift');
  assert.equal(stacksForLanguage(''), 'typescript,swift');
});

test('stacksForLanguage passes known stack ids through (with defaults)', () => {
  const s = stacksForLanguage('python');
  assert.ok(s.includes('python'));
  assert.ok(s.includes('typescript'));
  assert.ok(s.includes('swift'));
});

test('assertInstallableProjectPath rejects relative / missing / non-project', () => {
  assert.throws(() => assertInstallableProjectPath('relative/path'), /absolute/);
  assert.throws(() => assertInstallableProjectPath('/no/such/path-' + Date.now()), /does not exist|not accessible/);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-bare-'));
  try {
    assert.throws(() => assertInstallableProjectPath(bare), /not a LLM IDE project/);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('assertInstallableProjectPath accepts a marked project', () => {
  const dir = tempProject();
  try {
    assert.equal(assertInstallableProjectPath(dir), fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installProjectSkills links skills when the central kit is present', {
  skip: !fs.existsSync(path.join(KIT, 'scripts', 'install.sh')),
}, () => {
  const dir = tempProject();
  // Point resolution at the repo submodule (same as production).
  const prev = process.env.SKILLS_REPO;
  process.env.SKILLS_REPO = KIT;
  try {
    const result = installProjectSkills({ path: dir, language: 'en' });
    assert.equal(result.ok, true);
    assert.equal(result.path, fs.realpathSync(dir));
    assert.ok(result.kit.includes('skills') || result.kit === KIT);
    // At least one tool dir should have been created with a skill link.
    const cursorSkill = path.join(dir, '.cursor', 'skills');
    assert.ok(fs.existsSync(cursorSkill), 'expected .cursor/skills');
    const entries = fs.readdirSync(cursorSkill);
    assert.ok(entries.length > 0, 'expected skill symlinks');
    const sample = path.join(cursorSkill, entries[0]);
    assert.ok(fs.lstatSync(sample).isSymbolicLink(), 'skills should be symlinks');
  } finally {
    if (prev === undefined) delete process.env.SKILLS_REPO;
    else process.env.SKILLS_REPO = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installProjectSkills preserves a real .claude/settings.json (no --force)', {
  skip: !fs.existsSync(path.join(KIT, 'scripts', 'install.sh')),
}, () => {
  const dir = tempProject();
  const settings = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = '{"projectName":"KeepMe"}\n';
  fs.writeFileSync(settings, original);
  const prev = process.env.SKILLS_REPO;
  process.env.SKILLS_REPO = KIT;
  try {
    installProjectSkills({ path: dir });
    assert.equal(fs.readFileSync(settings, 'utf8'), original);
    assert.ok(!fs.lstatSync(settings).isSymbolicLink(), 'must not replace real settings');
  } finally {
    if (prev === undefined) delete process.env.SKILLS_REPO;
    else process.env.SKILLS_REPO = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
