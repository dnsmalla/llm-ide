import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { validateSource, decodeSourceHeader, getSource, setSource, removeSource, readSources, pruneSources } from '../plugins/source-store.mjs';

const C = 'a'.repeat(40); const T = 'b'.repeat(40);
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function pdir() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srcstore-')); const d = path.join(root, 'plugins'); fs.mkdirSync(d); return d; }

test('valid git / marketplace / zip records normalize to allowed keys', () => {
  assert.deepEqual(validateSource({ kind: 'git', url: 'https://github.com/o/r.git', ref: 'main', commit: C, extra: 1 }),
    { ok: true, source: { kind: 'git', url: 'https://github.com/o/r.git', ref: 'main', commit: C } });
  assert.equal(validateSource({ kind: 'marketplace', url: 'git@github.com:o/mp.git', ref: null, commit: C, entry: 'demo', path: 'plugins/demo', tree: T, version: '1.2.0' }).ok, true);
  assert.deepEqual(validateSource({ kind: 'zip', fileName: 'x.zip' }), { ok: true, source: { kind: 'zip', fileName: 'x.zip' } });
});

test('absent ref is omitted, null ref is kept', () => {
  assert.equal('ref' in validateSource({ kind: 'git', url: 'https://github.com/o/r.git', commit: C }).source, false);
  assert.equal(validateSource({ kind: 'git', url: 'https://github.com/o/r.git', ref: null, commit: C }).source.ref, null);
});

test('scp form with a normal host stays valid', () => {
  assert.equal(validateSource({ kind: 'git', url: 'git@github.com:o/r.git', commit: C }).ok, true);
});

test('rejects unsafe values', () => {
  for (const bad of [
    { kind: 'git', url: 'http://localhost/r.git', commit: C },
    { kind: 'git', url: 'https://127.0.0.1/r.git', commit: C },
    { kind: 'git', url: 'https://box.local/r.git', commit: C },
    { kind: 'git', url: 'https://github.com/o/r.git', ref: '--upload-pack=x', commit: C },
    { kind: 'git', url: 'https://github.com/o/r.git', commit: 'zz' },
    { kind: 'git', url: 'https://github.com/o/r .git', commit: C },
    { kind: 'git', url: 'file:///etc', commit: C },
    { kind: 'git', url: 'https://github.com/o/r.git' },
    { kind: 'marketplace', url: 'https://h.example/o/mp.git', commit: C, entry: 'demo', path: '../x', tree: T },
    { kind: 'marketplace', url: 'https://h.example/o/mp.git', commit: C, entry: 'demo', path: '/abs', tree: T },
    { kind: 'marketplace', url: 'https://h.example/o/mp.git', commit: C, entry: 'Demo', path: 'p', tree: T },
    { kind: 'marketplace', url: 'https://h.example/o/mp.git', commit: C, entry: 'demo', path: 'p' },
    { kind: 'zip', fileName: 'a/b.zip' },
    { kind: 'zip' },
    { kind: 'git', url: 'https://user:pw@github.com/o/r.git', commit: C },
    { kind: 'git', url: 'https://user@github.com/o/r.git', commit: C },
    { kind: 'git', url: 'https://github.com/o/r.git?x=1', commit: C },
    { kind: 'git', url: 'https://github.com/o/r.git#frag', commit: C },
    { kind: 'git', url: 'https://localhost./r.git', commit: C },
    { kind: 'git', url: 'https://app.localhost/r.git', commit: C },
    { kind: 'git', url: 'https://0.0.0.0/r.git', commit: C },
    { kind: 'git', url: 'https://169.254.169.254/r.git', commit: C },
    { kind: 'git', url: 'https://10.0.0.5/r.git', commit: C },
    { kind: 'git', url: 'https://192.168.1.1/r.git', commit: C },
    { kind: 'git', url: 'https://172.16.0.1/r.git', commit: C },
    { kind: 'git', url: 'https://2130706433/r.git', commit: C },
    { kind: 'git', url: 'https://[::1]/r.git', commit: C },
    { kind: 'git', url: 'https://box.local./r.git', commit: C },
    { kind: 'git', url: 'git@localhost:o/r.git', commit: C },
    { kind: 'git', url: 'git@127.0.0.1:o/r.git', commit: C },
    { kind: 'git', url: 'git@box.local:o/r.git', commit: C },
    { kind: 'git', url: 'git@127.1:x', commit: C },
    { kind: 'git', url: 'git@2130706433:x', commit: C },
    { kind: 'git', url: 'git@0x7f000001:x', commit: C },
    { kind: 'git', url: 'git@-host.com:o/r.git', commit: C },
    { kind: 'git', url: 'git@github.com:-o/r.git', commit: C },
    { kind: 'git', url: 'git@github.com:o/../r.git', commit: C },
    ...['a//b', 'a/', './x', 'a/./b', 'a\\b'].map((path) => ({ kind: 'marketplace', url: 'https://h.example/o/mp.git', commit: C, entry: 'demo', path, tree: T })),
    { kind: 'svn' },
    null,
  ]) assert.equal(validateSource(bad).ok, false, JSON.stringify(bad));
});

test('header decoding', () => {
  assert.deepEqual(decodeSourceHeader(undefined), { ok: true, source: null });
  assert.deepEqual(decodeSourceHeader(''), { ok: true, source: null });
  assert.equal(decodeSourceHeader(enc({ kind: 'zip', fileName: 'x.zip' })).ok, true);
  assert.equal(decodeSourceHeader('!!!').ok, false);
  assert.equal(decodeSourceHeader(Buffer.alloc(3000, 'a').toString('base64url')).ok, false);
});

test('record is only what the route wrote', () => {
  const d = pdir();
  fs.mkdirSync(path.join(d, 'demo')); fs.writeFileSync(path.join(d, 'demo', 'plugin-sources.json'), '{"demo":{"kind":"git"}}');
  assert.equal(getSource('demo', d), null);
  setSource('demo', { kind: 'zip', fileName: 'x.zip' }, d);
  assert.equal(getSource('demo', d).kind, 'zip');
  assert.match(getSource('demo', d).installedAt, /^\d{4}-/);
});

test('remove drops the record; corrupt file reads as empty', () => {
  const d = pdir();
  setSource('demo', { kind: 'zip', fileName: 'x.zip' }, d);
  removeSource('demo', d);
  assert.equal(getSource('demo', d), null);
  fs.writeFileSync(path.join(path.dirname(d), 'plugin-sources.json'), '{nope');
  assert.deepEqual(readSources(d), {});
});

test('pruneSources drops records for plugins that are not installed', () => {
  const d = pdir();
  setSource('keep', { kind: 'zip', fileName: 'k.zip' }, d);
  setSource('gone', { kind: 'zip', fileName: 'g.zip' }, d);
  pruneSources(new Set(['keep']), d);
  assert.deepEqual(Object.keys(readSources(d)), ['keep']);
});
