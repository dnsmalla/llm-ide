// The measured context split per v2 chat turn (migration 0044, extends 0040).
// No model calls: the engine turn runs against a scripted fake query, and the
// SDK's context categories are a fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applyMigrations } from '../kb/migrations.mjs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_turn-composition-split-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const db = await import('../kb/db.mjs');
// turn_composition lives in agent.db (Stage 1b). Reads flush the queue first, so a
// row written just before the read is visible, as it was when the write was sync.
const agentStore = await import('../kb/agent-db.mjs');
agentStore.closeAgentDb();
const agentReadDb = () => { agentStore.flushAgentQueue(); return agentStore.getAgentDb(); };
const users = await import('../server/users.mjs');
const { recordTurnComposition, turnCompositionRecent } = await import('../kb/turn-composition.mjs');
const { runAgentV2Turn } = await import('../llm_agent/sdk/engine.mjs');
const { v2ToolDefinitionChars } = await import('../llm_agent/sdk/tools.mjs');
const { handleKB } = await import('../routes/router.mjs');

const A = users.registerUser(db.getDb(), { email: 'tcs-a@example.test', password: 'CorrectHorseBattery', displayName: 'a' }).id;
const B = users.registerUser(db.getDb(), { email: 'tcs-b@example.test', password: 'CorrectHorseBattery', displayName: 'b' }).id;

// Known sizes: 4000 chars -> 1000 tokens, 2401 -> 601 (ceil), 800 -> 200, etc.
const SDK_CATEGORIES = [
  { name: 'System prompt', kind: 'used', tokens: 9000 },
  { name: 'System tools', kind: 'used', tokens: 6000 },
  { name: 'MCP tools', kind: 'used', tokens: 3000 },
  { name: 'Memory files', kind: 'used', tokens: 500 },
  { name: 'Messages', kind: 'used', tokens: 100000 },
  { name: 'Free space', kind: 'free', tokens: 800000 },
  { name: 'MCP tools (deferred)', kind: 'deferred', isDeferred: true, tokens: 50000 },
  { name: 'Skills', kind: 'used', tokens: 900 },
];
const measured = (turnId, extra = {}) => ({
  turnId, mode: 'execute', model: 'claude-sonnet-5-5', resumed: true,
  systemPromptKind: 'preset', systemChars: 4000, promptChars: 40, attachedFiles: 0, attachmentChars: 0,
  images: 0, tools: 20, mcpTools: 12, mcpServers: ['llmide', 'notion'], agents: 0, skills: 0,
  slashCommands: 0, claudeCodeVersion: '2.1.301', apiCalls: 3,
  firstCall: { inputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 120000 },
  skillsAppendChars: 8, memoryChars: 400, skillsFenceChars: 40, contextChars: 800,
  llmideToolChars: 2401, userMcpServers: 2, toolResultChars: 1000,
  sdkContextTotalTokens: 125000, sdkCategories: SDK_CATEGORIES,
  ...extra,
});

test('migration 0044 applies on a fresh database and adds the split columns', () => {
  const fresh = new Database(':memory:');
  applyMigrations(fresh);
  const cols = fresh.prepare('PRAGMA table_info(turn_composition)').all().map((c) => c.name);
  for (const c of [
    'system_prompt_tokens', 'skills_append_tokens', 'llmide_tool_tokens', 'user_mcp_servers',
    'context_fence_tokens', 'memory_fence_tokens', 'skills_fence_tokens', 'tool_result_chars',
    'tool_result_tokens', 'sdk_context_total_tokens', 'sdk_system_prompt_tokens', 'sdk_system_tools_tokens',
    'sdk_mcp_tools_tokens', 'sdk_memory_tokens', 'sdk_messages_tokens', 'sdk_categories',
  ]) assert.ok(cols.includes(c), `missing column ${c}`);
  fresh.close();
});

test('a faked turn with known sizes is written as approximate tokens and SDK categories', () => {
  assert.equal(recordTurnComposition(A, measured('split-1')), true);
  const r = agentReadDb().prepare('SELECT * FROM turn_composition WHERE user_id = ? AND turn_id = ?').get(A, 'split-1');
  assert.equal(r.system_prompt_tokens, 1000, 'chars / 4');
  assert.equal(r.skills_append_tokens, 2);
  assert.equal(r.llmide_tool_tokens, 601, 'ceil(2401 / 4)');
  assert.equal(r.context_fence_tokens, 200);
  assert.equal(r.memory_fence_tokens, 100);
  assert.equal(r.skills_fence_tokens, 10);
  assert.equal(r.tool_result_chars, 1000);
  assert.equal(r.tool_result_tokens, 250);
  assert.equal(r.user_mcp_servers, 2);
  assert.equal(r.sdk_context_total_tokens, 125000);
  assert.equal(r.sdk_system_prompt_tokens, 9000);
  assert.equal(r.sdk_system_tools_tokens, 6000);
  assert.equal(r.sdk_mcp_tools_tokens, 3000, 'the deferred MCP row never inflates the live MCP tools sum');
  assert.equal(r.sdk_memory_tokens, 500);
  assert.equal(r.sdk_messages_tokens, 100000);
  assert.equal(r.sdk_deferred_tools_tokens, 50000, 'deferred tool schemas are summed on their own');
  assert.match(r.sdk_categories, /^System prompt:used=9000;System tools:used=6000;MCP tools:used=3000;Memory files:used=500;Messages:used=100000;Free space:free=800000;MCP tools \(deferred\):deferred=50000;Skills:used=900$/);
  // The 0040 columns are unchanged.
  assert.equal(r.system_chars, 4000);
  assert.equal(r.first_call_prompt_tokens, 120005);
});

