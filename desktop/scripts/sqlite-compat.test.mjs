// desktop/scripts/sqlite-compat.test.mjs
// Tests for the glibc 2.28 better-sqlite3 module that SSH mode uploads: helpers, the symbol-ceiling gate
// (run through its CLI on fixture objdump text), the checksum pre-flight of the staging script, and text
// asserts on the workflow that can fail when the gate, the smoke step or the pins are removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync as readRaw, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkCeilings,
  compatBundleName,
  integrityOf,
  lockedPackage,
  maxGlibc,
  readCompatModule,
  symbolCeilings,
  verifyCompatModule,
} from './sqlite-compat.mjs';

// Windows checks the workflows out with CRLF; the asserts are written against LF.
const readFileSync = (p, enc) => readRaw(p, enc).replace(/\r\n/g, '\n');
const SCRIPTS = import.meta.dirname;
const REPO = join(SCRIPTS, '..', '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'sqlite-linux-compat.yml');
const wf = () => readFileSync(WORKFLOW, 'utf8');

// Lines in the shape `objdump -T` prints for dynamic symbols (version tag in its own column).
const objdumpLine = (tag, symbol) => `0000000000000000      DF *UND*  0000000000000000  ${tag}  ${symbol}`;
const fixture = (...tags) => tags.map((tag, i) => objdumpLine(tag, `sym_${i}`)).join('\n') + '\n';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'sqlite-compat-test-'));
}

test('compat bundle name carries the version and the compat suffix', () => {
  assert.equal(compatBundleName('1.2.3'), 'llmide-core-1.2.3-linux-x64-compat.tar.gz');
});

test('verifyCompatModule accepts matching bytes and rejects a wrong digest', () => {
  const bytes = Buffer.from('stand-in module');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.doesNotThrow(() => verifyCompatModule(bytes, digest));
  assert.throws(() => verifyCompatModule(bytes, '0'.repeat(64)), /compat sqlite checksum mismatch/);
});

test('readCompatModule returns the bytes when the sibling .sha256 matches', () => {
  const dir = tempDir();
  const file = join(dir, 'standin.node');
  const bytes = Buffer.from('stand-in module');
  writeFileSync(file, bytes);
  const shaFile = `${file}.sha256`;
  writeFileSync(shaFile, `${createHash('sha256').update(bytes).digest('hex')}  standin.node\n`);
  assert.deepEqual(readCompatModule(file), bytes);
});

test('readCompatModule rejects a wrong digest and a missing .sha256, naming the file', () => {
  const dir = tempDir();
  const file = join(dir, 'standin.node');
  writeFileSync(file, 'stand-in module');
  const shaFile = `${file}.sha256`;
  writeFileSync(shaFile, `${'0'.repeat(64)}  standin.node\n`);
  assert.throws(() => readCompatModule(file), (err) => err.message === `compat sqlite checksum mismatch: ${file}`);
  const orphan = join(dir, 'orphan.node');
  writeFileSync(orphan, 'x');
  assert.throws(() => readCompatModule(orphan), /compat sqlite checksum file missing/);
});

test('integrityOf produces the npm sha512 form and matches a known vector', () => {
  // sha512 of the empty input, in the base64 form the npm registry and package-lock.json use.
  assert.equal(
    integrityOf(Buffer.from('')),
    'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
  );
});

test('lockedPackage returns the pinned version and integrity, and fails when the entry is missing', () => {
  const lock = { packages: { 'node_modules/node-addon-api': { version: '8.9.2', integrity: 'sha512-abc' } } };
  assert.deepEqual(lockedPackage(lock, 'node_modules/node-addon-api'), { version: '8.9.2', integrity: 'sha512-abc' });
  assert.throws(() => lockedPackage(lock, 'node_modules/better-sqlite3'), /no pinned version for node_modules\/better-sqlite3/);
  assert.throws(() => lockedPackage({}, 'node_modules/node-addon-api'), /no pinned version/);
});

test('maxGlibc returns the highest GLIBC version, compared numerically', () => {
  assert.equal(maxGlibc(['GLIBC_2.2.5', 'GLIBC_2.28', 'GLIBC_2.17']), '2.28');
  assert.equal(maxGlibc(['GLIBC_2.34', 'GLIBC_2.4']), '2.34');
  assert.equal(maxGlibc([]), '0');
});

