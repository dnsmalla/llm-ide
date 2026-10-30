// The Agent SDK and the v2 engine (llm_agent/sdk/engine.mjs, ~200 ms of
// imports) are loaded on the first chat turn — or by the post-listen prewarm
// in server.mjs — never on the boot path. These tests pin that contract:
//   - importing every module server.mjs imports statically (routes/router.mjs,
//     server/ai-routes.mjs, …) loads neither engine.mjs nor any
//     @anthropic-ai/claude-agent-sdk file;
//   - the agent-v2 loader is memoised, and a REJECTED import does not stick
//     (a transient failure must not break chat until restart);
//   - an import failure reaches the client through the existing turn error
//     path (terminal ENGINE_ERROR event), not as a crashed request;
//   - the constants a route needs (AGENT_SDK_PROVIDER, RESERVED_MCP_NAME,
//     MAX_LOOP_MESSAGE_CHARS) are the same values the engine uses;
//   - the Loop route rejects a malformed request before it imports the Loop
//     engine (llm_agent/sdk/loop-agent.mjs), with the same 400 as before.
//
// Uses an in-process module-load hook (registerHooks, Node >= 22.15), like
// tests/feature-routes.test.mjs; each test file runs in its own process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeModule from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-lazy-engine-'));
process.env.LLMIDE_DB_PATH = path.join(tmpDir, 'kb.db');

const loadedUrls = [];
const hasLoadHooks = typeof nodeModule.registerHooks === 'function';
if (hasLoadHooks) {
  nodeModule.registerHooks({ load(url, ctx, next) { loadedUrls.push(url); return next(url, ctx); } });
}
const engineLoaded = () => loadedUrls.some((u) => u.endsWith('/llm_agent/sdk/engine.mjs'));
const sdkLoaded = () => loadedUrls.some((u) => u.includes('/@anthropic-ai/claude-agent-sdk/'));

// Every relative module server.mjs imports statically — read from its source
// so a new boot-path import is covered without editing this list. server.mjs
// itself is not imported: it listens on import.
function serverStaticImports() {
  const src = fs.readFileSync(path.join(EXT, 'server.mjs'), 'utf8');
  return [...src.matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?'(\.\/[^']+)';/gm)].map((m) => m[1]);
}

const bootModules = serverStaticImports();
for (const rel of bootModules) await import(pathToFileURL(path.join(EXT, rel)).href);
// The route modules the dispatcher mounts, named explicitly as well — the
// regex above must not be the only thing standing between this test and a
// silently empty list.
const agentV2 = await import('../routes/agent-v2.mjs');
await import('../routes/router.mjs');
await import('../server/ai-routes.mjs');
await import('../server/auth-routes.mjs');
await import('../routes/extension-routes.mjs');
// Loaded at boot whenever auto_tasks is enabled (routes/feature-routes.mjs);
// its Loop engine import is lazy for the same reason.
const { handleLoopAgentRoutes } = await import('../routes/loop-agent.mjs');
const { listSdkModels, __clearSdkModelsCacheForTest } = await import('../llm_agent/sdk/models.mjs');
await import('../llm_agent/sdk/transcripts.mjs');
const constants = await import('../llm_agent/sdk/constants.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');

