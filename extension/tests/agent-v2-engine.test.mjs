// Tests for the v2 chat engine (llm_agent/sdk/engine.mjs):
// buildEngineOptions + capAttachments (pure composition) and, since Task 6,
// runAgentV2Turn — the turn runner with the AskUserQuestion approval
// round-trip.
//
// Hermetic: readSkillInstructions and buildReadableRoots are injected as
// fakes, and runAgentV2Turn's queryFactory is a fabricated async stream, so
// no SDK subprocess ever spawns — the fake captures the composed
// (prompt, options) and tests invoke options.canUseTool exactly the way the
// real SDK does when the model reaches for a tool. resolveAnthropicKey lives
// here too (moved from spike-engine); its behavior stays covered by
// agent-sdk-spike.test.mjs through the spike-engine re-export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getEventListeners } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// runAgentV2Turn now existence-checks workspaceRoot (a stale root must fail
// clearly, not as an SDK spawn misdiagnosis) — materialize a fixture root.
// Kept under the tests dir, NOT /tmp: /tmp is unwritable under sandboxed
// runs, and a module-load mkdir failure would wipe out this whole file.
const WS = path.join(__dirname, '_agent-v2-ws-fixture');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-engine-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
// Per-user engine homes are derived from the DB's directory; clear the tree
// so a previous run's homes can't leak (in)to this one.
const agentSdkRoot = path.join(path.dirname(tmpDb), 'agent-sdk');
try { fs.rmSync(agentSdkRoot, { recursive: true, force: true }); } catch { /* ok */ }

const {
  buildEngineOptions, resolveAnthropicKey, resolveAgentEngineAuth, runAgentV2Turn, agentSdkHomeFor, resolveMaxBudgetUsd,
  approvalArgsFor, v2ToolPolicyForMode,
} = await import('../llm_agent/sdk/engine.mjs');
const { answerDecision, abortDecisionsForSession } = await import('../llm_agent/sdk/decisions.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { persistTurnMemory } = await import('../llm_agent/runtime/memory-persist.mjs');
const { listSessionMemory } = await import('../kb/session-memory.mjs');
const { hasAlwaysAllow, setAlwaysAllow } = await import('../kb/tool-approvals.mjs');
const { syncCustomProviders } = await import('../server/custom-providers.mjs');
const { setSecret } = await import('../server/vault.mjs');

// --- The brief's binding contract -------------------------------------------

test('mode mapping: plan-like modes become SDK plan mode with persona instructions', () => {
  for (const mode of ['plan', 'assist_plan']) {
    const { queryOptions } = buildEngineOptions({ userId: 'u', mode, agentContext: { workspaceRoot: WS } },
      { readSkill: () => null, roots: () => [WS] });
    assert.equal(queryOptions.permissionMode, 'plan');
    assert.equal(typeof queryOptions.planModeInstructions, 'string');
  }
});
test('mode mapping: execute/auto default; review/document persona-only', () => {
  const base = { readSkill: () => null, roots: () => [WS] };
  assert.equal(buildEngineOptions({ userId: 'u', mode: 'auto', agentContext: {} }, base).queryOptions.permissionMode, 'default');
  const rev = buildEngineOptions({ userId: 'u', mode: 'review', agentContext: {} }, base);
  assert.equal(rev.queryOptions.permissionMode, 'default');
  assert.ok(rev.queryOptions.systemPrompt.append.length > 0);
});
test('allowlist is read-only + llmide; skills inject via append; cwd + dirs from workspace', () => {
  const { queryOptions } = buildEngineOptions({
    userId: 'u', mode: 'execute', language: 'Japanese',
    skills: ['family/one'], agentContext: { workspaceRoot: WS, indexedRepos: ['/tmp/r'] },
  }, { readSkill: () => ({ name: 'one', content: '# One\ninstructions' }), roots: () => [WS, '/tmp/r'] });
  // Built-ins + every kind:'read' registry tool, in registry order. The three
  // kind:'act' tools (run-bash/task-create/task-update) are DELIBERATELY
  // absent: `allowedTools` means "auto-allowed without prompting", so listing
  // an act tool there would skip canUseTool — i.e. skip the safety gate.
  assert.deepEqual(queryOptions.allowedTools, [
    'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'mcp__llmide__ask-internal', 'mcp__llmide__ask-subagent',
    'mcp__llmide__web-search', 'mcp__llmide__fetch-url',
    'mcp__llmide__list-files', 'mcp__llmide__read-file', 'mcp__llmide__find-code',
    'mcp__llmide__search-kb', 'mcp__llmide__load-skill',
    'mcp__llmide__task-list', 'mcp__llmide__project_memory',
  ]);
  for (const act of ['mcp__llmide__run-bash', 'mcp__llmide__task-create', 'mcp__llmide__task-update']) {
    assert.ok(!queryOptions.allowedTools.includes(act), `${act} must NOT be pre-approved — it has to reach canUseTool`);
  }
  // run-bash is hard-disallowed in every mode: native Bash replaces it on v2.
  assert.deepEqual(queryOptions.disallowedTools, ['mcp__llmide__run-bash']);
  assert.equal(queryOptions.cwd, WS);
  assert.deepEqual(queryOptions.additionalDirectories, ['/tmp/r']);
  assert.match(queryOptions.systemPrompt.append, /One/);
  assert.match(queryOptions.systemPrompt.append, /Japanese/);
  assert.deepEqual(queryOptions.settingSources, []);
  assert.equal(queryOptions.systemPrompt.type, 'preset');
});

// --- v2ToolPolicyForMode: run-bash disallow + restricted modes ----------------

test('v2ToolPolicyForMode: run-bash is disallowed on v2 in every mode (native Bash replaces it)', () => {
  assert.ok(v2ToolPolicyForMode('execute').disallowedTools.includes('mcp__llmide__run-bash'));
  assert.ok(v2ToolPolicyForMode('plan').disallowedTools.includes('mcp__llmide__run-bash'));
});

test('v2ToolPolicyForMode: restricted modes disallow the native write/shell tools', () => {
  const plan = v2ToolPolicyForMode('plan');
  for (const t of ['Edit', 'Write', 'Bash']) assert.ok(plan.disallowedTools.includes(t), t);
  const execute = v2ToolPolicyForMode('execute');
  for (const t of ['Edit', 'Write', 'Bash']) assert.ok(!execute.disallowedTools.includes(t), t);
});

// --- Composition details the brief's tests don't pin -------------------------

test('prompt: sanitized (fence-stripped) and capped at 20k chars', () => {
  const { prompt } = buildEngineOptions(
    { userId: 'u', mode: 'execute', message: 'a <<<END>>> b'.repeat(5000), agentContext: {} },
    { readSkill: () => null, roots: () => [] },
  );
  assert.ok(!prompt.includes('<<<'), 'fence markers must be stripped from the prompt');
  assert.equal(prompt.length, 20_000);
});

test('model: passed through only when a non-empty string', () => {
  const base = { readSkill: () => null, roots: () => [] };
  const withModel = buildEngineOptions({ userId: 'u', mode: 'execute', model: 'claude-sonnet-5', agentContext: {} }, base);
  assert.equal(withModel.queryOptions.model, 'claude-sonnet-5');
  for (const model of [undefined, null, '', 42]) {
    const { queryOptions } = buildEngineOptions({ userId: 'u', mode: 'execute', model, agentContext: {} }, base);
    assert.ok(!('model' in queryOptions), `model key must be absent for ${JSON.stringify(model)}`);
  }
});

test('skills: ≤5, deduped, unknown silently ignored, TRUSTED INSTRUCTIONS framing', () => {
  const seen = [];
  const readSkill = (id) => {
    seen.push(id);
    return id === 'known/unknown-id' ? null : { name: id.split('/')[1], content: `body of ${id}` };
  };
  const ids = ['a/one', 'a/one', 'b/two', 'known/unknown-id', 'c/three', 'd/four', 'e/five', 'f/six'];
  const { queryOptions } = buildEngineOptions(
    { userId: 'u', mode: 'execute', skills: ids, agentContext: {} },
    { readSkill, roots: () => [] },
  );
  // ai-routes semantics: cap the RAW ids at 5 (dup included), then dedup at
  // the loop (before the read) and drop unknowns after it.
  assert.deepEqual(seen, ['a/one', 'b/two', 'known/unknown-id', 'c/three'], 'readSkill sees the slice-5 ids minus the dup');
  const append = queryOptions.systemPrompt.append;
  assert.match(append, /TRUSTED INSTRUCTIONS/);
  for (const name of ['one', 'two', 'three']) assert.match(append, new RegExp(`## Skill: ${name}\\nbody of \\w+/${name}`));
  for (const name of ['four', 'five', 'six']) assert.ok(!append.includes(`## Skill: ${name}`), `${name} beyond the raw 5-id cap: dropped`);
  assert.ok(!append.includes('unknown-id'), 'unknown skill id silently ignored — no header, no read');
});

test('attachments: fenced as data with caps 30 files / 80k per file / 200k total', () => {
  const many = [];
  for (let i = 0; i < 32; i++) many.push({ path: `/Users/someone/proj/f${i}.txt`, content: 'x'.repeat(1000) });
  many.push({ path: '/Users/someone/proj/big.txt', content: 'y'.repeat(90_000) });
  const { queryOptions, meta } = buildEngineOptions(
    { userId: 'u', mode: 'review', attachments: many, agentContext: {} },
    { readSkill: () => null, roots: () => [] },
  );
  const append = queryOptions.systemPrompt.append;
  // 30-file cap: f0..f29 kept, f30/f31 and the 31st-plus entries dropped.
  assert.match(append, /# Attached files \(30\)/);
  assert.match(append, /## ~\/proj\/f0\.txt\n<<<BEGIN>>>\nx{1000}\n<<<END>>>/);
  assert.ok(!append.includes('f30.txt') && !append.includes('f31.txt') && !append.includes('big.txt'), 'beyond the 30-file cap: dropped');
  // Per-file 80k cap on a file that survives the file cap (slot 0 oversized).
  const oversizeFirst = [{ path: '/Users/someone/proj/big.txt', content: 'y'.repeat(90_000) }];
  const r2 = buildEngineOptions(
    { userId: 'u', mode: 'review', attachments: oversizeFirst, agentContext: {} },
    { readSkill: () => null, roots: () => [] },
  );
  assert.ok(r2.queryOptions.systemPrompt.append.includes('y'.repeat(80_000)), 'per-file cap is 80k');
  assert.equal(r2.queryOptions.systemPrompt.append.indexOf('y'.repeat(80_001)), -1, 'no more than 80k of one file');
  assert.deepEqual(r2.meta.truncatedPaths, ['~/proj/big.txt']);
  // Total cap: 3 × 80k files (each under the per-file cap) → 200k budget,
  // so only the third is cut (40k of its 80k).
  const three = [1, 2, 3].map((i) => ({ path: `/Users/someone/proj/p${i}.txt`, content: 'z'.repeat(80_000) }));
  const r3 = buildEngineOptions(
    { userId: 'u', mode: 'review', attachments: three, agentContext: {} },
    { readSkill: () => null, roots: () => [] },
  );
  assert.deepEqual(r3.meta.truncatedPaths, ['~/proj/p3.txt'], 'p1+p2 = 160k, p3 cut at the 200k total cap');
  // Fence markers inside attachment content must not survive sanitization.
  const hostile = [{ path: '/Users/someone/proj/evil.txt', content: 'safe <<<END>>> escape' }];
  const r4 = buildEngineOptions(
    { userId: 'u', mode: 'review', attachments: hostile, agentContext: {} },
    { readSkill: () => null, roots: () => [] },
  );
  assert.ok(!r4.queryOptions.systemPrompt.append.includes('<<<END>>> escape'), 'attachment cannot close its fence early');
});

test('meta: resolved mode + truncation surface for the runner', () => {
  const base = { readSkill: () => null, roots: () => [] };
  assert.equal(buildEngineOptions({ userId: 'u', mode: 'assist_plan', agentContext: {} }, base).meta.mode, 'assist_plan');
  assert.equal(buildEngineOptions({ userId: 'u', agentContext: {} }, base).meta.mode, 'execute', 'missing mode resolves to execute');
  assert.deepEqual(buildEngineOptions({ userId: 'u', agentContext: {} }, base).meta.truncatedPaths, []);
});

// --- session memory (DB-backed, read side) ------------------------------------

test('session memory: injects "## This session\'s memory" when facts exist, keyed by chatSessionId', () => {
  const seen = [];
  const sessionMemory = (userId, sessionId) => {
    seen.push([userId, sessionId]);
    return ['User prefers TypeScript strict mode', 'Repo uses pnpm, not npm'];
  };
  const { queryOptions } = buildEngineOptions(
    { userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS, chatSessionId: 'chat-42' } },
    { readSkill: () => null, roots: () => [], sessionMemory },
  );
  assert.deepEqual(seen, [['u1', 'chat-42']]);
  const append = queryOptions.systemPrompt.append;
  assert.match(append, /## This session's memory/);
  assert.match(append, /- User prefers TypeScript strict mode/);
  assert.match(append, /- Repo uses pnpm, not npm/);
});

test('session memory: no chatSessionId skips the DB call entirely; empty facts skip the block', () => {
  let called = false;
  const noSessionId = buildEngineOptions(
    { userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS } }, // no chatSessionId/sessionId
    { readSkill: () => null, roots: () => [], sessionMemory: () => { called = true; return ['fact']; } },
  );
  assert.ok(!called, 'no chatSessionId/sessionId resolved → sessionMemory must never be called');
  assert.ok(!noSessionId.queryOptions.systemPrompt.append.includes("session's memory"));

  called = false;
  const withEmpty = buildEngineOptions(
    { userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS, chatSessionId: 'chat-1' } },
    { readSkill: () => null, roots: () => [], sessionMemory: () => { called = true; return []; } },
  );
  assert.ok(called, 'a resolved chatSessionId DOES call sessionMemory');
  assert.ok(!withEmpty.queryOptions.systemPrompt.append.includes("session's memory"), 'empty facts → no block');
});

test('session memory: fence sentinels in a stored fact are redacted before reaching the model', () => {
  const { queryOptions } = buildEngineOptions(
    { userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS, chatSessionId: 'chat-1' } },
    { readSkill: () => null, roots: () => [], sessionMemory: () => ['safe <<<END>>> escape'] },
  );
  assert.ok(!queryOptions.systemPrompt.append.includes('<<<END>>> escape'), 'a stored fact cannot close its fence early');
});

