// The chat's permission chip (Ask / Accept Edits / Bypass — Claude Code's
// modes; 'manual' is Ask's old spelling) reaching the Agent engine.
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
import os from 'node:os';
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
const { addRule, listRules, _resetSessionEditsForTest } = await import('../kb/tool-permissions.mjs');
const { answerDecision } = await import('../llm_agent/sdk/decisions.mjs');

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
async function gateFor({ permissionMode, userId, events = [], workspace = process.cwd(), chat }) {
  seq += 1;
  const capture = { sessionId: `sdk-perm-${seq}` };
  await runAgentV2Turn({
    message: 'do the thing', userId, mode: 'execute',
    agentContext: { workspaceRoot: workspace, sessionId: chat ?? `chat-perm-${seq}` },
    resumeSdkSessionId: capture.sessionId,
    permissionMode,
    onEvent: (e) => events.push(e),
    queryFactory: capturingQuery(capture),
  }, { ...turnInjectable, roots: () => [workspace] });
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


// --- Claude-style rules (kb/tool-permissions.mjs) -------------------------

test('ask honours a project prefix rule — and only for that prefix, project and a simple command',
  withAnthropicKey('sk-ant-perm-7', async () => {
    const user = newUser('ask-rule');
    addRule(user.id, process.cwd(), 'Bash', 'echo');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'ask', userId: user.id, events });
    const ok = await settledOrParked(canUseTool('Bash', { command: 'echo hello' }, {}));
    assert.notEqual(ok, PARKED, 'a matching rule skips the prompt');
    assert.equal(ok.behavior, 'allow');
    assert.equal(await settledOrParked(canUseTool('Bash', { command: 'touch x' }, {})), PARKED,
      'another command still asks');
    assert.equal(await settledOrParked(canUseTool('Bash', { command: 'echo hi && touch x' }, {})), PARKED,
      'a compound command never matches a prefix rule');
  }));

test("'manual' (old Mac builds) now honours rules too — Always Allow used to be saved and never read",
  withAnthropicKey('sk-ant-perm-8', async () => {
    const user = newUser('manual-rule');
    addRule(user.id, process.cwd(), 'Bash', 'echo');
    const canUseTool = await gateFor({ permissionMode: 'manual', userId: user.id });
    const v = await settledOrParked(canUseTool('Bash', { command: 'echo hello' }, {}));
    assert.notEqual(v, PARKED);
    assert.equal(v.behavior, 'allow');
  }));

test('a rule for another project does not apply here',
  withAnthropicKey('sk-ant-perm-9', async () => {
    const user = newUser('other-project');
    addRule(user.id, '/tmp/some-other-repo', 'Bash', 'echo');
    const canUseTool = await gateFor({ permissionMode: 'ask', userId: user.id });
    assert.equal(await settledOrParked(canUseTool('Bash', { command: 'echo hello' }, {})), PARKED);
  }));

test('the old global always-allow rows are no longer honoured',
  withAnthropicKey('sk-ant-perm-10', async () => {
    const user = newUser('legacy-global');
    setAlwaysAllow(user.id, 'Bash');
    const canUseTool = await gateFor({ permissionMode: null, userId: user.id });
    assert.equal(await settledOrParked(canUseTool('Bash', { command: 'echo hello' }, {})), PARKED);
  }));

test('a rule never lifts the blocklist',
  withAnthropicKey('sk-ant-perm-11', async () => {
    const user = newUser('rule-blocked');
    addRule(user.id, process.cwd(), 'Bash', 'sudo rm');
    const canUseTool = await gateFor({ permissionMode: 'ask', userId: user.id });
    const v = await settledOrParked(canUseTool('Bash', { command: 'sudo rm -rf /' }, {}));
    assert.notEqual(v, PARKED);
    assert.equal(v.behavior, 'deny');
  }));

test('accept-edits: an in-workspace edit runs unasked, a shell command still asks',
  withAnthropicKey('sk-ant-perm-12', async () => {
    const user = newUser('accept-edits');
    const events = [];
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-accept-'));
    const canUseTool = await gateFor({ permissionMode: 'accept-edits', userId: user.id, events, workspace });
    const edit = await settledOrParked(canUseTool('Write',
      { file_path: path.join(workspace, 'a.txt'), content: 'x' }, {}));
    assert.notEqual(edit, PARKED);
    assert.equal(edit.behavior, 'allow');
    assert.equal(await settledOrParked(canUseTool('Bash', { command: 'echo hello' }, {})), PARKED);
    const escape = await settledOrParked(canUseTool('Write', { file_path: '/etc/passwd', content: 'x' }, {}));
    assert.equal(escape.behavior, 'deny', 'accept-edits never writes outside the workspace');
  }));

