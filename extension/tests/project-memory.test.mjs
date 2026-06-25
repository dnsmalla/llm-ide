// Auto project-memory: the write/extract/persist half of the Graphify-memory
// loop plus the chat-input "/" command catalog. Covers:
//   - memory-writer: parse / render (dedup + caps) / append / overwrite
//   - memory-extract: fact sanitising + extraction over a stubbed runClaude
//   - memory.mjs reader: chat-memory.md is recalled, and the shared allow-list
//     gate (resolveAllowedRepoRoot) rejects traversal / relative / non-listed
//   - persistTurnMemory: end-to-end capture into an allow-listed repo
//   - HTTP: /kb/agent/commands shape + /kb/agent/project-memory gate & delete

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_project-memory-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const writer  = await import('../graphkit/memory-writer.mjs');
const extract = await import('../llm_agent/runtime/memory-extract.mjs');
const memory  = await import('../graphkit/memory.mjs');
const persist = await import('../llm_agent/runtime/memory-persist.mjs');
const db      = await import('../kb/db.mjs');
const users   = await import('../server/users.mjs');
const { handleAgentRoutes } = await import('../kb/routes/agent.mjs');

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}
function provision(email = 'pm@example.test') {
  return users.registerUser(db.getDb(), {
    email, password: 'CorrectHorseBattery', displayName: 'pm',
  }).id;
}
// Make a throwaway repo dir with a graphify-out/memory tree and allow-list it.
function tmpRepo(userId, tag) {
  const root = path.join(__dirname, `_pm-repo-${tag}-${process.pid}`);
  fs.mkdirSync(path.join(root, 'graphify-out', 'memory'), { recursive: true });
  db.addUserRepo(userId, root);
  return root;
}

// ── memory-writer (pure) ─────────────────────────────────────────────
test('parseChatMemoryFacts extracts bullet lines and dedups', () => {
  const facts = writer.parseChatMemoryFacts('# x\n- One\n- Two\nnot a bullet\n-   One  \n');
  assert.deepEqual(facts, ['One', 'Two']);
});

test('renderChatMemoryFile dedups and caps to newest', () => {
  const many = Array.from({ length: 130 }, (_, i) => `fact ${i}`);
  const out = writer.renderChatMemoryFile([...many, 'fact 0']); // dup of oldest
  const lines = writer.parseChatMemoryFacts(out);
  assert.equal(lines.length, 100);                  // capped at MAX_FACTS
  assert.ok(lines.includes('fact 129'));            // newest kept
  assert.ok(!lines.includes('fact 0'));             // oldest dropped
});

test('renderChatMemoryFile yields empty string for no facts', () => {
  assert.equal(writer.renderChatMemoryFile([]), '');
  assert.equal(writer.renderChatMemoryFile(['   ']), '');
});

test('appendChatMemory merges only genuinely-new facts, write/read round-trips', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'append');
  assert.deepEqual(writer.readChatMemoryFacts(root), []);
  writer.appendChatMemory({ root, facts: ['Uses pnpm', 'Deploys via CI'] });
  writer.appendChatMemory({ root, facts: ['uses PNPM', 'New thing'] }); // 1 dup (case/space)
  const facts = writer.readChatMemoryFacts(root);
  assert.deepEqual(facts, ['Uses pnpm', 'Deploys via CI', 'New thing']);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── memory-extract ───────────────────────────────────────────────────
