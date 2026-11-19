// Health check of one extension (plan 2026-11-19 phase 2): the five safety rules, each problem code and its fix.
// Servers, programs and the clock are fakes; plugin and catalog files live in a temp dir.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorld } from './helpers/extensions-world.mjs';
import { repoArchive, fixtureFetch } from './helpers/tar-fixture.mjs';

const world = createWorld({ tag: 'ext-health' });
process.env.LLMIDE_EXT_ALLOWED_SOURCES = '*/*';
const { freshDb } = await import('./provider-test-env.mjs');
const { users: [u1] } = freshDb(1);
const health = await import('../llm_agent/extensions/health.mjs');
const inst = await import('../llm_agent/extensions/install.mjs');
const installedMod = await import('../llm_agent/extensions/installed.mjs');
const { _resetInstalledRuntimeForTests } = await import('../llm_agent/extensions/installed-runtime.mjs');
const { HealthError } = health;
// A forced check inside 5 s of the last one is cached (L7), so a forced test call moves the clock first.
const checkExtension = (u, q, d) => { if (q.force) clock += 6000; return health.checkExtension(u, q, d); };

let clock = 1_000;
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
const REC = { id: 'files', consented: true, enabled: true };

/** Deps for an MCP check: one stdio registry row, a recording fake connect. */
function mcpDeps(over = {}) {
  const calls = { connect: 0, close: 0 };
  const deps = {
    now: () => clock, hub: false, selfHeal: false,
    mcpRecords: () => [REC],
    readSecret: () => () => '',
    effectiveServers: () => ({ files: { command: 'node', args: [] } }),
    resolveProgram: () => '/usr/bin/node',
    makeFetch: () => async () => new Response('x'),
    connect: async (servers) => {
      calls.connect += 1;
      const id = Object.keys(servers)[0];
      return {
        statuses: [{ name: id, status: 'connected', toolCount: 1 }],
        tools: [{ server: id, tool: 'list_things', description: `Lists things. token ${SECRET}` }],
        async close() { calls.close += 1; },
      };
    },
    ...over,
  };
  return { deps, calls };
}
const check = (q, deps) => checkExtension(u1, { kind: 'mcp', id: 'files', ...q }, deps);

beforeEach(() => { health._resetHealthForTests(); clock += 100_000; });

test('a working server is ok and lists its tools, redacted, and is closed', async () => {
  const { deps, calls } = mcpDeps();
  const r = await check({}, deps);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.problems, []);
  assert.equal(r.tools[0].name, 'list_things');
  assert.ok(!JSON.stringify(r).includes(SECRET), 'rule 4: a token in a tool description is redacted');
  assert.equal(calls.close, 1);
});

test('rule 1: a server the user has not allowed is never started', async () => {
  const { deps, calls } = mcpDeps({ mcpRecords: () => [{ ...REC, consented: false }] });
  const r = await check({}, deps);
  assert.equal(r.status, 'problem');
  assert.deepEqual([r.problems[0].code, r.problems[0].fix], ['NOT_ALLOWED', 'consent']);
  assert.equal(calls.connect, 0);
});

test('an unknown server is NOT_FOUND', async () => {
  const { deps } = mcpDeps({ mcpRecords: () => [] });
  await assert.rejects(check({}, deps), (e) => e instanceof HealthError && e.code === 'not_found');
  await assert.rejects(checkExtension(u1, { kind: 'bogus', id: 'x' }, deps), (e) => e.code === 'invalid');
});

test('a missing credential asks to set it and starts nothing', async () => {
  const { deps, calls } = mcpDeps({ mcpRecords: () => [{ ...REC, credential: { vaultKey: 'k', target: 'env', name: 'T' } }] });
  const r = await check({}, deps);
  assert.deepEqual([r.problems[0].code, r.problems[0].fix], ['CREDENTIAL_MISSING', 'set-credential']);
  assert.equal(calls.connect, 0);
});

test('rule 2: a stdio server on a hub is unknown and never started', async () => {
  const { deps, calls } = mcpDeps({ hub: true });
  const r = await check({}, deps);
  assert.equal(r.status, 'unknown');
  assert.deepEqual(r.problems.map((p) => [p.code, p.fix]), [['HUB_NO_LOCAL_PROGRAMS', 'none']]);
  assert.equal(calls.connect, 0);
});

