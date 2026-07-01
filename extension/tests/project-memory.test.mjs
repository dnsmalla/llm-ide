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
import { spawnSync } from 'node:child_process';

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

test('chat-memory.md is read past the old 4 KB reader cap (facts beyond 4 KB still reach the agent)', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'reader-cap');
  // The writer caps chat-memory.md at 8 KB; the reader used to clip at 4 KB, so
  // any fact past ~4 KB never reached the agent. Put a marker fact well past
  // 4 KB and assert it now survives into the injected block.
  const filler = Array.from({ length: 90 },
    (_, i) => `- filler fact ${i} about assorted project conventions and setup steps`).join('\n');
  const marker = '- LATE_FACT_MARKER deploys go through scripts/release.sh';
  const body = `# Chat memory\n${filler}\n${marker}\n`;
  assert.ok(body.length > 4000, 'fixture must exceed the old 4 KB reader cap');
  assert.ok(body.length <= 8000, 'fixture must stay within the 8 KB write cap');
  fs.writeFileSync(path.join(root, 'graphify-out', 'memory', 'chat-memory.md'), body);
  const out = memory.renderGraphifyMemory({ indexedRepos: [{ path: root, name: 'r' }] }, u);
  assert.match(out, /LATE_FACT_MARKER/, 'a fact past 4 KB must now be injected');
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderGraphifyMemory reports per-file injection stats into an optional sink', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'stats');
  const memDir = path.join(root, 'graphify-out', 'memory');
  fs.writeFileSync(path.join(memDir, 'repo.md'), '# Repo\n- overview line');
  fs.writeFileSync(path.join(memDir, 'chat-memory.md'), '# Chat memory\n- a durable fact');
  const stats = [];
  const out = memory.renderGraphifyMemory({ indexedRepos: [{ path: root, name: 'r' }] }, u, stats);
  assert.ok(out, 'block still renders');
  const files = stats.map((s) => s.file);
  assert.ok(files.includes('repo.md') && files.includes('chat-memory.md'), 'lists injected files');
  for (const s of stats) {
    assert.equal(typeof s.chars, 'number');
    assert.equal(typeof s.truncated, 'boolean');
    assert.equal(s.repo, 'r');
  }
  assert.ok(stats.every((s) => s.truncated === false), 'small files are not truncated');
  fs.rmSync(root, { recursive: true, force: true });
});

test('appendChatMemory reports evicted count when the fact store hits its cap', async () => {
  const { appendChatMemory, readChatMemoryFacts } = await import('../graphkit/index.mjs');
  const root = path.join(__dirname, `_pm-evict-${process.pid}`);
  fs.mkdirSync(path.join(root, 'graphify-out', 'memory'), { recursive: true });
  // Fill to the 100-fact cap.
  appendChatMemory({ root, facts: Array.from({ length: 100 }, (_, i) => `fact ${i} distinct convention`) });
  assert.equal(readChatMemoryFacts(root).length, 100);
  // Add 3 genuinely new facts → the 3 oldest are evicted to stay at the cap.
  const meta = {};
  const saved = appendChatMemory({ root, facts: ['brand new alpha', 'brand new beta', 'brand new gamma'], meta });
  assert.equal(saved.length, 100, 'stays at the 100-fact cap');
  assert.equal(meta.evicted, 3, 'reports the 3 evicted facts');
  assert.equal(meta.added, 0, 'net size unchanged (added == evicted at the cap)');
  fs.rmSync(root, { recursive: true, force: true });
});

test('config.memory exposes tunable budgets with sane defaults', async () => {
  const { config } = await import('../core/config.mjs');
  const m = config.memory;
  assert.equal(m.perFileChars, 4000);
  assert.equal(m.totalChars, 16000);
  assert.equal(m.maxRepos, 2);
  assert.equal(m.chatFileChars, 8000, 'shared reader+writer chat-memory cap');
  assert.equal(m.maxFacts, 100);
});