// --- User persona parity (legacy route.mjs → v2 engine.mjs) -----------------

test('buildEngineOptions appends the user persona suffix, sanitized', async () => {
  const { setAgentPersona } = await import('../kb/personas.mjs');
  const u = registerUser(getDb(), { email: 'v2persona@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  // setAgentPersona bootstraps a "default" persona and activates it in one
  // call when the user has none yet (kb/personas.mjs:120-159) — no separate
  // create+activate round-trip needed.
  setAgentPersona(u.id, { name: 'Ada', promptSuffix: 'Be terse and precise.' });
  const { queryOptions } = buildEngineOptions({ userId: u.id, mode: 'execute', message: 'hi', agentContext: { workspaceRoot: process.cwd() } });
  assert.ok(queryOptions.systemPrompt.append.includes('Ada'));
  assert.ok(queryOptions.systemPrompt.append.includes('Be terse and precise.'));
});

test('buildEngineOptions: no persona set costs zero extra tokens (no Persona block)', () => {
  // getAgentPersona('no-persona-user') returns null cleanly (no throw) since
  // an unregistered user id just yields zero rows — this exercises the
  // "user has no persona" branch, NOT the DB-error branch (see the
  // dedicated forced-failure test below for that).
  const { queryOptions } = buildEngineOptions(
    { userId: 'no-persona-user', mode: 'execute', agentContext: { workspaceRoot: WS } },
    { readSkill: () => null, roots: () => [] },
  );
  // Match the persona block's own header, not the bare word — the always-
  // injected System context (app-capabilities prose) could legitimately
  // mention "Personas" someday without a persona block existing.
  assert.ok(!queryOptions.systemPrompt.append.includes('---\nPersona'), 'no Persona block when the user has no custom persona');
});

test('buildEngineOptions: a persona-lookup error is swallowed — turn proceeds without the Persona block', () => {
  const { queryOptions } = buildEngineOptions(
    { userId: 'some-user', mode: 'execute', agentContext: { workspaceRoot: WS } },
    {
      readSkill: () => null,
      roots: () => [],
      getPersona: () => { throw new Error('boom: simulated DB failure'); },
    },
  );
  assert.ok(!queryOptions.systemPrompt.append.includes('---\nPersona'), 'a thrown persona lookup must not surface a Persona block');
  // The rest of the append (e.g. no crash, options object still well-formed)
  // proves the turn genuinely proceeds rather than the whole call throwing.
  assert.equal(typeof queryOptions.systemPrompt.append, 'string');
});

test('buildEngineOptions: mode persona and user persona coexist — neither clobbers the other', async () => {
  const { setAgentPersona } = await import('../kb/personas.mjs');
  const u = registerUser(getDb(), { email: 'v2persona-coexist@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  setAgentPersona(u.id, { name: 'Ada', promptSuffix: 'Be terse and precise.' });
  const { queryOptions } = buildEngineOptions({ userId: u.id, mode: 'plan', message: 'hi', agentContext: { workspaceRoot: process.cwd() } });
  const append = queryOptions.systemPrompt.append;
  assert.ok(append.includes('You are in PLAN mode'), 'the mode persona (plan) must still be present');
  assert.ok(append.includes('Ada'), 'the user persona name must also be present');
  assert.ok(append.includes('Be terse and precise.'), 'the user persona suffix must also be present');
});

// --- System context injection (parity with the legacy loop) -------------------

// The legacy loop grounds every turn in composeSystemContext (loop.mjs) —
// active project, indexed repos, recent issues, app capabilities. Without
// the same block the v2 agent doesn't know the chat is bound to a GitLab
// project or what "Auto Tasks" means in this app, and answers like vanilla
// Claude Code (checks git, reaches for harness cron tools).
test('buildEngineOptions: system prompt carries the System context block (project, issues, capabilities)', () => {
  const { queryOptions } = buildEngineOptions({
    userId: null, mode: 'execute', message: 'check open issues',
    agentContext: {
      workspaceRoot: WS,
      activeProject: { name: 'iis_summary', url: 'https://gitlab.example/iis_summary', provider: 'gitlab' },
      recentIssues: [{ iid: 7, title: 'Fix the summarizer', labels: ['bug'] }],
    },
  });
  const append = queryOptions.systemPrompt.append;
  assert.ok(append.includes('# System context'), 'the System context block must be present');
  assert.ok(append.includes('iis_summary'), 'the active project must be named');
  assert.ok(append.includes('#7 Fix the summarizer'), 'recent issues must be listed');
  assert.ok(append.includes('Auto Tasks'), 'app capabilities must brief the agent on app concepts');
  // Graphify project memory stays tool-driven on v2 (project_memory tool) —
  // its block must NOT be inlined into every turn.
  assert.ok(!append.includes('# Repository memory (Graphify)'),
    'Graphify memory must not be injected (v2 exposes it as the project_memory tool)');
});

// --- workspaceRoot: tilde expansion + existence -------------------------------

// The Mac client sends home-relative roots ("~/proj") — the wire convention
// every READ handler already expands (graphkit/memory's expandTilde). The
// SDK's `cwd` must expand too: Node spawn does not expand "~", so a literal
// tilde cwd is ENOENT and the SDK misreports it as a native-binary/libc
// launch failure (the exact banner the Mac showed).
test('buildEngineOptions: a home-relative workspaceRoot ("~/…") expands to an absolute cwd', () => {
  const rel = `~/llmide-v2-cwd-test`;
  const abs = path.join(os.homedir(), 'llmide-v2-cwd-test');
  const { queryOptions } = buildEngineOptions({
    userId: null, mode: 'execute', message: 'hi',
    agentContext: { workspaceRoot: rel },
  });
  assert.equal(queryOptions.cwd, abs, 'cwd must be the expanded absolute path, never a literal "~"');
});

test('runAgentV2Turn: a nonexistent workspaceRoot fails with a clear error, not an SDK spawn misdiagnosis', async () => {
  await assert.rejects(
    runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute',
      agentContext: { workspaceRoot: '/nonexistent/llmide-v2-root' },
      allowAmbientAuth: true, onEvent: () => {}, queryFactory: makeFakeQuery({ messages: [] }),
    }, turnInjectable),
    (e) => /workspaceRoot does not exist/.test(e.message) && e.message.includes('/nonexistent/llmide-v2-root'),
  );
});

// A root that stats fine but denies opendir (the macOS TCC shape: ~/Desktop,
// ~/Documents, iCloud Drive seen by an app with no folder grant) must fail
// with the real cause. Without this the SDK spawns the CLI with that cwd and
// reports a libc/musl mismatch, which sends the reader after the binary.
test('runAgentV2Turn: an unreadable workspaceRoot names the access denial, not a libc mismatch', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-v2-noperm-'));
  fs.chmodSync(dir, 0o000);
  t.after(() => { try { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  // Running as root would read it anyway — the denial is what's under test.
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  await assert.rejects(
    runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute',
      agentContext: { workspaceRoot: dir },
      allowAmbientAuth: true, onEvent: () => {}, queryFactory: makeFakeQuery({ messages: [] }),
    }, turnInjectable),
    (e) => /workspaceRoot is not readable \((EACCES|EPERM)\)/.test(e.message) && e.message.includes(dir),
  );
});

// The SDK labels every spawn-time failure of an existing binary
// 'executable_launch_failed' and blames libc. The engine must restate it with
// the errno the SDK attached and the cwd it spawned with.
test('runAgentV2Turn: an SDK launch failure is restated with the errno and cwd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-v2-launch-'));
  // The SDK spawns lazily: the launch failure surfaces while the caller is
  // iterating the query, not when query() is constructed.
  const boom = () => ({
    async *[Symbol.asyncIterator]() {
      throw Object.assign(
        new Error('Claude Code native binary at /x/claude exists but failed to launch. This usually means the binary does not match this system\u2019s libc'),
        { errorClass: 'executable_launch_failed', code: 'EPERM' },
      );
    },
  });
  await assert.rejects(
    runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute',
      agentContext: { workspaceRoot: dir },
      allowAmbientAuth: true, onEvent: () => {}, queryFactory: boom,
    }, turnInjectable),
    (e) => /failed to launch \(EPERM\)/.test(e.message) && e.message.includes(dir) && /Original SDK message/.test(e.message),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The SDK grants read access to cwd, so cwd must clear the same breadth bar