test('classification is by kind and anchored name: a deferred row never counts as live', () => {
  recordTurnComposition(A, measured('split-kind', {
    sdkCategories: [
      { name: 'System tools', kind: 'deferred', isDeferred: true, tokens: 7000 },
      { name: 'System tools (deferred)', kind: 'used', tokens: 8000 },
      { name: 'MCP tools', kind: 'used', isDeferred: true, tokens: 9000 },
    ],
  }));
  const r = agentReadDb().prepare('SELECT * FROM turn_composition WHERE turn_id = ?').get('split-kind');
  assert.equal(r.sdk_system_tools_tokens, null, 'neither row is a live "System tools"');
  assert.equal(r.sdk_mcp_tools_tokens, null, 'isDeferred excludes it from the live sum');
  assert.equal(r.sdk_deferred_tools_tokens, 16000, 'deferred = kind deferred OR isDeferred, tool rows only (7000 + 9000)');
});

test('unmeasured parts stay NULL, not zero', () => {
  assert.equal(recordTurnComposition(A, { turnId: 'split-bare', mode: 'ask', systemChars: 40 }), true);
  const r = agentReadDb().prepare('SELECT * FROM turn_composition WHERE turn_id = ?').get('split-bare');
  assert.equal(r.system_prompt_tokens, 10);
  assert.equal(r.llmide_tool_tokens, null);
  assert.equal(r.tool_result_chars, null);
  assert.equal(r.sdk_messages_tokens, null);
  assert.equal(r.sdk_categories, null);
});

test('reads are user-scoped, newest first, limit clamped', () => {
  recordTurnComposition(B, measured('split-b1'));
  recordTurnComposition(A, measured('split-a2'));
  const mine = turnCompositionRecent(A, { limit: 50 });
  assert.ok(mine.length >= 2);
  assert.ok(mine.every((t) => t.turnId !== 'split-b1'), 'B\'s turn is never returned to A');
  assert.equal(mine[0].turnId, 'split-a2', 'newest first');
  assert.equal(mine[0].sdkMessagesTokens, 100000, 'keys are camelCase');
  assert.equal('userId' in mine[0] || 'user_id' in mine[0], false, 'the owner column is not echoed');
  assert.equal(turnCompositionRecent(A, { limit: 1 }).length, 1);
  assert.equal(turnCompositionRecent(A, { limit: 100000 }).length <= 200, true, 'limit capped');
  assert.equal(turnCompositionRecent(A, { limit: 'nonsense' }).length > 0, true, 'bad limit falls back to default');
});

test('GET /kb/usage/turn-composition returns only the caller\'s turns', async () => {
  const res = { statusCode: 200, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); },
    setHeader(k, v) { this.headers[k] = v; }, write(c) { this.body += c; }, end(c) { if (c) this.body += c; } };
  const req = { method: 'GET', url: '/kb/usage/turn-composition?limit=5', user: { id: B }, on(e, cb) { if (e === 'end') cb(); return req; } };
  assert.equal(await handleKB(req, res), true);
  assert.equal(res.statusCode, 200);
  const turns = JSON.parse(res.body).turns;
  assert.ok(turns.length >= 1 && turns.length <= 5);
  assert.ok(turns.every((t) => t.turnId === 'split-b1'), 'only B\'s own rows');
});

test('a v2 turn records real measured parts: fence, skills, llmide schemas, SDK categories', async () => {
  const gen = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-split', tools: ['Read', 'mcp__llmide__search-kb'], capabilities: [] };
    yield { type: 'assistant', session_id: 'sdk-split', message: { id: 'msg_s', content: [],
      usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 } } };
    yield { type: 'result', subtype: 'success', session_id: 'sdk-split' };
  })();
  gen.getContextUsage = async () => ({ totalTokens: 4321, rawMaxTokens: 200000, percentage: 2, categories: SDK_CATEGORIES });
  const { composition } = await runAgentV2Turn({
    message: 'hello', userId: A, mode: 'execute', agentContext: { workspaceRoot: process.cwd() },
    attachments: [{ path: 'notes.txt', content: 'y'.repeat(300) }],
    allowAmbientAuth: true, onEvent: () => {}, queryFactory: () => gen,
  }, { readSkill: () => null, roots: () => [process.cwd()], sessionMemory: () => [], persistMemory: async () => null });
  for (const k of ['skillsAppendChars', 'memoryChars', 'skillsFenceChars', 'contextChars', 'userMcpServers']) {
    assert.ok(Number.isInteger(composition[k]) && composition[k] >= 0, `${k} is a count of chars`);
  }
  assert.ok(composition.contextChars >= 300, 'the attachment body is inside the fenced context');
  assert.ok(composition.llmideToolChars > 0, 'llmide tool definitions are sized');
  assert.equal(composition.userMcpServers, 0);
  assert.equal(composition.sdkContextTotalTokens, 4321);
  assert.deepEqual(composition.sdkCategories, SDK_CATEGORIES);
});

test('v2ToolDefinitionChars: sized per turn, and a gateway turn mounts at least as many', () => {
  const direct = v2ToolDefinitionChars({ mode: 'execute' });
  assert.ok(direct > 0);
  assert.ok(v2ToolDefinitionChars({ mode: 'execute', gateway: true }) >= direct);
});
