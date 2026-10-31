import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeCopyFilter, verifyStagedCore } from './stage-filter.mjs';

const SKIP_FILE = /(\.db(-wal|-shm|-journal)?|\.log(\.old)?|\.DS_Store)$/;
const put = (root, rel, body = 'x') => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  return p;
};
const tmp = (n) => mkdtempSync(join(tmpdir(), `stage-${n}-`));

function devExtension() {
  const ext = tmp('ext');
  put(ext, 'server.mjs');
  put(ext, 'kb/db.mjs');
  put(ext, 'kb/migrations/0001_init.sql');
  put(ext, 'kb/agent-migrations/0001.sql');
  put(ext, 'kb/schema.json');
  for (const f of ['kb/data.db', 'kb/data.db-wal', 'kb/data.db.pre-move', 'kb/agent.db.pre-move', 'kb/notes.bak', 'kb/db.mjs.bak',
    'kb/.dev-secrets', 'kb/.dev-secrets.json', 'kb/server.log', 'kb/server.log.old', 'kb/readme.txt', 'kb/dump.csv',
    'kb/backups/data-1.db', 'kb/backups/note.sql', 'kb/migrations/0002.sql.orig']) put(ext, f);
  return ext;
}

test('copy filter lets only .mjs/.json/.sql through under kb/ and nothing from backups', () => {
  const ext = devExtension();
  const out = tmp('out');
  cpSync(ext, out, { recursive: true, filter: makeCopyFilter(ext, { skipFile: SKIP_FILE }) });
  for (const keep of ['server.mjs', 'kb/db.mjs', 'kb/migrations/0001_init.sql', 'kb/agent-migrations/0001.sql', 'kb/schema.json']) {
    assert.ok(existsSync(join(out, keep)), keep);
  }
  for (const gone of ['kb/data.db', 'kb/data.db-wal', 'kb/data.db.pre-move', 'kb/agent.db.pre-move', 'kb/notes.bak', 'kb/db.mjs.bak', 'kb/.dev-secrets',
    'kb/.dev-secrets.json', 'kb/server.log', 'kb/readme.txt', 'kb/dump.csv', 'kb/backups', 'kb/migrations/0002.sql.orig']) {
    assert.ok(!existsSync(join(out, gone)), `${gone} must not be staged`);
  }
  assert.deepEqual(verifyStagedCore(out), []);
});

test('copy filter drops symlinks', () => {
  const ext = devExtension();
  symlinkSync('/etc/hosts', join(ext, 'kb', 'hosts.mjs'));
  const out = tmp('out');
  cpSync(ext, out, { recursive: true, filter: makeCopyFilter(ext, { skipFile: SKIP_FILE }) });
  assert.ok(!existsSync(join(out, 'kb', 'hosts.mjs')));
});

test('verification fails on every forbidden artefact and on escaping symlinks', () => {
  const core = tmp('core');
  const cases = ['root/extension/kb/data.db', 'root/extension/kb/data.db.pre-move', 'root/extension/kb/x.db-wal', 'root/extension/old.bak',
    'root/extension/.dev-secrets', 'root/extension/.dev-secrets.local', 'root/extension/server.log', 'root/extension/kb/backups/a.sql',
    'root/extension/.env', 'root/extension/kb/notes.txt'];
  for (const c of cases) {
    const p = put(core, c);
    const problems = verifyStagedCore(core);
    assert.ok(problems.length > 0, `${c} was not flagged`);
    rmSync(p, { recursive: true, force: true });
    rmSync(join(core, 'root/extension/kb/backups'), { recursive: true, force: true });
  }
  assert.deepEqual(verifyStagedCore(core), []);
  symlinkSync('/etc', join(core, 'root', 'extension', 'escape'));
  assert.ok(verifyStagedCore(core).some((m) => m.includes('symlink leaves')));
  rmSync(join(core, 'root', 'extension', 'escape'));
  symlinkSync(join(core, 'root'), join(core, 'root', 'extension', 'inside'));
  assert.deepEqual(verifyStagedCore(core), [], 'a symlink that stays inside the tree is fine');
  symlinkSync('/nonexistent-target', join(core, 'dangling'));
  assert.ok(verifyStagedCore(core).some((m) => m.includes('dangling')));
});

test('node_modules is not name-checked (a package may ship a .db fixture)', () => {
  const core = tmp('nm');
  put(core, 'root/extension/node_modules/pkg/fixture.db');
  assert.deepEqual(verifyStagedCore(core), []);
});
