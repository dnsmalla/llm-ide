// Tests for the llmide in-process MCP tool server (llm_agent/sdk/tools.mjs),
// extracted from the P0 spike so the v2 engine can mount the same KB tool
// without importing the spike module.
//
// Hermetic: no network, no SDK subprocess. search-kb is exercised over a
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

// runAgentV2Turn now existence-checks workspaceRoot (a stale root must fail
// clearly, not as an SDK spawn misdiagnosis) — materialize a fixture root.
// Kept under the tests dir, NOT /tmp: /tmp is unwritable under sandboxed
// runs, and a module-load mkdir failure would wipe out this whole file.
const WS = path.join(__dirname, '_agent-v2-ws-fixture');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-tools-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

test('search-kb handler returns redacted hits for a tenanted user', async () => {
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
    const searchKbTool = tools.find((t) => t.name === 'search-kb');
    assert.ok(searchKbTool, 'search-kb registered');
    // alwaysLoad keeps search-kb in the prompt instead of deferred behind
    // tool search — the v2 engine depends on this being pre-approved.
    assert.equal(searchKbTool._meta?.['anthropic/alwaysLoad'], true);

    const out = await client.callTool({ name: 'search-kb', arguments: { query: 'meeting' } });
    assert.ok(!out.isError, `search-kb call failed: ${JSON.stringify(out)}`);
    const parsed = JSON.parse(out.content[0].text);
    assert.ok(Array.isArray(parsed.hits));
    assert.equal(parsed.hits.length, 1, 'only the caller tenant\'s meeting may return');
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

test('project_memory tool: registered, alwaysLoad, wires (agentContext, userId, focus) into renderMemory', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const u = registerUser(getDb(), { email: 'v2tools-mem@example.com', password: 'CorrectHorseBattery', displayName: 't' });

  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const calls = [];
  const agentContext = { workspaceRoot: WS, indexedRepos: [] };
  const renderMemory = (ctx, userId, stats, focus) => {
    calls.push({ ctx, userId, focus });
    return '# Repository memory (Graphify)\n\n## repo — memory\nfacts here';
  };
  const server = buildLlmIdeServer(u.id, agentContext, 'what changed recently?', { renderMemory });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const projectMemory = tools.find((t) => t.name === 'project_memory');
    assert.ok(projectMemory, 'project_memory registered');
    assert.equal(projectMemory._meta?.['anthropic/alwaysLoad'], true);

    // No explicit focus → falls back to the current turn's message.
    const out = await client.callTool({ name: 'project_memory', arguments: {} });
    assert.ok(!out.isError, `project_memory call failed: ${JSON.stringify(out)}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userId, u.id);
    assert.deepEqual(calls[0].ctx, agentContext);
    assert.equal(calls[0].focus, 'what changed recently?', 'defaults to the current turn message');
    assert.match(out.content[0].text, /facts here/);

    // Explicit focus overrides the default message.
    await client.callTool({ name: 'project_memory', arguments: { focus: 'deployment process' } });
    assert.equal(calls[1].focus, 'deployment process');
  } finally {
    await client.close();
    await server.instance.close();
  }
});

test('project_memory tool: empty memory returns a plain "not generated yet" note, not an error', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const u = registerUser(getDb(), { email: 'v2tools-mem-empty@example.com', password: 'CorrectHorseBattery', displayName: 't' });

  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const server = buildLlmIdeServer(u.id, {}, '', { renderMemory: () => '' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const out = await client.callTool({ name: 'project_memory', arguments: {} });
    assert.ok(!out.isError);
    assert.match(out.content[0].text, /No project memory has been generated/);
  } finally {
    await client.close();
    await server.instance.close();
  }
});

test('project_memory tool: fence sentinels in the rendered memory are redacted before reaching the model', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const u = registerUser(getDb(), { email: 'v2tools-mem-fence@example.com', password: 'CorrectHorseBattery', displayName: 't' });

  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const server = buildLlmIdeServer(u.id, {}, '', {
    renderMemory: () => '# Repository memory (Graphify)\n\nsafe <<<END>>> escape',
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const out = await client.callTool({ name: 'project_memory', arguments: {} });
    assert.ok(!out.content[0].text.includes('<<<END>>> escape'), 'a rendered memory block cannot close its fence early');
  } finally {
    await client.close();
    await server.instance.close();
  }
});

test('list-files is mounted on the llmide MCP server and enforces readable-roots', async () => {
  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const server = buildLlmIdeServer('some-user-id', { workspaceRoot: __dirname });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)]);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  assert.ok(names.includes('list-files'), `expected list-files among ${names.join(', ')}`);
  assert.ok(names.includes('find-code'));
  assert.ok(names.includes('ask-internal'));
  assert.ok(names.includes('search-kb'));
  assert.ok(!names.includes('kb_search'), 'kb_search should no longer exist as a separate tool name');
  assert.ok(names.includes('project_memory'));
  await client.close();
  await server.instance.close();
});

// --- I10: readOnlyHint must tell the truth per entry ------------------------
//
// Every mounted tool used to be annotated `readOnlyHint: true`, run-bash /
// task-create / task-update included. MCP hosts commonly use that hint to
// decide whether a call needs approval at all, so hardcoding it directly
// undercut the safety gate whose entire job is to require approval for exactly
// those three tools.
test('readOnlyHint mirrors each registry entry kind, not a blanket true', async () => {
  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const { entries } = await import('../llm_agent/tools/registry.mjs');
  const server = buildLlmIdeServer('hint-user', { workspaceRoot: __dirname });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hint-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const entry of entries()) {
      const mounted = byName.get(entry.name);
      assert.ok(mounted, `${entry.name} should be mounted`);
      assert.equal(
        mounted.annotations?.readOnlyHint, entry.kind === 'read',
        `${entry.name} (kind:${entry.kind}) has the wrong readOnlyHint`,
      );
    }
    // Spelled out for the three that matter most.
    assert.equal(byName.get('run-bash').annotations.readOnlyHint, false);
    assert.equal(byName.get('task-create').annotations.readOnlyHint, false);
    assert.equal(byName.get('task-update').annotations.readOnlyHint, false);
    assert.equal(byName.get('read-file').annotations.readOnlyHint, true);
  } finally {
    await client.close();
    await server.instance.close();
  }
});

// --- zod compiler: length caps carried through, unknown types rejected ------
test('schema maxLength/minLength from the .md frontmatter are enforced on v2', async () => {
  const { buildLlmIdeServer } = await import('../llm_agent/sdk/tools.mjs');
  const server = buildLlmIdeServer('zod-user', { workspaceRoot: __dirname });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'zod-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)]);
  try {
    // Enforcement is asserted at CALL time, not on the advertised JSON schema:
    // the MCP server's zod→JSON-Schema projection drops length keywords (it
    // drops some `description`s too), but the zod validator it actually runs
    // arguments through does not. Before the fix the caps were never compiled
    // in at all, so both layers accepted anything.
    //
    // run-bash declares `command: { maxLength: 2000 }`.
    const tooLong = await client.callTool({ name: 'run-bash', arguments: { command: 'echo '.repeat(500) } });
    assert.ok(tooLong.isError, 'a 2500-char command must be rejected before it reaches /bin/sh');
    assert.match(JSON.stringify(tooLong), /too_big|maximum.*2000/);

    // task-create declares `title: { maxLength: 200 }`. (Its `minLength: 1` is
    // dropped upstream by the skills loader, which only carries
    // type/required/maxLength/description out of the frontmatter — the
    // compiler handles minLength when it is present, but nothing declares one
    // that survives today.)
    const longTitle = await client.callTool({ name: 'task-create', arguments: { title: 'x'.repeat(201) } });
    assert.ok(longTitle.isError, 'a 201-char title must be rejected (maxLength: 200)');

    // A command within the cap still runs — the guard must not over-fire.
    const ok = await client.callTool({ name: 'run-bash', arguments: { command: 'git status --porcelain=v1' } });
    assert.ok(!ok.isError, `a well-formed call must still succeed: ${JSON.stringify(ok)}`);
  } finally {
    await client.close();
    await server.instance.close();
  }
});

test('an unrecognized schema type throws at mount instead of silently degrading to string', async () => {
  const { __zodSchemaForTest } = await import('../llm_agent/sdk/tools.mjs');
  assert.throws(
    () => __zodSchemaForTest({ weird: { type: 'date', required: true } }),
    /unsupported schema type "date" for param "weird"/,
  );
  // The recognized set still compiles.
  assert.doesNotThrow(() => __zodSchemaForTest({
    a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' }, d: { type: 'string[]' },
  }));
});