test('config.memory clamps out-of-range env values instead of silently disabling the feature', () => {
  // config.mjs reads process.env once at import time, so an invalid value
  // set in *this* process can't be observed by re-importing — spawn a fresh
  // process per case instead.
  const readMemoryConfig = (env) => {
    const r = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import { config } from './core/config.mjs'; console.log(JSON.stringify(config.memory));",
    ], {
      cwd: __dirname + '/..',
      env: {
        ...process.env,
        LLMIDE_JWT_SECRET: 'a'.repeat(48),
        LLMIDE_VAULT_KEY: 'b'.repeat(48),
        NODE_ENV: 'test',
        ...env,
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };

  // A zero/negative budget would previously silently disable memory
  // injection entirely rather than erroring or falling back — now it's
  // clamped to the documented floor.
  assert.equal(readMemoryConfig({ LLMIDE_MEM_TOTAL_CHARS: '0' }).totalChars, 500);
  assert.equal(readMemoryConfig({ LLMIDE_MEM_MAX_REPOS: '-3' }).maxRepos, 1);
  assert.equal(readMemoryConfig({ LLMIDE_MEM_MAX_FACTS: '0' }).maxFacts, 1);
  // An absurdly large value is capped rather than letting an operator inflate
  // per-turn prompt cost unbounded.
  assert.equal(readMemoryConfig({ LLMIDE_MEM_TOTAL_CHARS: '999999999' }).totalChars, 200_000);
  // Non-numeric input falls back to the documented default, same as envInt.
  assert.equal(readMemoryConfig({ LLMIDE_MEM_MAX_FACTS: 'not-a-number' }).maxFacts, 100);
});

test('extractMemories reports approx extraction token cost via meta', async () => {
  const { extractMemories } = await import('../llm_agent/runtime/memory-extract.mjs');
  const fakeRun = async () => JSON.stringify(['the build runs offline via build.sh']);
  const meta = {};
  const facts = await extractMemories({
    userMessage: 'how does the build work?',
    reply: 'It runs offline via build.sh with no network access.',
    existingFacts: [],
    runClaude: fakeRun,
    userId: 'u',
    meta,
  });
  assert.ok(Array.isArray(facts) && facts.length >= 1);
  assert.equal(typeof meta.approxTokens, 'number');
  assert.ok(meta.approxTokens > 0, 'reports a positive token estimate');
});

test('isWorthExtracting skips pure acknowledgments / contentless turns', async () => {
  const { isWorthExtracting } = await import('../llm_agent/runtime/memory-extract.mjs');
  // Pure acks / pleasantries — no durable fact possible, must skip.
  assert.equal(isWorthExtracting({ userMessage: 'thanks', reply: "You're welcome!" }), false);
  assert.equal(isWorthExtracting({ userMessage: 'ok great, that works!', reply: 'Glad it works.' }), false);
  assert.equal(isWorthExtracting({ userMessage: 'perfect thank you', reply: 'Anytime.' }), false);
  assert.equal(isWorthExtracting({ userMessage: '  OK  ', reply: 'done' }), false);
  // Empty / missing reply → nothing to extract from.
  assert.equal(isWorthExtracting({ userMessage: 'we use pnpm workspaces', reply: '' }), false);
});

test('isWorthExtracting keeps substantive turns (low false-negative)', async () => {
  const { isWorthExtracting } = await import('../llm_agent/runtime/memory-extract.mjs');
  // A short but substantive user statement carrying a durable fact must NOT be skipped.
  assert.equal(isWorthExtracting({ userMessage: 'we deploy via GitHub Actions to Fly.io', reply: 'Got it.' }), true);
  // Normal Q&A.
  assert.equal(isWorthExtracting({ userMessage: 'how does auth work here?', reply: 'It uses JWT access + refresh tokens signed with LLMIDE_JWT_SECRET.' }), true);
});

test('extractMemories short-circuits (no model call) on a contentless turn', async () => {
  const { extractMemories } = await import('../llm_agent/runtime/memory-extract.mjs');
  let called = false;
  const spyRun = async () => { called = true; return '[]'; };
  const facts = await extractMemories({
    userMessage: 'thanks!',
    reply: 'No problem.',
    existingFacts: [],
    runClaude: spyRun,
    userId: 'u',
  });
  assert.deepEqual(facts, []);
  assert.equal(called, false, 'the summarize-tier model must not be called on a pure-ack turn');
});

test('sanitizeFacts tags {category, fact} objects and keeps legacy strings', async () => {
  const { sanitizeFacts } = await import('../llm_agent/runtime/memory-extract.mjs');
  const out = sanitizeFacts([
    { category: 'tooling', fact: 'The build runs offline via build.sh' },
    'a legacy plain string fact',                                   // back-compat
    { category: 'nonsense', fact: 'unknown category becomes untagged' },
    { fact: 'object with no category field' },
  ]);
  assert.equal(out[0], '[tooling] The build runs offline via build.sh');
  assert.equal(out[1], 'a legacy plain string fact');
  assert.equal(out[2], 'unknown category becomes untagged');
  assert.equal(out[3], 'object with no category field');
});

test('sanitizeFacts dedups by fact text, ignoring category and case', async () => {
  const { sanitizeFacts } = await import('../llm_agent/runtime/memory-extract.mjs');
  const out = sanitizeFacts([
    { category: 'tooling', fact: 'deploy via release.sh' },
    { category: 'command', fact: 'Deploy via release.sh' },
  ]);
  assert.equal(out.length, 1);
});

test('writeChatMemoryFacts round-trips and leaves no temp file behind', async () => {
  const { writeChatMemoryFacts, readChatMemoryFacts } = await import('../graphkit/index.mjs');
  const root = path.join(__dirname, `_pm-atomic-${process.pid}`);
  const memDir = path.join(root, 'graphify-out', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  writeChatMemoryFacts(root, ['deploy via release.sh', 'uses pnpm workspaces']);
  // Content correct.
  const facts = readChatMemoryFacts(root);
  assert.ok(facts.includes('deploy via release.sh') && facts.includes('uses pnpm workspaces'));
  // The atomic writer must clean up after itself — no stray temp files may
  // remain in the memory dir, only chat-memory.md.
  const leftovers = fs.readdirSync(memDir).filter((f) => f !== 'chat-memory.md');
  assert.deepEqual(leftovers, [], `no temp/stray files should remain, found: ${leftovers.join(', ')}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeChatMemoryFacts creates the memory dir if missing', async () => {
  const { writeChatMemoryFacts, readChatMemoryFacts } = await import('../graphkit/index.mjs');
  const root = path.join(__dirname, `_pm-atomic-mkdir-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });   // root exists, memory subdir does NOT
  writeChatMemoryFacts(root, ['a durable fact worth keeping']);
  assert.deepEqual(readChatMemoryFacts(root), ['a durable fact worth keeping']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('appendChatMemory does not re-add an existing fact under a new category', async () => {
  const { appendChatMemory } = await import('../graphkit/index.mjs');
  const root = path.join(__dirname, `_pm-cat-${process.pid}`);
  fs.mkdirSync(path.join(root, 'graphify-out', 'memory'), { recursive: true });
  appendChatMemory({ root, facts: ['the API uses cursor pagination'] });   // untagged
  const meta = {};
  const saved = appendChatMemory({ root, facts: ['[architecture] the API uses cursor pagination'], meta });
  assert.equal(saved.length, 1, 'same fact tagged with a category is not duplicated');
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

// ── workspace-root path (open folder that isn't an indexed repo) ─────
test('buildAllowedRoots trusts a validated workspace root, rejects over-broad ones', () => {
  reset();
  const u = provision(); // user has NO indexed repos
  const ws = path.join(__dirname, `_pm-ws-${process.pid}`);
  fs.mkdirSync(path.join(ws, 'graphify-out', 'memory'), { recursive: true });
  // A real, deep, project-shaped folder is accepted…
  const ok = memory.buildAllowedRoots(u, ws);
  assert.equal(ok.size, 1);
  assert.ok(memory.resolveAllowedRepoRoot(ws, ok)); // resolvable
  // …but over-broad roots are refused (would mean "read most of the disk").
  assert.equal(memory.buildAllowedRoots(u, '/').size, 0);
  if (process.env.HOME) assert.equal(memory.buildAllowedRoots(u, process.env.HOME).size, 0);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('renderGraphifyMemory inlines chat-memory.md from the workspace root (no indexed repo)', () => {
  reset();
  const u = provision(); // no addUserRepo — the folder is NOT indexed
  const ws = path.join(__dirname, `_pm-ws2-${process.pid}`);
  fs.mkdirSync(path.join(ws, 'graphify-out', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'graphify-out', 'memory', 'chat-memory.md'),
    '# Chat memory\n- Uses the open-workspace memory path\n');
  // indexedRepos empty, but workspaceRoot is provided → still recalled.
  const out = memory.renderGraphifyMemory({ indexedRepos: [], workspaceRoot: ws }, u);
  assert.match(out, /open-workspace memory path/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('persistTurnMemory captures into the workspace root when no repo is indexed', async () => {
  reset();
  const u = provision();
  const ws = path.join(__dirname, `_pm-ws3-${process.pid}`);
  fs.mkdirSync(path.join(ws, 'graphify-out', 'memory'), { recursive: true });
  const runClaude = async () => '["Deploys via build.sh offline"]';
  const result = await persist.persistTurnMemory({
    agentContext: { indexedRepos: [], workspaceRoot: ws },
    userId: u, userMessage: 'q', reply: 'a', runClaude,
  });
  assert.ok(Array.isArray(result) && result.some((f) => /build\.sh/.test(f)));
  const onDisk = fs.readFileSync(path.join(ws, 'graphify-out', 'memory', 'chat-memory.md'), 'utf8');
  assert.match(onDisk, /build\.sh/);
  fs.rmSync(ws, { recursive: true, force: true });
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

test('GET project-memory resolves the FIRST allow-listed candidate (not blindly the first)', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'http-multi');           // allow-listed
  writer.appendChatMemory({ root, facts: ['Resolved from the allow-listed repo'] });
  // First candidate is NOT allow-listed; the second is — mirrors the agent's
  // write target so the viewer reads the same file (regression for the
  // viewer/backend mismatch).
  const multiUrl = `/kb/agent/project-memory?repo=${encodeURIComponent('/tmp/not-listed')}&repo=${encodeURIComponent(root)}`;
  const res = mkRes();
  await handleAgentRoutes(mkReq('GET', multiUrl), res, { userId: u, url: multiUrl });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.facts, ['Resolved from the allow-listed repo']);
  assert.equal(res.body.repo, root);
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
