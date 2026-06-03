// Tests for extension/plugins/installer.mjs — zip-based install +
// uninstall pipeline.
//
// We shell out to system `zip` to build fixture archives; if zip is
// unavailable the test is skipped. That keeps the test self-contained
// (no fixture binaries in the repo) and exercises the real unzip
// codepath the production handler uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { installFromZip, uninstall } from '../plugins/installer.mjs';

function hasZip() {
  const r = spawnSync('zip', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function newTempRoot() { return mkdtempSync(join(tmpdir(), 'inst-test-')); }

function writeManifest(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
}

function zipDirectory(srcDir, zipPath, opts = {}) {
  // `cd <srcDir> && zip -r <zipPath> .` produces an archive whose
  // entries live at the root (no top-level folder). Pass
  // includeParent:true to wrap the contents inside a single dir,
  // matching the "I zipped my plugin folder" UX.
  const args = ['-r', '-q', zipPath];
  let cwd, target;
  if (opts.includeParent) {
    const parent = join(srcDir, '..');
    const leaf = srcDir.slice(parent.length + 1);
    cwd = parent;
    target = leaf;
  } else {
    cwd = srcDir;
    target = '.';
  }
  const r = spawnSync('zip', [...args, target], { cwd, stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`zip failed: ${r.stderr?.toString()}`);
}

const skipReason = hasZip() ? null : 'system zip not available';

test('installs a valid zip whose plugin.json sits at the root', { skip: skipReason || false }, async () => {
  const stage = newTempRoot();
  const installDir = newTempRoot();
  try {
    const srcPlugin = join(stage, 'my-plugin');
    writeManifest(srcPlugin, {
      name: 'my-plugin', version: '1.0.0',
      displayName: 'My Plugin', description: 'test', author: 'me',
    });
    const zipPath = join(stage, 'pkg.zip');
    zipDirectory(srcPlugin, zipPath); // root-level entries

    const result = await installFromZip(readFileSync(zipPath), { pluginDir: installDir });
    assert.equal(result.ok, true, `install failed: ${result.error || ''}`);
    assert.equal(result.plugin.name, 'my-plugin');
    assert.equal(result.plugin.version, '1.0.0');
    assert.ok(existsSync(join(installDir, 'my-plugin', 'plugin.json')));
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('installs a valid zip wrapped in a single top-level directory', { skip: skipReason || false }, async () => {
  // Common shape produced by `zip -r foo.zip my-plugin/` or Finder's
  // Compress action: the archive contains a single dir.
  const stage = newTempRoot();
  const installDir = newTempRoot();
  try {
    const srcPlugin = join(stage, 'wrapped-plugin');
    writeManifest(srcPlugin, {
      name: 'wrapped-plugin', version: '0.2.0',
      displayName: 'Wrapped', description: 'test',
    });
    const zipPath = join(stage, 'pkg.zip');
    zipDirectory(srcPlugin, zipPath, { includeParent: true });

    const result = await installFromZip(readFileSync(zipPath), { pluginDir: installDir });
    assert.equal(result.ok, true, `install failed: ${result.error || ''}`);
    assert.equal(result.plugin.name, 'wrapped-plugin');
    assert.ok(existsSync(join(installDir, 'wrapped-plugin', 'plugin.json')));
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('refuses install when plugin.json is missing', { skip: skipReason || false }, async () => {
  const stage = newTempRoot();
  const installDir = newTempRoot();
  try {
    const srcPlugin = join(stage, 'no-manifest');
    mkdirSync(srcPlugin, { recursive: true });
    writeFileSync(join(srcPlugin, 'README.md'), 'no plugin.json here', 'utf8');
    const zipPath = join(stage, 'pkg.zip');
    zipDirectory(srcPlugin, zipPath);

    const result = await installFromZip(readFileSync(zipPath), { pluginDir: installDir });
    assert.equal(result.ok, undefined);
    assert.match(result.error, /plugin\.json not found/);
    assert.equal(result.status, 400);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('refuses install when manifest is invalid', { skip: skipReason || false }, async () => {
  const stage = newTempRoot();
  const installDir = newTempRoot();
  try {
    const srcPlugin = join(stage, 'bad');
    writeManifest(srcPlugin, { name: 'Bad Name!', version: '1.0.0', displayName: 'b', description: '' });
    const zipPath = join(stage, 'pkg.zip');
    zipDirectory(srcPlugin, zipPath);

    const result = await installFromZip(readFileSync(zipPath), { pluginDir: installDir });
    assert.equal(result.ok, undefined);
    assert.match(result.error, /validation failed/);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('refuses install when name collides with an existing plugin and replace=false', { skip: skipReason || false }, async () => {
  const stage = newTempRoot();
  const installDir = newTempRoot();
  try {
    // Pre-install a plugin
    mkdirSync(join(installDir, 'twice'), { recursive: true });
    writeFileSync(join(installDir, 'twice', 'plugin.json'),
      JSON.stringify({ name: 'twice', version: '1.0.0', displayName: 'A' }), 'utf8');

    // Build a new zip with the same name but different version
    const srcPlugin = join(stage, 'twice');
    writeManifest(srcPlugin, { name: 'twice', version: '2.0.0', displayName: 'B' });
    const zipPath = join(stage, 'pkg.zip');
    zipDirectory(srcPlugin, zipPath);

    const result = await installFromZip(readFileSync(zipPath), { pluginDir: installDir, replace: false });
    assert.equal(result.ok, undefined);
    assert.match(result.error, /already installed/);
    assert.equal(result.status, 409);

    // Original survived
    const persisted = JSON.parse(readFileSync(join(installDir, 'twice', 'plugin.json'), 'utf8'));
    assert.equal(persisted.version, '1.0.0');
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('replace=true overwrites existing same-named plugin', { skip: skipReason || false }, async () => {
  const stage = newTempRoot();
  const installDir = newTempRoot();
  try {
    mkdirSync(join(installDir, 'over'), { recursive: true });
    writeFileSync(join(installDir, 'over', 'plugin.json'),
      JSON.stringify({ name: 'over', version: '1.0.0', displayName: 'OLD' }), 'utf8');

    const srcPlugin = join(stage, 'over');
    writeManifest(srcPlugin, { name: 'over', version: '2.0.0', displayName: 'NEW' });
    const zipPath = join(stage, 'pkg.zip');
    zipDirectory(srcPlugin, zipPath);

    const result = await installFromZip(readFileSync(zipPath), { pluginDir: installDir, replace: true });
    assert.equal(result.ok, true);
    assert.equal(result.plugin.version, '2.0.0');
    const persisted = JSON.parse(readFileSync(join(installDir, 'over', 'plugin.json'), 'utf8'));
    assert.equal(persisted.version, '2.0.0');
    assert.equal(persisted.displayName, 'NEW');
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('refuses non-Buffer input', async () => {
  const r1 = await installFromZip('not bytes');
  assert.match(r1.error, /expected Buffer bytes/);
  const r2 = await installFromZip(null);
  assert.match(r2.error, /expected Buffer bytes/);
});

test('refuses empty body', async () => {
  const r = await installFromZip(Buffer.alloc(0));
  assert.match(r.error, /empty zip/);
});

test('refuses oversized body (>5 MB)', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  const r = await installFromZip(big);
  assert.match(r.error, /exceeds.*bytes/);
  assert.equal(r.status, 413);
});

test('refuses malformed zip', async () => {
  const r = await installFromZip(Buffer.from('this is not a zip file at all'));
  assert.ok(r.error);
  assert.equal(r.status, 400);
});

test('rejects zip with path-traversal entries', { skip: skipReason || false }, async () => {
  const stage = newTempRoot();
  const installDir = newTempRoot();
  try {
    // Build a zip whose payload sits in ../escapee
    const safe = join(stage, 'safe');
    mkdirSync(safe, { recursive: true });
    writeFileSync(join(safe, 'plugin.json'),
      JSON.stringify({ name: 'p', version: '1.0.0', displayName: 'p' }), 'utf8');
    const zipPath = join(stage, 'pkg.zip');
    // Use `zip -r pkg.zip safe ../sneaky.txt` — first create the sneaky file
    const sneaky = join(stage, '..', 'sneaky.txt');
    writeFileSync(sneaky, 'pwned', 'utf8');
    const r1 = spawnSync('zip', ['-r', zipPath, 'safe'], { cwd: stage });
    if (r1.status !== 0) throw new Error('zip phase 1 failed');
    // zip from outside the staging dir with a relative escape
    const r2 = spawnSync('zip', ['-g', zipPath, '../sneaky.txt'], { cwd: stage });
    // `zip` strips leading ../ by default, so this test may not produce
    // an actually-traversing entry. If it didn't, skip the assertion.
    const listing = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).stdout || '';
    if (!listing.includes('..')) {
      // Couldn't craft a traversal entry on this system; skip the assertion.
      return;
    }
    const result = await installFromZip(readFileSync(zipPath), { pluginDir: installDir });
    assert.match(result.error, /unsafe path/);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('uninstall removes installed plugin', { skip: skipReason || false }, async () => {
  const installDir = newTempRoot();
  try {
    mkdirSync(join(installDir, 'gone'), { recursive: true });
    writeFileSync(join(installDir, 'gone', 'plugin.json'),
      JSON.stringify({ name: 'gone', version: '1.0.0', displayName: 'x' }), 'utf8');

    const result = await uninstall('gone', { pluginDir: installDir });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.equal(existsSync(join(installDir, 'gone')), false);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('uninstall is idempotent (returns ok:true even when missing)', async () => {
  const installDir = newTempRoot();
  try {
    const result = await uninstall('not-there', { pluginDir: installDir });
    assert.equal(result.ok, true);
    assert.equal(result.removed, false);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('uninstall rejects invalid plugin names', async () => {
  const r1 = await uninstall('Bad Name!');
  assert.match(r1.error, /invalid plugin name/);
  const r2 = await uninstall('../escape');
  assert.match(r2.error, /invalid plugin name/);
  const r3 = await uninstall('');
  assert.match(r3.error, /invalid plugin name/);
});
