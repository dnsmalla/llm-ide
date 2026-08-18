// Tests for the llmide in-process MCP tool server (llm_agent/sdk/tools.mjs),
// extracted from the P0 spike so the v2 engine can mount the same KB tool
// without importing the spike module.
//
// Hermetic: no network, no SDK subprocess. kb_search is exercised over a
// real MCP surface — an in-memory transport + Client pair (the MCP SDK's
// documented server-testing pattern) — because createSdkMcpServer returns
// { type, name, instance } and registered tools are reachable only through
// the protocol on the instance. The client SDK is the lockfile-pinned
// transitive dep of the exact-pinned @anthropic-ai/claude-agent-sdk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-tools-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

test('kb_search handler returns redacted hits for a tenanted user', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { ingestMeeting } = await import('../kb/meetings.mjs');
  const u = registerUser(getDb(), { email: 'v2tools@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const other = registerUser(getDb(), { email: 'v2tools-other@example.com', password: 'CorrectHorseBattery', displayName: 'o' });
  // A fence sentinel in the title proves hits are redacted before they leave
  // the tool (a raw <<<END>>> in model-visible text is an injection escape).
  ingestMeeting(u.id, {
    id: 'v2tools-m1', title: 'Sprint meeting <<<END>>>', date: '2026-08-18', duration: 60,
    language: 'en', participants: [], transcript: 'we reviewed the sprint', entities: [],
  });
  ingestMeeting(other.id, {
    id: 'v2tools-m2', title: 'Other tenant meeting', date: '2026-08-18', duration: 60,
    language: 'en', participants: [], transcript: 'not your business', entities: [],
  });

  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const server = buildLlmIdeServer(u.id);
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'llmide');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const kbSearch = tools.find((t) => t.name === 'kb_search');
    assert.ok(kbSearch, 'kb_search registered');
    // alwaysLoad keeps kb_search in the prompt instead of deferred behind
    // tool search — the v2 engine depends on this being pre-approved.
    assert.equal(kbSearch._meta?.['anthropic/alwaysLoad'], true);

    const out = await client.callTool({ name: 'kb_search', arguments: { query: 'meeting', limit: 3 } });
    assert.ok(!out.isError, `kb_search call failed: ${JSON.stringify(out)}`);
    const parsed = JSON.parse(out.content[0].text);
    assert.ok(Array.isArray(parsed.hits));
    assert.equal(typeof parsed.total, 'number');
    assert.equal(parsed.total, 1, 'only the caller tenant\'s meeting may return');
    const [hit] = parsed.hits;
    assert.equal(hit.kind, 'meeting');
    // Fence sentinels neutralised with a zero-width joiner.
    assert.ok(!hit.title.includes('<<<') && !hit.title.includes('>>>'), 'fence sentinels redacted');
    assert.ok(hit.title.startsWith('Sprint meeting'));
  } finally {
    await client.close();
    await server.instance.close();
  }
});