test('a hub still checks a remote server', async () => {
  const { deps, calls } = mcpDeps({ hub: true, effectiveServers: () => ({ files: { type: 'http', url: 'https://mcp.example.com/mcp' } }) });
  assert.equal((await check({}, deps)).status, 'ok');
  assert.equal(calls.connect, 1);
});

test('a program that is not installed names only its basename', async () => {
  const { deps, calls } = mcpDeps({ resolveProgram: () => null, effectiveServers: () => ({ files: { command: '/Users/someone/bin/npx', args: [] } }) });
  const r = await check({}, deps);
  assert.deepEqual([r.problems[0].code, r.problems[0].fix, r.problems[0].detail], ['PROGRAM_MISSING', 'install-program', { program: 'npx' }]);
  assert.ok(!JSON.stringify(r).includes('/Users/'));
  assert.equal(calls.connect, 0);
});

test('resolveProgram finds a program on PATH without running it and rejects a missing one', () => {
  const dir = fs.mkdtempSync(path.join(world.root, 'bin-'));
  const f = path.join(dir, 'fake-tool');
  fs.writeFileSync(f, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(health.resolveProgram('fake-tool', {}, { pathEnv: dir }), f);
  assert.equal(health.resolveProgram('nope-tool', {}, { pathEnv: dir }), null);
  assert.equal(health.resolveProgram('fake-tool', { PATH: '/nonexistent' }, { pathEnv: dir }), null, 'the server env PATH wins');
});

test('a failed start says so in plain words and never echoes server text; the connection is closed', async () => {
  const { deps, calls } = mcpDeps({
    connect: async (servers) => {
      const id = Object.keys(servers)[0];
      return { statuses: [{ name: id, status: 'failed', toolCount: 0, reason: 'error' }], tools: [], error: SECRET, async close() { calls.close += 1; } };
    },
  });
  const r = await check({}, deps);
  assert.deepEqual([r.problems[0].code, r.problems[0].fix], ['START_FAILED', 'switch-off']);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.equal(calls.close, 1);
});

test('an unreachable remote server; a 401 or 403 is a credential problem, never sign-in', async () => {
  const remote = { files: { type: 'http', url: 'https://mcp.example.com/mcp?key=' + SECRET } };
  const failed = (id) => ({ statuses: [{ name: id, status: 'failed', toolCount: 0, reason: 'timeout' }], tools: [], async close() {} });
  const a = await check({ force: true }, mcpDeps({ effectiveServers: () => remote, connect: async (s) => failed(Object.keys(s)[0]) }).deps);
  assert.deepEqual([a.problems[0].code, a.problems[0].fix], ['UNREACHABLE', 'switch-off']);
  assert.ok(!JSON.stringify(a).includes(SECRET) && !JSON.stringify(a).includes('mcp.example.com'));
  const b = await check({ force: true }, mcpDeps({
    effectiveServers: () => remote,
    connect: async (s, o) => { await o.deps.makeFetch({})('https://x'); return failed(Object.keys(s)[0]); },
    makeFetch: () => async () => new Response('no', { status: 401 }),
  }).deps);
  assert.deepEqual([b.problems[0].code, b.problems[0].fix], ['CREDENTIAL_MISSING', 'set-credential']);
  const withHeaders = { files: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` } } };
  const probe = (cfg, status) => check({ force: true }, mcpDeps({
    effectiveServers: () => cfg,
    connect: async (s, o) => { await o.deps.makeFetch({})('https://x'); return failed(Object.keys(s)[0]); },
    makeFetch: () => async () => new Response('no', { status }),
  }).deps);
  const c = await probe(withHeaders, 401);
  assert.deepEqual([c.problems[0].code, c.problems[0].fix, c.problems[0].message], ['CREDENTIAL_REJECTED', 'set-credential', 'This MCP server rejected its credential. Enter it again.']);
  assert.equal((await probe(remote, 403)).problems[0].code, 'CREDENTIAL_REJECTED');
  assert.ok(!health.FIXES.includes('sign-in'));
});

test('M1: a loopback or private remote server is never probed (unknown / LOCAL_ADDRESS)', async () => {
  for (const url of ['http://localhost:3000/mcp', 'http://127.0.0.1/mcp', 'http://192.168.1.5/mcp', 'http://[::1]:9/mcp', 'http://box.local/mcp']) {
    const { deps, calls } = mcpDeps({ effectiveServers: () => ({ files: { type: 'http', url } }) });
    const r = await check({ force: true }, deps);
    assert.equal(r.status, 'unknown', url);
    assert.deepEqual([r.problems[0].code, r.problems[0].fix], ['LOCAL_ADDRESS', 'none']);
    assert.equal(calls.connect, 0, url);
  }
});

test('M1: an OAuth catalog server is never probed (unknown / SIGNS_IN_IN_CHAT)', async () => {
  const { deps, calls } = mcpDeps({ mcpRecords: () => [{ ...REC, catalogId: 'notion' }] });
  const r = await check({}, deps);
  assert.equal(r.status, 'unknown');
  assert.deepEqual([r.problems[0].code, r.problems[0].fix], ['SIGNS_IN_IN_CHAT', 'none']);
  assert.equal(calls.connect, 0);
});

test('L4: a switched-off server, or one of a switched-off plugin, is unknown and never started', async () => {
  const off = mcpDeps({ mcpRecords: () => [{ ...REC, enabled: false }] });
  const r = await check({}, off.deps);
  assert.deepEqual([r.status, r.problems[0].code, r.problems[0].fix], ['unknown', 'SWITCHED_OFF', 'none']);
  const plug = mcpDeps({ mcpRecords: () => [{ ...REC, source: 'plugin', pluginName: 'p1' }], pluginEnabled: () => (n) => n !== 'p1' });
  assert.equal((await check({ force: true }, plug.deps)).problems[0].code, 'SWITCHED_OFF');
  assert.equal(off.calls.connect + plug.calls.connect, 0);
});

test('L6: aborting the request aborts the probe, closes the late connection and caches nothing', async () => {
  const ac = new AbortController();
  let sawSignal = false;
  let closed = 0;
  const { deps } = mcpDeps({
    connect: (s, o) => new Promise((res) => { o.signal.addEventListener('abort', () => { sawSignal = true; res({ statuses: [], tools: [], async close() { closed += 1; } }); }); }),
  });
  const run = check({ signal: ac.signal }, deps);
  setTimeout(() => ac.abort(), 10);
  const r = await run;
  assert.equal(sawSignal, true);
  assert.equal(r.problems[0].code, 'START_FAILED');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(closed, 1);
  const again = mcpDeps();
  await check({}, again.deps);
  assert.equal(again.calls.connect, 1, 'the abandoned result was not cached');
});

test('L7: force within 5 s of a completed check returns it; after 5 s it runs again', async () => {
  const { deps, calls } = mcpDeps();
  await health.checkExtension(u1, { kind: 'mcp', id: 'files' }, deps);
  clock += 4_000;
  await health.checkExtension(u1, { kind: 'mcp', id: 'files', force: true }, deps);
  assert.equal(calls.connect, 1);
  clock += 2_000;
  await health.checkExtension(u1, { kind: 'mcp', id: 'files', force: true }, deps);
  assert.equal(calls.connect, 2);
});

test('L8: a relative program path is unknown, not resolved against the core folder', async () => {
  assert.equal(health.resolveProgram('./bin/x', {}), undefined);
  assert.equal(health.resolveProgram('bin/x', {}), undefined);
  const { deps, calls } = mcpDeps({ resolveProgram: health.resolveProgram, effectiveServers: () => ({ files: { command: './bin/x', args: [] } }) });
  const r = await check({}, deps);
  assert.deepEqual([r.status, r.problems[0].code, r.problems[0].fix], ['unknown', 'RELATIVE_PROGRAM', 'none']);
  assert.equal(calls.connect, 0);
});

test('rule 1 with the REAL effectiveMcpServers: an unconsented server never reaches connect', async () => {
  const { addMcpPlugin, setConsented, setEnabledMcp } = await import('../mcp/state.mjs');
  const id = addMcpPlugin({ name: 'real-one', command: 'node', args: [] }).plugin.id;
  const { deps, calls } = mcpDeps({ resolveProgram: () => '/usr/bin/node' });
  delete deps.mcpRecords; delete deps.effectiveServers;
  const q = { kind: 'mcp', id, force: true };
  assert.equal((await checkExtension(u1, q, deps)).problems[0].code, 'NOT_ALLOWED');
  assert.equal(calls.connect, 0);
  setConsented(u1, id, true);
  assert.equal((await checkExtension(u1, q, deps)).problems[0].code, 'SWITCHED_OFF', 'consented but off: still not started');
  assert.equal(calls.connect, 0);
  setEnabledMcp(u1, id, true);
  assert.equal((await checkExtension(u1, q, deps)).status, 'ok');
  assert.equal(calls.connect, 1);
  setConsented(u1, id, false);
  assert.equal((await checkExtension(u1, q, deps)).problems[0].code, 'NOT_ALLOWED');
  assert.equal(calls.connect, 1, 'revoked consent: connect is not reached again');
  const { effectiveMcpServers } = await import('../mcp/mcp-config.mjs');
  assert.deepEqual(effectiveMcpServers(u1, { only: id, ignoreEnabled: true, pluginEnabled: () => true }), {});
});

test('rule 4: a secret in env, a header and a loader warning appears nowhere in the result or the incident', async () => {
  const seen = [];
  const cfg = { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` }, env: { TOKEN: SECRET } };
  const { deps } = mcpDeps({
    selfHeal: true, recordIncident: (u, rep) => { seen.push(rep); },
    effectiveServers: () => ({ files: cfg }),
    connect: async (s, o) => { await o.deps.makeFetch({})('https://x'); throw new Error(`boom ${SECRET}`); },
    makeFetch: () => async () => new Response('no', { status: 401 }),
  });
  const r = await check({}, deps);
  assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(seen).includes(SECRET));
  // loader text: a stored path, a secret and YAML parser output never reach a message
  const hostile = `read failed: ENOENT ${world.root}/items/x/SKILL.md ${SECRET} bad indentation at line 3`;
  const dir = path.join(process.env.LLMIDE_PLUGIN_DIR, 'warnplug');
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"warnplug"}');
  const { reloadPlugins } = await import('../llm_agent/skills/registry.mjs');
  reloadPlugins();
  const pr = await checkExtension(u1, { kind: 'plugin', id: 'warnplug', force: true }, { now: () => clock, selfHeal: true, recordIncident: (u, rep) => { seen.push(rep); }, loadPlugin: () => ({ warnings: [hostile, `invalid name ${SECRET}`] }) });
  assert.equal(pr.status, 'problem');
  const all = JSON.stringify([pr, seen]);
  assert.ok(!all.includes(SECRET) && !all.includes(world.root) && !all.includes('indentation'));
});

