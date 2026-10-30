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
  billableTokens, buildChildEnv, comparabilityProblems, compareResults, compareRuns, defaultBenchModel,
  formatCompare, helperUsageSince, ledgerRowsForTurns, loadScenarios, maxLedgerId, median, metricVerdict,
  parseArgs, parseEnvAssignment, runBench, toolExpectationFailures,
} from '../../scripts/token-bench.mjs';
import { handleMessage as mcpHandle, toolsFor as mcpTools } from '../../scripts/bench-fixtures/fake-mcp-server.mjs';
import { quickMode } from '../llm_agent/modes/mode-classify.mjs';
import { restrictsTools } from '../llm_agent/modes/mode-personas.mjs';
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

const V2_IDS = ['greeting', 'explain-file', 'small-edit', 'plan-step', 'two-turn-reuse', 'long-tool-results', 'cache-slope'];
const V3_IDS = ['repo-search', 'auto-mode', 'mode-switch', 'cache-slope-12', 'mcp-two-servers', 'ended-chat-continue'];
const V4_IDS = ['switch-handoff', 'capped-session', 'compress-long-tools'];
// The router scenarios need server switches (--env); the default fake runs below use the other thirteen.
const withoutRouter = (list) => list.filter((s) => !s.requiresEnv);

test('loadScenarios reads the committed set (version 4 = the v3 thirteen unchanged + three router scenarios) with tool scenarios marked', () => {
  const { version, scenarios, compatibleWith } = loadScenarios(SCENARIOS);
  assert.equal(version, 4);
  assert.deepEqual(compatibleWith, [2, 3]);
  assert.deepEqual(scenarios.map((s) => s.id), [...V2_IDS, ...V3_IDS, ...V4_IDS]);
  assert.equal(scenarios.find((s) => s.id === 'two-turn-reuse').turns.length, 2);
  assert.equal(scenarios.find((s) => s.id === 'cache-slope').turns.length, 5);
  assert.deepEqual(
    scenarios.filter((s) => s.expectTools).map((s) => s.id),
    ['explain-file', 'small-edit', 'long-tool-results', 'repo-search', 'mode-switch', 'compress-long-tools'],
  );
});

test('the v2 scenarios are byte-for-byte what the committed v2 baseline measured (comparability)', () => {
  const { scenarios } = loadScenarios(SCENARIOS);
  const v2 = scenarios.filter((s) => V2_IDS.includes(s.id));
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'bench', 'token-baseline.json'), 'utf8'));
  assert.deepEqual(v2.map((s) => s.id), baseline.scenarios.map((s) => s.id));
  for (const s of v2) {
    const b = baseline.scenarios.find((x) => x.id === s.id);
    assert.equal(s.mode, b.mode, `${s.id} mode`);
    assert.equal(s.turns.length, b.turns, `${s.id} turn count`);
    assert.equal(Boolean(s.expectTools), b.expectTools, `${s.id} expectTools`);
    for (const key of ['classifier', 'turnModes', 'dropSessionBefore', 'fakeMcp', 'route', 'requiresEnv']) assert.equal(s[key], undefined, `${s.id} ${key}`);
  }
});

test('v3 scenarios: auto-mode really reaches the classifier; the others use the features they name', () => {
  const { scenarios } = loadScenarios(SCENARIOS);
  const by = (id) => scenarios.find((s) => s.id === id);
  assert.equal(by('auto-mode').mode, 'auto');
  assert.equal(by('auto-mode').classifier, true);
  assert.equal(quickMode(by('auto-mode').turns[0]), null, 'a quickMode hit would skip the classifier model call');
  assert.deepEqual(by('mode-switch').turnModes, ['ask', 'execute']);
  assert.equal(by('cache-slope-12').turns.length, 12);
  assert.equal(by('mcp-two-servers').fakeMcp, 2);
  // User MCP servers are mounted only in an unrestricted mode (engine.mjs buildUserMcpServers).
  assert.equal(restrictsTools(by('mcp-two-servers').mode), false, 'ask/plan/review/document load no user MCP servers');
  assert.deepEqual(by('ended-chat-continue').dropSessionBefore, [2]);
  assert.ok(by('repo-search').expectTools);
});

