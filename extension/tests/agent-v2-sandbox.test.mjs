// K1 A11: options.sandbox is stated by us (LLMIDE_V2_SANDBOX), not left to the
// operator's managed settings by default-silence. Default `inherit` = today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-sandbox-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { runAgentV2Turn, sandboxOptionFromEnv } = await import('../llm_agent/sdk/engine.mjs');

test('sandboxOptionFromEnv: inherit (default) passes nothing; typos never change the posture', () => {
  for (const v of [undefined, '', 'inherit', 'INHERIT', 'yes', 'true', '1', 'ONN', 'enabled']) {
    assert.equal(sandboxOptionFromEnv(v), null, String(v));
  }
});

test('sandboxOptionFromEnv: off and on state the policy; on keeps our approval gates authoritative', () => {
  assert.deepEqual(sandboxOptionFromEnv('off'), { enabled: false });
  assert.deepEqual(sandboxOptionFromEnv(' ON '), {
    enabled: true, failIfUnavailable: false, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
  });
});

async function optionsFor(envValue) {
  const prev = process.env.LLMIDE_V2_SANDBOX;
  if (envValue === undefined) delete process.env.LLMIDE_V2_SANDBOX; else process.env.LLMIDE_V2_SANDBOX = envValue;
  let seen = null;
  try {
    await runAgentV2Turn({
      message: 'hi', userId: 'u-sb', mode: 'execute', agentContext: { workspaceRoot: process.cwd() },
      allowAmbientAuth: true, onEvent: () => {},
      queryFactory: (_prompt, options) => { seen = options; return (async function* () { yield { type: 'result', subtype: 'success', session_id: 's' }; })(); },
    }, { readSkill: () => null, roots: () => [], sessionMemory: () => [], persistMemory: async () => null });
  } finally {
    if (prev === undefined) delete process.env.LLMIDE_V2_SANDBOX; else process.env.LLMIDE_V2_SANDBOX = prev;
  }
  return seen;
}

test('the SDK query options carry no sandbox key by default, and the stated one when asked', async () => {
  assert.ok(!('sandbox' in await optionsFor(undefined)), 'default = today: no key at all');
  assert.ok(!('sandbox' in await optionsFor('inherit')));
  assert.deepEqual((await optionsFor('off')).sandbox, { enabled: false });
  assert.equal((await optionsFor('on')).sandbox.enabled, true);
});
