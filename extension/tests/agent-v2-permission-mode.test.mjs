// The chat's permission chip (Manual / Bypass) reaching the Agent engine.
//
// The legacy loop has always applied this setting client-side, in the Mac
// app's ChatAutoChainPolicy. The Agent engine approves tools SERVER-side, so
// the setting never reached it: a chat set to Bypass still parked approval
// cards, and one set to Manual still auto-ran anything the user had once
// marked "always allow". These tests pin both directions — and, just as
// importantly, that neither one can reach past the hard safety rails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-permission-mode-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { runAgentV2Turn } = await import('../llm_agent/sdk/engine.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { setAlwaysAllow } = await import('../kb/tool-approvals.mjs');

const turnInjectable = {
  readSkill: () => null, roots: () => [],
  sessionMemory: () => [], persistMemory: async () => null,
};

function capturingQuery(capture) {
  return (prompt, options) => {
    capture.prompt = prompt;
    capture.options = options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: capture.sessionId, tools: [], capabilities: [] };
      yield { type: 'result', subtype: 'success', session_id: capture.sessionId };
    })();
  };
}

function withAnthropicKey(value, fn) {
  return async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = value;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  };
}

let seq = 0;
async function gateFor({ permissionMode, userId, events = [] }) {
  seq += 1;
  const capture = { sessionId: `sdk-perm-${seq}` };
  await runAgentV2Turn({
    message: 'do the thing', userId, mode: 'execute',
    agentContext: { workspaceRoot: process.cwd(), sessionId: `chat-perm-${seq}` },
    resumeSdkSessionId: capture.sessionId,
    permissionMode,
    onEvent: (e) => events.push(e),
    queryFactory: capturingQuery(capture),
  }, turnInjectable);
  return capture.options.canUseTool;
}

function newUser(tag) {
  return registerUser(getDb(), {
    email: `perm-${tag}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
}

// `echo hello` is genuinely 'prompt'-tier: gates.mjs's AUTO_SAFE_PATTERNS
// covers git status/diff/log, ls, cat, grep/rg and test runners — not echo.
const PROMPT_TIER_COMMAND = 'echo hello';

// A parked approval never settles on its own, so a test that awaited one
// would hang for the registry timeout. Racing it against a tick tells us it
// parked without waiting for it.
const PARKED = Symbol('parked');
function settledOrParked(promise) {
  return Promise.race([promise, new Promise((r) => setImmediate(() => r(PARKED)))]);
}

test('bypass: a prompt-tier command runs without parking an approval',
  withAnthropicKey('sk-ant-perm-1', async () => {
    const user = newUser('bypass-bash');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'bypass', userId: user.id, events });
    const verdict = await settledOrParked(
      canUseTool('mcp__llmide__run-bash', { command: PROMPT_TIER_COMMAND }, {}));
    assert.notEqual(verdict, PARKED, 'bypass must not park an approval');
    assert.equal(verdict.behavior, 'allow');
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 0,
      'allow-all means the user is never asked');
  }));

test('bypass does NOT lift the blocklist — a destructive command is still refused',
  withAnthropicKey('sk-ant-perm-2', async () => {
    const user = newUser('bypass-blocked');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'bypass', userId: user.id, events });
    const verdict = await settledOrParked(
      canUseTool('mcp__llmide__run-bash', { command: 'sudo rm -rf /' }, {}));
    assert.notEqual(verdict, PARKED, 'a blocked command is decided, not parked');
    assert.equal(verdict.behavior, 'deny',
      'allow-all is about how much confirming the user wants, not about the safety rail');
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 0);
  }));

test('bypass does NOT lift write containment — a write outside the workspace is still refused',
  withAnthropicKey('sk-ant-perm-3', async () => {
    const user = newUser('bypass-escape');
    const canUseTool = await gateFor({ permissionMode: 'bypass', userId: user.id });
    const verdict = await settledOrParked(
      canUseTool('Write', { file_path: '/etc/passwd', content: 'x' }, {}));
    assert.notEqual(verdict, PARKED);
    assert.equal(verdict.behavior, 'deny');
  }));

test('manual: an always-allowed tool asks again anyway',
  withAnthropicKey('sk-ant-perm-4', async () => {
    const user = newUser('manual-always');
    setAlwaysAllow(user.id, 'Bash');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'manual', userId: user.id, events });
    const verdict = await settledOrParked(
      canUseTool('Bash', { command: PROMPT_TIER_COMMAND }, {}));
    assert.equal(verdict, PARKED, 'manual means ask every time, stored always-allow included');
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 1);
  }));

test('manual leaves the auto tier alone — a read-only command still runs unprompted',
  withAnthropicKey('sk-ant-perm-5', async () => {
    const user = newUser('manual-auto');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'manual', userId: user.id, events });
    const verdict = await settledOrParked(canUseTool('Bash', { command: 'git status' }, {}));
    assert.notEqual(verdict, PARKED, 'prompting for read-only operations would make Manual unusable');
    assert.equal(verdict.behavior, 'allow');
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 0);
  }));

test('no permission mode: an older client keeps the server policy — always-allow still short-circuits',
  withAnthropicKey('sk-ant-perm-6', async () => {
    const user = newUser('absent');
    setAlwaysAllow(user.id, 'Bash');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: null, userId: user.id, events });
    const verdict = await settledOrParked(
      canUseTool('Bash', { command: PROMPT_TIER_COMMAND }, {}));
    assert.notEqual(verdict, PARKED);
    assert.equal(verdict.behavior, 'allow');
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 0);
  }));