// buildReadableRoots applies ("~" would grant the whole home dir — repo-files
// refuses it as a root, and the engine must refuse it as a cwd).
test('runAgentV2Turn: a too-broad workspaceRoot ("~") is refused, not granted as cwd', async () => {
  await assert.rejects(
    runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute',
      agentContext: { workspaceRoot: '~' },
      allowAmbientAuth: true, onEvent: () => {}, queryFactory: makeFakeQuery({ messages: [] }),
    }, turnInjectable),
    (e) => /workspaceRoot is too broad/.test(e.message),
  );
});

// isTooBroadRoot compares normalized paths — a literal ".." spelling of the
// home dir must not slip past it (read roots already reject "..";
// repo-files.mjs:97), so the engine resolves before checking.
test('runAgentV2Turn: a ".."-spelled too-broad workspaceRoot is still refused', async () => {
  const home = os.homedir();
  const dotted = path.join(home, '..', path.basename(home)); // resolves back to home
  await assert.rejects(
    runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute',
      agentContext: { workspaceRoot: `${home}/../${path.basename(home)}` },
      allowAmbientAuth: true, onEvent: () => {}, queryFactory: makeFakeQuery({ messages: [] }),
    }, turnInjectable),
    (e) => /workspaceRoot is too broad/.test(e.message),
    `literal "${dotted}" must resolve to the home dir and be refused`,
  );
});

