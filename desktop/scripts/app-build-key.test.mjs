import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { appBuildKey } from './app-build-key.mjs';

let repo;
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
const write = (rel, text) => {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const key = (env = {}) => appBuildKey({ repo, env });

describe('appBuildKey', () => {
  before(() => {
    // Hermetic: a throwaway repo, never the real checkout (which has graph-kit and a moving HEAD).
    repo = mkdtempSync(join(tmpdir(), 'app-build-key-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    write('.gitignore', 'desktop/resources/\n');
    write('desktop/a.ts', 'one\n');
    write('docs/x.md', 'doc\n');
    write('extension/server.mjs', 'server\n');
    write('extension/package.json', '{}\n');
    write('extension/package-lock.json', '{}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    write('desktop/resources/core/STAGE.json', '{"sourceHash":"a"}\n');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it('is stable for an unchanged tree', () => {
    assert.equal(key(), key());
  });

  it('changes with an uncommitted edit, and again when it is committed', () => {
    const base = key();
    write('desktop/a.ts', 'two\n');
    const edited = key();
    assert.notEqual(edited, base);
    git('commit', '-q', '-am', 'edit');
    assert.notEqual(key(), base);
  });

  it('changes with a new untracked file', () => {
    const base = key();
    write('ui/new.ts', 'x\n');
    assert.notEqual(key(), base);
  });

  it('ignores docs and extension sources (the staged core is covered by STAGE.json)', () => {
    const base = key();
    write('docs/x.md', 'changed doc\n');
    write('extension/server.mjs', 'changed server\n');
    assert.equal(key(), base);
  });

  it('changes with extension/package-lock.json', () => {
    const base = key();
    write('extension/package-lock.json', '{"v":2}\n');
    assert.notEqual(key(), base);
  });

  it('changes with STAGE.json', () => {
    const base = key();
    write('desktop/resources/core/STAGE.json', '{"sourceHash":"b"}\n');
    assert.notEqual(key(), base);
  });

  it('changes with LLMIDE_BUILD_FEATURES', () => {
    assert.notEqual(key({ LLMIDE_BUILD_FEATURES: 'kb' }), key({}));
  });
});