test('maxGlibc ignores symbols from other version families', () => {
  assert.equal(maxGlibc(['GLIBCXX_3.4.30', 'CXXABI_1.3', 'GLIBC_2.17']), '2.17');
});

test('symbolCeilings reads the highest of each family from objdump text', () => {
  const text = fixture('GLIBC_2.2.5', 'GLIBC_2.28', 'GLIBCXX_3.4.9', 'GLIBCXX_3.4.28', 'CXXABI_1.3.12');
  assert.deepEqual(symbolCeilings(text), { glibc: '2.28', glibcxx: '3.4.28', cxxabi: '1.3.12' });
});

test('symbolCeilings reports 0 for a family that is absent', () => {
  assert.deepEqual(symbolCeilings(fixture('GLIBC_2.2.5')), { glibc: '2.2.5', glibcxx: '0', cxxabi: '0' });
  assert.deepEqual(symbolCeilings(''), { glibc: '0', glibcxx: '0', cxxabi: '0' });
});

test('symbolCeilings ignores non-numeric tags such as GLIBC_PRIVATE', () => {
  assert.deepEqual(symbolCeilings(fixture('GLIBC_PRIVATE')), { glibc: '0', glibcxx: '0', cxxabi: '0' });
});

test('GLIBC_ does not match inside a GLIBCXX_ tag', () => {
  assert.equal(symbolCeilings(fixture('GLIBCXX_3.4.29')).glibc, '0');
});

test('checkCeilings passes at exactly the limits (2.28, 3.4.28, 1.3.12)', () => {
  assert.deepEqual(checkCeilings(fixture('GLIBC_2.28', 'GLIBCXX_3.4.28', 'CXXABI_1.3.12')), []);
});