process.on('exit', () => {
  try { closeDb(); } catch { /* already closed */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeReq({ method, url, body, rawBody, user }) {
  const chunks = rawBody != null
    ? [Buffer.from(rawBody)]
    : (body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  const req = {
    method, url, user, headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}

function makeRes() {
  return {
    on() { return this; },
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    sseEvents() {
      return this._body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
    },
  };
}

test('boot path: server.mjs static imports (+ the Loop route) load neither engine.mjs nor the Agent SDK', { skip: !hasLoadHooks }, () => {
  assert.ok(bootModules.includes('./routes/router.mjs'), `parsed server.mjs imports: ${bootModules.join(', ')}`);
  assert.ok(bootModules.includes('./server/ai-routes.mjs'));
  assert.ok(loadedUrls.some((u) => u.endsWith('/routes/agent-v2.mjs')), 'the hook saw the route load');
  assert.equal(loadedUrls.some((u) => u.endsWith('/llm_agent/sdk/loop-agent.mjs')), false, 'Loop engine loaded with its route');
  assert.equal(engineLoaded(), false, 'llm_agent/sdk/engine.mjs loaded on the boot path');
  assert.equal(sdkLoaded(), false, '@anthropic-ai/claude-agent-sdk loaded on the boot path');
});

const loopEngineLoaded = () => loadedUrls.some((u) => u.endsWith('/llm_agent/sdk/loop-agent.mjs'));

// A malformed Loop request costs no engine import: validation needs only pure
// constants (constants.mjs), so a client hammering the route with bad bodies
// cannot pull the Agent SDK into a server that never ran a Loop step. The
// expected bodies are the ones the route answered before the import moved —
// the wire contract the Mac decodes must not change with the load order.
test('loop route: a malformed request is rejected with 400 without importing the Loop engine', { skip: !hasLoadHooks }, async () => {
  const validation = (message) => ({ error: { code: 'VALIDATION_FAILED', message } });
  const max = constants.MAX_LOOP_MESSAGE_CHARS;
  const cases = [
    [{ rawBody: 'not json' }, validation('Body must be a JSON object')],
    [{ body: 'a string' }, validation('Body must be a JSON object')],
    [{ body: { repoRoot: '/tmp' } }, validation('message is required')],
    [{ body: { message: '   ' } }, validation('message is required')],
    [{ body: { message: 'x'.repeat(max + 1) } }, validation(`message exceeds ${max} characters`)],
    [{ body: { message: 'x', skills: 'a' } }, validation('skills must be an array of ids')],
    [{ body: { message: 'x', skills: ['a', 'b', 'c', 'd', 'e', 'f'] } }, validation('skills must be at most 5 non-empty id strings')],
    [{ body: { message: 'x', timeoutMs: -5 } }, validation('timeoutMs must be a positive number of milliseconds')],
    [{ body: { message: 'x', provider: 'p'.repeat(129) } }, validation('provider must be a string of at most 128 characters')],
  ];
  for (const [input, expected] of cases) {
    const res = makeRes();
    const handled = await handleLoopAgentRoutes(
      makeReq({ method: 'POST', url: '/kb/loop/agent-run', ...input }), res, { userId: 'u-lazy' },
      // No deps: a validation failure must not reach the runAgent/validateRoot seam.
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400, JSON.stringify(input).slice(0, 120));
    assert.deepEqual(JSON.parse(res._body), expected);
  }
  assert.equal(max, 200_000, 'the Loop message cap is unchanged');
  assert.equal(loopEngineLoaded(), false, 'a rejected request imported the Loop engine');
  assert.equal(sdkLoaded(), false, 'a rejected request imported the Agent SDK');
});

test('models: an injected queryFn lists models without loading the SDK', { skip: !hasLoadHooks }, async () => {
  __clearSdkModelsCacheForTest();
  const fakeQuery = () => ({
    supportedModels: async () => [{ value: 'claude-test-1', resolvedModel: 'claude-test-1', displayName: 'Test 1', description: 'x' }],
    close() {},
  });
  const models = await listSdkModels(null, { queryFn: fakeQuery });
  assert.equal(models[0].id, 'claude-test-1');
  assert.equal(sdkLoaded(), false);
  assert.equal(engineLoaded(), false);
  __clearSdkModelsCacheForTest();
});

test('loader: a rejected engine import does not stick; success is memoised', async () => {
  let calls = 0;
  const fakeEngine = { runAgentV2Turn: async () => ({ usageTotals: {} }) };
  agentV2.__setEngineImporterForTest(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient import failure');
    return fakeEngine;
  });
  try {
    await assert.rejects(agentV2.loadAgentEngine(), /transient import failure/);
    assert.equal(await agentV2.loadAgentEngine(), fakeEngine, 'the retry after a rejection imports again');
    assert.equal(await agentV2.loadAgentEngine(), fakeEngine);
    assert.equal(calls, 2, 'a resolved import is memoised');
  } finally {
    agentV2.__setEngineImporterForTest(null);
  }
});

test('route: an engine import failure surfaces as the terminal ENGINE_ERROR event', async () => {
  const user = registerUser(getDb(), { email: 'lazy-engine@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  agentV2.__setEngineImporterForTest(async () => { throw new Error('Cannot find module sdk.mjs'); });
  try {
    const res = makeRes();
    // No deps argument: the production default (the lazy runner) is what runs.
    await agentV2.handleAgentV2Routes(makeReq({
      method: 'POST', url: '/agent/v2/stream', user,
      body: { message: 'hello', mode: 'execute', agentContext: { chatSessionId: 'chat-lazy', workspaceRoot: tmpDir } },
    }), res);
    assert.equal(res.statusCode, 200);
    const last = res.sseEvents().at(-1);
    assert.equal(last.type, 'error');
    assert.equal(last.code, 'ENGINE_ERROR');
    assert.match(last.message, /Cannot find module/);
    assert.equal(last.retryable, false);
    assert.ok(res.ended);
  } finally {
    agentV2.__setEngineImporterForTest(null);
  }
});

test('prewarm: a failure is logged, never thrown, and leaves the loader retryable', async () => {
  const logged = [];
  const fakeLog = { info: (m, f) => logged.push(['info', m, f]), warn: (m, f) => logged.push(['warn', m, f]) };
  let calls = 0;
  agentV2.__setEngineImporterForTest(async () => { calls += 1; if (calls === 1) throw new Error('boom'); return {}; });
  try {
    const failed = await agentV2.prewarmAgentEngine({ log: fakeLog });
    assert.equal(failed.ok, false);
    assert.deepEqual(logged.map(([lvl, m]) => [lvl, m]), [['warn', 'engine_prewarm_failed']]);
    assert.match(logged[0][2].error, /boom/);
    const ok = await agentV2.prewarmAgentEngine({ log: fakeLog });
    assert.equal(ok.ok, true);
    assert.equal(logged[1][1], 'engine_prewarmed');
    assert.equal(typeof logged[1][2].ms, 'number');
  } finally {
    agentV2.__setEngineImporterForTest(null);
  }
});

test('loader: the real import loads the engine and the SDK; constants match the engine', { skip: !hasLoadHooks }, async () => {
  const engine = await agentV2.loadAgentEngine();
  assert.equal(typeof engine.runAgentV2Turn, 'function');
  assert.equal(engineLoaded(), true);
  assert.equal(sdkLoaded(), true);
  assert.equal(engine.AGENT_SDK_PROVIDER, constants.AGENT_SDK_PROVIDER);
  assert.equal(constants.AGENT_SDK_PROVIDER, 'anthropic');
  assert.equal(constants.RESERVED_MCP_NAME, 'llmide');
  // The Loop engine re-exports the constant its route validates with: one definition.
  const loopEngine = await import('../llm_agent/sdk/loop-agent.mjs');
  assert.equal(loopEngine.MAX_LOOP_MESSAGE_CHARS, constants.MAX_LOOP_MESSAGE_CHARS);
  const auth = await import('../llm_agent/sdk/auth.mjs');
  assert.equal(engine.resolveAnthropicKey, auth.resolveAnthropicKey, 'engine re-exports the one auth ladder');
  assert.equal(engine.agentSdkHomeFor, auth.agentSdkHomeFor);
});

test('config: LLMIDE_ENGINE_PREWARM defaults on, 0 turns it off', () => {
  const read = (value) => {
    const env = { ...process.env, LLMIDE_DB_PATH: path.join(tmpDir, 'cfg.db') };
    if (value == null) delete env.LLMIDE_ENGINE_PREWARM; else env.LLMIDE_ENGINE_PREWARM = value;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const { config } = await import('./core/config.mjs'); process.stdout.write(String(config.enginePrewarm));"],
    { cwd: EXT, env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout;
  };
  assert.equal(read(null), 'true');
  assert.equal(read('0'), 'false');
  assert.equal(read('1'), 'true');
});

// End-to-end wiring in server.mjs: the prewarm runs AFTER the listen line, and
// LLMIDE_ENGINE_PREWARM=0 keeps the engine out of the process entirely.
// Spawns `node server.mjs` on a free loopback port, so this needs local listen
// permission (run the suite with the sandbox disabled).
async function bootServer(extraEnv, { until, settleMs = 0 }) {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
  });
  const dir = fs.mkdtempSync(path.join(tmpDir, 'boot-'));
  const env = {
    ...process.env, ...extraEnv,
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1', LLMIDE_LOG_JSON: '1',
    LLMIDE_DB_PATH: path.join(dir, 'kb.db'), LLMIDE_BACKUP_INTERVAL_HOURS: '0',
  };
  // The node test runner marks its children; the server must boot as itself.
  delete env.NODE_TEST_CONTEXT;
  delete env.LLMIDE_FEATURES;
  // Report from the child whether engine.mjs was ever loaded.
  const hook = path.join(dir, 'hook.mjs');
  fs.writeFileSync(hook, [
    "import { registerHooks } from 'node:module';",
    'let seen = false;',
    "registerHooks({ load(url, ctx, next) { if (url.endsWith('/llm_agent/sdk/engine.mjs')) seen = true; return next(url, ctx); } });",
    "process.on('SIGTERM', () => { process.stdout.write(`\\nENGINE_LOADED ${seen}\\n`); process.exit(0); });",
  ].join('\n'));
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, 'server.mjs'],
    { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && child.exitCode == null && !until(output)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, settleMs));
  const exited = new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
  child.kill('SIGTERM');
  await exited;
  return output;
}

test('server.mjs: engine prewarm lands after server_started', async () => {
  const output = await bootServer({}, { until: (out) => /engine_prewarm(ed|_failed)/.test(out) });
  const started = output.indexOf('server_started');
  const prewarmed = output.indexOf('engine_prewarmed');
  assert.ok(started >= 0, `server_started logged (output: ${output.slice(-2000)})`);
  assert.ok(prewarmed > started, `engine_prewarmed logged after server_started (output: ${output.slice(-2000)})`);
  assert.match(output, /ENGINE_LOADED true/);
});

test('server.mjs: LLMIDE_ENGINE_PREWARM=0 boots without loading the engine', async () => {
  const output = await bootServer({ LLMIDE_ENGINE_PREWARM: '0' }, { until: (out) => out.includes('server_started'), settleMs: 500 });
  assert.ok(output.includes('server_started'), `server_started logged (output: ${output.slice(-2000)})`);
  assert.doesNotMatch(output, /engine_prewarm/);
  assert.match(output, /ENGINE_LOADED false/);
});