test('v4 router scenarios: structure, required switches, and that the v3 scenarios are unchanged', () => {
  const { scenarios } = loadScenarios(SCENARIOS);
  const by = (id) => scenarios.find((s) => s.id === id);
  const sw = by('switch-handoff');
  assert.deepEqual(sw.requiresEnv, ['LLMIDE_ROUTER']);
  assert.ok(sw.route.steps.every((st) => st.before >= 1 && st.before < sw.turns.length), 'a switch lands mid-chat');
  const cap = by('capped-session');
  assert.deepEqual(cap.requiresEnv, ['LLMIDE_ROUTER', 'LLMIDE_ROUTER_CAP']);
  assert.equal(cap.route.expectRefusal, true);
  assert.ok(cap.route.tokenLimit > 0 && cap.turns.length >= 4);
  assert.deepEqual(by('compress-long-tools').requiresEnv, ['LLMIDE_ROUTER', 'LLMIDE_ROUTER_COMPRESS']);
  // The thirteen v3 scenarios carry none of the new fields.
  for (const s of scenarios.filter((x) => [...V2_IDS, ...V3_IDS].includes(x.id))) {
    assert.equal(s.route, undefined, s.id);
    assert.equal(s.requiresEnv, undefined, s.id);
  }
});

test('loadScenarios validates the route fields; a run without the required switches fails up front', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-bench-scen-v4-'));
  try {
    const file = path.join(dir, 's.json');
    const bad = (sc, re) => {
      fs.writeFileSync(file, JSON.stringify({ version: 4, scenarios: [{ id: 'x', mode: 'ask', turns: ['a', 'b'], ...sc }] }));
      assert.throws(() => loadScenarios(file), re);
    };
    bad({ route: 'x' }, /route must be an object/);
    bad({ route: { tokenLimit: 0 } }, /tokenLimit/);
    bad({ route: { tokenLimit: 1.5 } }, /tokenLimit/);
    bad({ route: { expectRefusal: 'yes' } }, /expectRefusal/);
    bad({ route: { steps: [{ before: 2, provider: 'anthropic', model: 'm' }] } }, /before/);
    bad({ route: { steps: [{ before: 1, provider: 'openai', model: 'm' }] } }, /provider/);
    bad({ route: { steps: [{ before: 1, provider: 'anthropic', model: '' }] } }, /provider/);
    bad({ requiresEnv: ['not_upper'] }, /requiresEnv/);
    bad({ requiresEnv: 'LLMIDE_ROUTER' }, /requiresEnv/);
    const { scenarios } = loadScenarios(SCENARIOS);
    await assert.rejects(
      runBench({ fake: true, model: FAKE_MODEL, scenarios: scenarios.filter((s) => s.id === 'capped-session'), scenariosVersion: 4, repeat: 1 }),
      /needs --env LLMIDE_ROUTER=on --env LLMIDE_ROUTER_CAP=on/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runBench --fake with the router on: the switch scenario pins mid-chat and the capped one is refused at its limit', async () => {
  const { scenarios } = loadScenarios(SCENARIOS);
  const pick = scenarios.filter((s) => ['switch-handoff', 'capped-session'].includes(s.id));
  const results = await runBench({
    fake: true, model: FAKE_MODEL, scenarios: pick, scenariosVersion: 4, repeat: 1,
    extraEnv: { LLMIDE_ROUTER: 'on', LLMIDE_ROUTER_CAP: 'on' },
  });
  const sw = results.scenarios.find((s) => s.id === 'switch-handoff');
  assert.equal(sw.turns, 4);
  assert.equal(sw.route, true);
  const cap = results.scenarios.find((s) => s.id === 'capped-session');
  assert.ok(cap.perTurn.length >= 1 && cap.perTurn.length < 5, `the chat was refused before the fifth turn (ran ${cap.perTurn.length})`);
});

test('loadScenarios validates the v3 fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-bench-scen-v3-'));
  try {
    const file = path.join(dir, 's.json');
    const bad = (sc, re) => {
      fs.writeFileSync(file, JSON.stringify({ version: 3, scenarios: [{ id: 'x', mode: 'ask', turns: ['a', 'b'], ...sc }] }));
      assert.throws(() => loadScenarios(file), re);
    };
    bad({ turnModes: ['ask'] }, /turnModes/);
    bad({ turnModes: ['ask', 'auto'] }, /turnModes/);
    bad({ dropSessionBefore: [0] }, /dropSessionBefore/);
    bad({ dropSessionBefore: [2] }, /dropSessionBefore/);
    bad({ fakeMcp: 0 }, /fakeMcp/);
    fs.writeFileSync(file, JSON.stringify({ version: 3, scenarios: [{ id: 'x', mode: 'auto', classifier: true, turns: ['a'] }] }));
    assert.equal(loadScenarios(file).scenarios[0].mode, 'auto');
    fs.writeFileSync(file, JSON.stringify({ version: 3, scenarios: [{ id: 'x', mode: 'ask', turns: ['a'] }, { id: 'x', mode: 'ask', turns: ['a'] }] }));
    assert.throws(() => loadScenarios(file), /duplicate scenario id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a v2 baseline stays comparable with a v3 run (compatibleWith) and not with an unrelated version', () => {
  const base = run([scenario('a', 100, 1000)], { scenariosVersion: 2 });
  const cur = run([scenario('a', 100, 1000)], { scenariosVersion: 3, scenariosCompatibleWith: [2] });
  assert.deepEqual(comparabilityProblems(cur, base), []);
  assert.equal(comparabilityProblems({ ...cur, scenariosCompatibleWith: [] }, base).length, 1);
  assert.equal(comparabilityProblems(cur, { ...base, scenariosVersion: 1 }).length, 1, 'only versions the run lists');
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

test('parseEnvAssignment: LLMIDE_* and CLAUDE_CODE_* only, bench-owned and isolation names refused', () => {
  assert.deepEqual(parseEnvAssignment('LLMIDE_V2_COMPACT_PROMPT=1'), ['LLMIDE_V2_COMPACT_PROMPT', '1']);
  assert.deepEqual(parseEnvAssignment('CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1'), ['CLAUDE_CODE_DISABLE_TERMINAL_TITLE', '1']);
  assert.deepEqual(parseEnvAssignment('LLMIDE_X=a=b'), ['LLMIDE_X', 'a=b'], 'the value may contain =');
  assert.deepEqual(parseEnvAssignment('LLMIDE_X='), ['LLMIDE_X', ''], 'an empty value is allowed');
  for (const bad of ['PATH=/x', 'HOME=/tmp/h', 'ANTHROPIC_API_KEY=k', 'llmide_x=1', 'LLMIDE_', 'NOEQUALS', '=1', 'NODE_ENV=production']) {
    assert.throws(() => parseEnvAssignment(bad), /--env/, bad);
  }
  for (const owned of ['LLMIDE_DB_PATH', 'LLMIDE_PORT', 'LLMIDE_DATA_DIR', 'LLMIDE_BENCH_FAKE', 'LLMIDE_ALLOW_REMOTE', 'LLMIDE_AGENT_DB_PATH']) {
    assert.throws(() => parseEnvAssignment(`${owned}=1`), /owned by the bench/, owned);
  }
});

test('parseArgs: --env is repeatable, --compare takes two files, bad combinations are refused', () => {
  const a = parseArgs(['--env', 'LLMIDE_A=1', '--env', 'CLAUDE_CODE_B=2', '--only', 'greeting,auto-mode']);
  assert.deepEqual(a.env, { LLMIDE_A: '1', CLAUDE_CODE_B: '2' });
  assert.deepEqual(a.only, ['greeting', 'auto-mode']);
  assert.deepEqual(parseArgs([]).env, {});
  assert.deepEqual(parseArgs(['--compare', 'a.json', 'b.json']).compare, ['a.json', 'b.json']);
  assert.throws(() => parseArgs(['--env']), /needs a value/);
  assert.throws(() => parseArgs(['--env', 'LLMIDE_A=1', '--env', 'LLMIDE_A=2']), /given twice/);
  assert.throws(() => parseArgs(['--env', 'HOME=/x']), /--env/);
  assert.throws(() => parseArgs(['--compare', 'a.json']), /two results files/);
  assert.throws(() => parseArgs(['--compare', 'a.json', '--fake']), /two results files/);
  assert.throws(() => parseArgs(['--compare', 'a.json', 'b.json', '--fake']), /cannot be combined/);
  assert.throws(() => parseArgs(['--compare', 'a.json', 'b.json', '--env', 'LLMIDE_A=1']), /cannot be combined/);
  assert.throws(() => parseArgs(['--unknown']), /unknown flag/);
});

test('buildChildEnv passes --env values through after the strip, and the bench settings still win', () => {
  const base = { HOME: '/h', LLMIDE_V2_COMPACT_PROMPT: '1', CLAUDE_CODE_X: 'inherited' };
  const env = buildChildEnv(base, {
    port: 1, dbPath: '/t/b.db', jwtSecret: 'j', vaultKey: 'v', fake: false,
    extraEnv: { LLMIDE_V2_AUTOCOMPACT_WINDOW: '100000', CLAUDE_CODE_X: 'override' },
  });
  assert.equal(env.LLMIDE_V2_COMPACT_PROMPT, undefined, 'inherited LLMIDE_* is still stripped');
  assert.equal(env.LLMIDE_V2_AUTOCOMPACT_WINDOW, '100000');
  assert.equal(env.CLAUDE_CODE_X, 'override');
  assert.equal(env.LLMIDE_DB_PATH, '/t/b.db');
  // A reserved name smuggled past parseArgs is still refused here.
  assert.throws(() => buildChildEnv(base, {
    port: 1, dbPath: 'd', jwtSecret: 'j', vaultKey: 'v', fake: false, extraEnv: { LLMIDE_DB_PATH: '/real.db' },
  }), /owned by the bench/);
  assert.equal(buildChildEnv(base, { port: 1, dbPath: 'd', jwtSecret: 'j', vaultKey: 'v', fake: false, pluginDir: '/t/p' }).LLMIDE_PLUGIN_DIR, '/t/p');
  assert.equal(buildChildEnv(base, { port: 1, dbPath: 'd', jwtSecret: 'j', vaultKey: 'v', fake: false }).LLMIDE_PLUGIN_DIR, undefined);
});

test('metricVerdict: a delta inside the spread is no-result; gates, better, worse and flat otherwise', () => {
  const v = (a, b, spread, extra = {}) => metricVerdict({ a, b, spread, gatePct: 15, ...extra }).verdict;
  assert.equal(v(1000, 1300, 400), 'no-result', '+30% but the samples themselves span 400');
  assert.equal(v(1000, 1300, 299), 'regression');
  assert.equal(v(1000, 1300, null), 'regression', 'without samples the gate decides');
  assert.equal(v(1000, 1100, 50), 'worse', 'real, +10%, under the 15% gate');
  assert.equal(v(1000, 800, 50), 'better');
  assert.equal(v(1000, 1020, 5), 'flat');
  assert.equal(v(1000, 1000, 0), 'no-result', 'zero delta is inside any spread');
  assert.equal(v(1000, 1030, 0), 'flat');
  assert.equal(v(1000, 1150, 150), 'no-result', 'delta equal to the spread is not larger than it');
  assert.equal(v(null, 5, 1), 'n/a');
  assert.equal(v(1000, 1400, 0, { floor: 500 }), 'worse', 'an absolute floor: +40% but only 400 over');
  assert.equal(metricVerdict({ a: 1000, b: 1600, spread: 0, gatePct: 15, floor: 500 }).verdict, 'regression');
});

const sc = (id, o = {}) => ({
  id, billableTokens: 10000, totalMs: 5000, ttftMs: 1000, hops: 2,
  billableSamples: [9800, 10000, 10200], totalMsSamples: [4900, 5000, 5100], ttftMsSamples: [950, 1000, 1050], hopsSamples: [2, 2, 2],
  ...o,
});

test('compareRuns: a quiet pair passes; a real >15% token rise fails; noise-sized rises are no-result', () => {
  const a = run([sc('x'), sc('y'), sc('z')]);
  // x: +30% tokens, samples tight -> regression. y: +30% but samples span 8000 -> no-result.
  // z: tokens -20% -> better.
  const b = run([
    sc('x', { billableTokens: 13000, billableSamples: [12800, 13000, 13200] }),
    sc('y', { billableTokens: 13000, billableSamples: [8000, 13000, 16000] }),
    sc('z', { billableTokens: 8000, billableSamples: [7800, 8000, 8200] }),
  ]);
  const c = compareRuns(a, b);
  const by = (id) => c.rows.find((r) => r.id === id);
  assert.equal(by('x').tokens.verdict, 'regression');
  assert.equal(by('x').failed, true);
  assert.equal(by('y').tokens.verdict, 'no-result');
  assert.equal(by('y').failed, false);
  assert.equal(by('z').tokens.verdict, 'better');
  assert.equal(c.failed, true);
  assert.equal(compareRuns(a, a).failed, false);
  assert.equal(compareRuns(a, a).rows[0].tokens.verdict, 'no-result', 'identical runs: delta 0 is inside the spread');
});

test('compareRuns: time needs 30% and the 500 ms floor; hops need 20%; a scenario in one file only is not compared', () => {
  const a = run([sc('t'), sc('h'), sc('only-a')]);
  const b = run([
    sc('t', { totalMs: 7000, totalMsSamples: [6950, 7000, 7050] }), // +40%, +2000 ms
    sc('h', { hops: 3, hopsSamples: [3, 3, 3] }), // +50% hops
    sc('only-b'),
  ]);
  const c = compareRuns(a, b);
  assert.equal(c.rows.find((r) => r.id === 't').time.verdict, 'regression');
  assert.equal(c.rows.find((r) => r.id === 'h').hops.verdict, 'regression');
  assert.equal(c.rows.find((r) => r.id === 'only-a').status, 'only-in-a');
  assert.equal(c.rows.find((r) => r.id === 'only-b').status, 'only-in-b');
  const quick = compareRuns(run([sc('q', { totalMs: 300, totalMsSamples: [299, 300, 301] })]),
    run([sc('q', { totalMs: 450, totalMsSamples: [449, 450, 451] })]));
  assert.equal(quick.rows[0].time.verdict, 'worse', '+50% but only 150 ms: under the floor');
  assert.equal(quick.failed, false);
  // Files with no samples (old results): the gate decides and the report says so.
  const old = (o) => ({ id: 'o', billableTokens: o, totalMs: 1000, hops: 1, raw: {}, turns: 1 });
  const noSamples = compareRuns(run([old(1000)]), run([old(1300)]));
  assert.equal(noSamples.rows[0].tokens.spreadKnown, false);
  assert.equal(noSamples.rows[0].tokens.verdict, 'regression');
  assert.match(formatCompare(run([old(1000)]), run([old(1300)]), noSamples), /no samples/);
});

test('formatCompare reports tokens, hops, ttft and time per scenario with the spread', () => {
  const a = run([sc('x')]);
  const b = run([sc('x', { billableTokens: 13000, billableSamples: [12800, 13000, 13200], helperBillableTokens: 700 })], { env: { LLMIDE_FLAG: '1' } });
  const text = formatCompare(a, b, compareRuns(a, b), ['a.json', 'b.json']);
  for (const needle of ['billable', 'hops', 'ttft ms', 'total ms', 'spread 400', 'regression', 'LLMIDE_FLAG', 'a.json']) {
    assert.ok(text.includes(needle), `report mentions ${needle}`);
  }
});

test('helperUsageSince counts rows outside the turn endpoints after a cut-off, per user', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, endpoint TEXT, input_tokens INT,
    output_tokens INT, cache_read_tokens INT, cache_creation_tokens INT, request_id TEXT)`);
  const ins = db.prepare('INSERT INTO usage_ledger (user_id, endpoint, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?,?,?,?,?,?)');
  ins.run('u1', null, 999, 999, 0, 0); // before the cut-off
  const mark = maxLedgerId(db, 'u1');
  ins.run('u1', '/agent/v2/stream', 100, 10, 0, 0); // a turn's own row: not helper
  ins.run('u1', '/agent/v2/stream:internal', 100, 10, 0, 0); // SDK-internal model: already in the turn
  ins.run('u1', null, 200, 20, 1000, 0); // classifier / memory extraction
  ins.run('u1', 'something-else', 50, 5, 0, 80);
  ins.run('u2', null, 7777, 7777, 0, 0); // another user
  const h = helperUsageSince(db, 'u1', mark);
  assert.equal(h.calls, 2);
  assert.equal(h.billable, billableTokens({ input: 250, output: 25, cacheRead: 1000, cacheWrite: 80 }));
  assert.equal(helperUsageSince(db, 'u1', maxLedgerId(db, 'u1')).calls, 0);
  db.close();
});

test('the stub MCP server speaks enough stdio MCP: initialize, tools/list, tools/call, notifications', () => {
  const init = mcpHandle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 's1');
  assert.equal(init.result.serverInfo.name, 's1');
  assert.ok(init.result.capabilities.tools);
  assert.equal(mcpHandle({ jsonrpc: '2.0', method: 'notifications/initialized' }, 's1'), null);
  const list = mcpHandle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 's1');
  assert.deepEqual(list.result.tools.map((t) => t.name), ['s1_lookup', 's1_status']);
  assert.notDeepEqual(mcpTools('s1').map((t) => t.name), mcpTools('s2').map((t) => t.name), 'two servers never share a tool name');
  assert.equal(mcpHandle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 's1_status' } }, 's1').result.content[0].text, 'ok');
  assert.equal(mcpHandle({ jsonrpc: '2.0', id: 4, method: 'nope' }, 's1').error.code, -32601);
  // And as a real child process over stdio.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bench-fixtures', 'fake-mcp-server.mjs'), 's9'], {
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', encoding: 'utf8',
  });
  assert.match(r.stdout, /"s9_lookup"/);
});

test('CLI: --compare reads two files, runs nothing, exits 0 / 1 / 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-bench-compare-test-'));
  try {
    const w = (name, obj) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
    const base = run([sc('x')], { repeat: 3 });
    const worse = run([sc('x', { billableTokens: 14000, billableSamples: [13900, 14000, 14100] })], { repeat: 3 });
    const cli = (...files) => spawnSync(process.execPath, [BENCH, '--compare', ...files], { encoding: 'utf8' });
    const a = w('a.json', base);
    const same = cli(a, w('same.json', base));
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.match(same.stdout, /PASS/);
    const bad = cli(a, w('b.json', worse));
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /FAILED: B regressed A/);
    const other = cli(a, w('c.json', { ...worse, model: 'another-model' }));
    assert.equal(other.status, 2);
    assert.match(other.stderr, /not comparable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const { scenarios, version, compatibleWith } = loadScenarios(SCENARIOS);
  const results = await runBench({
    fake: true, model: FAKE_MODEL, scenarios: withoutRouter(scenarios), scenariosVersion: version, compatibleWith, repeat: 1,
  });
  assert.equal(results.fake, true);
  assert.equal(results.scenariosVersion, 4);
  assert.deepEqual(results.scenariosCompatibleWith, [2, 3]);
  assert.equal(results.scenarios.length, 13);
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
  assert.equal(toolExpectationFailures(results).length, 5);
  const ended = results.scenarios.find((s) => s.id === 'ended-chat-continue');
  assert.equal(ended.perTurn[2].cacheRead, 0, 'after the SDK session is dropped the third turn starts a fresh session');
  assert.ok(ended.perTurn[1].cacheRead > 0);
  assert.equal(results.scenarios.find((s) => s.id === 'cache-slope-12').perTurn.length, 12);
  for (const s of results.scenarios) assert.equal(s.helperCalls, 0, `${s.id}: the fake makes no helper calls`);
  assert.deepEqual(results.env, {});
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
      fake: true, model: FAKE_MODEL, scenarios: withoutRouter(scenarios), scenariosVersion: version, repeat: 1,
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