test('checkCeilings fails for GLIBC_2.34, the prebuild the Ubuntu 20.04 server cannot load', () => {
  const problems = checkCeilings(fixture('GLIBC_2.34'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GLIBC_2\.34 is above the GLIBC_2\.28 ceiling/);
});

test('checkCeilings compares GLIBC numerically: 2.4 passes, 2.34 does not', () => {
  assert.deepEqual(checkCeilings(fixture('GLIBC_2.4')), []);
  assert.deepEqual(checkCeilings(fixture('GLIBC_2.4', 'GLIBC_2.34')).length, 1);
});

test('checkCeilings fails for GLIBCXX_3.4.29 and for CXXABI_1.3.13', () => {
  const glibcxx = checkCeilings(fixture('GLIBCXX_3.4.29'));
  assert.equal(glibcxx.length, 1);
  assert.match(glibcxx[0], /GLIBCXX_3\.4\.29 is above the GLIBCXX_3\.4\.28 ceiling/);
  const cxxabi = checkCeilings(fixture('CXXABI_1.3.13'));
  assert.equal(cxxabi.length, 1);
  assert.match(cxxabi[0], /CXXABI_1\.3\.13 is above the CXXABI_1\.3\.12 ceiling/);
});

test('checkCeilings reports every family above its limit, one problem each', () => {
  assert.equal(checkCeilings(fixture('GLIBC_2.34', 'GLIBCXX_3.4.29', 'CXXABI_1.3.13')).length, 3);
});

test('the gate CLI exits 1 on a bad fixture and names the problem', () => {
  const dir = tempDir();
  const file = join(dir, 'objdump.txt');
  writeFileSync(file, fixture('GLIBC_2.34'));
  const run = spawnSync(process.execPath, [join(SCRIPTS, 'sqlite-compat-check.mjs'), file], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /GLIBC_2\.34 is above the GLIBC_2\.28 ceiling/);
  assert.match(run.stdout, /highest symbol versions: GLIBC 2\.34/);
});

test('the gate CLI fails on empty input and on input with no versioned symbols', () => {
  for (const input of ['', 'objdump: not a dynamic object\n']) {
    const run = spawnSync(process.execPath, [join(SCRIPTS, 'sqlite-compat-check.mjs')], { input, encoding: 'utf8' });
    assert.equal(run.status, 1, `exit ${run.status} for ${JSON.stringify(input)}`);
    assert.match(run.stderr, /no versioned symbols found/);
  }
});

test('the gate CLI exits 0 on a good fixture and reads stdin when no file is given', () => {
  const good = fixture('GLIBC_2.2.5', 'GLIBC_2.28', 'GLIBCXX_3.4.28', 'CXXABI_1.3.12');
  const run = spawnSync(process.execPath, [join(SCRIPTS, 'sqlite-compat-check.mjs')], { input: good, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /GLIBC 2\.28, GLIBCXX 3\.4\.28, CXXABI 1\.3\.12/);
});

// Skipped on Windows: stage-hub-core.mjs is POSIX-only and exits 2 on a drive-letter --out before reaching the checksum.
test('staging refuses a wrong .sha256 before creating the output dir or any compat bundle', { skip: process.platform === 'win32' && 'hub staging is POSIX-only' }, () => {
  const dir = tempDir();
  const module = join(dir, 'standin.node');
  writeFileSync(module, 'stand-in module');
  const shaFile = `${module}.sha256`;
  writeFileSync(shaFile, `${'0'.repeat(64)}  standin.node\n`);
  const out = join(dir, 'out');
  const run = spawnSync(process.execPath, [join(SCRIPTS, 'stage-hub-core.mjs'), '--compat-sqlite', module, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /compat sqlite checksum mismatch/);
  assert.equal(existsSync(out), false, 'the output dir must not be created on a checksum failure');
});

test('the workflow runs the gate CLI on the built module, after the build', () => {
  const text = wf();
  assert.match(text, /node "\$GITHUB_WORKSPACE\/desktop\/scripts\/sqlite-compat-check\.mjs"/);
  assert.ok(existsSync(join(SCRIPTS, 'sqlite-compat-check.mjs')));
  assert.ok(text.indexOf('sqlite-compat-check.mjs') > text.indexOf('node-gyp rebuild'));
});

test('the workflow links the module against static libstdc++ and libgcc', () => {
  assert.match(wf(), /LDFLAGS: -static-libstdc\+\+ -static-libgcc/);
});

test('the workflow loads the built module and runs a query before publishing the artifact', () => {
  const text = wf();
  assert.match(text, /nativeBinding: process\.argv\[1\]/);
  assert.match(text, /select 1 as x/);
  assert.ok(text.indexOf('select 1 as x') < text.indexOf('actions/upload-artifact@'));
});

test('the workflow reads both pins from the lockfile and checks the tarball integrity', () => {
  const text = wf();
  assert.match(text, /extension\/package-lock\.json/);
  assert.match(text, /lockedPackage\(lock, 'node_modules\/better-sqlite3'\)/);
  assert.match(text, /lockedPackage\(lock, 'node_modules\/node-addon-api'\)/);
  assert.match(text, /integrityOf\(readFileSync/);
  assert.doesNotMatch(text, /13\.0\.3/);
});

test('the workflow pins the manylinux 2.28 container and Node 22.23.4, matching node-pin.json', () => {
  const text = wf();
  assert.match(text, /image: quay\.io\/pypa\/manylinux_2_28_x86_64/);
  assert.match(text, /NODE_VERSION: '22\.23\.4'/);
  const pin = JSON.parse(readFileSync(join(SCRIPTS, 'node-pin.json'), 'utf8'));
  assert.equal(pin.version, '22.23.4');
});

test('the workflow is dispatch-only, reads with contents: read, and has no push or PR trigger', () => {
  const text = wf();
  assert.match(text, /^on:\s*\n\s+workflow_dispatch:\s*\n/m);
  assert.doesNotMatch(text, /^\s*(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(text, /^permissions:\s*\n\s+contents: read\s*$/m);
});

test('every expression in the workflow sits on a key: value line, so none is spliced into a shell script', () => {
  const offenders = wf().split('\n').filter((line) => line.includes('${{') && !/^\s*[\w-]+:\s*\$\{\{/.test(line));
  assert.deepEqual(offenders, []);
});

test('the compat workflow ships no extra files beside the module and its checksum', () => {
  // The artifact path is the only publishing surface; a second glob would widen what leaves the runner.
  const paths = readdirSync(join(REPO, '.github', 'workflows')).filter((f) => f.startsWith('sqlite-linux-compat'));
  assert.deepEqual(paths, ['sqlite-linux-compat.yml']);
  assert.match(wf(), /sqlite-compat-out\/\*\.node\.sha256/);
});
