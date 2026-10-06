// Update orchestrator for Claude-imported plugins: two-tier detection and the
// one-click update (Claude CLI update -> re-import -> trust reset). The real
// claude CLI is never run here: every test injects a fake `run`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'claude-update-'));
process.env.LLMIDE_PLUGIN_DIR = join(tmp, 'llmide-plugins');

const { checkClaudeUpdates, updateClaudePlugin, isPluginUpdating, _resetForTests } = await import('../plugins/claude-update.mjs');
const { importPlugin, readImportStamp } = await import('../plugins/claude-adapter.mjs');
const { setHooksTrusted, listHooksTrusted, listHooksTrustedKinds, setEnabled, listEnabled, clearHooksTrustForPlugin } = await import('../plugins/state.mjs');

let caseCounter = 0;

/** A fresh Claude root + llm-ide plugin dir with `claude-demo` imported from demo@mp 1.0.0. */
function setup({ legacy = false } = {}) {
  caseCounter += 1;
  const base = join(tmp, `case-${caseCounter}`);
  const claudeRoot = join(base, 'claude');
  const mnDir = join(base, 'llmide');
  const installPath = writeClaudeVersion(claudeRoot, '1.0.0');
  mkdirSync(mnDir, { recursive: true });
  if (legacy) {
    mkdirSync(join(mnDir, 'claude-demo'), { recursive: true });
    writeFileSync(join(mnDir, 'claude-demo', 'plugin.json'), JSON.stringify({
      name: 'claude-demo', version: '0.0.0', origin: 'claude', sourcePlugin: 'demo',
    }), 'utf8');
  } else {
    const res = importPlugin({
      source: 'installed', name: 'demo', installPath, sourceVersion: '1.0.0', scope: 'user', claudeRoot, llmidePluginDir: mnDir,
    });
    assert.equal(res.ok, true, res.error);
  }
  return { claudeRoot, mnDir, installPath };
}

/** Write one version of demo into Claude's cache; returns its installPath. */
function writeClaudeVersion(claudeRoot, version, { hooks = '{"hooks":{}}' } = {}) {
  const dir = join(claudeRoot, 'cache', 'mp', 'demo', version);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'hello'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version }), 'utf8');
  writeFileSync(join(dir, 'skills', 'hello', 'SKILL.md'), `---\nname: hello\ndescription: hi\n---\nv${version}`, 'utf8');
  writeFileSync(join(dir, 'hooks', 'hooks.json'), hooks, 'utf8');
  return dir;
}

/**
 * Fake CLI. `list` is a function (so tests can change what Claude reports after
 * the update) or an object; `update` returns {stdout, exitCode} or a promise.
 */
function fakeRun({ list, update, enoent = false } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (enoent) { const err = new Error('spawn claude ENOENT'); err.code = 'ENOENT'; throw err; }
    const key = `${args[1]} ${args[2]}`;
    if (key === 'marketplace update') return { stdout: '', stderr: '', exitCode: 0 };
    if (key === 'list --available') {
      const body = typeof list === 'function' ? list() : list;
      return { stdout: JSON.stringify(body), stderr: '', exitCode: 0 };
    }
    if (args[1] === 'update') {
      const r = typeof update === 'function' ? await update(args) : update;
      return { stderr: '', ...r };
    }
    throw new Error(`unexpected argv ${args.join(' ')}`);
  };
  return { run, calls };
}

const listOf = (installed, available = []) => ({ installed, available });
const inst = (version, installPath, extra = {}) => ({ id: 'demo@mp', version, scope: 'user', installPath, ...extra });
const okLine = (from, to) => ({ stdout: `${JSON.stringify({ ok: true, from, to })}\n`, exitCode: 0 });

function baseDeps(env, run, extra = {}) {
  const calls = { reload: 0, clearTrust: [], clearMcp: [] };
  const deps = {
    run,
    claudeRoot: env.claudeRoot,
    llmidePluginDir: env.mnDir,
    reload: async () => { calls.reload += 1; },
    isTurnActive: () => false,
    clearTrust: (n) => calls.clearTrust.push(n),
    clearMcpConsents: (n) => calls.clearMcp.push(n),
    ...extra,
  };
  return { deps, calls };
}

