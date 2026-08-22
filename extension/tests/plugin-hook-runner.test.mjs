// Hook execution. A trusted plugin's `command` hooks become SDK hook
// callbacks; everything about how they run is bounded here: consent, timeout,
// output cap, and the exit-code-2 blocking convention Claude Code defines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-runner-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');

const { buildPluginHooks, runHookCommand } = await import('../llm_agent/sdk/hooks.mjs');

const hook = (extra = {}) => ({ event: 'PreToolUse', matcher: null, command: 'true', timeoutMs: 5_000, ...extra });

test('an untrusted plugin contributes no hooks at all', () => {
  const hooks = buildPluginHooks([
    { name: 'reviewer', hooks: [hook()] },
  ], { trusted: new Set() });
  assert.deepEqual(hooks, {});
});

test('a trusted plugin contributes one matcher per event, carrying its matcher', () => {
  const hooks = buildPluginHooks([
    { name: 'reviewer', hooks: [hook({ matcher: 'Bash' }), hook({ event: 'SessionStart' })] },
  ], { trusted: new Set(['reviewer']) });
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart']);
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(typeof hooks.PreToolUse[0].hooks[0], 'function');
  assert.equal(hooks.SessionStart[0].matcher, undefined, 'no matcher means "every occurrence"');
});

test('hooks from several trusted plugins on one event are all present', () => {
  const hooks = buildPluginHooks([
    { name: 'a', hooks: [hook()] },
    { name: 'b', hooks: [hook()] },
    { name: 'c', hooks: [hook()] },
  ], { trusted: new Set(['a', 'c']) });
  assert.equal(hooks.PreToolUse.length, 2, 'only the trusted two');
});

test('a zero-exit hook continues the turn', async () => {
  const result = await runHookCommand({ command: 'exit 0', timeoutMs: 5_000 }, { input: {} });
  assert.equal(result.continue, true);
  assert.equal(result.decision, undefined);
});

test('exit code 2 blocks, and stderr becomes the reason the model sees', async () => {
  const result = await runHookCommand(
    { command: 'echo "not allowed" 1>&2; exit 2', timeoutMs: 5_000 }, { input: {} });
  assert.equal(result.continue, false);
  assert.match(result.stopReason || '', /not allowed/);
});

test('any other non-zero exit is a hook failure, not a block', async () => {
  const result = await runHookCommand({ command: 'exit 3', timeoutMs: 5_000 }, { input: {} });
  assert.equal(result.continue, true, 'a broken hook must not wedge the turn');
});

test('a hook that overruns its timeout is killed and does not block the turn', async () => {
  const result = await runHookCommand({ command: 'sleep 5', timeoutMs: 150 }, { input: {} });
  assert.equal(result.continue, true);
  assert.match(result.systemMessage || '', /timed out/);
});

test('hook output is capped so a chatty hook cannot flood the turn', async () => {
  const result = await runHookCommand(
    { command: 'yes abcdefgh | head -c 200000 1>&2; exit 2', timeoutMs: 10_000 }, { input: {} });
  assert.equal(result.continue, false);
  assert.ok((result.stopReason || '').length <= 4_200, `reason was ${result.stopReason?.length} chars`);
});

test('the hook receives its event payload on stdin', async () => {
  const out = path.join(tmp, 'stdin.txt');
  const result = await runHookCommand(
    { command: `cat > ${out}`, timeoutMs: 5_000 },
    { input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' } });
  assert.equal(result.continue, true);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(seen.tool_name, 'Bash');
});

test('a hook that ignores SIGTERM is killed outright, not left running', async () => {
  // The runner returns as soon as the timeout fires, but the CHILD must not
  // survive it: a hook trapping TERM would otherwise keep running as an
  // orphan long after the turn moved on.
  const marker = path.join(tmp, `survivor-${Date.now()}.txt`);
  const result = await runHookCommand(
    { command: `trap '' TERM; sleep 3; echo alive > ${marker}`, timeoutMs: 150 },
    { input: {} });
  assert.equal(result.continue, true);
  assert.match(result.systemMessage || '', /timed out/);
  // Past the kill grace period and past the child's own sleep.
  await new Promise((r) => setTimeout(r, 3_600));
  assert.equal(fs.existsSync(marker), false,
    'the hook outlived SIGTERM and kept running — the SIGKILL escalation never fired');
});