test('M3: only faults are recorded, and only when new for the item', async () => {
  const seen = [];
  const rec = (u, rep) => { seen.push(rep.message); };
  // user-setup problems are never incidents
  await check({}, mcpDeps({ mcpRecords: () => [{ ...REC, consented: false }], selfHeal: true, recordIncident: rec }).deps);
  await check({ force: true }, mcpDeps({ resolveProgram: () => null, selfHeal: true, recordIncident: rec }).deps);
  assert.deepEqual(seen, []);
  // a fault is recorded on the transition, not on every forced re-check or cache expiry
  const failing = mcpDeps({ connect: async (s) => ({ statuses: [{ name: Object.keys(s)[0], status: 'failed', reason: 'error' }], tools: [], async close() {} }), selfHeal: true, recordIncident: rec });
  await check({ force: true }, failing.deps);
  await check({ force: true }, failing.deps);
  clock += 40_000;
  await check({}, failing.deps);
  assert.deepEqual(seen, ['mcp files: START_FAILED']);
  await check({ force: true }, mcpDeps({ selfHeal: true, recordIncident: rec }).deps); // recovers
  await check({ force: true }, failing.deps); // recurs
  assert.equal(seen.length, 2);
});

test('rule 3: a connect that throws or hangs is reported, and a late connection is still closed', async () => {
  const thrown = await check({ force: true }, mcpDeps({ connect: async () => { throw new Error(`boom ${SECRET}`); } }).deps);
  assert.equal(thrown.problems[0].code, 'START_FAILED');
  assert.ok(!JSON.stringify(thrown).includes(SECRET));
  let closed = 0;
  let release;
  const late = new Promise((r) => { release = r; });
  const r = await check({ force: true }, mcpDeps({
    limits: { connectMs: -4999 },
    connect: async () => { await late; return { statuses: [], tools: [], async close() { closed += 1; } }; },
  }).deps);
  assert.equal(r.problems[0].code, 'START_FAILED');
  assert.match(r.problems[0].message, /too long/);
  release();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(closed, 1);
});

