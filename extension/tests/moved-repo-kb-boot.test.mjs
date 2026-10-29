// A server (or any config importer) started in the repo-kb layout after the
// data was moved must refuse BEFORE creating any file in kb/ — notably a new
// .dev-secrets.json with a different key. Runs against a temp copy of the
// extension tree so the real repo kb is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDevSecrets } from '../core/dev-secrets.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = ['core', 'kb', 'server', 'routes', 'agents', 'connectors', 'graphkit', 'guardrails',
  'llm-sources', 'llm_agent', 'mcp', 'plugins', 'providers', 'graph_generation', 'scripts'];

let work; let repo; let kb;

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-moved-boot-'));
  repo = path.join(work, 'repo');
  const ext = path.join(repo, 'extension');
  fs.mkdirSync(ext, { recursive: true });
  for (const d of COPY) if (fs.existsSync(path.join(EXT, d))) fs.cpSync(path.join(EXT, d), path.join(ext, d), { recursive: true });
  for (const f of ['server.mjs', 'package.json']) fs.copyFileSync(path.join(EXT, f), path.join(ext, f));
  fs.symlinkSync(path.join(EXT, 'node_modules'), path.join(ext, 'node_modules'));
  kb = path.join(repo, 'kb');
  fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, 'MOVED-TO-APP-SUPPORT.txt'), 'moved');
});
after(() => { fs.rmSync(work, { recursive: true, force: true }); });

const childEnv = (extra = {}) => {
  const env = { ...process.env, HOME: path.join(work, 'home'), ...extra };
  for (const k of Object.keys(env)) {
    if ((k === 'NODE_TEST_CONTEXT' || k.startsWith('LLMIDE_')) && !(k in extra)) delete env[k];
  }
  return env;
};
const listing = () => fs.readdirSync(kb).sort();
const run = (args, extra) => spawnSync(process.execPath, args, {
  cwd: path.join(repo, 'extension'), env: childEnv(extra), encoding: 'utf8', timeout: 60000,
});

test('a moved repo-kb server boot refuses and creates no file in kb/', () => {
  const before = listing();
  const r = run(['server.mjs']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Refusing to start: the data in .* was moved/);
  assert.deepEqual(listing(), before);
});

test('importing config on a moved repo kb throws and creates no file in kb/', () => {
  const before = listing();
  const r = run(['--input-type=module', '-e', "await import('./core/config.mjs')"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /was moved to the app data directory/);
  assert.deepEqual(listing(), before);
  assert.equal(fs.existsSync(path.join(kb, '.dev-secrets.json')), false);
});

test('LLMIDE_ALLOW_EMPTY_LEGACY=1 behaves as before: secrets are generated in kb/', () => {
  const r = run(['--input-type=module', '-e', "await import('./core/config.mjs')"], { LLMIDE_ALLOW_EMPTY_LEGACY: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(kb, '.dev-secrets.json')), true);
  fs.rmSync(path.join(kb, '.dev-secrets.json'));
});

test('a test-run import of config never touches the repo kb', () => {
  const before = listing();
  const r = run(['--input-type=module', '-e', "await import('./core/config.mjs')"], { NODE_TEST_CONTEXT: 'child-v8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listing(), before);
});

test('ephemeral dev secrets read and write no file', () => {
  const file = path.join(work, 'never', '.dev-secrets.json');
  const s = loadDevSecrets({ primaryFile: file, ephemeral: true });
  assert.equal(s.generated, true);
  assert.ok(s.jwtSecret.length >= 32 && s.vaultKey.length >= 32);
  assert.equal(fs.existsSync(path.dirname(file)), false);
});