test('reimport tier when Claude is ahead', async () => {
  _resetForTests();
  const env = setup();
  const p = writeClaudeVersion(env.claudeRoot, '1.1.0');
  const { run } = fakeRun({ list: listOf([inst('1.1.0', p)]) });
  const res = await checkClaudeUpdates({ deps: { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir } });
  assert.equal(res.cli, true);
  assert.equal(typeof res.checkedAt, 'string');
  assert.equal(res.updates.length, 1);
  assert.deepEqual(
    { ...res.updates[0] },
    { name: 'claude-demo', pluginId: 'demo@mp', importedVersion: '1.0.0', claudeVersion: '1.1.0', latest: '1.1.0', tier: 'reimport' },
  );
});

test('upstream tier from catalog version', async () => {
  _resetForTests();
  const env = setup();
  const { run } = fakeRun({ list: listOf([inst('1.0.0', env.installPath)], [{ pluginId: 'demo@mp', version: '1.2.0', source: './demo' }]) });
  const res = await checkClaudeUpdates({ deps: { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir } });
  assert.equal(res.updates.length, 1);
  assert.equal(res.updates[0].tier, 'upstream');
  assert.equal(res.updates[0].latest, '1.2.0');
  assert.equal(res.updates[0].claudeVersion, '1.0.0');
});

test('no entry when neither tier applies', async () => {
  _resetForTests();
  const env = setup();
  const { run } = fakeRun({ list: listOf([inst('1.0.0', env.installPath)], [{ pluginId: 'demo@mp', source: './demo' }]) });
  const res = await checkClaudeUpdates({ deps: { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir } });
  assert.deepEqual(res.updates, []);
});

test('legacy import without stamp is reimport', async () => {
  _resetForTests();
  const env = setup({ legacy: true });
  const { run } = fakeRun({ list: listOf([inst('1.0.0', env.installPath)]) });
  const res = await checkClaudeUpdates({ deps: { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir } });
  assert.equal(res.updates.length, 1);
  assert.equal(res.updates[0].tier, 'reimport');
  assert.equal(res.updates[0].importedVersion, null);
});

test('marketplace update never runs on a non-forced check', async () => {
  _resetForTests();
  const env = setup();
  const { run, calls } = fakeRun({ list: listOf([inst('1.0.0', env.installPath)]) });
  const deps = { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir };
  await checkClaudeUpdates({ deps });
  await checkClaudeUpdates({ deps });
  assert.equal(calls.filter((a) => a[1] === 'marketplace').length, 0);
  assert.equal(calls.filter((a) => a[1] === 'list').length, 2, 'tier 1 is always read fresh');
});

test('forced checks refresh at most once per 30 minutes', async () => {
  _resetForTests();
  const env = setup();
  const { run, calls } = fakeRun({ list: listOf([inst('1.0.0', env.installPath)]) });
  let clock = 1_000_000;
  const deps = { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir, now: () => clock };
  const mpCalls = () => calls.filter((a) => a[1] === 'marketplace').length;
  await checkClaudeUpdates({ force: true, deps });
  clock += 10 * 60 * 1000;
  await checkClaudeUpdates({ force: true, deps });
  assert.equal(mpCalls(), 1, 'a forced check within 30 min reuses the refresh');
  clock += 31 * 60 * 1000;
  await checkClaudeUpdates({ force: true, deps });
  assert.equal(mpCalls(), 2, 'an expired cache refreshes again');
});

test('concurrent forced checks share one marketplace update', async () => {
  _resetForTests();
  const env = setup();
  const { run: base, calls } = fakeRun({ list: listOf([inst('1.0.0', env.installPath)]) });
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = async (args) => { if (args[1] === 'marketplace') await gate; return base(args); };
  const deps = { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir };
  const a = checkClaudeUpdates({ force: true, deps });
  const b = checkClaudeUpdates({ force: true, deps });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.cli && rb.cli, true);
  assert.equal(calls.filter((x) => x[1] === 'marketplace').length, 1);
});

test('a forced check during an update answers from the list only', async () => {
  _resetForTests();
  const env = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { run, calls } = fakeRun({
    list: listOf([inst('1.0.0', env.installPath)]),
    update: async () => { await gate; return okLine('1.0.0', '1.0.0'); },
  });
  const { deps } = baseDeps(env, run);
  const updating = updateClaudePlugin({ name: 'claude-demo', deps });
  const res = await checkClaudeUpdates({ force: true, deps: { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir } });
  assert.equal(res.cli, true);
  assert.equal(calls.filter((a) => a[1] === 'marketplace').length, 0);
  release();
  await updating;
});