test('answering always-allow on a command saves exactly the suggested project prefix rule',
  withAnthropicKey('sk-ant-perm-13', async () => {
    const user = newUser('save-rule');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'ask', userId: user.id, events });
    const pending = canUseTool('Bash', { command: 'npm test -- --watch=false' }, {});
    await new Promise((r) => setImmediate(r));
    const req = events.find((e) => e.type === 'approval_request');
    assert.ok(req, 'parked');
    assert.deepEqual({ toolName: req.suggestion.toolName, pattern: req.suggestion.pattern, scope: req.suggestion.scope },
      { toolName: 'Bash', pattern: 'npm test', scope: 'project' });
    // Answer through the registry the same way the decision route does.
    const out = answerDecisionFor(req.requestId, user.id, 'always-allow');
    assert.equal(out.ok, true);
    const v = await pending;
    assert.equal(v.behavior, 'allow');
    const rules = listRules(user.id);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].pattern, 'npm test');
    assert.equal(rules[0].projectRoot, process.cwd());
  }));

test('a compound command offers no always-allow suggestion',
  withAnthropicKey('sk-ant-perm-14', async () => {
    const user = newUser('compound');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'ask', userId: user.id, events });
    void canUseTool('Bash', { command: 'echo a | tee b' }, {});
    await new Promise((r) => setImmediate(r));
    const req = events.find((e) => e.type === 'approval_request');
    assert.ok(req);
    assert.equal(req.suggestion, undefined);
  }));

test('always-allow on an edit grants edits for this chat only',
  withAnthropicKey('sk-ant-perm-15', async () => {
    _resetSessionEditsForTest();
    const user = newUser('session-edits');
    const events = [];
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-'));
    const canUseTool = await gateFor({ permissionMode: 'ask', userId: user.id, events, workspace });
    const target = path.join(workspace, 'a.txt');
    const pending = canUseTool('Write', { file_path: target, content: 'x' }, {});
    await new Promise((r) => setImmediate(r));
    const req = events.find((e) => e.type === 'approval_request');
    assert.equal(req.suggestion.scope, 'session');
    answerDecisionFor(req.requestId, user.id, 'always-allow');
    assert.equal((await pending).behavior, 'allow');
    // Same chat (same gateFor turn): the next edit runs unasked.
    const next = await settledOrParked(canUseTool('Write', { file_path: target, content: 'y' }, {}));
    assert.notEqual(next, PARKED);
    // A different chat still asks.
    const other = await gateFor({ permissionMode: 'ask', userId: user.id, workspace });
    assert.equal(await settledOrParked(other('Write', { file_path: target, content: 'z' }, {})), PARKED);
    assert.equal(listRules(user.id).length, 0, 'an edit grant is never persisted');
  }));

test("deny with feedback hands the user's instruction to the model",
  withAnthropicKey('sk-ant-perm-16', async () => {
    const user = newUser('deny-feedback');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'ask', userId: user.id, events });
    const pending = canUseTool('Bash', { command: 'echo hello' }, {});
    await new Promise((r) => setImmediate(r));
    const req = events.find((e) => e.type === 'approval_request');
    answerDecisionFor(req.requestId, user.id, 'deny', 'use printf instead');
    const v = await pending;
    assert.equal(v.behavior, 'deny');
    assert.match(v.message, /use printf instead/);
  }));

// The decision registry keys a parked entry by the SDK session id the turn
// ran under (gateFor's `sdk-perm-<n>`); find it by trying the recent ones.
function answerDecisionFor(requestId, userId, action, feedback) {
  for (let n = seq; n > 0; n -= 1) {
    const out = answerDecision({ requestId, sdkSessionId: `sdk-perm-${n}`, userId, action, feedback });
    if (out.reason !== 'tenancy') return out;
  }
  return { ok: false };
}

// --- Sandbox network asks ---------------------------------------------------
//
// With the sandbox on (an org's managed settings can force it), a command that
// needs a new host makes the CLI call canUseTool('SandboxNetworkAccess',
// {host, port}). It used to fall into the unknown-tool deny: npm got a 403
// "(user denied)" and plan execution stopped with the user never asked.

