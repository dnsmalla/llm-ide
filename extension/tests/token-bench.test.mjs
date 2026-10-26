// The token bench (scripts/token-bench.mjs, Phase 1 P17): its comparison logic,
// its metering and isolation helpers, and an end-to-end --fake run against a
// temp-DB server (no model calls: the server is started with LLMIDE_BENCH_FAKE=1
// and --bench-fake, which routes turns to llm_agent/sdk/bench-fake-engine.mjs).
//
// The end-to-end cases spawn the server on a free loopback port, so they need
// local listen permission (run the suite with the sandbox disabled).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  billableTokens, buildChildEnv, comparabilityProblems, compareResults, defaultBenchModel,
  ledgerRowsForTurns, loadScenarios, median, runBench, toolExpectationFailures,
} from '../../scripts/token-bench.mjs';
import { benchFakeEngineEnabled } from '../routes/agent-v2.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(EXT, '..');
const BENCH = path.join(ROOT, 'scripts', 'token-bench.mjs');
const SCENARIOS = path.join(ROOT, 'schema', 'bench', 'scenarios.json');
const FAKE_MODEL = 'bench-model';

const scenario = (id, billable, totalMs, extra = {}) => ({
  id, billableTokens: billable, totalMs, raw: {}, turns: 1, hops: 1, ...extra,
});
const run = (scenarios, extra = {}) => ({
  model: FAKE_MODEL, fake: true, scenariosVersion: 2, weights: { cacheRead: 0.1, cacheWrite: 1.25 },
  scenarios, ...extra,
});

test('billableTokens weights cache reads 0.1x and cache writes 1.25x', () => {
  assert.equal(billableTokens({ input: 10, output: 20, cacheRead: 1000, cacheWrite: 100 }), 10 + 20 + 100 + 125);
  assert.equal(billableTokens({}), 0);
});

test('median takes the middle value, and the mean of the two middles for an even count', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([]), null);
});

test('defaultBenchModel is the cheapest (fast) picker model from anthropic-models.json', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'models', 'anthropic-models.json'), 'utf8'));
  assert.equal(defaultBenchModel(), cfg.models.find((m) => m.fast).id);
});

test('loadScenarios reads the committed set (version 2) with the tool-expecting scenarios marked', () => {
  const { version, scenarios } = loadScenarios(SCENARIOS);
  assert.equal(version, 2);
  assert.deepEqual(scenarios.map((s) => s.id), [
    'greeting', 'explain-file', 'small-edit', 'plan-step', 'two-turn-reuse', 'long-tool-results', 'cache-slope',
  ]);
  assert.equal(scenarios.find((s) => s.id === 'two-turn-reuse').turns.length, 2);
  assert.equal(scenarios.find((s) => s.id === 'cache-slope').turns.length, 5);
  assert.deepEqual(
    scenarios.filter((s) => s.expectTools).map((s) => s.id),
    ['explain-file', 'small-edit', 'long-tool-results'],
  );
});

test('loadScenarios refuses an auto mode: the classifier must not be part of the measurement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-bench-scen-test-'));
  try {
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, scenarios: [{ id: 'x', mode: 'auto', turns: ['hi'] }] }));
    assert.throws(() => loadScenarios(file), /uses mode "auto"/);
    fs.writeFileSync(file, JSON.stringify({ version: 1, scenarios: [{ id: 'x', mode: 'auto_read_only', turns: ['hi'] }] }));
    assert.throws(() => loadScenarios(file), /auto_read_only/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compareResults passes an identical run and fails a >15% token regression on the median', () => {
  const base = { scenarios: [scenario('a', 1000, 10_000), scenario('b', 2000, 10_000)] };
  assert.equal(compareResults(structuredClone(base), base).failed, false);

  const worse = { scenarios: [scenario('a', 1160, 10_000), scenario('b', 2000, 10_000)] };
  const r = compareResults(worse, base);
  assert.equal(r.failed, true);
  assert.equal(r.rows.find((x) => x.id === 'a').status, 'REGRESSION');
  assert.equal(r.rows.find((x) => x.id === 'b').status, 'ok');

  // Exactly at the threshold is not a regression; just over it is.
  const edge = (tokens) => ({ scenarios: [scenario('a', tokens, 10_000), scenario('b', 2000, 10_000)] });
  assert.equal(compareResults(edge(1150), base).failed, false);
  assert.equal(compareResults(edge(1151), base).failed, true);
});

test('compareResults: time gate is 30% on the median and needs an absolute floor too', () => {
  const base = { scenarios: [scenario('a', 1000, 100)] };
  // +200% but only +200 ms: under the 500 ms floor, so jitter, not a regression.
  assert.equal(compareResults({ scenarios: [scenario('a', 1000, 300)] }, base).failed, false);
  // +50% and +5 s: a real slowdown.
  assert.equal(compareResults({ scenarios: [scenario('a', 1000, 5100)] }, { scenarios: [scenario('a', 1000, 3400)] }).failed, true);
  // +25% is under the 30% time gate.
  assert.equal(compareResults({ scenarios: [scenario('a', 1000, 4250)] }, { scenarios: [scenario('a', 1000, 3400)] }).failed, false);
  // Thresholds are configurable.
  assert.equal(compareResults({ scenarios: [scenario('a', 1000, 110)] }, base, { timePct: 5, timeFloorMs: 0 }).failed, true);
});

