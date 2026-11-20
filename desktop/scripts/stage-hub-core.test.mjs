// desktop/scripts/stage-hub-core.test.mjs
// Tests for where the staged hub bundle is written by default. The staging run itself downloads hundreds of MB,
// so these tests cover only the output-folder resolution and the workspace helper rules, with no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HUB_OUT_FOLDER, resolveHubOut } from './hub-out.mjs';
import {
  HELPER_TARGET,
  ensureHelperToolchain,
  hasInstalledTarget,
  readWorkspaceHelper,
  resolveHelperFile,
  stageWorkspaceHelper,
  workspaceHelperOption,
} from './stage-hub-core.mjs';

const DESKTOP = '/repo/desktop';
// A stand-in for the static helper: the ELF magic followed by padding. The staging code only checks the magic.
const ELF_STANDIN = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
const READY = { hasCargo: () => true, installedTargets: () => `aarch64-apple-darwin\n${HELPER_TARGET}\n` };
const NO_TARGET = { hasCargo: () => true, installedTargets: () => 'aarch64-apple-darwin\n' };
const NEVER_PROBED = {
  hasCargo: () => { throw new Error('the toolchain must not be probed'); },
  installedTargets: () => { throw new Error('the toolchain must not be probed'); },
};

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-helper-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the default output is desktop/hub-dist, not Vite\'s desktop/dist', () => {
  assert.equal(HUB_OUT_FOLDER, 'hub-dist');
  assert.equal(resolveHubOut([], DESKTOP), join(DESKTOP, 'hub-dist'));
  assert.equal(resolveHubOut(['--version', '1.2.3'], DESKTOP), join(DESKTOP, 'hub-dist'));
});

test('--out still overrides the default', () => {
  assert.equal(resolveHubOut(['--out', '/srv/bundles'], DESKTOP), resolve('/srv/bundles'));
  assert.equal(resolveHubOut(['--compat-sqlite', '/x/module.node', '--out', '/srv/out'], DESKTOP), resolve('/srv/out'));
});

test('a --out without a value, or followed by another flag, falls back to the default', () => {
  assert.equal(resolveHubOut(['--out'], DESKTOP), join(DESKTOP, 'hub-dist'));
  assert.equal(resolveHubOut(['--out', '--version', '1.2.3'], DESKTOP), join(DESKTOP, 'hub-dist'));
});

test('--workspace-helper is optional and needs an absolute path as its value', () => {
  assert.equal(workspaceHelperOption([]), null);
  assert.equal(workspaceHelperOption(['--version', '1.2.3']), null);
  assert.equal(workspaceHelperOption(['--workspace-helper', '/srv/llmide-workspace']), '/srv/llmide-workspace');
  assert.throws(() => workspaceHelperOption(['--workspace-helper']), /needs an absolute file path/);
  assert.throws(() => workspaceHelperOption(['--workspace-helper', 'build/llmide-workspace']), /needs an absolute file path/);
  assert.throws(() => workspaceHelperOption(['--workspace-helper', '--version']), /needs an absolute file path/);
});

test('a helper that is missing or not an ELF program is refused with the same message', (t) => {
  const dir = scratch(t);
  const text = join(dir, 'helper-text');
  writeFileSync(text, '#!/bin/sh\n');
  const macho = join(dir, 'helper-macho');
  writeFileSync(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  const missing = join(dir, 'missing');
  for (const file of [text, macho, missing]) {
    assert.throws(() => readWorkspaceHelper(file), { message: `--workspace-helper is not a Linux program: ${file}` });
  }
});

test('an ELF helper is accepted and returned as given', (t) => {
  const dir = scratch(t);
  const elf = join(dir, 'llmide-workspace');
  writeFileSync(elf, ELF_STANDIN);
  assert.equal(readWorkspaceHelper(elf), elf);
});

test('without a given helper, a missing cargo or missing musl target fails with its install step', () => {
  const noCargo = { hasCargo: () => false, installedTargets: () => '' };
  assert.throws(() => ensureHelperToolchain(noCargo), {
    message: 'cargo is not installed; pass --workspace-helper <file> with a prebuilt helper.',
  });
  assert.throws(() => ensureHelperToolchain(NO_TARGET), {
    message: 'install the target: rustup target add x86_64-unknown-linux-musl',
  });
  const noRustup = { hasCargo: () => true, installedTargets: () => { throw new Error('spawn rustup ENOENT'); } };
  assert.throws(() => ensureHelperToolchain(noRustup), {
    message: 'rustup is not installed; pass --workspace-helper <file> with a prebuilt helper.',
  });
  assert.doesNotThrow(() => ensureHelperToolchain(READY));
});

test('the installed-target check matches whole lines only', () => {
  assert.equal(hasInstalledTarget(`${HELPER_TARGET}\n`), true);
  assert.equal(hasInstalledTarget(`${HELPER_TARGET}-extra\n`), false);
  assert.equal(hasInstalledTarget(''), false);
});

test('a given helper skips the toolchain and the build; without one the build runs after the check', (t) => {
  const dir = scratch(t);
  const elf = join(dir, 'llmide-workspace');
  writeFileSync(elf, ELF_STANDIN);
  let builds = 0;
  const build = () => { builds += 1; return elf; };
  assert.equal(resolveHelperFile(['--workspace-helper', elf], NEVER_PROBED, build), elf);
  assert.equal(builds, 0);
  assert.throws(() => resolveHelperFile([], NO_TARGET, build), {
    message: 'install the target: rustup target add x86_64-unknown-linux-musl',
  });
  assert.equal(builds, 0);
  assert.equal(resolveHelperFile([], READY, build), elf);
  assert.equal(builds, 1);
});

test('the staged helper is core/bin/llmide-workspace with mode 0755, even from a 0644 source', (t) => {
  const dir = scratch(t);
  const source = join(dir, 'source-helper');
  writeFileSync(source, ELF_STANDIN);
  chmodSync(source, 0o644);
  const core = join(dir, 'core');
  mkdirSync(core);
  const staged = stageWorkspaceHelper(core, source);
  assert.equal(staged, join(core, 'bin', 'llmide-workspace'));
  // Windows has no POSIX file modes; the archive test below checks the mode where tar can carry it.
  if (process.platform !== 'win32') assert.equal(statSync(staged).mode & 0o777, 0o755);
});

// Skipped on Windows: the hub bundle is staged on Linux/macOS (stage-hub-core.mjs requires a '/' path), NTFS has no
// exec bit, and GNU tar there reads `C:` as a remote host.
test('the bundle archive lists core/bin/llmide-workspace as an executable', { skip: process.platform === 'win32' && 'hub staging is POSIX-only' }, (t) => {
  const dir = scratch(t);
  const stage = join(dir, 'stage');
  const core = join(stage, 'core');
  mkdirSync(core, { recursive: true });
  writeFileSync(join(stage, 'VERSION'), '0.0.0\n');
  const source = join(dir, 'source-helper');
  writeFileSync(source, ELF_STANDIN);
  stageWorkspaceHelper(core, source);
  const tarball = join(dir, 'bundle.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const listing = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8' });
  const line = listing.split('\n').find((entry) => entry.endsWith('core/bin/llmide-workspace'));
  assert.ok(line, listing);
  assert.ok(line.startsWith('-rwxr-xr-x '), line);
});