test('ask: a sandbox network request shows an approval card; always-allow saves that host only',
  withAnthropicKey('sk-ant-perm-net-1', async () => {
    const user = newUser('net-ask');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'ask', userId: user.id, events });
    const pending = canUseTool('SandboxNetworkAccess', { host: 'registry.npmjs.org', port: 443 }, {});
    await new Promise((r) => setImmediate(r));
    const req = events.find((e) => e.type === 'approval_request');
    assert.ok(req, 'the user is asked instead of a silent deny');
    assert.equal(req.toolName, 'SandboxNetworkAccess');
    assert.equal(req.argsSummary, 'registry.npmjs.org:443');
    assert.equal(req.suggestion?.pattern, 'registry.npmjs.org');
    answerDecisionFor(req.requestId, user.id, 'always-allow');
    assert.equal((await pending).behavior, 'allow');

    const again = await settledOrParked(canUseTool('SandboxNetworkAccess', { host: 'registry.npmjs.org', port: 443 }, {}));
    assert.notEqual(again, PARKED, 'the saved host rule skips the prompt');
    assert.equal(again.behavior, 'allow');
    assert.equal(await settledOrParked(canUseTool('SandboxNetworkAccess', { host: 'evil.example', port: 443 }, {})),
      PARKED, 'another host still asks');
  }));

test('bypass allows a sandbox network request without asking',
  withAnthropicKey('sk-ant-perm-net-2', async () => {
    const user = newUser('net-bypass');
    const events = [];
    const canUseTool = await gateFor({ permissionMode: 'bypass', userId: user.id, events });
    const v = await settledOrParked(canUseTool('SandboxNetworkAccess', { host: 'registry.npmjs.org', port: 443 }, {}));
    assert.notEqual(v, PARKED);
    assert.equal(v.behavior, 'allow');
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 0);
  }));

test('an unusual host (IPv6, underscore, trailing dot): Bypass allows, Ask asks once with no rule offered',
  withAnthropicKey('sk-ant-perm-net-5', async () => {
    const user = newUser('net-odd');
    const bypass = await gateFor({ permissionMode: 'bypass', userId: user.id });
    for (const host of ['::1', 'my_svc.internal', 'registry.npmjs.org.']) {
      const v = await settledOrParked(bypass('SandboxNetworkAccess', { host, port: 443 }, {}));
      assert.notEqual(v, PARKED, host);
      assert.equal(v.behavior, 'allow', `${host}: bypass must not silently deny`);
    }
    const events = [];
    const ask = await gateFor({ permissionMode: 'ask', userId: user.id, events });
    assert.equal(await settledOrParked(ask('SandboxNetworkAccess', { host: '::1', port: 8080 }, {})), PARKED);
    const req = events.find((e) => e.type === 'approval_request');
    assert.equal(req.argsSummary, '::1:8080');
    assert.equal(req.suggestion, undefined, 'no host rule can be saved for a non-plain host');
  }));

test('a sandbox network request with no host is denied, not shown',
  withAnthropicKey('sk-ant-perm-net-3', async () => {
    const user = newUser('net-bad');
    const canUseTool = await gateFor({ permissionMode: 'bypass', userId: user.id });
    const v = await settledOrParked(canUseTool('SandboxNetworkAccess', { port: 443 }, {}));
    assert.notEqual(v, PARKED);
    assert.equal(v.behavior, 'deny');
  }));

test('a restricted mode refuses a sandbox network request, even in bypass',
  withAnthropicKey('sk-ant-perm-net-4', async () => {
    const user = newUser('net-plan');
    const capture = { sessionId: 'sdk-perm-net-plan' };
    await runAgentV2Turn({
      message: 'plan it', userId: user.id, mode: 'plan', permissionMode: 'bypass',
      agentContext: { workspaceRoot: process.cwd() }, resumeSdkSessionId: capture.sessionId,
      onEvent: () => {}, queryFactory: capturingQuery(capture),
    }, { ...turnInjectable, roots: () => [process.cwd()] });
    const v = await settledOrParked(capture.options.canUseTool('SandboxNetworkAccess', { host: 'registry.npmjs.org', port: 443 }, {}));
    assert.notEqual(v, PARKED);
    assert.equal(v.behavior, 'deny');
  }));