test('runAgentV2Turn: a file-valued workspaceRoot is refused (spawn needs a directory cwd)', async () => {
  const filePath = path.join(__dirname, '_agent-v2-ws-file-fixture');
  fs.writeFileSync(filePath, 'not a dir\n');
  try {
    await assert.rejects(
      runAgentV2Turn({
        message: 'm', userId: 'u1', mode: 'execute',
        agentContext: { workspaceRoot: filePath },
        allowAmbientAuth: true, onEvent: () => {}, queryFactory: makeFakeQuery({ messages: [] }),
      }, turnInjectable),
      (e) => /workspaceRoot is not a directory/.test(e.message) && e.message.includes(filePath),
    );
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

// --- resolveAnthropicKey move ------------------------------------------------

test('resolveAnthropicKey: moved to engine.mjs, spike re-export is the same function', async () => {
  const { resolveAnthropicKey: fromSpike } = await import('../llm_agent/sdk/spike-engine.mjs');
  assert.equal(fromSpike, resolveAnthropicKey, 'spike-engine must re-export the engine implementation, not a copy');
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-engine-test';
  try {
    assert.deepEqual(resolveAnthropicKey(null), { key: 'sk-ant-engine-test', source: 'env' });
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

// --- runAgentV2Turn: the turn runner + approval round-trip --------------------

// Per-user engine homes (spec §6, amended): every KEYED v2 turn composes
// CLAUDE_CONFIG_DIR from agentSdkHomeFor — the DB directory +
// /agent-sdk/<userId>/ — so one keyed tenant's SDK transcripts/credentials
// can never cross to another. Ambient turns deliberately skip the override
// (see the dedicated auth test below): the operator's login lives under the
// default config dir. (The same derivation backs the route's transcript
// cleanup, which scans both roots.)
test('agentSdkHomeFor: per-user dir under the server data dir; rejects unsafe ids', () => {
  assert.equal(agentSdkHomeFor('user-a'), path.join(path.dirname(tmpDb), 'agent-sdk', 'user-a'));
  for (const bad of [null, undefined, '', 42, '../escape', 'a/b', 'a..b']) {
    assert.equal(agentSdkHomeFor(bad), null, `${JSON.stringify(bad)} must not resolve a home`);
  }
});

test('per-user CLAUDE_CONFIG_DIR: composed for every KEYED turn',
  withAnthropicKey('sk-ant-v2-test', async () => {
    // A capturing factory (makeFakeQuery's shape, without the script) so the
    // composed options survive the turn for inspection.
    const capture = {};
    const capturingQuery = (prompt, options) => {
      capture.prompt = prompt;
      capture.options = options;
      return (async function* () {})();
    };
    const turn = (userId) => runAgentV2Turn({
      message: 'm', userId, mode: 'execute', agentContext: { workspaceRoot: WS },
      onEvent: () => {}, queryFactory: capturingQuery,
    }, turnInjectable);

    await turn('user-a');
    const homeA = capture.options.env.CLAUDE_CONFIG_DIR;
    const keyA = capture.options.env.ANTHROPIC_API_KEY;
    await turn('user-b');
    const homeB = capture.options.env.CLAUDE_CONFIG_DIR;

    assert.equal(homeA, agentSdkHomeFor('user-a'));
    assert.equal(homeB, agentSdkHomeFor('user-b'));
    assert.notEqual(homeA, homeB, 'each tenant gets its own engine home');
    assert.equal(keyA, 'sk-ant-v2-test', 'resolved key still rides along in the same env');
    // The home dir itself was created (isolation must not depend on the SDK
    // quietly making it later).
    assert.ok(fs.existsSync(agentSdkHomeFor('user-a')));

    // The discriminator is "a key resolved", NOT "ambient was disallowed":
    // the production route always passes allowAmbientAuth: true, so a keyed
    // turn under that flag must STILL be isolated. Pins against a refactor
    // to `allowAmbientAuth ? null : sdkHome`, which would silently strip
    // isolation from every keyed turn the route runs.
    const keyedAmbientOk = {};
    await runAgentV2Turn({
      message: 'm', userId: 'user-a', mode: 'execute', agentContext: { workspaceRoot: WS },
      allowAmbientAuth: true, onEvent: () => {},
      queryFactory: (p, o) => { keyedAmbientOk.options = o; return (async function* () {})(); },
    }, turnInjectable);
    assert.equal(keyedAmbientOk.options.env.CLAUDE_CONFIG_DIR, agentSdkHomeFor('user-a'),
      'a keyed turn keeps its per-user home even when ambient auth is allowed');
  }));

// --- Anthropic-compatible custom providers (gateway turns) ---------------------
//
// The Agent SDK only speaks the Anthropic Messages API, so a non-Anthropic
// model reaches it through a custom provider's Anthropic-format door (Z.AI
// GLM `…/api/anthropic`). The env contract is the `claude` CLI's own
// LLM-gateway one — ANTHROPIC_BASE_URL + the provider's key — and anything
// without such a door is refused BEFORE the SDK spawns.

// Registers ONE provider (syncCustomProviders replaces the registry) with its
// key in the vault; `anthropicBaseURL: null` registers a plain OpenAI-form
// provider that the engine must refuse.
function registerGatewayProvider(userId, {
  id = 'glm-gw', anthropicBaseURL = 'https://api.z.ai/api/anthropic', key = 'glm-key-1',
} = {}) {
  const vaultKey = `custom.${id}.apiKey`;
  syncCustomProviders([{
    id, name: 'GLM', baseURL: 'https://api.z.ai/api/paas/v4', apiKey: vaultKey, models: [],
    isOpenAICompatible: true, isEnabled: true,
    ...(anthropicBaseURL ? { anthropicBaseURL } : {}),
  }]);
  if (key) setSecret(getDb(), userId, vaultKey, key);
  return `custom:${id}`;
}

test('resolveAgentEngineAuth: first-party keeps the ladder; a gateway brings its own key + door; the rest is refused',
  withAnthropicKey('sk-ant-first-party', async () => {
    const user = registerUser(getDb(), { email: 'v2gw-auth@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    try {
      assert.deepEqual(resolveAgentEngineAuth(undefined, user.id),
        { provider: 'anthropic', key: 'sk-ant-first-party', source: 'env', baseUrl: null });
      assert.equal(resolveAgentEngineAuth('anthropic', user.id).baseUrl, null);

      const gateway = registerGatewayProvider(user.id);
      assert.deepEqual(resolveAgentEngineAuth(gateway, user.id),
        { provider: gateway, key: 'glm-key-1', source: 'vault', baseUrl: 'https://api.z.ai/api/anthropic' });

      const plain = registerGatewayProvider(user.id, { id: 'glm-plain', anthropicBaseURL: null });
      assert.throws(() => resolveAgentEngineAuth(plain, user.id),
        (e) => e.code === 'PROVIDER_NOT_AGENT_CAPABLE' && /Anthropic-compatible endpoint/.test(e.message));
      assert.throws(() => resolveAgentEngineAuth('custom:never-registered', user.id),
        (e) => e.code === 'PROVIDER_UNAVAILABLE' && /not found/.test(e.message));
      for (const builtIn of ['openai', 'google', 'deepseek']) {
        assert.throws(() => resolveAgentEngineAuth(builtIn, user.id),
          (e) => e.code === 'PROVIDER_NOT_AGENT_CAPABLE', `${builtIn} has no Anthropic door`);
      }
    } finally { syncCustomProviders([]); }
  }));

test('gateway turn: ANTHROPIC_BASE_URL + the provider key ride the SDK env; the model id goes verbatim',
  withAnthropicKey(undefined, async () => {
    const user = registerUser(getDb(), { email: 'v2gw-turn@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const gateway = registerGatewayProvider(user.id);
    const capture = {};
    let spawned = false;
    const refusingQuery = () => { spawned = true; return (async function* () {})(); };
    try {
      // No first-party key anywhere and ambient NOT allowed: a gateway turn
      // must still run — on the provider's own key.
      await runAgentV2Turn({
        message: 'm', userId: user.id, mode: 'execute', provider: gateway, model: 'glm-4.7',
        agentContext: { workspaceRoot: WS },
        onEvent: () => {}, queryFactory: (p, o) => { capture.options = o; return (async function* () {})(); },
      }, turnInjectable);
      const env = capture.options.env;
      assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'glm-key-1', 'Z.AI/Ollama shape');
      assert.equal(env.ANTHROPIC_API_KEY, 'glm-key-1', 'DeepSeek shape');
      assert.equal(capture.options.model, 'glm-4.7');
      // The engine home follows the USER's first-party auth, not the turn's
      // key: this user has no Claude key, so their Claude turns run ambient
      // in the operator home — and their gateway turn must live there too,
      // or a Claude ↔ GLM switch would change homes and lose the transcript.
      assert.equal(env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR,
        'an ambient user\'s gateway turn shares the operator home with their Claude turns');

      // Same gateway, a user WITH a vault Claude key: every turn of theirs is
      // isolated in the per-user home — gateway turns included.
      const keyedUser = registerUser(getDb(), { email: 'v2gw-turn-keyed@example.com', password: 'CorrectHorseBattery', displayName: 't' });
      setSecret(getDb(), keyedUser.id, 'claude.apiKey', 'sk-ant-vault-key');
      const keyedGateway = registerGatewayProvider(keyedUser.id);
      const keyedCapture = {};
      await runAgentV2Turn({
        message: 'm', userId: keyedUser.id, mode: 'execute', provider: keyedGateway, model: 'glm-4.7',
        agentContext: { workspaceRoot: WS },
        onEvent: () => {}, queryFactory: (p, o) => { keyedCapture.options = o; return (async function* () {})(); },
      }, turnInjectable);
      assert.equal(keyedCapture.options.env.CLAUDE_CONFIG_DIR, agentSdkHomeFor(keyedUser.id));
      assert.equal(keyedCapture.options.env.ANTHROPIC_AUTH_TOKEN, 'glm-key-1',
        'the gateway token, not the vault Claude key, authenticates the gateway turn');
      assert.equal(keyedCapture.options.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');

      // Refused before the SDK spawns — the factory is never reached.
      const plain = registerGatewayProvider(user.id, { id: 'glm-plain', anthropicBaseURL: null });
      for (const provider of [plain, 'openai']) {
        await assert.rejects(
          () => runAgentV2Turn({
            message: 'm', userId: user.id, mode: 'execute', provider, agentContext: { workspaceRoot: WS },
            allowAmbientAuth: true, onEvent: () => {}, queryFactory: refusingQuery,
          }, turnInjectable),
          (e) => e.code === 'PROVIDER_NOT_AGENT_CAPABLE',
        );
      }
      assert.equal(spawned, false);
    } finally { syncCustomProviders([]); }
  }));

test('first-party turn: no gateway env is injected (operator process.env semantics unchanged)',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const capture = {};
    await runAgentV2Turn({
      message: 'm', userId: 'user-a', mode: 'execute', agentContext: { workspaceRoot: WS },
      onEvent: () => {}, queryFactory: (p, o) => { capture.options = o; return (async function* () {})(); },
    }, turnInjectable);
    assert.equal(capture.options.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL);
    assert.equal(capture.options.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_AUTH_TOKEN);
    assert.equal(capture.options.env.ANTHROPIC_API_KEY, 'sk-ant-v2-test');
  }));

// The fake SDK query: captures the (prompt, options) the runner composed so
// a test can drive options.canUseTool directly — exactly what the real SDK
// does when the model reaches for a tool. No subprocess, no timers.
function makeFakeQuery(script) {
  return (prompt, options) => {
    script.prompt = prompt;
    script.options = options;
    return (async function* () {
      for (const m of script.messages) yield m;
    })();
  };
}

// The runner's auth ladder reads process.env.ANTHROPIC_API_KEY, so every
// turn test pins it explicitly (fresh test DB → no vault key): a fake key
// when the turn should run, deleted for the no-key error path.
function withAnthropicKey(value, fn) {
  return async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    if (value === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  };
}

// sessionMemory/persistMemory default to no-ops here so the existing turn
// tests stay hermetic (no DB reads beyond what they already exercise, no
// fire-and-forget background work outliving a test) — dedicated tests below
// exercise the real wiring with their own fakes.
const turnInjectable = {
  readSkill: () => null, roots: () => [],
  sessionMemory: () => [], persistMemory: async () => null,
};

test('AskUserQuestion round-trip: request event → answer → allow with updatedInput',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const script = { messages: [
      { type: 'system', subtype: 'init', session_id: 'sdk-9', tools: [], capabilities: [] },
      { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } } },
      { type: 'result', subtype: 'success', session_id: 'sdk-9', total_cost_usd: 0.25, num_turns: 2, duration_ms: 1200 },
    ] };
    const events = [];
    const { result, usageTotals } = await runAgentV2Turn({
      message: 'hi', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS },
      resumeSdkSessionId: 'sdk-9', onEvent: (e) => events.push(e),
      queryFactory: makeFakeQuery(script),
    }, turnInjectable);
    assert.equal(script.prompt, 'hi');
    assert.equal(script.options.env.ANTHROPIC_API_KEY, 'sk-ant-v2-test', 'resolved key flows into the subprocess env');
    assert.equal(typeof script.options.canUseTool, 'function');
    assert.equal(script.options.maxTurns, 40);
    assert.equal(result.subtype, 'success');
    assert.deepEqual(usageTotals,
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, costUsd: 0.25, numTurns: 2, durationMs: 1200 });
    // Simulate the SDK asking mid-turn: canUseTool parks a decision under a
    // requestId and only resolves once the registry hears from the client.
    const questions = [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }];
    const decision = script.options.canUseTool('AskUserQuestion', { questions });
    const req = events.find((e) => e.type === 'approval_request');
    assert.ok(req, 'approval_request emitted');
    assert.equal(req.kind, 'AskUserQuestion');
    assert.deepEqual(req.questions, questions);
    const res = answerDecision({ requestId: req.requestId, sdkSessionId: 'sdk-9', userId: 'u1', answers: { 'Pick one?': 'A' } });
    assert.equal(res.ok, true);
    const d = await decision;
    assert.equal(d.behavior, 'allow');
    assert.deepEqual(d.updatedInput.questions, questions);
    assert.deepEqual(d.updatedInput.answers, { 'Pick one?': 'A' });
    assert.ok(events.some((e) => e.type === 'approval_resolved' && e.outcome === 'answer'));
  }));