test('compareResults --time-advisory reports a slowdown without failing on it', () => {
  const base = { scenarios: [scenario('a', 1000, 3400)] };
  const slow = { scenarios: [scenario('a', 1000, 6000)] };
  const r = compareResults(slow, base, { timeAdvisory: true });
  assert.equal(r.failed, false);
  assert.equal(r.rows[0].status, 'time-advisory');
  assert.equal(compareResults(slow, base).failed, true);
});

test('compareResults fails a scenario missing from the run and reports a new one without failing', () => {
  const base = { scenarios: [scenario('a', 1000, 100), scenario('gone', 1000, 100)] };
  const cur = { scenarios: [scenario('a', 1000, 100), scenario('new', 5, 5)] };
  const r = compareResults(cur, base);
  assert.equal(r.failed, true);
  assert.equal(r.rows.find((x) => x.id === 'gone').status, 'missing');
  assert.equal(r.rows.find((x) => x.id === 'new').status, 'new');
});

test('comparabilityProblems refuses a baseline from another model, mode, scenario version or weights', () => {
  const cur = run([]);
  assert.deepEqual(comparabilityProblems(cur, run([])), []);
  assert.equal(comparabilityProblems(cur, run([], { model: 'other' })).length, 1);
  assert.equal(comparabilityProblems(cur, run([], { fake: false })).length, 1);
  assert.equal(comparabilityProblems(cur, run([], { scenariosVersion: 1 })).length, 1);
  assert.equal(comparabilityProblems(cur, run([], { weights: { cacheRead: 0.2, cacheWrite: 1.25 } })).length, 1);
  assert.equal(comparabilityProblems(cur, { scenarios: [] }).length, 4, 'an old-format baseline has no version or weights');
});

test('toolExpectationFailures flags tool scenarios with one API call per turn only', () => {
  const r = run([
    scenario('explain-file', 1, 1, { expectTools: true, hops: 1 }),
    scenario('small-edit', 1, 1, { expectTools: true, hops: 3 }),
    scenario('greeting', 1, 1, { hops: 1 }),
  ]);
  const f = toolExpectationFailures(r);
  assert.equal(f.length, 1);
  assert.match(f[0], /explain-file/);
});

