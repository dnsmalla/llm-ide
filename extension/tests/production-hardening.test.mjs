// Regression tests for the production-hardening pass:
//   1. Sub-model routing — model/maxTokens thread from runAgentLoop and
//      the ask-internal / ask-subagent handlers into runClaude.
//   2. Agent loop nesting depth guard.
//   3. Skill loader — required-field errors, oversized _base.md rejected.
//   4. buildSystemPrompt aggregate skill-body cap.
//   5. deleteSourcesByPrefix escapes LIKE wildcards (underscore in a
//      repo path must not delete a sibling repo's rows).

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
const tmpDb = path.join(__dirname, '_production-hardening-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { runAgentLoop, buildSystemPrompt } = await import('../llm_agent/runtime/loop.mjs');
const { askSubagent } = await import('../llm_agent/runtime/handlers/ask-subagent.mjs');
const { loadSkills } = await import('../llm_agent/skills/loader.mjs');

// Stub runClaude that records the opts of every call.
function makeStubClaude(responses = []) {
  const calls = [];
  let idx = 0;
  const fn = async (prompt, opts) => {
    calls.push({ prompt, opts });
    const out = responses[idx] ?? 'plain answer';
    idx += 1;
    return out;
  };
  fn.calls = calls;
  return fn;
}

// ── 1. Sub-model routing ────────────────────────────────────────────

test('runAgentLoop threads model and maxTokens into runClaude', async () => {
  const stub = makeStubClaude(['done']);
  await runAgentLoop({
    skills: new Map(),
    userMessage: 'hi',
    history: [],
    agentContext: { base: 'sys' },
    runClaude: stub,
    kb: null,
    userId: 'u1',
    handlers: {},
    model: 'claude-haiku-4-5',
    maxTokens: 1234,
  });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].opts.model, 'claude-haiku-4-5');
  assert.equal(stub.calls[0].opts.maxTokens, 1234);
});

test('runAgentLoop defaults: no model, maxTokens 2048', async () => {
  const stub = makeStubClaude(['done']);
  await runAgentLoop({
    skills: new Map(),
    userMessage: 'hi',
    history: [],
    agentContext: { base: 'sys' },
    runClaude: stub,
    kb: null,
    userId: 'u1',
    handlers: {},
  });
  assert.equal(stub.calls[0].opts.model, undefined);
  assert.equal(stub.calls[0].opts.maxTokens, 2048);
});

test('askSubagent: frontmatter model wins over deployment default', async () => {
  const stub = makeStubClaude(['sub answer']);
  const subagents = new Map([
    ['leaf', {
      systemPrompt: 'leaf prompt',
      allowedTools: [],
      maxIterations: 1,
      model: 'claude-haiku-4-5',
      pluginName: 't',
    }],
  ]);
  await askSubagent({ name: 'leaf', question: 'q' }, {
    runClaude: stub, kb: null, userId: 'u1',
    subagents, internalSkillsBase: '', defaultModel: 'claude-sonnet-4-6',
  });
  assert.equal(stub.calls[0].opts.model, 'claude-haiku-4-5');
});

test('askSubagent: deployment default model used when subagent declares none', async () => {
  const stub = makeStubClaude(['sub answer']);
  const subagents = new Map([
    ['leaf', { systemPrompt: 'p', allowedTools: [], maxIterations: 1, pluginName: 't' }],
  ]);
  await askSubagent({ name: 'leaf', question: 'q' }, {
    runClaude: stub, kb: null, userId: 'u1',
    subagents, internalSkillsBase: '', defaultModel: 'claude-sonnet-4-6',
  });
  assert.equal(stub.calls[0].opts.model, 'claude-sonnet-4-6');
});

// ── 2. Depth guard ──────────────────────────────────────────────────

test('runAgentLoop rejects nesting beyond MAX_LOOP_DEPTH', async () => {
  const stub = makeStubClaude(['x']);
  await assert.rejects(
    runAgentLoop({
      skills: new Map(), userMessage: 'hi', history: [],
      agentContext: { base: 's' }, runClaude: stub, kb: null,
      userId: 'u1', handlers: {}, depth: 3,
    }),
    /nesting exceeds depth/,
  );
  assert.equal(stub.calls.length, 0, 'no LLM call should be made past the depth cap');
});