test('cli missing falls back to the scan', async () => {
  _resetForTests();
  const env = setup();
  // The fallback scan reads installed_plugins.json, which points at a newer version.
  const p = writeClaudeVersion(env.claudeRoot, '1.3.0');
  writeFileSync(join(env.claudeRoot, 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'demo@mp': [{ scope: 'user', installPath: p, version: '1.3.0' }] },
  }), 'utf8');
  const { run } = fakeRun({ enoent: true });
  const res = await checkClaudeUpdates({ deps: { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir } });
  assert.equal(res.cli, false);
  assert.deepEqual(res.updates, [{
    name: 'claude-demo', pluginId: null, importedVersion: '1.0.0', claudeVersion: '1.3.0', latest: '1.3.0', tier: 'upstream',
  }]);
});

test('needs confirmation round trip', async () => {
  _resetForTests();
  const env = setup();
  const p = writeClaudeVersion(env.claudeRoot, '1.1.0');
  let updated = false;
  const { run, calls } = fakeRun({
    list: () => listOf([updated ? inst('1.1.0', p) : inst('1.0.0', env.installPath)]),
    update: (args) => {
      if (!args.includes('--accept-command')) {
        return { stdout: JSON.stringify({ ok: false, shownCommand: { command: 'npm i', sha256: 'abc123' } }), exitCode: 1 };
      }
      updated = true;
      return okLine('1.0.0', '1.1.0');
    },
  });
  const { deps } = baseDeps(env, run);
  const first = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(first.status, 409);
  assert.deepEqual(first.body, { code: 'NEEDS_CONFIRMATION', command: 'npm i', sha256: 'abc123' });
  assert.equal(readImportStamp('claude-demo', env.mnDir).sourceVersion, '1.0.0', 'nothing changed yet');

  const second = await updateClaudePlugin({ name: 'claude-demo', acceptCommand: 'abc123', deps });
  assert.equal(second.status, 200);
  assert.equal(second.body.ok, true);
  const updateCalls = calls.filter((a) => a[1] === 'update');
  const last = updateCalls[updateCalls.length - 1];
  assert.deepEqual(last.slice(last.indexOf('--accept-command')), ['--accept-command', 'abc123']);
  for (const argv of updateCalls) assert.equal(argv.includes('-y'), false, '-y is never passed');
  assert.ok(updateCalls[0].includes('--scope') && updateCalls[0].includes('user'), 'scope as installed');
});

test('CLI failure leaves llm-ide untouched', async () => {
  _resetForTests();
  const env = setup();
  const { run } = fakeRun({ list: listOf([inst('1.0.0', env.installPath)]), update: { stdout: 'boom', exitCode: 1 } });
  const { deps, calls } = baseDeps(env, run);
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'CLI_FAILED');
  assert.equal(typeof res.body.detail, 'string');
  assert.equal(readImportStamp('claude-demo', env.mnDir).sourceVersion, '1.0.0');
  assert.equal(calls.reload, 0);
});

test('CLI missing during update is CLI_FAILED', async () => {
  _resetForTests();
  const env = setup();
  const { run } = fakeRun({ enoent: true });
  const { deps } = baseDeps(env, run);
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { code: 'CLI_FAILED', detail: 'claude CLI not found' });
  assert.equal(isPluginUpdating(), false);
});

test('re-import failure after Claude updated', async () => {
  _resetForTests();
  const env = setup();
  let updated = false;
  const { run } = fakeRun({
    list: () => listOf([updated ? inst('1.1.0', join(env.claudeRoot, 'cache', 'mp', 'demo', 'gone')) : inst('1.0.0', env.installPath)]),
    update: () => { updated = true; return okLine('1.0.0', '1.1.0'); },
  });
  const { deps, calls } = baseDeps(env, run);
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'REIMPORT_FAILED');
  assert.equal(res.body.claudeUpdated, true);
  assert.equal(typeof res.body.detail, 'string');
  assert.equal(readImportStamp('claude-demo', env.mnDir).sourceVersion, '1.0.0', 'old copy kept');
  assert.equal(calls.reload, 0);
});