test('ledgerRowsForTurns includes the :internal helper rows of a turn and nothing else', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE usage_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, endpoint TEXT, request_id TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER)`);
  const put = (user, endpoint, req, n) => db.prepare(
    'INSERT INTO usage_ledger (user_id, endpoint, request_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?,?,?,?,?,?,?)',
  ).run(user, endpoint, req, n, n, n, n);
  put('u1', '/agent/v2/stream', 't1', 1);
  put('u1', '/agent/v2/stream:internal', 't1', 10);      // helper model, same turn: counted
  put('u1', '/agent/v2/stream', 't2', 100);              // another turn: not counted
  put('u1', '/code-assist', 't1', 1000);                 // another endpoint: not counted
  put('u2', '/agent/v2/stream', 't1', 10_000);           // another user: not counted

  const rows = ledgerRowsForTurns(db, 'u1', ['t1']);
  assert.deepEqual(rows.map((r) => r.endpoint).sort(), ['/agent/v2/stream', '/agent/v2/stream:internal']);
  assert.equal(rows.reduce((n, r) => n + r.input_tokens, 0), 11);
  assert.deepEqual(ledgerRowsForTurns(db, 'u1', []), []);
  db.close();
});

test('buildChildEnv strips every LLMIDE_* variable, keeps HOME, and sets only the bench settings', () => {
  const base = {
    HOME: '/Users/tester', PATH: '/usr/bin', NODE_ENV: 'production', NODE_TEST_CONTEXT: 'x',
    LLMIDE_FEATURES: 'terminal', LLMIDE_BENCH_FAKE: '1', LLMIDE_DB_PATH: '/real/kb.db', LLMIDE_PORT: '3456',
    LLMIDE_ALLOW_REMOTE: '1',
  };
  const env = buildChildEnv(base, { port: 4000, dbPath: '/tmp/x.db', jwtSecret: 'j', vaultKey: 'v', fake: false });
  assert.equal(env.HOME, '/Users/tester');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.NODE_TEST_CONTEXT, undefined);
  assert.equal(env.LLMIDE_FEATURES, undefined);
  assert.equal(env.LLMIDE_ALLOW_REMOTE, undefined);
  assert.equal(env.LLMIDE_BENCH_FAKE, undefined, 'a real run never inherits the fake switch');
  assert.equal(env.LLMIDE_DB_PATH, '/tmp/x.db');
  assert.equal(env.LLMIDE_PORT, '4000');
  assert.equal(env.LLMIDE_HOST, '127.0.0.1');
  assert.equal(env.LLMIDE_ENGINE_PREWARM, '0');
  assert.equal(buildChildEnv(base, { port: 1, dbPath: 'd', jwtSecret: 'j', vaultKey: 'v', fake: true }).LLMIDE_BENCH_FAKE, '1');
});

test('the fake engine seam needs LLMIDE_BENCH_FAKE=1, the --bench-fake flag, and no production', () => {
  assert.equal(benchFakeEngineEnabled({ LLMIDE_BENCH_FAKE: '1' }, ['node', 'server.mjs', '--bench-fake']), true);
  assert.equal(benchFakeEngineEnabled({ LLMIDE_BENCH_FAKE: '1' }, ['node', 'server.mjs']), false, 'env alone is not enough');
  assert.equal(benchFakeEngineEnabled({}, ['node', 'server.mjs', '--bench-fake']), false, 'the flag alone is not enough');
  assert.equal(benchFakeEngineEnabled({ LLMIDE_BENCH_FAKE: '0' }, ['node', 'server.mjs', '--bench-fake']), false);
  assert.equal(
    benchFakeEngineEnabled({ LLMIDE_BENCH_FAKE: '1', NODE_ENV: 'production' }, ['node', 'server.mjs', '--bench-fake']),
    false,
  );
});

test('runBench --fake end to end: every turn metered, cache reused on the second turn', async () => {
  const { scenarios, version } = loadScenarios(SCENARIOS);
  const results = await runBench({
    fake: true, model: FAKE_MODEL, scenarios, scenariosVersion: version, repeat: 1,
  });
  assert.equal(results.fake, true);
  assert.equal(results.scenariosVersion, 2);
  assert.equal(results.scenarios.length, 7);
  for (const s of results.scenarios) {
    assert.ok(s.billableTokens > 0, `${s.id} billable`);
    assert.ok(s.raw.output > 0, `${s.id} output`);
    assert.equal(s.hops, s.turns, `${s.id} one fake API call per turn`);
    assert.equal(s.perTurn.length, s.turns, `${s.id} per-turn detail`);
    assert.ok(s.contextSplit && s.contextSplit.sdkContextTotalTokens > 0, `${s.id} context split`);
  }
  const reuse = results.scenarios.find((s) => s.id === 'two-turn-reuse');
  assert.ok(reuse.perTurn[1].cacheRead > 0, 'second turn reads the first turn back from cache');
  const slope = results.scenarios.find((s) => s.id === 'cache-slope');
  assert.ok(slope.perTurn[4].cacheRead > slope.perTurn[1].cacheRead, 'the cache-read slope grows with the chat');
  const greeting = results.scenarios.find((s) => s.id === 'greeting');
  assert.equal(greeting.raw.cacheRead, 0, 'a fresh chat reads nothing from cache');
  // The fake makes one API call per turn, so the tool scenarios warn in fake mode.
  assert.equal(toolExpectationFailures(results).length, 3);
});

test('CLI: --baseline --fake is refused (synthetic numbers are never a baseline)', () => {
  const r = spawnSync(process.execPath, [BENCH, '--baseline', '--fake'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to write a baseline from --fake/);
});

test('CLI: --fake compares medians with a baseline; 0 when unchanged, 1 on a >15% token regression, 2 when incomparable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-bench-cli-test-'));
  try {
    const { scenarios, version } = loadScenarios(SCENARIOS);
    const current = await runBench({
      fake: true, model: FAKE_MODEL, scenarios, scenariosVersion: version, repeat: 1,
    });
    const cli = (extra) => spawnSync(process.execPath, [
      BENCH, '--fake', '--model', FAKE_MODEL, '--repeat', '1', '--out', path.join(dir, 'r.json'), ...extra,
    ], { encoding: 'utf8' });

    const ok = path.join(dir, 'ok-baseline.json');
    fs.writeFileSync(ok, JSON.stringify(current));
    const pass = cli(['--baseline-file', ok]);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /PASS: no scenario regressed/);
    assert.match(pass.stdout, /WARN \(tool expectation\)/, 'fake mode warns about the tool scenarios');

    // A baseline 20% below what the run now bills: the run is a 25% regression.
    const low = structuredClone(current);
    for (const s of low.scenarios) s.billableTokens = Math.round(s.billableTokens / 1.25);
    const bad = path.join(dir, 'low-baseline.json');
    fs.writeFileSync(bad, JSON.stringify(low));
    const fail = cli(['--baseline-file', bad]);
    assert.equal(fail.status, 1, fail.stdout + fail.stderr);
    assert.match(fail.stdout, /REGRESSION/);
    assert.match(fail.stdout, /FAILED: regression/);

    const other = structuredClone(current);
    other.model = 'some-other-model';
    const mismatch = path.join(dir, 'other-model.json');
    fs.writeFileSync(mismatch, JSON.stringify(other));
    const refused = cli(['--baseline-file', mismatch]);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /not comparable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
