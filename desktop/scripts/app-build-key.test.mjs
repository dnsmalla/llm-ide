import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { appBuildKey } from './app-build-key.mjs';

// WHY the env: the developer's global git config (hooks path, signing, includes) must not leak into the fixture.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const created = [];

function gitIn(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'ignore' });
}

/** A fresh throwaway repo per test: never the real checkout, and no state shared between cases. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'app-build-key-'));
  created.push(repo);
  const git = (...args) => gitIn(repo, ...args);
  const write = (rel, text) => {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  write('.gitignore', 'desktop/resources/\nignored.log\n');
  write('desktop/a.ts', 'one\n');
  write('desktop/b.ts', 'bee\n');
  write('docs/x.md', 'doc\n');
  write('extension/server.mjs', 'server\n');
  write('extension/package.json', '{}\n');
  write('extension/package-lock.json', '{}\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'init');
  return { repo, git, write, key: (env = {}) => appBuildKey({ repo, env }) };
}

afterEach(() => {
  while (created.length) rmSync(created.pop(), { recursive: true, force: true });
});

describe('appBuildKey', () => {
  it('is stable for an unchanged tree', () => {
    const { key } = makeRepo();
    assert.equal(key(), key());
  });

  it('changes with an uncommitted edit, and again when it is committed', () => {
    const { git, write, key } = makeRepo();
    const base = key();
    write('desktop/a.ts', 'two\n');
    assert.notEqual(key(), base);
    git('commit', '-q', '--no-verify', '-am', 'edit');
    assert.notEqual(key(), base);
  });

  it('changes with a new untracked file', () => {
    const { write, key } = makeRepo();
    const base = key();
    write('ui/new.ts', 'x\n');
    assert.notEqual(key(), base);
  });

  it('changes when a tracked file is deleted', () => {
    const { repo, key } = makeRepo();
    const base = key();
    unlinkSync(join(repo, 'desktop', 'b.ts'));
    assert.notEqual(key(), base);
  });

  it('ignores docs and extension edits (the core is re-copied into the bundle on every build)', () => {
    const { write, key } = makeRepo();
    const base = key();
    write('docs/x.md', 'changed doc\n');
    write('extension/server.mjs', 'changed server\n');
    write('extension/package-lock.json', '{"v":2}\n');
    assert.equal(key(), base);
  });

  it('ignores gitignored files', () => {
    const { write, key } = makeRepo();
    const base = key();
    write('ignored.log', 'noise\n');
    write('desktop/resources/core/anything', 'x\n');
    assert.equal(key(), base);
  });

  it('does not need desktop/resources/core/STAGE.json', () => {
    const { write, key } = makeRepo();
    assert.doesNotThrow(() => key());
    const base = key();
    write('desktop/resources/core/STAGE.json', '{"sourceHash":"a"}\n');
    assert.equal(key(), base);
  });

  it('changes with LLMIDE_BUILD_FEATURES and LLMIDE_INCLUDE_SPIKE', () => {
    const { key } = makeRepo();
    assert.notEqual(key({ LLMIDE_BUILD_FEATURES: 'kb' }), key({}));
    assert.notEqual(key({ LLMIDE_INCLUDE_SPIKE: '1' }), key({}));
  });

  it('does not throw on an untracked nested git repo, and includes it', () => {
    const { repo, key } = makeRepo();
    const base = key();
    const nested = join(repo, 'ui', 'vendored');
    mkdirSync(nested, { recursive: true });
    gitIn(nested, 'init', '-q');
    // git lists it as `ui/vendored/`; a plain readFileSync on that directory would throw EISDIR.
    let withNested;
    assert.doesNotThrow(() => { withNested = key(); });
    assert.notEqual(withNested, base, 'the nested repo must contribute to the key');
  });

  it('hashes a symlink by its target', () => {
    const { repo, key } = makeRepo();
    const link = join(repo, 'desktop', 'link');
    symlinkSync('a.ts', link);
    const toA = key();
    unlinkSync(link);
    symlinkSync('b.ts', link);
    assert.notEqual(key(), toA);
    unlinkSync(link);
    symlinkSync('does-not-exist', link); // dangling links must not throw
    assert.doesNotThrow(() => key());
  });

  it('changes when a submodule moves to another commit', () => {
    const upstream = mkdtempSync(join(tmpdir(), 'app-build-key-sub-'));
    created.push(upstream);
    gitIn(upstream, 'init', '-q');
    gitIn(upstream, 'config', 'user.email', 'test@example.com');
    gitIn(upstream, 'config', 'user.name', 'test');
    writeFileSync(join(upstream, 'f'), '1\n');
    gitIn(upstream, 'add', '-A');
    gitIn(upstream, 'commit', '-q', '--no-verify', '-m', 'one');
    const { repo, git, key } = makeRepo();
    git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'graph-kit');
    git('commit', '-q', '--no-verify', '-m', 'add submodule');
    const base = key();
    writeFileSync(join(upstream, 'f'), '2\n');
    gitIn(upstream, 'commit', '-q', '--no-verify', '-am', 'two');
    gitIn(join(repo, 'graph-kit'), '-c', 'protocol.file.allow=always', 'pull', '-q');
    assert.notEqual(key(), base);
  });
});
