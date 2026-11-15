// desktop/scripts/sqlite-compat.test.mjs
// Helpers for the glibc 2.28 better-sqlite3 module that SSH mode uploads, plus text asserts on its workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync as readRaw } from 'node:fs';
import { join } from 'node:path';
import { compatBundleName, maxGlibc, verifyCompatModule } from './sqlite-compat.mjs';

// Windows checks the workflows out with CRLF; the asserts are written against LF.
const readFileSync = (p, enc) => readRaw(p, enc).replace(/\r\n/g, '\n');
const WF = join(import.meta.dirname, '..', '..', '.github', 'workflows');
const wf = () => readFileSync(join(WF, 'sqlite-linux-compat.yml'), 'utf8');

test('compat bundle name carries the version and the compat suffix', () => {
  assert.equal(compatBundleName('1.2.3'), 'llmide-core-1.2.3-linux-x64-compat.tar.gz');
});

test('verifyCompatModule accepts matching bytes and rejects a wrong digest', () => {
  const bytes = Buffer.from('stand-in module');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.doesNotThrow(() => verifyCompatModule(bytes, digest));
  assert.throws(() => verifyCompatModule(bytes, '0'.repeat(64)), /compat sqlite checksum mismatch/);
});

test('maxGlibc returns the highest GLIBC version, compared numerically', () => {
  assert.equal(maxGlibc(['GLIBC_2.2.5', 'GLIBC_2.28', 'GLIBC_2.17']), '2.28');
  assert.equal(maxGlibc(['GLIBC_2.34', 'GLIBC_2.4']), '2.34');
  assert.equal(maxGlibc([]), '0');
});

test('maxGlibc ignores symbols from other version families', () => {
  assert.equal(maxGlibc(['GLIBCXX_3.4.30', 'CXXABI_1.3', 'GLIBC_2.17']), '2.17');
});

test('the workflow pins the manylinux 2.28 container and Node 22.23.4, and is dispatch-only', () => {
  const text = wf();
  assert.match(text, /quay\.io\/pypa\/manylinux_2_28_x86_64/);
  assert.match(text, /22\.23\.4/);
  assert.match(text, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(text, /^\s*(push|pull_request|pull_request_target|schedule):/m);
});

test('the workflow reads better-sqlite3 from the lockfile and checks the glibc ceiling', () => {
  const text = wf();
  assert.match(text, /extension\/package-lock\.json/);
  assert.match(text, /objdump -T/);
  assert.match(text, /GLIBC_/);
  assert.match(text, /2\.28/);
  assert.match(text, /^permissions:\s*\n\s+contents: read/m);
});
