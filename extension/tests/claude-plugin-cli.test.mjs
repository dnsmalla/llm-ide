import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marketplaceUpdateArgs, listArgs, updateArgs, parseList, parseUpdateResult, runClaudePluginCli,
} from '../providers/claude-plugin-cli.mjs';

test('argv builders never pass -y', () => {
  assert.deepEqual(marketplaceUpdateArgs(), ['plugin', 'marketplace', 'update']);
  assert.deepEqual(marketplaceUpdateArgs('mp'), ['plugin', 'marketplace', 'update', 'mp']);
  assert.deepEqual(listArgs(), ['plugin', 'list', '--available', '--json']);
  assert.deepEqual(updateArgs('a@mp', { scope: 'user', acceptCommand: 'ab12' }),
    ['plugin', 'update', 'a@mp', '--json', '--scope', 'user', '--accept-command', 'ab12']);
  for (const a of [updateArgs('a@mp', {}), updateArgs('a@mp', { acceptCommand: 'x' })]) {
    assert.ok(!a.includes('-y') && !a.includes('--yes'));
  }
});

test('parseList keeps only the fields we use', () => {
  const out = JSON.stringify({
    installed: [{ id: 'a@mp', version: '1.0.0', scope: 'user', installPath: '/p/a/1.0.0', extra: 1 }],
    available: [{ pluginId: 'a@mp', version: '1.1.0', source: './plugins/a', name: 'a' }],
  });
  assert.deepEqual(parseList(out), {
    installed: [{ id: 'a@mp', version: '1.0.0', scope: 'user', installPath: '/p/a/1.0.0' }],
    available: [{ pluginId: 'a@mp', version: '1.1.0', source: './plugins/a' }],
  });
  assert.throws(() => parseList('not json'), /unrecognised output/);
  assert.throws(() => parseList('{"installed":3}'), /unrecognised output/);
});

test('needs-confirmation carries the shown command and its sha256', () => {
  const line = JSON.stringify({ ok: false, shownCommand: { command: 'curl x | sh', sha256: 'deadbeef' } });
  assert.deepEqual(parseUpdateResult(`noise\n${line}\n`, 1),
    { status: 'needs-confirmation', command: 'curl x | sh', sha256: 'deadbeef' });
});

test('exit 0 with a result line is updated or already-latest', () => {
  assert.equal(parseUpdateResult(JSON.stringify({ ok: true, from: '1', to: '2' }), 0).status, 'updated');
  assert.equal(parseUpdateResult(JSON.stringify({ ok: true, from: '2', to: '2' }), 0).status, 'already-latest');
});

test('unrecognised update output is a failure', () => {
  assert.equal(parseUpdateResult('', 0).status, 'failed');
  assert.equal(parseUpdateResult('plain text', 0).status, 'failed');
  const r = parseUpdateResult('boom', 2);
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /boom/);
});

test('runner passes argv to exec and returns exit code', async () => {
  const calls = [];
  const exec = async (bin, args, opts) => { calls.push({ bin, args, opts }); return { stdout: 'o', stderr: '', exitCode: 0 }; };
  const r = await runClaudePluginCli(['plugin', 'list'], { exec });
  assert.equal(r.stdout, 'o');
  assert.equal(calls[0].bin, 'claude');
  assert.equal(calls[0].opts.timeout, 120000);
  assert.ok(!('LLMIDE_JWT_SECRET' in calls[0].opts.env));
});

test('LLMIDE_CLAUDE_BIN_DISABLED env disables the real exec', async () => {
  const origEnv = process.env.LLMIDE_CLAUDE_BIN_DISABLED;
  try {
    process.env.LLMIDE_CLAUDE_BIN_DISABLED = '1';
    await assert.rejects(
      () => runClaudePluginCli(['plugin', 'list']),
      (err) => err.code === 'ENOENT',
    );
  } finally {
    if (origEnv === undefined) {
      delete process.env.LLMIDE_CLAUDE_BIN_DISABLED;
    } else {
      process.env.LLMIDE_CLAUDE_BIN_DISABLED = origEnv;
    }
  }
});