test('loop hands read handlers a pre-incremented depth for their sub-loops', async () => {
  // The +1 lives in loop.mjs (single enforcement point); handlers must
  // receive ctx.depth = parent depth + 1 and forward it verbatim.
  const fence = '<<<TOOL_CALL>>>\n{"name":"probe","arguments":{}}\n<<<END_TOOL_CALL>>>';
  const stub = makeStubClaude([fence, 'done']);
  let seenDepth = null;
  const out = await runAgentLoop({
    skills: new Map([['probe', { name: 'probe', kind: 'read', schema: {}, body: 'probe skill' }]]),
    userMessage: 'hi',
    history: [],
    agentContext: { base: 'sys' },
    runClaude: stub,
    kb: null,
    userId: 'u1',
    handlers: { probe: (args, ctx) => { seenDepth = ctx.depth; return { ok: true }; } },
    depth: 1,
  });
  assert.equal(seenDepth, 2, 'handler ctx.depth must be parent depth + 1');
  assert.equal(out.reply, 'done');
});

test('runAgentLoop allows depth at the cap', async () => {
  const stub = makeStubClaude(['fine']);
  const out = await runAgentLoop({
    skills: new Map(), userMessage: 'hi', history: [],
    agentContext: { base: 's' }, runClaude: stub, kb: null,
    userId: 'u1', handlers: {}, depth: 2,
  });
  assert.equal(out.reply, 'fine');
});

// ── 3. Skill loader validation ──────────────────────────────────────

function makeSkillDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltest-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('skill missing name reports missing required field', () => {
  const dir = makeSkillDir({
    'foo.md': '---\nkind: read\n---\nbody text\n',
  });
  const { skills, warnings } = loadSkills(dir);
  assert.equal(skills.size, 0);
  assert.ok(warnings.some((w) => /missing required field 'name'/.test(w)), warnings.join('; '));
});

test('skill missing kind reports missing required field', () => {
  const dir = makeSkillDir({
    'foo.md': '---\nname: foo\n---\nbody text\n',
  });
  const { skills, warnings } = loadSkills(dir);
  assert.equal(skills.size, 0);
  assert.ok(warnings.some((w) => /missing required field 'kind'/.test(w)), warnings.join('; '));
});

test('oversized _base.md is rejected, not truncated', () => {
  const dir = makeSkillDir({
    '_base.md': 'A'.repeat(40_000),
    'ok.md': '---\nname: ok\nkind: read\n---\nfine\n',
  });
  const { base, skills, warnings } = loadSkills(dir);
  assert.equal(base, '', 'oversized base must not be partially loaded');
  assert.ok(warnings.some((w) => /_base\.md exceeds/.test(w)));
  assert.equal(skills.size, 1, 'other skills still load');
});

// ── 4. System prompt aggregate cap ──────────────────────────────────

test('buildSystemPrompt drops skills beyond the aggregate byte budget', () => {
  const big = 'B'.repeat(30_000);
  const skills = new Map();
  for (let i = 0; i < 10; i++) {
    skills.set(`s${i}`, { body: `skill-${i}-${big}` });
  }
  const prompt = buildSystemPrompt({ base: 'base', skills, agentContextBlock: '' });
  // 128 KB budget / ~30 KB bodies → only the first 4 fit.
  assert.match(prompt, /skill-0-/);
  assert.match(prompt, /skill-3-/);
  assert.doesNotMatch(prompt, /skill-5-/);
});

test('buildSystemPrompt keeps all skills under the budget', () => {
  const skills = new Map([
    ['a', { body: 'alpha body' }],
    ['b', { body: 'beta body' }],
  ]);
  const prompt = buildSystemPrompt({ base: 'base', skills, agentContextBlock: '' });
  assert.match(prompt, /alpha body/);
  assert.match(prompt, /beta body/);
});

// ── 5. deleteSourcesByPrefix LIKE escaping ──────────────────────────

test('deleteSourcesByPrefix: underscore in prefix does not match sibling paths', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  const u = users.registerUser(db.getDb(), { email: 'p@example.com', password: 'pw123456789AB!', displayName: 'P' });
  const userId = u.user?.id ?? u.id;

  db.ingestSources(userId, [
    { kind: 'code', ref: '/repo/my_app/a.js',  title: 'a', body: 'alpha' },
    { kind: 'code', ref: '/repo/myXapp/b.js',  title: 'b', body: 'beta' },
  ]);

  // `_` must match literally: deleting my_app/ must not touch myXapp/.
  const deleted = db.deleteSourcesByPrefix(userId, 'code', '/repo/my_app/');
  assert.equal(deleted, 1, 'exactly the my_app row should be deleted');

  const remaining = db.getDb()
    .prepare('SELECT ref FROM sources WHERE user_id = ?').all(userId)
    .map((r) => r.ref);
  assert.deepEqual(remaining, ['/repo/myXapp/b.js']);

  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});