test('an unknown native tool is denied with the not-enabled message', withAnthropicKey('sk-ant-v2-test', async () => {
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  await runAgentV2Turn({
    message: 'm', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS },
    onEvent: () => {}, queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('NotebookEdit', { notebook_path: '/tmp/x.ipynb' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /not enabled/);
}));

test('native Bash: blocked command is denied even with always-allow set', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-blocked@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  setAlwaysAllow(user.id, 'Bash');
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: WS },
    onEvent: () => {}, queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('Bash', { command: 'sudo rm -rf /' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /blocked/i);
}));

test('native Bash: auto-safe command allows with no approval parked', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-auto@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  const events = [];
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: WS },
    onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('Bash', { command: 'git status' });
  assert.equal(d.behavior, 'allow');
  assert.ok(!events.some((e) => e.type === 'approval_request'));
}));

test('native Bash: prompt-tier command parks a ToolApproval carrying args.command', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-prompt@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const script = { messages: [{ type: 'init', session_id: 'sdk-nb1' }, { type: 'result', subtype: 'success', session_id: 'sdk-nb1' }] };
  const events = [];
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: WS },
    resumeSdkSessionId: 'sdk-nb1', onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const decision = script.options.canUseTool('Bash', { command: 'npm run build' });
  const req = events.find((e) => e.type === 'approval_request');
  assert.equal(req.kind, 'ToolApproval');
  assert.equal(req.toolName, 'Bash');
  assert.deepEqual(req.args, { command: 'npm run build' });
  answerDecision({ requestId: req.requestId, sdkSessionId: 'sdk-nb1', userId: user.id, action: 'allow' });
  const d = await decision;
  assert.equal(d.behavior, 'allow');
}));

test('native Edit: in-workspace target parks with diff args; always-allow persists per tool', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-edit@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'v2edit-'));
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'old');
  const script = { messages: [{ type: 'init', session_id: 'sdk-ed1' }, { type: 'result', subtype: 'success', session_id: 'sdk-ed1' }] };
  const events = [];
  // C1's fix builds allowedWriteRoots from `roots()` (the same validated
  // roots the read path uses), so this test's roots fake must actually
  // resolve to the workspace it writes into — turnInjectable's `roots: ()
  // => []` (used by the containment-failure tests) would wrongly block
  // every write here.
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: workspace },
    resumeSdkSessionId: 'sdk-ed1', onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
  }, { ...turnInjectable, roots: () => [workspace] });
  const input = { file_path: path.join(workspace, 'a.txt'), old_string: 'old', new_string: 'new' };
  const decision = script.options.canUseTool('Edit', input);
  const req = events.find((e) => e.type === 'approval_request');
  assert.equal(req.toolName, 'Edit');
  assert.deepEqual(req.args, { filePath: input.file_path, oldString: 'old', newString: 'new', replaceAll: false });
  answerDecision({ requestId: req.requestId, sdkSessionId: 'sdk-ed1', userId: user.id, action: 'always-allow' });
  const d = await decision;
  assert.equal(d.behavior, 'allow');
  assert.equal(hasAlwaysAllow(user.id, 'Edit'), true);
  // The always-allow row now shortcuts the prompt tier for the next Edit.
  const d2 = await script.options.canUseTool('Edit', input);
  assert.equal(d2.behavior, 'allow');
}));

test('native Write: an out-of-workspace target is denied, never parked', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-escape@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'v2esc-'));
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  const events = [];
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: workspace },
    onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('Write', { file_path: '../evil.txt', content: 'x' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /workspace/i);
  assert.ok(!events.some((e) => e.type === 'approval_request'));
}));

test('native Write: an over-broad workspace root (e.g. the home directory) refuses the whole turn up front',
  withAnthropicKey('sk-ant-v2-test', async () => {
    // Stronger than the original containment contract (final whole-branch
    // review, C1): the raw client-supplied workspaceRoot no longer even
    // reaches the SDK — the turn is refused before spawn with the same
    // isTooBroadRoot bar the read path applies, so an over-broad root can
    // never be granted as cwd, let alone reach the Write gate.
    const homeInjectable = { readSkill: () => null, sessionMemory: () => [], persistMemory: async () => null };
    const user = registerUser(getDb(), { email: 'v2native-homeroot@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
    await assert.rejects(
      runAgentV2Turn({
        message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: os.homedir() },
        onEvent: () => {}, queryFactory: makeFakeQuery(script),
      }, homeInjectable),
      (e) => /workspaceRoot is too broad/.test(e.message),
    );
    assert.equal(script.options, undefined, 'the SDK must never have been invoked for an over-broad root');
  }));

// Pins the C1 guard now that over-broad roots are refused upstream: the
// Write containment set must come from roots() (buildReadableRoots), never
// from the raw workspaceRoot — a revert to `[workspaceRoot]` would allow
// this in-workspace write even though roots() granted a different dir.
test('native Write: containment follows roots(), not the raw workspaceRoot',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const user = registerUser(getDb(), { email: 'v2native-rootsrc@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'v2rootsrc-'));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2other-'));
    const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: workspace },
      onEvent: () => {}, queryFactory: makeFakeQuery(script),
    }, { ...turnInjectable, roots: () => [otherDir] });
    const d = await script.options.canUseTool('Write', { file_path: path.join(workspace, 'a.txt'), content: 'x' });
    assert.equal(d.behavior, 'deny', 'an in-workspace target must still be denied when roots() does not grant the workspace');
  }));

test('native Write: a blocked (out-of-workspace) target is denied even with always-allow set',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const user = registerUser(getDb(), { email: 'v2native-blocked-write@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    setAlwaysAllow(user.id, 'Write'); // must NOT override a containment 'blocked' classification
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'v2blk-'));
    const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
    const events = [];
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: workspace },
      onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
    }, turnInjectable);
    const d = await script.options.canUseTool('Write', { file_path: '../evil.txt', content: 'x' });
    assert.equal(d.behavior, 'deny');
    assert.ok(!events.some((e) => e.type === 'approval_request'));
  }));

