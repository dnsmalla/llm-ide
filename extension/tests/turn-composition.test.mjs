import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_turn-composition-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { recordTurnComposition } = await import('../kb/turn-composition.mjs');
const U = users.registerUser(db.getDb(), { email: 'tc@example.test', password: 'CorrectHorseBattery', displayName: 't' }).id;

const row = {
  turnId: 't1', mode: 'ask', model: 'claude-sonnet-5-5', resumed: false, systemPromptKind: 'preset',
  systemChars: 2573, promptChars: 1172, attachedFiles: 1, attachmentChars: 900, images: 0,
  tools: 17, mcpTools: 11, mcpServers: ['llmide'], agents: 6, skills: 22, slashCommands: 57,
  claudeCodeVersion: '2.1.288', apiCalls: 1,
  firstCall: { inputTokens: 2, cacheCreationTokens: 19566, cacheReadTokens: 0 },
};

test('a turn composition row is stored with sizes and counts, keyed by turn id', () => {
  assert.equal(recordTurnComposition(U, row), true);
  const r = db.getDb().prepare('SELECT * FROM turn_composition WHERE user_id = ? AND turn_id = ?').get(U, 't1');
  assert.equal(r.mode, 'ask');
  assert.equal(r.system_prompt_kind, 'preset');
  assert.equal(r.system_chars, 2573);
  assert.equal(r.prompt_chars, 1172);
  assert.equal(r.attachment_chars, 900);
  assert.equal(r.mcp_tools, 11);
  assert.equal(r.mcp_servers, 'llmide');
  assert.equal(r.skills, 22);
  assert.equal(r.resumed, 0);
  assert.equal(r.first_call_prompt_tokens, 19568, 'input + cache write + cache read of the FIRST API call');
  assert.equal(r.first_call_cache_creation_tokens, 19566);
  assert.equal(r.first_call_cache_read_tokens, 0);
});

test('best-effort: bad input or no user records nothing and never throws', () => {
  assert.equal(recordTurnComposition(U, { ...row, turnId: '' }), false);
  assert.equal(recordTurnComposition(null, row), false);
  assert.equal(recordTurnComposition(U, null), false);
});

test('names are clamped, never text: mcp server names joined and capped', () => {
  recordTurnComposition(U, { ...row, turnId: 't2', mcpServers: Array.from({ length: 50 }, (_, i) => `s${i}`) });
  const r = db.getDb().prepare('SELECT mcp_servers FROM turn_composition WHERE turn_id = ?').get('t2');
  assert.ok(r.mcp_servers.length <= 512);
});