test('rule 3: close() runs when listing the result throws', async () => {
  let closed = 0;
  const { deps } = mcpDeps({ connect: async (s) => ({ statuses: [{ name: Object.keys(s)[0], status: 'connected' }], get tools() { throw new Error('x'); }, async close() { closed += 1; } }) });
  await assert.rejects(check({}, deps));
  assert.equal(closed, 1);
});

test('rule 5: concurrent checks share one run; results are cached 30 s; force bypasses', async () => {
  const { deps, calls } = mcpDeps();
  const [a, b] = await Promise.all([check({}, deps), check({}, deps)]);
  assert.equal(calls.connect, 1);
  assert.equal(a, b);
  clock += 29_000;
  await check({}, deps);
  assert.equal(calls.connect, 1);
  await check({ force: true }, deps);
  assert.equal(calls.connect, 2);
  clock += 31_000;
  await check({}, deps);
  assert.equal(calls.connect, 3);
  await checkExtension('other-user', { kind: 'mcp', id: 'files' }, deps);
  assert.equal(calls.connect, 4, 'the cache is per user');
});

test('plugin: a missing hook file is reported; a clean plugin is ok; an unknown one is NOT_FOUND', async () => {
  const dir = path.join(world.pluginDir ?? process.env.LLMIDE_PLUGIN_DIR, 'hookmiss');
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"hookmiss"}');
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/run.sh' }] }] } }));
  const { reloadPlugins } = await import('../llm_agent/skills/registry.mjs');
  reloadPlugins();
  const r = await checkExtension(u1, { kind: 'plugin', id: 'hookmiss' }, { now: () => clock, selfHeal: false });
  assert.deepEqual(r.problems.map((p) => [p.code, p.fix]), [['HOOK_FILE_MISSING', 'none']]);
  assert.ok(!JSON.stringify(r).includes(dir));
  assert.deepEqual(r.problems[0].detail, { file: 'run.sh' });
  fs.writeFileSync(path.join(dir, 'run.sh'), 'exit 0\n');
  const ok = await checkExtension(u1, { kind: 'plugin', id: 'hookmiss', force: true }, { now: () => clock, selfHeal: false });
  assert.equal(ok.status, 'ok', 'untrusted hooks are a choice, not a problem');
  await assert.rejects(checkExtension(u1, { kind: 'plugin', id: 'nope' }, {}), (e) => e.code === 'not_found');
});