test('native tools are denied in a restricted mode', withAnthropicKey('sk-ant-v2-test', async () => {
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  await runAgentV2Turn({
    message: 'm', userId: 'u1', mode: 'plan', agentContext: { workspaceRoot: WS },
    onEvent: () => {}, queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('Edit', { file_path: '/tmp/w/a.txt', old_string: 'a', new_string: 'b' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /plan mode/);
}));

test('approvalArgsFor caps every string field at 20k and marks truncation', () => {
  const long = 'x'.repeat(25_000);
  const edit = approvalArgsFor('Edit', { file_path: '/w/a.txt', old_string: long, new_string: 'n' });
  assert.equal(edit.oldString.length, 20_000);
  assert.equal(edit.truncated, true);
  const write = approvalArgsFor('Write', { file_path: '/w/a.txt', content: long });
  assert.equal(write.contentPreview.length, 20_000);
  assert.equal(write.totalChars, 25_000);
  assert.equal(write.truncated, true);
  const bash = approvalArgsFor('Bash', { command: 'git status' });
  assert.deepEqual(bash, { command: 'git status' });
});

test('approvalArgsFor(Edit): replaceAll is forwarded as a real boolean, not run through the string cap', () => {
  const withReplaceAll = approvalArgsFor('Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true });
  assert.equal(withReplaceAll.replaceAll, true);
  const withoutReplaceAll = approvalArgsFor('Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' });
  assert.equal(withoutReplaceAll.replaceAll, false, 'omitted replace_all must decode to false, not undefined');
  const explicitFalse = approvalArgsFor('Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: false });
  assert.equal(explicitFalse.replaceAll, false);
});

test('approvalArgsFor(Write): exists reports whether the target already exists on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2write-exists-'));
  const existingFile = path.join(dir, 'already-here.txt');
  fs.writeFileSync(existingFile, 'old content');
  const overwrite = approvalArgsFor('Write', { file_path: existingFile, content: 'new content' });
  assert.equal(overwrite.exists, true);
  const newFile = path.join(dir, 'not-here-yet.txt');
  const create = approvalArgsFor('Write', { file_path: newFile, content: 'new content' });
  assert.equal(create.exists, false);
});

// --- Task 7: act-tool gating (mcp__llmide__run-bash/task-create/task-update) --
//
// canUseTool's act-tool branch: always-allow FIRST, then the tool's own
// gate; 'blocked' denies unconditionally (never overridable by always-allow
// — that's WHY always-allow is checked first but the gate still runs after
// it, rather than short-circuiting it), 'auto' allows immediately, 'prompt'
// genuinely blocks on a parked ToolApproval decision.

test('act tool: run-bash with a blocked command is denied even with always-allow set',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const user = registerUser(getDb(), { email: 'v2eng-blocked@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    setAlwaysAllow(user.id, 'run-bash'); // must NOT override a blocked classification
    const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: WS },
      onEvent: () => {}, queryFactory: makeFakeQuery(script),
    }, turnInjectable);
    const d = await script.options.canUseTool('mcp__llmide__run-bash', { command: 'sudo rm -rf /' });
    assert.equal(d.behavior, 'deny');
    assert.match(d.message, /blocked/i);
  }));

test('act tool: run-bash with an auto-safe command allows immediately, no approval parked',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const user = registerUser(getDb(), { email: 'v2eng-auto@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
    const events = [];
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: WS },
      onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
    }, turnInjectable);
    const d = await script.options.canUseTool('mcp__llmide__run-bash', { command: 'git status' });
    assert.equal(d.behavior, 'allow');
    assert.deepEqual(d.updatedInput, { command: 'git status' });
    assert.ok(!events.some((e) => e.type === 'approval_request'), 'an auto command never parks an approval');
  }));

test('act tool: task-create/task-update are always-gated auto (autoGate) — no prompt',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const user = registerUser(getDb(), { email: 'v2eng-taskauto@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: WS },
      onEvent: () => {}, queryFactory: makeFakeQuery(script),
    }, turnInjectable);
    const dCreate = await script.options.canUseTool('mcp__llmide__task-create', { title: 'do the thing' });
    assert.equal(dCreate.behavior, 'allow');
    const dUpdate = await script.options.canUseTool('mcp__llmide__task-update', { taskId: 1, status: 'in_progress' });
    assert.equal(dUpdate.behavior, 'allow');
  }));

test('act tool: run-bash with an unrecognized command parks a ToolApproval and genuinely blocks until answered',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const user = registerUser(getDb(), { email: 'v2eng-prompt@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const script = { messages: [
      { type: 'system', subtype: 'init', session_id: 'sdk-rb1', tools: [], capabilities: [] },
      { type: 'result', subtype: 'success', session_id: 'sdk-rb1' },
    ] };
    const events = [];
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: WS },
      resumeSdkSessionId: 'sdk-rb1', onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
    }, turnInjectable);
    const decision = script.options.canUseTool('mcp__llmide__run-bash', { command: 'some-unknown-cli --deploy' });
    // Genuinely blocked — not yet settled after a microtask tick.
    let settled = false;
    decision.then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'a prompt decision must not optimistically allow before an answer arrives');
    const req = events.find((e) => e.type === 'approval_request');
    assert.ok(req, 'approval_request emitted');
    assert.equal(req.kind, 'ToolApproval');
    assert.equal(req.toolName, 'run-bash');
    const res = answerDecision({ requestId: req.requestId, sdkSessionId: 'sdk-rb1', userId: user.id, action: 'allow' });
    assert.equal(res.ok, true);
    const d = await decision;
    assert.equal(d.behavior, 'allow');
    assert.ok(events.some((e) => e.type === 'approval_resolved' && e.outcome === 'allow'));
    // The always-allow table was NOT written for a plain 'allow' — only 'always-allow' persists it.
    assert.equal(hasAlwaysAllow(user.id, 'run-bash'), false);
  }));

test('act tool: run-bash prompt decision answered "deny" denies the tool',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const user = registerUser(getDb(), { email: 'v2eng-deny@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const script = { messages: [
      { type: 'system', subtype: 'init', session_id: 'sdk-rb2', tools: [], capabilities: [] },
      { type: 'result', subtype: 'success', session_id: 'sdk-rb2' },
    ] };
    const events = [];
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: WS },
      resumeSdkSessionId: 'sdk-rb2', onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
    }, turnInjectable);
    const decision = script.options.canUseTool('mcp__llmide__run-bash', { command: 'some-other-unknown-cli' });
    const req = events.find((e) => e.type === 'approval_request');
    assert.ok(req, 'approval_request emitted');
    const res = answerDecision({ requestId: req.requestId, sdkSessionId: 'sdk-rb2', userId: user.id, action: 'deny' });
    assert.equal(res.ok, true);
    const d = await decision;
    assert.equal(d.behavior, 'deny');
    assert.ok(events.some((e) => e.type === 'approval_resolved' && e.outcome === 'deny'));
    assert.equal(hasAlwaysAllow(user.id, 'run-bash'), false);
  }));

test('act tool: run-bash prompt decision answered "always-allow" persists the approval and allows',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const user = registerUser(getDb(), { email: 'v2eng-alwaysallow@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const script = { messages: [
      { type: 'system', subtype: 'init', session_id: 'sdk-rb3', tools: [], capabilities: [] },
      { type: 'result', subtype: 'success', session_id: 'sdk-rb3' },
    ] };
    const events = [];
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: WS },
      resumeSdkSessionId: 'sdk-rb3', onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
    }, turnInjectable);
    assert.equal(hasAlwaysAllow(user.id, 'run-bash'), false);
    const decision = script.options.canUseTool('mcp__llmide__run-bash', { command: 'yet-another-unknown-cli' });
    const req = events.find((e) => e.type === 'approval_request');
    answerDecision({ requestId: req.requestId, sdkSessionId: 'sdk-rb3', userId: user.id, action: 'always-allow' });
    const d = await decision;
    assert.equal(d.behavior, 'allow');
    assert.equal(hasAlwaysAllow(user.id, 'run-bash'), true);

    // A SECOND call, even with a fresh unrecognized command, now allows
    // immediately with no new approval parked — always-allow short-circuits
    // the gate on the next call.
    const before = events.length;
    const d2 = await script.options.canUseTool('mcp__llmide__run-bash', { command: 'brand-new-unknown-cli' });
    assert.equal(d2.behavior, 'allow');
    assert.equal(events.length, before, 'no new approval_request for an always-allowed tool');
  }));

test('resume failure maps to SESSION_UNRESUMABLE',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const boom = () => (async function* () { throw new Error('No conversation found with session id: x'); })();
    await assert.rejects(
      runAgentV2Turn({
        message: 'm', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS },
        resumeSdkSessionId: 'x', onEvent: () => {}, queryFactory: boom,
      }, turnInjectable),
      (e) => e.code === 'SESSION_UNRESUMABLE',
    );
  }));