test('sanitizeFacts filters non-strings, junk, dups, and caps at 5', () => {
  const out = extract.sanitizeFacts(
    ['Good fact one', 42, '  ', 'xy', 'Good fact one', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Theta'],
  );
  // 42 (non-string), '  ' & 'xy' (<4 chars), and the dup are dropped; capped at 5.
  assert.deepEqual(out, ['Good fact one', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
});

test('sanitizeFacts on non-array → []', () => {
  assert.deepEqual(extract.sanitizeFacts(null), []);
  assert.deepEqual(extract.sanitizeFacts('nope'), []);
});

test('extractMemories parses a JSON array from the model', async () => {
  const runClaude = async () => '["Project uses Swift 6", "Tests run via npm test"]';
  const out = await extract.extractMemories({ userMessage: 'q', reply: 'a', existingFacts: [], runClaude, userId: 'u' });
  assert.deepEqual(out, ['Project uses Swift 6', 'Tests run via npm test']);
});

test('extractMemories tolerates fenced JSON and ignores prose around it', async () => {
  const runClaude = async () => 'Sure!\n```json\n["Only durable fact"]\n```\nDone.';
  const out = await extract.extractMemories({ userMessage: 'q', reply: 'a', existingFacts: [], runClaude, userId: 'u' });
  assert.deepEqual(out, ['Only durable fact']);
});

test('extractMemories returns [] on garbage, throw, or empty reply', async () => {
  assert.deepEqual(await extract.extractMemories({ reply: 'a', runClaude: async () => 'not json at all' }), []);
  assert.deepEqual(await extract.extractMemories({ reply: 'a', runClaude: async () => { throw new Error('boom'); } }), []);
  assert.deepEqual(await extract.extractMemories({ reply: '', runClaude: async () => '["x"]' }), []);
  assert.deepEqual(await extract.extractMemories({ reply: 'a', runClaude: 'not a fn' }), []);
});

// ── reader: chat-memory.md recall + gate ─────────────────────────────
test('renderGraphifyMemory inlines chat-memory.md for an allow-listed repo', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'reader');
  fs.writeFileSync(path.join(root, 'graphify-out', 'memory', 'chat-memory.md'),
    '# Chat memory\n- The build runs offline via build.sh\n');
  const out = memory.renderGraphifyMemory({ indexedRepos: [{ path: root, name: 'r' }] }, u);
  assert.match(out, /chat-memory\.md/);
  assert.match(out, /build runs offline/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveAllowedRepoRoot gate: accepts allow-listed, rejects traversal/relative/unlisted', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'gate');
  const allowed = memory.buildAllowedRoots(u);
  assert.equal(memory.resolveAllowedRepoRoot(root, allowed), root);              // allow-listed
  assert.equal(memory.resolveAllowedRepoRoot(`${root}/../evil`, allowed), null); // .. segment
  assert.equal(memory.resolveAllowedRepoRoot('relative/path', allowed), null);   // not absolute
  assert.equal(memory.resolveAllowedRepoRoot('/tmp/not-listed', allowed), null); // not in allow-list
  fs.rmSync(root, { recursive: true, force: true });
});

// ── persistTurnMemory (end-to-end) ───────────────────────────────────
test('persistTurnMemory writes extracted facts into the allow-listed repo', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'persist');
  const runClaude = async () => '["The API client lives in LlmIdeAPIClient.swift"]';
  const result = await persist.persistTurnMemory({
    agentContext: { indexedRepos: [{ path: root, name: 'r' }] },
    userId: u, userMessage: 'where is the api client', reply: 'It is in ...', runClaude,
  });
  assert.deepEqual(result, ['The API client lives in LlmIdeAPIClient.swift']);
  assert.deepEqual(writer.readChatMemoryFacts(root), result);
  fs.rmSync(root, { recursive: true, force: true });
});

test('persistTurnMemory is a no-op without repos or for an unlisted repo', async () => {
  reset();
  const u = provision();
  const runClaude = async () => '["x"]';
  assert.equal(await persist.persistTurnMemory({ agentContext: {}, userId: u, reply: 'a', runClaude }), null);
  assert.equal(await persist.persistTurnMemory({
    agentContext: { indexedRepos: [{ path: '/tmp/never-listed', name: 'r' }] },
    userId: u, reply: 'a', runClaude,
  }), null);
});

// ── HTTP endpoints ───────────────────────────────────────────────────
function mkRes() {
  return {
    statusCode: 0, body: null, headersSent: false, headers: {},
    writeHead(code, h) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, h || {}); },
    end(s) { this.body = s ? JSON.parse(s) : null; },
  };
}
function mkReq(method, url, bodyObj) {
  const r = new Readable({ read() {} });
  r.method = method; r.url = url;
  if (bodyObj !== undefined) r.push(Buffer.from(JSON.stringify(bodyObj)));
  r.push(null);
  return r;
}

test('GET /kb/agent/commands returns a sorted command list shape', async () => {
  reset();
  const u = provision();
  const res = mkRes();
  const handled = await handleAgentRoutes(mkReq('GET', '/kb/agent/commands'), res, { userId: u, url: '/kb/agent/commands' });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.commands)); // shape (likely empty with no plugins enabled)
});

test('GET /kb/agent/project-memory is gated and returns facts for an allow-listed repo', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'http-get');
  writer.appendChatMemory({ root, facts: ['Endpoint-visible fact'] });
  // allow-listed → facts
  const okUrl = `/kb/agent/project-memory?repo=${encodeURIComponent(root)}`;
  let res = mkRes();
  await handleAgentRoutes(mkReq('GET', okUrl), res, { userId: u, url: okUrl });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.facts, ['Endpoint-visible fact']);
  // not allow-listed → empty, never reads disk
  const badUrl = `/kb/agent/project-memory?repo=${encodeURIComponent('/tmp/elsewhere')}`;
  res = mkRes();
  await handleAgentRoutes(mkReq('GET', badUrl), res, { userId: u, url: badUrl });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { facts: [], repo: null });
  fs.rmSync(root, { recursive: true, force: true });
});

test('DELETE /kb/agent/project-memory removes one fact and clears all', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'http-del');
  writer.appendChatMemory({ root, facts: ['keep me', 'remove me'] });
  let res = mkRes();
  await handleAgentRoutes(
    mkReq('DELETE', '/kb/agent/project-memory', { repo: root, fact: 'remove me' }),
    res, { userId: u, url: '/kb/agent/project-memory' },
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.facts, ['keep me']);
  // clear all
  res = mkRes();
  await handleAgentRoutes(
    mkReq('DELETE', '/kb/agent/project-memory', { repo: root, all: true }),
    res, { userId: u, url: '/kb/agent/project-memory' },
  );
  assert.deepEqual(res.body.facts, []);
  // unlisted repo → 404
  res = mkRes();
  await handleAgentRoutes(
    mkReq('DELETE', '/kb/agent/project-memory', { repo: '/tmp/nope', fact: 'x' }),
    res, { userId: u, url: '/kb/agent/project-memory' },
  );
  assert.equal(res.statusCode, 404);
  fs.rmSync(root, { recursive: true, force: true });
});