test('trust reset only when executables changed', async () => {
  _resetForTests();
  const env = setup();
  const changed = writeClaudeVersion(env.claudeRoot, '1.1.0', { hooks: '{"hooks":{"PreToolUse":[{"command":"curl x"}]}}' });
  const same = writeClaudeVersion(env.claudeRoot, '1.2.0');
  let current = inst('1.0.0', env.installPath);
  const { run } = fakeRun({ list: () => listOf([current]), update: () => okLine('x', 'y') });

  const a = baseDeps(env, run);
  current = inst('1.0.0', env.installPath);
  const runChanged = async (args) => { if (args[1] === 'update') current = inst('1.1.0', changed); return run(args); };
  const res1 = await updateClaudePlugin({ name: 'claude-demo', deps: { ...a.deps, run: runChanged } });
  assert.equal(res1.status, 200);
  assert.deepEqual(res1.body, { ok: true, from: '1.0.0', to: '1.1.0', trustReset: true, claudeUpdated: true });
  assert.deepEqual(a.calls.clearTrust, ['claude-demo']);
  assert.deepEqual(a.calls.clearMcp, ['claude-demo'], 'MCP consents reset with hook trust');
  assert.equal(a.calls.reload, 1);
  assert.equal(readImportStamp('claude-demo', env.mnDir).sourceVersion, '1.1.0');

  // 1.1.0 -> 1.2.0 puts the hooks back, so to make "unchanged" exact, compare 1.2.0 -> 1.2.0'.
  const b = baseDeps(env, run);
  const runSame = async (args) => { if (args[1] === 'update') current = inst('1.2.0', same); return run(args); };
  await updateClaudePlugin({ name: 'claude-demo', deps: { ...b.deps, run: runSame } });
  const c = baseDeps(env, run);
  const res3 = await updateClaudePlugin({ name: 'claude-demo', deps: { ...c.deps, run: runSame } });
  assert.equal(res3.body.trustReset, false);
  assert.deepEqual(c.calls.clearTrust, []);
  assert.deepEqual(c.calls.clearMcp, []);
});

test('default clearTrust drops hook trust for every user', async () => {
  _resetForTests();
  setEnabled('u1', 'claude-demo', true);
  setHooksTrusted('u1', 'claude-demo', true, ['hooks', 'bin']);
  setHooksTrusted('u2', 'claude-demo', true);
  setHooksTrusted('u2', 'other', true);
  clearHooksTrustForPlugin('claude-demo');
  assert.equal(listHooksTrusted('u1').has('claude-demo'), false);
  assert.equal(listHooksTrustedKinds('u1').has('claude-demo'), false);
  assert.equal(listHooksTrusted('u2').has('claude-demo'), false);
  assert.equal(listHooksTrusted('u2').has('other'), true, 'other plugins keep their grant');
  assert.equal(listEnabled('u1').has('claude-demo'), true, 'enable state is kept');
});

test('one update at a time', async () => {
  _resetForTests();
  const env = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { run } = fakeRun({
    list: listOf([inst('1.0.0', env.installPath)]),
    update: async () => { await gate; return okLine('1.0.0', '1.0.0'); },
  });
  const { deps } = baseDeps(env, run);
  const first = updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(isPluginUpdating(), true);
  const second = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { code: 'UPDATE_IN_PROGRESS' });
  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(isPluginUpdating(), false);
});

test('refuses while a chat turn is running', async () => {
  _resetForTests();
  const env = setup();
  const { run, calls } = fakeRun({ list: listOf([inst('1.0.0', env.installPath)]) });
  const { deps } = baseDeps(env, run, { isTurnActive: () => true });
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { code: 'BUSY' });
  assert.equal(calls.length, 0);
});

test('already latest', async () => {
  _resetForTests();
  const env = setup();
  // Pretend the stamp is stale-but-equal: delete the copied skill so a re-import is observable.
  const skill = join(env.mnDir, 'claude-demo', 'skills', 'hello', 'SKILL.md');
  writeFileSync(skill, 'tampered', 'utf8');
  const { run } = fakeRun({ list: listOf([inst('1.0.0', env.installPath)]), update: okLine('1.0.0', '1.0.0') });
  const { deps, calls } = baseDeps(env, run);
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, from: '1.0.0', to: '1.0.0', trustReset: false, claudeUpdated: false });
  assert.match(readFileSync(skill, 'utf8'), /v1\.0\.0/, 're-import still ran');
  assert.equal(calls.reload, 1);
});