test('aborted approval denies with the no-answer message; session id captured from init',
  withAnthropicKey('sk-ant-v2-test', async () => {
    // No resumeSdkSessionId: currentSdkSessionId must be captured from the
    // streamed init message for abortDecisionsForSession to find the entry.
    const script = { messages: [{ type: 'system', subtype: 'init', session_id: 'sdk-cap', tools: [], capabilities: [] }] };
    const events = [];
    await runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS },
      onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
    }, turnInjectable);
    const decision = script.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Q?' }] });
    const req = events.find((e) => e.type === 'approval_request');
    assert.ok(req, 'approval_request emitted');
    assert.equal(abortDecisionsForSession('sdk-cap'), 1);
    const d = await decision;
    assert.equal(d.behavior, 'deny');
    assert.match(d.message, /did not answer/);
    assert.ok(events.some((e) => e.type === 'approval_resolved' && e.outcome === 'aborted'));
  }));

test('abort wiring: turn/per-call signals deny a parked approval promptly and listeners detach',
  withAnthropicKey('sk-ant-v2-test', async () => {
    // Turn A carries the turn-level signal; turn B passes none, so B's
    // canUseTool sees only the SDK's per-call signal — each wiring in isolation.
    const scriptA = { messages: [{ type: 'system', subtype: 'init', session_id: 'sdk-abort-a', tools: [], capabilities: [] }] };
    const scriptB = { messages: [{ type: 'system', subtype: 'init', session_id: 'sdk-abort-b', tools: [], capabilities: [] }] };
    const events = [];
    const turnAc = new AbortController();
    const base = {
      message: 'm', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS },
      onEvent: (e) => events.push(e),
    };
    await runAgentV2Turn({ ...base, signal: turnAc.signal, queryFactory: makeFakeQuery(scriptA) }, turnInjectable);
    await runAgentV2Turn({ ...base, queryFactory: makeFakeQuery(scriptB) }, turnInjectable);
    const questions = [{ question: 'Q?' }];
    const lastReq = () => events.filter((e) => e.type === 'approval_request').at(-1);
    // Race guard: fail in 5 s instead of hanging on the registry's 300 s timeout.
    const failAfter = (msg) => new Promise((_, rej) => { setTimeout(() => rej(new Error(msg)), 5_000).unref(); });
    try {
      // Settling by answer detaches both listeners — the turn signal outlives
      // any single question, so leaving listeners armed would leak per asked
      // question.
      const pc = new AbortController();
      const answered = scriptA.options.canUseTool('AskUserQuestion', { questions }, { signal: pc.signal });
      assert.equal(getEventListeners(turnAc.signal, 'abort').length, 1, 'turn signal armed while parked');
      assert.equal(getEventListeners(pc.signal, 'abort').length, 1, 'per-call signal armed while parked');
      answerDecision({ requestId: lastReq().requestId, sdkSessionId: 'sdk-abort-a', userId: 'u1', answers: { 'Q?': 'A' } });
      assert.equal((await answered).behavior, 'allow');
      assert.equal(getEventListeners(turnAc.signal, 'abort').length, 0, 'turn-signal listener detached on settle');
      assert.equal(getEventListeners(pc.signal, 'abort').length, 0, 'per-call listener detached on settle');

      // Turn-level abort while parked → prompt deny + approval_resolved 'aborted'.
      const parked = scriptA.options.canUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal });
      const t0 = Date.now();
      turnAc.abort();
      const d = await Promise.race([parked, failAfter('turn abort did not deny the parked approval')]);
      assert.ok(Date.now() - t0 < 2_000, `deny must be prompt, not the 300 s registry timeout (took ${Date.now() - t0} ms)`);
      assert.deepEqual(d, { behavior: 'deny', message: 'The user did not answer the question.' });
      assert.ok(events.some((e) => e.type === 'approval_resolved' && e.outcome === 'aborted'),
        'approval_resolved outcome aborted emitted');

      // The SDK's per-call signal alone (no turn signal on B) also denies.
      const pcB = new AbortController();
      const perCall = scriptB.options.canUseTool('AskUserQuestion', { questions }, { signal: pcB.signal });
      pcB.abort();
      const d2 = await Promise.race([perCall, failAfter('per-call abort did not deny the parked approval')]);
      assert.equal(d2.behavior, 'deny');
      assert.match(d2.message, /did not answer/);
    } finally {
      // Clear any straggler so no 300 s registry timer outlives the test.
      abortDecisionsForSession('sdk-abort-a');
      abortDecisionsForSession('sdk-abort-b');
    }
  }));

test('missing workspaceRoot is rejected before any query starts', async () => {
  let queryStarted = false;
  await assert.rejects(
    runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute', agentContext: {},
      onEvent: () => {}, queryFactory: () => { queryStarted = true; return (async function* () {})(); },
    }, turnInjectable),
    (e) => /workspaceRoot is required/.test(e.message),
  );
  assert.equal(queryStarted, false);
});

// --- maxBudgetUsd (spec §7) ----------------------------------------------------

test('maxBudgetUsd: a usable cap flows into query options; no cap → option absent',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const seen = [];
    const capped = { messages: [] };
    await runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute', model: 'claude-sonnet-5',
      agentContext: { workspaceRoot: WS },
      onEvent: () => {}, queryFactory: makeFakeQuery(capped),
    }, { ...turnInjectable, resolveBudget: (...args) => { seen.push(args); return 1.25; } });
    assert.deepEqual(seen, [['u1', 'claude-sonnet-5', { provider: 'anthropic' }]],
      'resolver sees (userId, requested model, the provider the turn runs on)');
    assert.equal(capped.options.maxBudgetUsd, 1.25);

    const uncapped = { messages: [] };
    await runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute', model: 'claude-sonnet-5',
      agentContext: { workspaceRoot: WS },
      onEvent: () => {}, queryFactory: makeFakeQuery(uncapped),
    }, { ...turnInjectable, resolveBudget: () => null });
    assert.ok(!('maxBudgetUsd' in uncapped.options), 'no usable cap → option absent');
  }));

test('resolveMaxBudgetUsd: runs/tokens caps (all model-limits stores today) yield no USD cap; a usd-unit row resolves', () => {
  const db = getDb();
  const user = registerUser(db, {
    email: 'v2budget@example.com', password: 'CorrectHorseBattery', displayName: 't',
  });
  // No limits configured → no budget.
  assert.equal(resolveMaxBudgetUsd(user.id, 'claude-sonnet-5'), null);
  // A runs cap — the shape the "Model & Limits" UI actually writes — is a
  // windowed usage count, not dollars: must NOT be laundered into maxBudgetUsd.
  db.prepare(
    `INSERT INTO model_limits (user_id, provider, model, priority, enabled, limit_value, unit, window_kind, threshold_pct)
     VALUES (?, 'anthropic', 'claude-sonnet-5', 0, 1, 500, 'runs', 'daily', 90)`,
  ).run(user.id);
  assert.equal(resolveMaxBudgetUsd(user.id, 'claude-sonnet-5'), null, 'a runs cap is not a USD budget');
  // A usd-unit row — not producible via setLimits today (VALID_UNITS rejects
  // it; inserted raw here) — resolves as the per-turn ceiling. That is the
  // read path the limits system grows into without an engine change.
  db.prepare(
    `UPDATE model_limits SET unit='usd', limit_value=5 WHERE user_id=? AND model='claude-sonnet-5'`,
  ).run(user.id);
  assert.equal(resolveMaxBudgetUsd(user.id, 'claude-sonnet-5'), 5);
  // Guards: other model, no model, no user → null.
  assert.equal(resolveMaxBudgetUsd(user.id, 'claude-opus-4-8'), null);
  assert.equal(resolveMaxBudgetUsd(user.id, null), null);
  assert.equal(resolveMaxBudgetUsd(null, 'claude-sonnet-5'), null);
});

test('auth: no key throws the spike error unless allowAmbientAuth',
  withAnthropicKey(undefined, async () => {
    // Fresh test DB has no vault key for u1 and the env key is deleted →
    // the runner must refuse rather than silently use operator ambient auth.
    await assert.rejects(
      runAgentV2Turn({
        message: 'm', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS },
        onEvent: () => {}, queryFactory: makeFakeQuery({ messages: [] }),
      }, turnInjectable),
      (e) => /No Anthropic API key available/.test(e.message),
    );
    // Ambient opt-in: the turn runs and the composed env carries NO
    // fabricated key AND no CLAUDE_CONFIG_DIR override — ambient auth means
    // the subprocess finds the operator's login on its own, and that login
    // lives under the operator's DEFAULT config dir. Redirecting the config
    // dir to the (empty) per-user home makes the CLI "Not logged in" and
    // fails every ambient turn — the regression behind the Mac chat's
    // ENGINE_ERROR banner.
    const ambient = { messages: [] };
    await runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS },
      allowAmbientAuth: true, onEvent: () => {}, queryFactory: makeFakeQuery(ambient),
    }, turnInjectable);
    const env = ambient.options.env ?? {};
    assert.ok(!('ANTHROPIC_API_KEY' in env), 'ambient auth must not fabricate an env key');
    assert.ok(!('CLAUDE_CONFIG_DIR' in env),
      'ambient turns must not redirect CLAUDE_CONFIG_DIR — the operator login lives in the default config dir');
  }));

// --- memory write-back (persistTurnMemory, fire-and-forget) -------------------