test('plugin: a repairable source makes the hook fix "repair"', async () => {
  const { reloadPlugins, loadedPlugins } = await import('../llm_agent/skills/registry.mjs');
  reloadPlugins();
  const p = loadedPlugins().find((x) => x.name === 'hookmiss');
  fs.rmSync(path.join(p.dir, 'run.sh'));
  const r = await checkExtension(u1, { kind: 'plugin', id: 'hookmiss', force: true }, { now: () => clock, selfHeal: false, pluginSource: () => ({ kind: 'git' }) });
  assert.equal(r.problems[0].fix, 'repair');
});

test('skill kit: a missing folder, an unreadable skill, and a clean kit', async () => {
  const base = { now: () => clock, selfHeal: false };
  const q = { kind: 'skill-kit', id: 'kit', force: true };
  const gone = await checkExtension(u1, q, { ...base, llmSource: () => ({ id: 'kit', origin: 'git', location: path.join(world.root, 'absent') }) });
  assert.deepEqual([gone.problems[0].code, gone.problems[0].fix], ['FILES_MISSING', 'none']);
  const builtin = await checkExtension(u1, q, { ...base, llmSource: () => ({ id: 'kit', origin: 'builtin', location: path.join(world.root, 'absent') }) });
  assert.equal(builtin.problems[0].fix, 'repair');
  const kit = fs.mkdtempSync(path.join(world.root, 'kit-'));
  fs.mkdirSync(path.join(kit, 'skills', 'good'), { recursive: true });
  fs.mkdirSync(path.join(kit, 'skills', 'bad'), { recursive: true });
  fs.mkdirSync(path.join(kit, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(kit, '.claude-plugin', 'plugin.json'), '{"name":"kit"}');
  fs.writeFileSync(path.join(kit, 'skills', 'good', 'SKILL.md'), '---\nname: good\ndescription: d\n---\nbody\n');
  fs.writeFileSync(path.join(kit, 'skills', 'bad', 'SKILL.md'), 'no frontmatter at all\n');
  const r = await checkExtension(u1, q, { ...base, llmSource: () => ({ id: 'kit', origin: 'git', location: kit }) });
  assert.deepEqual(r.problems.map((p) => [p.code, p.fix]), [['SKILL_INVALID', 'none']]);
  assert.deepEqual(r.problems[0].detail, { file: 'skills/bad/SKILL.md' });
  assert.ok(!JSON.stringify(r).includes(kit));
  fs.rmSync(path.join(kit, 'skills', 'bad'), { recursive: true });
  assert.equal((await checkExtension(u1, q, { ...base, llmSource: () => ({ id: 'kit', origin: 'git', location: kit }) })).status, 'ok');
});

// ---- catalog items (real installs from fixture archives) ----
const SHA = 'a'.repeat(40);
const url = (r) => `https://codeload.github.com/acme/${r}/tar.gz/${SHA}`;
const REPOS = {
  runner: { '.claude-plugin/plugin.json': '{"name":"runner"}', 'hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] } }) },
  remote2: { 'server.json': JSON.stringify({ name: 'acme/remote2', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example.com/mcp' }] }) },
  remote: { 'server.json': JSON.stringify({ name: 'acme/remote', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example.com/mcp' }] }) },
};
const fetchAll = fixtureFetch(Object.fromEntries(Object.entries(REPOS).map(([r, f]) => [url(r), repoArchive(f)])));
const install = (r) => inst.installFromGithub({ userId: u1, url: `https://github.com/acme/${r}`, commit: SHA }, { fetch: fetchAll });

test('catalog: missing consent is NOT_ALLOWED / consent; nothing is started', async () => {
  await install('runner');
  let started = 0;
  const r = await checkExtension(u1, { kind: 'catalog', id: 'plugin:acme/runner' }, { now: () => clock, selfHeal: false, connect: async () => { started += 1; } });
  assert.deepEqual([r.problems[0].code, r.problems[0].fix], ['NOT_ALLOWED', 'consent']);
  assert.equal(started, 0);
  await assert.rejects(checkExtension(u1, { kind: 'catalog', id: 'plugin:acme/none' }, {}), (e) => e.code === 'not_found');
});

test('catalog: a switched-on remote MCP item is connected and checked; changed files read FILES_CHANGED / repair', async () => {
  await install('remote');
  inst.setInstalledEnabled(u1, 'mcp:acme/remote', true, { consents: ['mcp'], commit: SHA });
  const { deps, calls } = mcpDeps();
  const d = { ...deps, mcpRecords: undefined, effectiveServers: undefined };
  delete d.mcpRecords; delete d.effectiveServers;
  const r = await checkExtension(u1, { kind: 'catalog', id: 'mcp:acme/remote' }, d);
  assert.equal(r.status, 'ok');
  assert.equal(calls.connect, 1);
  assert.equal(calls.close, 1);
  assert.equal(r.tools[0].name, 'list_things');
  const stored = installedMod.itemStoreDir(u1, 'mcp:acme/remote');
  const sha = fs.readdirSync(stored)[0];
  fs.writeFileSync(path.join(stored, sha, 'server.json'), '{"tampered":true}');
  _resetInstalledRuntimeForTests();
  const bad = await checkExtension(u1, { kind: 'catalog', id: 'mcp:acme/remote', force: true }, d);
  assert.deepEqual([bad.problems[0].code, bad.problems[0].fix], ['FILES_CHANGED', 'repair']);
  assert.equal(calls.connect, 1, 'changed files are never started');
  assert.ok(!JSON.stringify(bad).includes(world.root));
});

test('L8: a hook path that leaves the plugin folder is ignored', async () => {
  const dir = path.join(process.env.LLMIDE_PLUGIN_DIR, 'hooktrav');
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"hooktrav"}');
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/../nowhere.sh' }] }] } }));
  const { reloadPlugins } = await import('../llm_agent/skills/registry.mjs');
  reloadPlugins();
  const r = await checkExtension(u1, { kind: 'plugin', id: 'hooktrav' }, { now: () => clock, selfHeal: false });
  assert.equal(r.status, 'ok');
});

test('M2: a catalog loader warning becomes a fixed sentence; a switched-off item is unknown', async () => {
  const id = 'mcp:acme/remote2';
  await install('remote2');
  inst.setInstalledEnabled(u1, id, true, { consents: ['mcp'], commit: SHA });
  _resetInstalledRuntimeForTests();
  const hostile = `${id}: read failed: ENOENT ${world.root}/x ${SECRET}`;
  const base = { now: () => clock, selfHeal: false };
  const off = await checkExtension(u1, { kind: 'catalog', id, force: true }, { ...base, catalogOverlay: () => ({ items: new Map() }) });
  assert.deepEqual([off.status, off.problems[0].code, off.problems[0].fix], ['unknown', 'SWITCHED_OFF', 'none']);
  const r = await checkExtension(u1, { kind: 'catalog', id, force: true }, { ...base, catalogActive: () => ({ warnings: [hostile, `${id}: bad yaml at line 2 ${SECRET}`], mcp: [] }) });
  assert.deepEqual(r.problems.map((p) => [p.code, p.fix]), [['FILES_CHANGED', 'repair'], ['LOAD_WARNING', 'none']]);
  assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(world.root));
});

test('L6: a joiner is not cancelled when the first request goes away; the run stops only when every waiter is gone', async () => {
  const mk = () => {
    const st = { aborted: false, closed: 0, release: null };
    const { deps } = mcpDeps({
      connect: (sv, o) => new Promise((res) => {
        const id = Object.keys(sv)[0];
        const done = () => res({ statuses: [{ name: id, status: 'connected' }], tools: [], async close() { st.closed += 1; } });
        st.release = done;
        o.signal.addEventListener('abort', () => { st.aborted = true; done(); });
      }),
    });
    return { st, deps };
  };
  const q = { kind: 'mcp', id: 'files' };
  // 1: A aborts, B stays and gets the completed result
  const one = mk();
  const a = new AbortController();
  const b = new AbortController();
  const pa = health.checkExtension(u1, { ...q, signal: a.signal }, one.deps);
  const pb = health.checkExtension(u1, { ...q, signal: b.signal }, one.deps);
  await new Promise((r) => setTimeout(r, 5));
  a.abort();
  await pa;
  assert.equal(one.st.aborted, false, 'the connect was not aborted');
  one.st.release();
  assert.equal((await pb).status, 'ok');
  assert.equal(one.st.closed, 1);
  // 2: both abort, the connect sees it and the server is closed
  health._resetHealthForTests();
  const two = mk();
  const c = new AbortController();
  const e = new AbortController();
  const pc = health.checkExtension(u1, { ...q, signal: c.signal }, two.deps);
  const pe = health.checkExtension(u1, { ...q, signal: e.signal }, two.deps);
  await new Promise((r) => setTimeout(r, 5));
  c.abort();
  assert.equal(two.st.aborted, false);
  e.abort();
  await Promise.all([pc, pe]);
  assert.equal(two.st.aborted, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(two.st.closed, 1);
});