test('unknown or non-Claude plugin is NOT_FOUND', async () => {
  _resetForTests();
  const env = setup();
  const { run, calls } = fakeRun({ list: listOf([]) });
  const { deps } = baseDeps(env, run);
  assert.equal((await updateClaudePlugin({ name: 'claude-nope', deps })).status, 404);
  assert.equal((await updateClaudePlugin({ name: '../etc', deps })).status, 404);
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 404, 'imported but no longer installed in Claude Code');
  assert.equal(calls.filter((a) => a[1] === 'update').length, 0);
  assert.ok(existsSync(join(env.mnDir, 'claude-demo')));
});

test('required deps are enforced', async () => {
  _resetForTests();
  const env = setup();
  const { run } = fakeRun({ list: listOf([]) });
  await assert.rejects(updateClaudePlugin({ name: 'claude-demo', deps: { run, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir } }), /reload/);
  await assert.rejects(
    updateClaudePlugin({ name: 'claude-demo', deps: { run, reload: () => {}, isTurnActive: () => false, claudeRoot: env.claudeRoot, llmidePluginDir: env.mnDir } }),
    /clearMcpConsents/,
  );
});

test('reimport tier at click time is offline and never runs the CLI update', async () => {
  _resetForTests();
  const env = setup();
  const p = writeClaudeVersion(env.claudeRoot, '1.1.0');
  const { run, calls } = fakeRun({ list: listOf([inst('1.1.0', p)]), update: () => { throw new Error('must not run'); } });
  const { deps, calls: depCalls } = baseDeps(env, run);
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, from: '1.0.0', to: '1.1.0', trustReset: false, claudeUpdated: false });
  assert.equal(calls.filter((a) => a[1] === 'update').length, 0, 'updateArgs never used');
  assert.equal(readImportStamp('claude-demo', env.mnDir).sourceVersion, '1.1.0');
  assert.equal(depCalls.reload, 1);
});

test('upstream tier at click time runs the CLI update', async () => {
  _resetForTests();
  const env = setup();
  const p = writeClaudeVersion(env.claudeRoot, '1.2.0');
  let updated = false;
  const { run, calls } = fakeRun({
    list: () => listOf([updated ? inst('1.2.0', p) : inst('1.0.0', env.installPath)], [{ pluginId: 'demo@mp', version: '1.2.0', source: './demo' }]),
    update: () => { updated = true; return okLine('1.0.0', '1.2.0'); },
  });
  const { deps } = baseDeps(env, run);
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 200);
  assert.equal(res.body.claudeUpdated, true);
  assert.equal(res.body.to, '1.2.0');
  assert.equal(calls.filter((a) => a[1] === 'update').length, 1);
});

test('CLI missing during update re-imports offline when Claude is ahead', async () => {
  _resetForTests();
  const env = setup();
  const p = writeClaudeVersion(env.claudeRoot, '1.3.0');
  writeFileSync(join(env.claudeRoot, 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'demo@mp': [{ scope: 'user', installPath: p, version: '1.3.0' }] },
  }), 'utf8');
  const { run } = fakeRun({ enoent: true });
  const { deps, calls } = baseDeps(env, run);
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, from: '1.0.0', to: '1.3.0', trustReset: false, claudeUpdated: false });
  const stamp = readImportStamp('claude-demo', env.mnDir);
  assert.equal(stamp.sourceVersion, '1.3.0');
  assert.equal(stamp.sourceScope, 'user');
  assert.equal(calls.reload, 1);
});

test('CLI missing during update with Claude at the stamped version is CLI_FAILED', async () => {
  _resetForTests();
  const env = setup();
  writeFileSync(join(env.claudeRoot, 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'demo@mp': [{ scope: 'user', installPath: env.installPath, version: '1.0.0' }] },
  }), 'utf8');
  const { run } = fakeRun({ enoent: true });
  const { deps, calls } = baseDeps(env, run);
  const res = await updateClaudePlugin({ name: 'claude-demo', deps });
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { code: 'CLI_FAILED', detail: 'claude CLI not found' });
  assert.equal(calls.reload, 0);
});
