// The token bench (scripts/token-bench.mjs, Phase 1 P17): its comparison logic,
// and an end-to-end --fake run against a temp-DB server (no model calls: the
// server is started with LLMIDE_BENCH_FAKE=1, the fake engine in
// llm_agent/sdk/bench-fake-engine.mjs).
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

import {
  billableTokens, compareResults, defaultBenchModel, loadScenarios, runBench,
} from '../../scripts/token-bench.mjs';
import { benchFakeEngineEnabled } from '../routes/agent-v2.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(EXT, '..');
const BENCH = path.join(ROOT, 'scripts', 'token-bench.mjs');
const SCENARIOS = path.join(ROOT, 'schema', 'bench', 'scenarios.json');

const scenario = (id, billable, totalMs) => ({
  id, billableTokens: billable, totalMs, raw: {}, turns: 1, hops: 1,
});

test('billableTokens weights cache reads 0.1x and cache writes 1.25x', () => {
  assert.equal(billableTokens({ input: 10, output: 20, cacheRead: 1000, cacheWrite: 100 }), 10 + 20 + 100 + 125);
  assert.equal(billableTokens({}), 0);
});

test('defaultBenchModel is the cheapest (fast) picker model from anthropic-models.json', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'models', 'anthropic-models.json'), 'utf8'));
  assert.equal(defaultBenchModel(), cfg.models.find((m) => m.fast).id);
});

test('loadScenarios reads the committed scenario set: four single-turn plus one two-turn scenario', () => {
  const list = loadScenarios(SCENARIOS);
  assert.deepEqual(list.map((s) => s.id), ['greeting', 'explain-file', 'small-edit', 'plan-step', 'two-turn-reuse']);
  assert.equal(list.find((s) => s.id === 'two-turn-reuse').turns.length, 2);
});

test('compareResults passes an identical run and fails a >15% token regression', () => {
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

test('compareResults: time regressions need both >15% and an absolute floor', () => {
  const base = { scenarios: [scenario('a', 1000, 100)] };
  // +200% but only +200 ms: under the 500 ms floor, so jitter, not a regression.
  assert.equal(compareResults({ scenarios: [scenario('a', 1000, 300)] }, base).failed, false);
  // +50% and +5 s: a real slowdown.
  const slow = { scenarios: [scenario('a', 1000, 5100)] };
  const base2 = { scenarios: [scenario('a', 1000, 3400)] };
  assert.equal(compareResults(slow, base2).failed, true);
  // The thresholds are configurable.
  assert.equal(compareResults({ scenarios: [scenario('a', 1000, 110)] }, base, { timePct: 5, timeFloorMs: 0 }).failed, true);
});

test('compareResults fails a scenario missing from the run and reports a new one without failing', () => {
  const base = { scenarios: [scenario('a', 1000, 100), scenario('gone', 1000, 100)] };
  const cur = { scenarios: [scenario('a', 1000, 100), scenario('new', 5, 5)] };
  const r = compareResults(cur, base);
  assert.equal(r.failed, true);
  assert.equal(r.rows.find((x) => x.id === 'gone').status, 'missing');
  assert.equal(r.rows.find((x) => x.id === 'new').status, 'new');
});

test('the fake engine seam is on only with LLMIDE_BENCH_FAKE=1 and never in production', () => {
  assert.equal(benchFakeEngineEnabled({ LLMIDE_BENCH_FAKE: '1' }), true);
  assert.equal(benchFakeEngineEnabled({ LLMIDE_BENCH_FAKE: '0' }), false);
  assert.equal(benchFakeEngineEnabled({}), false);
  assert.equal(benchFakeEngineEnabled({ LLMIDE_BENCH_FAKE: '1', NODE_ENV: 'production' }), false);
});

test('runBench --fake end to end: every scenario metered, cache reused on the second turn', async () => {
  const results = await runBench({ fake: true, model: 'bench-model', scenarios: loadScenarios(SCENARIOS) });
  assert.equal(results.fake, true);
  assert.equal(results.scenarios.length, 5);
  for (const s of results.scenarios) {
    assert.ok(s.billableTokens > 0, `${s.id} billable`);
    assert.ok(s.raw.output > 0, `${s.id} output`);
    assert.equal(s.hops, s.turns, `${s.id} one fake API call per turn`);
    assert.ok(s.contextSplit && s.contextSplit.sdkContextTotalTokens > 0, `${s.id} context split`);
  }
  const reuse = results.scenarios.find((s) => s.id === 'two-turn-reuse');
  assert.ok(reuse.raw.cacheRead > 0, 'second turn reads the first turn back from cache');
  const greeting = results.scenarios.find((s) => s.id === 'greeting');
  assert.equal(greeting.raw.cacheRead, 0, 'a fresh chat reads nothing from cache');
});

test('CLI: --baseline --fake is refused (synthetic numbers are never a baseline)', () => {
  const r = spawnSync(process.execPath, [BENCH, '--baseline', '--fake'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to write a baseline from --fake/);
});

test('CLI: --fake compares with a baseline and exits 1 on a >15% token regression, 0 when unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-bench-cli-test-'));
  try {
    const current = await runBench({ fake: true, model: 'bench-model', scenarios: loadScenarios(SCENARIOS) });
    const ok = path.join(dir, 'ok-baseline.json');
    fs.writeFileSync(ok, JSON.stringify(current));
    const pass = spawnSync(process.execPath, [BENCH, '--fake', '--baseline-file', ok, '--out', path.join(dir, 'r1.json')], { encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /PASS: no scenario regressed/);

    // A baseline 20% below what the run now bills: the run is a 25% regression.
    const low = structuredClone(current);
    for (const s of low.scenarios) s.billableTokens = Math.round(s.billableTokens / 1.25);
    const bad = path.join(dir, 'low-baseline.json');
    fs.writeFileSync(bad, JSON.stringify(low));
    const fail = spawnSync(process.execPath, [BENCH, '--fake', '--baseline-file', bad, '--out', path.join(dir, 'r2.json')], { encoding: 'utf8' });
    assert.equal(fail.status, 1, fail.stdout + fail.stderr);
    assert.match(fail.stdout, /REGRESSION/);
    assert.match(fail.stdout, /FAILED: regression/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
