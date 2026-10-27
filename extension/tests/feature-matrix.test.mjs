// Pure logic of the feature matrix (scripts/feature-matrix.mjs): the closure,
// the row table, the quadrant selections against the Makefile, the server and
// live-test environments, and argument parsing. No servers are booted here;
// the matrix itself is run by `make feature-matrix`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_KEYS, EXCLUDABLE, ROWS, cleanInherited, enabledAfter, groupOf, isFailed,
  liveEnv, parseArgs, select, serverEnv, table,
} from '../../scripts/feature-matrix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rowById = (id) => ROWS.find((r) => r.id === id);

test('enabledAfter with nothing off returns every key, sorted', () => {
  assert.deepEqual(enabledAfter([]), [...ALL_KEYS].sort());
});

test('enabledAfter(file_explorer) closes over its three dependents', () => {
  assert.deepEqual(enabledAfter(['file_explorer']), ['agent_chat', 'auto_tasks', 'mobile_sync', 'terminal']);
});

test('enabledAfter of a non-dependency key removes only that key', () => {
  assert.deepEqual(
    enabledAfter(['terminal']),
    ALL_KEYS.filter((k) => k !== 'terminal').sort(),
  );
});

test('a dependent switched off alone does not take its dependency with it', () => {
  assert.ok(enabledAfter(['doc_gen']).includes('file_explorer'));
});

test('ROWS ids are unique and every excludable key has its own row', () => {
  const ids = ROWS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const k of ['code_graph_3d', 'gantt_issues', 'terminal', 'doc_gen', 'mobile_sync', 'auto_tasks']) {
    assert.ok(ids.includes(k), `missing single-key row ${k}`);
  }
  assert.ok(ids.includes('closure:file_explorer'));
});

test('closure row disables file_explorer and its three dependents', () => {
  assert.deepEqual(rowById('closure:file_explorer').disabled.sort(), ['code_graph_3d', 'doc_gen', 'file_explorer', 'gantt_issues']);
});

test('each row partitions ALL_KEYS into enabled and disabled', () => {
  for (const row of ROWS) {
    assert.deepEqual([...row.enabled, ...row.disabled].sort(), [...ALL_KEYS].sort(), row.id);
  }
});

test('row.features lists every key minus the row off-keys (closure dependents included)', () => {
  const list = rowById('terminal').features.split(',');
  assert.equal(list.includes('terminal'), false);
  assert.equal(list.length, ALL_KEYS.length - 1);
});

test('quadrant rows carry the same enabled sets as the Makefile build-mac-* targets', () => {
  const makefile = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8');
  const featuresFor = (target) => {
    const block = makefile.split(`\n${target}:`)[1] ?? '';
    const m = /LLMIDE_FEATURES=([a-z_,]+)/.exec(block.split('\n')[0] + block.split('\n')[1]);
    assert.ok(m, `no LLMIDE_FEATURES for ${target}`);
    return m[1].split(',').sort();
  };
  assert.deepEqual(rowById('lite').enabled, featuresFor('build-mac-lite'));
  assert.deepEqual(rowById('min').enabled, featuresFor('build-mac-min'));
  assert.deepEqual(rowById('mobile-only').enabled, featuresFor('build-mac-mobile-only'));
});

test('groupOf maps feature-owned route prefixes and leaves always-on routes alone', () => {
  assert.equal(groupOf('/kb/loop/agent-run'), 'auto_tasks');
  assert.equal(groupOf('/kb/issue-schedule'), 'gantt_issues');
  assert.equal(groupOf('/kb/ingest-code-graph'), 'code_graph_3d');
  assert.equal(groupOf('/generate-doc'), 'doc_gen');
  assert.equal(groupOf('/generate-docx'), null);
  assert.equal(groupOf('/kb/dispatch'), null);
});

test('cleanInherited drops LLMIDE_*, ANTHROPIC_*, NODE_TEST_CONTEXT and NODE_ENV only', () => {
  const env = cleanInherited({
    PATH: '/bin', HOME: '/h', LLMIDE_FEATURES: 'x', LLMIDE_DB_PATH: '/x', ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_BASE_URL: 'u', NODE_TEST_CONTEXT: 'c', NODE_ENV: 'production',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('serverEnv sets the deliberate values and nothing inherited leaks through', () => {
  const row = rowById('doc_gen');
  const env = serverEnv(row, '/tmp/d', 3999, {
    PATH: '/bin', LLMIDE_FEATURES: 'auto_tasks', ANTHROPIC_API_KEY: 'secret', LLMIDE_PORT: '1',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.LLMIDE_FEATURES, row.features);
  assert.equal(env.LLMIDE_PORT, '3999');
  assert.equal(env.LLMIDE_HOST, '127.0.0.1');
  assert.equal(env.LLMIDE_DB_PATH, '/tmp/d/kb.db');
  assert.equal(env.LLMIDE_ENGINE_PREWARM, '0');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('liveEnv carries the assert-mode settings and strips inherited LLMIDE_FEATURES', () => {
  const row = rowById('lite');
  const env = liveEnv(row, { LLMIDE_FEATURES: 'everything', PATH: '/bin' });
  assert.equal(env.CONTRACT_EXPECT_DISABLED, '1');
  assert.equal(env.CONTRACT_FEATURES, row.features);
  assert.equal(env.LLMIDE_FEATURES, undefined);
  assert.equal(env.PATH, '/bin');
});

test('select returns every row, or the named ones (file_explorer maps to its closure row)', () => {
  assert.equal(select({ keys: [] }).length, ROWS.length);
  assert.deepEqual(select({ keys: ['file_explorer', 'lite'] }).map((r) => r.id), ['closure:file_explorer', 'lite']);
  assert.throws(() => select({ keys: ['nope'] }), /unknown row nope/);
});

test('parseArgs: --mac-only implies --mac and has no server side', () => {
  const args = parseArgs(['--all', '--mac-only']);
  assert.equal(args.all, true);
  assert.equal(args.mac, true);
  assert.equal(args.macOnly, true);
  assert.equal(parseArgs(['--all']).mac, false);
});

test('parseArgs rejects an unknown flag and a dangling --key', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--key']), /needs a row id/);
});

test('isFailed treats boot/server, live and mac failures as failed and skipped sides as passing', () => {
  const row = rowById('terminal');
  assert.equal(isFailed({ row, server: { ok: true }, live: { ok: true }, mac: null }), false);
  assert.equal(isFailed({ row, server: { ok: false }, live: null, mac: null }), true);
  assert.equal(isFailed({ row, server: null, live: { ok: false }, mac: null }), true);
  assert.equal(isFailed({ row, server: null, live: null, mac: { ok: false } }), true);
  assert.equal(isFailed({ row, server: null, live: null, mac: { ok: true } }), false);
});

test('table shows - for sides that did not run (mac-only)', () => {
  const out = table([{ row: rowById('terminal'), server: null, live: null, mac: { ok: true, secs: 12 } }]);
  assert.match(out, /terminal\s+.*-\s+-\s+ok 12s/);
});