test('memory write-back: a turn with reply text fires persistMemory with the accumulated reply, unawaited',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const script = { messages: [
      { type: 'system', subtype: 'init', session_id: 'sdk-mem', tools: [], capabilities: [] },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } },
      { type: 'result', subtype: 'success', session_id: 'sdk-mem' },
    ] };
    const calls = [];
    let resolveGate;
    const gate = new Promise((r) => { resolveGate = r; });
    const persistMemory = async (args) => { calls.push(args); resolveGate(); return null; };
    const t0 = Date.now();
    await runAgentV2Turn({
      message: 'hi there', userId: 'u1', mode: 'execute',
      agentContext: { workspaceRoot: WS, chatSessionId: 'chat-mem' },
      onEvent: () => {}, queryFactory: makeFakeQuery(script),
    }, { ...turnInjectable, persistMemory });
    // The turn itself must not wait on persistMemory's own promise — assert
    // fire-and-forget by requiring the turn to have already returned quickly
    // (well under a real extraction call's latency), then await the gate to
    // observe the call that already happened.
    assert.ok(Date.now() - t0 < 2_000, 'runAgentV2Turn must not await persistMemory');
    await gate;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userId, 'u1');
    assert.equal(calls[0].userMessage, 'hi there');
    assert.equal(calls[0].reply, 'Hello world', 'delta text accumulates into the reply persistMemory receives');
    assert.deepEqual(calls[0].agentContext, { workspaceRoot: WS, chatSessionId: 'chat-mem' });
    assert.equal(typeof calls[0].runClaude, 'function');
  }));

test('memory write-back: no reply text (e.g. a pure tool-call turn) never calls persistMemory',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const script = { messages: [{ type: 'result', subtype: 'success', session_id: 'sdk-noreply' }] };
    let called = false;
    await runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS },
      onEvent: () => {}, queryFactory: makeFakeQuery(script),
    }, { ...turnInjectable, persistMemory: async () => { called = true; } });
    assert.ok(!called, 'empty reply text must not trigger a memory-extraction call');
  }));

test('memory write-back: a thrown/rejecting persistMemory never surfaces to the caller',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const script = { messages: [
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
      { type: 'result', subtype: 'success', session_id: 'sdk-boom' },
    ] };
    const { result } = await runAgentV2Turn({
      message: 'm', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: WS },
      onEvent: () => {}, queryFactory: makeFakeQuery(script),
    }, { ...turnInjectable, persistMemory: async () => { throw new Error('boom'); } });
    assert.equal(result.subtype, 'success', 'the turn itself succeeds regardless of a failing memory write');
  }));

// --- llmide tool server: agentContext/message threaded through for project_memory --

test('llmide tool server receives agentContext + message so project_memory can use them',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const capture = {};
    const capturingQuery = (prompt, options) => {
      capture.mcpServers = options.mcpServers;
      return (async function* () {})();
    };
    await runAgentV2Turn({
      message: 'what changed recently?', userId: 'u1', mode: 'execute',
      agentContext: { workspaceRoot: WS, indexedRepos: [] },
      onEvent: () => {}, queryFactory: capturingQuery,
    }, turnInjectable);
    assert.equal(capture.mcpServers.llmide.type, 'sdk');
    assert.equal(capture.mcpServers.llmide.name, 'llmide');
  }));

// --- Task 4: expanded V2_ALLOWED_TOOLS + the extra toolCtx fields -------------
//
// mcp__llmide__list-files is a newly-allowed registry read tool (previously
// only reachable via the 'mcp__llmide__*' wildcard, which this task replaced
// with explicit names). Proves two things end-to-end: (1) the scripted
// tool_use name is actually present in the composed allowedTools the SDK
// would enforce against, and (2) the llmide server the runner mounts is not
// just present (already covered above) but a REAL, callable MCP server —
// connecting a real MCP Client to the same instance and invoking list-files
// exercises buildLlmIdeServer's readableRoots wiring for real. Full mount/
// dispatch coverage for every registry tool (including ask-internal/
// ask-subagent's runClaude/userSkills/userSubagents/internalSkills wiring)
// lives in tests/agent-v2-tools.test.mjs — this test only pins that the v2
// engine's allowlist + mcpServers composition actually reach a working tool.
test('stream: a turn that calls mcp__llmide__list-files succeeds (v2 read-tool parity)',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const script = { messages: [
      { type: 'system', subtype: 'init', session_id: 's1', tools: ['mcp__llmide__list-files'], mcp_servers: [] },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__llmide__list-files', input: {} }] },
      },
      { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1, duration_ms: 1, session_id: 's1' },
    ] };
    const events = [];
    const { result } = await runAgentV2Turn({
      message: 'list the files here', userId: 'u1', mode: 'execute',
      agentContext: { workspaceRoot: __dirname },
      onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
    }, turnInjectable);

    // The scripted tool_use name must actually be in the allowlist the SDK
    // enforces — this is the concrete regression the wildcard removal risks.
    assert.ok(
      script.options.allowedTools.includes('mcp__llmide__list-files'),
      'mcp__llmide__list-files must be explicitly named in V2_ALLOWED_TOOLS',
    );
    // Mounting doesn't throw and the scripted 'result' terminates the stream.
    assert.equal(result.subtype, 'success');

    // The mounted server is not a stub: connect a real MCP client to the
    // SAME instance the runner composed and actually call the tool.
    const server = script.options.mcpServers.llmide;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const out = await client.callTool({ name: 'list-files', arguments: {} });
      assert.ok(!out.isError, `list-files call failed: ${JSON.stringify(out)}`);
      const parsed = JSON.parse(out.content[0].text);
      assert.ok(Array.isArray(parsed.files), 'list-files actually ran against the workspace root');
    } finally {
      await client.close();
      await server.instance.close();
    }
  }));

// --- end-to-end round trip: a fact from turn 1 is recalled in turn 2 ----------
//
// Every other memory test above fakes sessionMemory AND persistMemory, which
// proves the WIRING but not that the two sides actually agree on a real DB.
// This test uses the REAL persistTurnMemory (kb/session-memory.mjs's real
// appendSessionMemory) and the REAL listSessionMemory read path — only
// queryFactory (no SDK subprocess) and runClaude (no real LLM call, for the
// extraction step persistTurnMemory itself makes) are faked. It is the one
// test that would catch a chatSessionId-resolution mismatch between the write
// path and the read path.
test('session memory end-to-end: a fact captured from turn 1 is recalled by turn 2',
  withAnthropicKey('sk-ant-v2-test', async () => {
    const workspaceRoot = path.join(__dirname, '_agent-v2-memory-roundtrip-fixture');
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    // runAgentV2Turn existence-checks workspaceRoot — start from a clean but
    // EXISTING fixture root, as production always would.
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const user = registerUser(getDb(), {
      email: 'v2mem-roundtrip@example.com', password: 'CorrectHorseBattery', displayName: 't',
    });
    const agentContext = { workspaceRoot, chatSessionId: 'chat-roundtrip-1' };
    // extractMemories expects {"facts":[{category,key,fact}],"superseded":[]}
    // JSON text back from runClaude (llm_agent/runtime/memory-extract.mjs).
    const fakeRunClaude = async () => JSON.stringify({
      facts: [{ category: 'tooling', key: 'test-runner', fact: 'This repo runs tests with node --test.' }],
      superseded: [],
    });
    try {
      let capturedPromise;
      const persistMemory = (args) => { capturedPromise = persistTurnMemory(args); return capturedPromise; };
      const scriptTurn1 = { messages: [
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Run tests with node --test.' } } },
        { type: 'result', subtype: 'success', session_id: 'sdk-roundtrip' },
      ] };
      await runAgentV2Turn({
        message: 'How do I run the test suite in this repo?', userId: user.id, mode: 'execute', agentContext,
        onEvent: () => {}, queryFactory: makeFakeQuery(scriptTurn1),
      }, {
        readSkill: () => null, roots: () => [],
        sessionMemory: listSessionMemory, persistMemory, runClaude: fakeRunClaude,
      });
      // persistMemory is fire-and-forget from the runner's own perspective —
      // the test awaits the SAME promise it captured to know the real
      // extraction + DB write actually finished before turn 2 reads.
      await capturedPromise;

      // Sanity: the real DB write actually happened (not just that the call
      // didn't throw) — same table listSessionMemory reads via buildEngineOptions.
      assert.deepEqual(
        listSessionMemory(user.id, 'chat-roundtrip-1'),
        ['[tooling|test-runner] This repo runs tests with node --test.'],
      );

      // Turn 2, same chat: buildEngineOptions (real sessionMemory, no fake)
      // must surface the fact turn 1 captured.
      const { queryOptions } = buildEngineOptions(
        { userId: user.id, mode: 'execute', message: 'anything else I should know?', agentContext },
        { readSkill: () => null, roots: () => [], sessionMemory: listSessionMemory },
      );
      const append = queryOptions.systemPrompt.append;
      assert.match(append, /## This session's memory/);
      assert.match(append, /This repo runs tests with node --test\./);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }));
