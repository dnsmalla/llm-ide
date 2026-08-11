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
// Make a throwaway repo dir with a system/memory tree and allow-list it.
function tmpRepo(userId, tag) {
  const root = path.join(__dirname, `_pm-repo-${tag}-${process.pid}`);
  fs.mkdirSync(path.join(root, 'system', 'memory'), { recursive: true });
  db.addUserRepo(userId, root);
  return root;
}

// ── memory-writer (pure) ─────────────────────────────────────────────
test('parseChatMemoryFacts extracts bullet lines and dedups', () => {
  const facts = writer.parseChatMemoryFacts('# x\n- One\n- Two\nnot a bullet\n-   One  \n');
  assert.deepEqual(facts, ['One', 'Two']);
});

test('renderChatMemoryFile dedups and caps to newest', async () => {
  // Derived from config, not hard-coded: the cap is an operator-tunable budget
  // and a literal here just breaks whenever the default moves.
  const { config } = await import('../core/config.mjs');
  const cap = config.memory.maxFacts;
  const many = Array.from({ length: cap + 30 }, (_, i) => `fact ${i}`);
  const out = writer.renderChatMemoryFile([...many, 'fact 0']); // dup of oldest
  const lines = writer.parseChatMemoryFacts(out);
  assert.equal(lines.length, cap);                        // capped at MAX_FACTS
  assert.ok(lines.includes(`fact ${cap + 29}`));          // newest kept
  assert.ok(!lines.includes('fact 0'));                   // oldest dropped
});

test('renderChatMemoryFile yields empty string for no facts', () => {
  assert.equal(writer.renderChatMemoryFile([]), '');
  assert.equal(writer.renderChatMemoryFile(['   ']), '');
});

test('appendChatMemory upserts by factKey: same index updates IN PLACE, write/read round-trips', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'append');
  assert.deepEqual(writer.readChatMemoryFacts(root), []);
  writer.appendChatMemory({ root, facts: ['Uses pnpm', 'Deploys via CI'] });
  const meta = {};
  // 'uses PNPM' has the SAME factKey as 'Uses pnpm' (case/space normalised), so
  // it's an update of that entry — not a duplicate to discard, and not a second
  // row. It keeps position 0; only 'New thing' is appended.
  writer.appendChatMemory({ root, facts: ['uses PNPM', 'New thing'], meta });
  const facts = writer.readChatMemoryFacts(root);
  assert.deepEqual(facts, ['uses PNPM', 'Deploys via CI', 'New thing']);
  assert.equal(meta.added, 1, 'one genuinely new fact');
  assert.equal(meta.updated, 1, 'one existing index updated with new text');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a changed VALUE under the same subject id updates in place, not appends', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'upsert-order');
  writer.appendChatMemory({
    root,
    facts: ['[tooling|server-port] the server binds to port 3456', 'b', 'c'],
  });
  const meta = {};
  // Same subject id, NEW value. Without the id these two sentences have
  // different factKeys, so the store used to end up holding BOTH — the agent
  // then saw two contradictory ports with no way to tell which was current.
  writer.appendChatMemory({
    root,
    facts: ['[tooling|server-port] the server binds to port 4000'],
    meta,
  });
  const facts = writer.readChatMemoryFacts(root);
  assert.equal(facts.length, 3, 'no new row');
  assert.equal(facts[0], '[tooling|server-port] the server binds to port 4000',
               'updated in place, position preserved');
  assert.equal(meta.updated, 1);
  assert.equal(meta.added, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('factIndex prefers the subject id and falls back to full text', () => {
  assert.equal(writer.factIndex('[tooling|server-port] binds to 3456'), '#server-port');
  assert.equal(writer.factIndex('[tooling|server-port] binds to 4000'), '#server-port',
               'value change keeps the index');
  // No id → legacy full-text key, so pre-existing facts behave exactly as before.
  assert.equal(writer.factIndex('[tooling] uses pnpm'), writer.factKey('uses pnpm'));
  assert.equal(writer.factIndex('uses pnpm'), writer.factKey('the project uses pnpm'));
  // A subject id can never collide with a text key (`#` namespace).
  assert.notEqual(writer.factIndex('[x|abc] q'), writer.factIndex('abc'));
});

test('distinct subject ids stay distinct rows', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'upsert-distinct');
  writer.appendChatMemory({
    root,
    facts: ['[tooling|server-port] port 3456', '[tooling|test-command] npm test'],
  });
  assert.equal(writer.readChatMemoryFacts(root).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sanitizeFacts renders the subject id into the stored tag', async () => {
  const { sanitizeFacts } = await import('../llm_agent/runtime/memory-extract.mjs');
  assert.deepEqual(
    sanitizeFacts([{ category: 'tooling', key: 'Server Port', fact: 'binds to 3456' }]),
    ['[tooling|server-port] binds to 3456'],
  );
  // A key with tag-breaking characters is normalised, never stored raw.
  assert.deepEqual(
    sanitizeFacts([{ category: 'tooling', key: 'a|b]c', fact: 'something durable' }]),
    ['[tooling|a-b-c] something durable'],
  );
  // Missing category still yields a usable index.
  assert.deepEqual(
    sanitizeFacts([{ key: 'k', fact: 'something durable' }]),
    ['[|k] something durable'],
  );
});

test('sanitizeFacts collapses two facts sharing one subject id, last wins', async () => {
  const { sanitizeFacts } = await import('../llm_agent/runtime/memory-extract.mjs');
  const out = sanitizeFacts([
    { category: 'tooling', key: 'port', fact: 'binds to 3456' },
    { category: 'tooling', key: 'port', fact: 'binds to 4000' },
  ]);
  assert.deepEqual(out, ['[tooling|port] binds to 4000']);
});

test('appendChatMemory is a no-op when the incoming fact is byte-identical', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'upsert-noop');
  writer.appendChatMemory({ root, facts: ['exactly the same fact'] });
  const meta = {};
  writer.appendChatMemory({ root, facts: ['exactly the same fact'], meta });
  assert.deepEqual(writer.readChatMemoryFacts(root), ['exactly the same fact']);
  assert.equal(meta.added, 0);
  assert.equal(meta.updated, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('chat memory left in the legacy tree is read, then migrated forward on write', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'migrate');
  const legacyDir = path.join(root, 'graphify-out', 'memory');
  const legacyFile = path.join(legacyDir, 'chat-memory.md');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(legacyFile, '# Chat memory\n- Uses pnpm workspaces\n');

  // Read falls back to the old location so pre-move facts aren't lost.
  assert.deepEqual(writer.readChatMemoryFacts(root), ['Uses pnpm workspaces']);

  // The first write materialises everything at the canonical path...
  writer.appendChatMemory({ root, facts: ['Deploys via CI'] });
  const canonical = path.join(root, 'system', 'memory', 'chat-memory.md');
  assert.deepEqual(writer.readChatMemoryFacts(root), ['Uses pnpm workspaces', 'Deploys via CI']);
  assert.ok(fs.existsSync(canonical), 'facts now live at the canonical path');
  // ...and retires the old file, so exactly one copy exists afterwards.
  assert.ok(!fs.existsSync(legacyFile), 'legacy file is removed once carried forward');

  fs.rmSync(root, { recursive: true, force: true });
});

test('appendChatMemory removes superseded facts by factKey', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'supersede');
  writer.appendChatMemory({ root, facts: ['uses npm for installs', 'deploys via fly.io'] });
  const meta = {};
  const saved = writer.appendChatMemory({
    root,
    facts: ['uses pnpm for installs'],
    remove: ['the project uses npm for installs'], // paraphrase — factKey folds the lead-in
    meta,
  });
  assert.equal(meta.removed, 1);
  assert.ok(saved.some((f) => f.includes('pnpm')));
  assert.ok(!saved.some((f) => /uses npm for installs/.test(f)), 'superseded fact gone');
  assert.ok(saved.some((f) => f.includes('fly.io')), 'unrelated fact untouched');
});

test('appendChatMemory with only removals still persists the removal', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'supersede-only');
  writer.appendChatMemory({ root, facts: ['uses npm for installs'] });
  const meta = {};
  const saved = writer.appendChatMemory({ root, facts: [], remove: ['uses npm for installs'], meta });
  assert.equal(meta.removed, 1);
  assert.equal(saved.length, 0);
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
  assert.deepEqual(out.facts, ['Project uses Swift 6', 'Tests run via npm test']);
  assert.deepEqual(out.superseded, []);
});

test('extractMemories tolerates fenced JSON and ignores prose around it', async () => {
  const runClaude = async () => 'Sure!\n```json\n["Only durable fact"]\n```\nDone.';
  const out = await extract.extractMemories({ userMessage: 'q', reply: 'a', existingFacts: [], runClaude, userId: 'u' });
  assert.deepEqual(out.facts, ['Only durable fact']);
});

test('extractMemories returns [] on garbage, throw, or empty reply', async () => {
  assert.deepEqual((await extract.extractMemories({ reply: 'a', runClaude: async () => 'not json at all' })).facts, []);
  assert.deepEqual((await extract.extractMemories({ reply: 'a', runClaude: async () => { throw new Error('boom'); } })).facts, []);
  assert.deepEqual((await extract.extractMemories({ reply: '', runClaude: async () => '["x"]' })).facts, []);
  assert.deepEqual((await extract.extractMemories({ reply: 'a', runClaude: 'not a fn' })).facts, []);
});

test('extractMemories parses {facts, superseded} object shape', async () => {
  const fake = async () => JSON.stringify({
    facts: [{ category: 'tooling', fact: 'uses pnpm for installs' }],
    superseded: ['uses npm for installs'],
  });
  const out = await extract.extractMemories({
    userMessage: 'we switched from npm to pnpm',
    reply: 'Noted — updated the build docs for pnpm.',
    existingFacts: ['uses npm for installs', 'deploys via fly.io'],
    runClaude: fake,
    userId: 'u1',
  });
  assert.deepEqual(out.facts, ['[tooling] uses pnpm for installs']);
  assert.deepEqual(out.superseded, ['uses npm for installs']);
});

test('extractMemories legacy bare-array shape still works, superseded empty', async () => {
  const fake = async () => JSON.stringify([{ category: 'tooling', fact: 'uses jest' }]);
  const out = await extract.extractMemories({
    userMessage: 'we test with jest', reply: 'ok noted', existingFacts: [],
    runClaude: fake, userId: 'u1',
  });
  assert.deepEqual(out.facts, ['[tooling] uses jest']);
  assert.deepEqual(out.superseded, []);
});

test('extractMemories drops superseded entries that match no existing fact', async () => {
  const fake = async () => JSON.stringify({ facts: [], superseded: ['hallucinated fact'] });
  const out = await extract.extractMemories({
    userMessage: 'real question', reply: 'real reply',
    existingFacts: ['uses pnpm'], runClaude: fake, userId: 'u1',
  });
  assert.deepEqual(out.superseded, [], 'only verbatim-known facts may be superseded');
});

test('extractMemories rejects a superseded claim matching a fact past MAX_EXISTING_LISTED (60)', async () => {
  // buildPrompt only shows the model the first 60 existingFacts; sanitizeSuperseded
  // must validate against that same slice, not the full on-disk list — otherwise a
  // claim could exactly factKey-match a fact the model never saw (index 60, 0-based,
  // i.e. the 61st fact, which falls just past the 60-fact slice).
  const unseenFact = 'fact number 60 the project uses an unseen legacy tool';
  const existingFacts = Array.from({ length: 61 }, (_, i) => (
    i === 60 ? unseenFact : `fact number ${i} distinct project convention`
  ));
  const fake = async () => JSON.stringify({ facts: [], superseded: [unseenFact] });
  const out = await extract.extractMemories({
    userMessage: 'real question', reply: 'real reply',
    existingFacts, runClaude: fake, userId: 'u1',
  });
  assert.deepEqual(out.superseded, [], 'a fact outside the shown slice must never be accepted as superseded');
});

// ── reader: chat-memory.md recall + gate ─────────────────────────────
test('renderGraphifyMemory inlines chat-memory.md for an allow-listed repo', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'reader');
  fs.writeFileSync(path.join(root, 'system', 'memory', 'chat-memory.md'),
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
  fs.writeFileSync(path.join(root, 'system', 'memory', 'chat-memory.md'), body);
  const out = memory.renderGraphifyMemory({ indexedRepos: [{ path: root, name: 'r' }] }, u);
  assert.match(out, /LATE_FACT_MARKER/, 'a fact past 4 KB must now be injected');
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderGraphifyMemory reports per-file injection stats into an optional sink', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'stats');
  const memDir = path.join(root, 'system', 'memory');
  fs.mkdirSync(path.join(root, 'system', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(root, 'system', 'graph', 'index.md'), '# Repo\n- overview line');
  fs.writeFileSync(path.join(memDir, 'chat-memory.md'), '# Chat memory\n- a durable fact');
  const stats = [];
  const out = memory.renderGraphifyMemory({ indexedRepos: [{ path: root, name: 'r' }] }, u, stats);
  assert.ok(out, 'block still renders');
  const files = stats.map((s) => s.file);
  assert.ok(files.includes('graph/index.md') && files.includes('chat-memory.md'), 'lists injected files');
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
  const { config } = await import('../core/config.mjs');
  const cap = config.memory.maxFacts;
  const root = path.join(__dirname, `_pm-evict-${process.pid}`);
  fs.mkdirSync(path.join(root, 'system', 'memory'), { recursive: true });
  // Fill to the fact cap.
  appendChatMemory({ root, facts: Array.from({ length: cap }, (_, i) => `fact ${i} distinct convention`) });
  assert.equal(readChatMemoryFacts(root).length, cap);
  // Add 3 genuinely new facts → the 3 oldest are evicted to stay at the cap.
  const meta = {};
  const saved = appendChatMemory({ root, facts: ['brand new alpha', 'brand new beta', 'brand new gamma'], meta });
  assert.equal(saved.length, cap, 'stays at the fact cap');
  assert.equal(meta.evicted, 3, 'reports the 3 evicted facts');
  // `added` counts facts genuinely inserted, NOT the net size delta — at the
  // cap those 3 inserts are offset by 3 evictions, and reporting 0 there hid
  // the fact that anything was captured at all.
  assert.equal(meta.added, 3, 'reports the inserts, independent of eviction');
  fs.rmSync(root, { recursive: true, force: true });
});

test('config.memory exposes tunable budgets with sane defaults', async () => {
  const { config } = await import('../core/config.mjs');
  const m = config.memory;
  assert.equal(m.perFileChars, 6000);
  assert.equal(m.totalChars, 40000);
  assert.equal(m.maxRepos, 2);
  assert.equal(m.chatInjectChars, 16000, 'per-prompt chat-memory injection room');
  assert.equal(m.chatStoreChars, 200000, 'shared reader+writer on-disk chat-memory cap');
  assert.equal(m.maxFacts, 1000);
  // The store must be able to hold more than one prompt can inline — that gap
  // is the whole point of relevance-ranked recall.
  assert.ok(m.chatStoreChars > m.chatInjectChars);
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
  assert.equal(readMemoryConfig({ LLMIDE_MEM_CHAT_STORE_CHARS: '0' }).chatStoreChars, 1_000);
  assert.equal(readMemoryConfig({ LLMIDE_MEM_CHAT_STORE_CHARS: '999999999' }).chatStoreChars, 2_000_000);
  // Non-numeric input falls back to the documented default, same as envInt.
  assert.equal(readMemoryConfig({ LLMIDE_MEM_MAX_FACTS: 'not-a-number' }).maxFacts, 1_000);
});

test('extractMemories reports approx extraction token cost via meta', async () => {
  const { extractMemories } = await import('../llm_agent/runtime/memory-extract.mjs');
  const fakeRun = async () => JSON.stringify(['the build runs offline via build.sh']);
  const meta = {};
  const { facts } = await extractMemories({
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
  const { facts } = await extractMemories({
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

test('factKey collapses leading-filler paraphrases so they dedupe', async () => {
  const { factKey } = await import('../graphkit/index.mjs');
  // The audit's cited case: same fact, one with a "the project" lead-in.
  assert.equal(factKey('The project uses pnpm workspaces'), factKey('uses pnpm workspaces'));
  assert.equal(factKey('The API is REST'), factKey('API is REST'));
  assert.equal(factKey('[architecture] this repo deploys via Fly.io'), factKey('deploys via Fly.io'));
});

test('factKey does NOT merge genuinely distinct facts', async () => {
  const { factKey } = await import('../graphkit/index.mjs');
  assert.notEqual(factKey('deploy to staging'), factKey('deploy to prod'));
  assert.notEqual(factKey('the API uses REST'), factKey('the API uses GraphQL'));
});

test('appendChatMemory dedupes a leading-filler paraphrase against an existing fact', async () => {
  const { appendChatMemory } = await import('../graphkit/index.mjs');
  const root = path.join(__dirname, `_pm-paraphrase-${process.pid}`);
  fs.mkdirSync(path.join(root, 'system', 'memory'), { recursive: true });
  appendChatMemory({ root, facts: ['uses pnpm workspaces'] });
  const saved = appendChatMemory({ root, facts: ['The project uses pnpm workspaces'] });
  assert.equal(saved.length, 1, 'a leading-filler paraphrase must not create a second entry');
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeChatMemoryFacts round-trips and leaves no temp file behind', async () => {
  const { writeChatMemoryFacts, readChatMemoryFacts } = await import('../graphkit/index.mjs');
  const root = path.join(__dirname, `_pm-atomic-${process.pid}`);
  const memDir = path.join(root, 'system', 'memory');
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
  fs.mkdirSync(path.join(root, 'system', 'memory'), { recursive: true });
  appendChatMemory({ root, facts: ['the API uses cursor pagination'] });   // untagged
  const meta = {};
  const saved = appendChatMemory({ root, facts: ['[architecture] the API uses cursor pagination'], meta });
  assert.equal(saved.length, 1, 'same fact tagged with a category is not duplicated');
  fs.rmSync(root, { recursive: true, force: true });
});

test('repoMemoryBlock never exceeds its char budget (header + joins counted)', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'budget');
  // An oversized overview that would fill the whole budget on its own.
  fs.mkdirSync(path.join(root, 'system', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(root, 'system', 'graph', 'index.md'),
    'x'.repeat(50_000), 'utf8');
  const allowed = memory.buildAllowedRoots(u);
  const budget = 2000;
  const block = memory.repoMemoryBlock({ name: 'R', path: root }, budget, allowed, null, '');
  assert.ok(block, 'a block is produced');
  assert.ok(block.length <= budget,
    `block (${block.length}) must not exceed budget (${budget}) once the header + joins are counted`);
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
  fs.mkdirSync(path.join(ws, 'system', 'memory'), { recursive: true });
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
  fs.mkdirSync(path.join(ws, 'system', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'system', 'memory', 'chat-memory.md'),
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
  fs.mkdirSync(path.join(ws, 'system', 'memory'), { recursive: true });
  const runClaude = async () => '["Deploys via build.sh offline"]';
  const result = await persist.persistTurnMemory({
    agentContext: { indexedRepos: [], workspaceRoot: ws },
    userId: u, userMessage: 'q', reply: 'a', runClaude,
  });
  assert.ok(Array.isArray(result) && result.some((f) => /build\.sh/.test(f)));
  const onDisk = fs.readFileSync(path.join(ws, 'system', 'memory', 'chat-memory.md'), 'utf8');
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

// ── Session-scoped memory (delete the chat → delete what it taught) ───

test('forgetSessionMemory drops only the deleted session\'s facts', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'session-forget');
  writer.appendChatMemory({ root, facts: ['from chat A', 'shared fact'], sessionId: 'A' });
  writer.appendChatMemory({ root, facts: ['from chat B'], sessionId: 'B' });

  const { facts, removed } = writer.forgetSessionMemory({ root, sessionId: 'A' });
  assert.equal(removed, 2);
  assert.deepEqual(facts, ['from chat B'], 'chat B\'s memory survives');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a fact re-confirmed by a later session belongs to that session', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'session-reattribute');
  writer.appendChatMemory({ root, facts: ['[tooling|pm] uses npm'], sessionId: 'A' });
  // Session B revises the same subject → B now owns the row, so deleting A
  // must not take it away. (Deleting a chat should never remove knowledge a
  // LATER chat re-established.)
  writer.appendChatMemory({ root, facts: ['[tooling|pm] uses pnpm'], sessionId: 'B' });

  const afterA = writer.forgetSessionMemory({ root, sessionId: 'A' });
  assert.equal(afterA.removed, 0);
  assert.deepEqual(afterA.facts, ['[tooling|pm] uses pnpm']);

  const afterB = writer.forgetSessionMemory({ root, sessionId: 'B' });
  assert.equal(afterB.removed, 1);
  assert.deepEqual(afterB.facts, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('facts captured with no session id are never forgotten by a session delete', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'session-unattributed');
  writer.appendChatMemory({ root, facts: ['unattributed fact'] });
  writer.appendChatMemory({ root, facts: ['session fact'], sessionId: 'S' });
  const { facts, removed } = writer.forgetSessionMemory({ root, sessionId: 'S' });
  assert.equal(removed, 1);
  assert.deepEqual(facts, ['unattributed fact']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('forgetSessionMemory is a safe no-op for an unknown or empty session', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'session-noop');
  writer.appendChatMemory({ root, facts: ['a fact'], sessionId: 'S' });
  assert.equal(writer.forgetSessionMemory({ root, sessionId: 'other' }).removed, 0);
  assert.equal(writer.forgetSessionMemory({ root, sessionId: '' }).removed, 0);
  assert.equal(writer.forgetSessionMemory({ root, sessionId: undefined }).removed, 0);
  assert.deepEqual(writer.readChatMemoryFacts(root), ['a fact']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the origins sidecar self-prunes when facts are deleted by other paths', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'session-prune');
  writer.appendChatMemory({ root, facts: ['x fact', 'y fact'], sessionId: 'S' });
  assert.equal(Object.keys(writer.readFactOrigins(root)).length, 2);
  // The viewer's own delete path knows nothing about origins — the sidecar has
  // to stay honest on its own, or a later fact could inherit a stale owner.
  writer.writeChatMemoryFacts(root, ['x fact']);
  assert.deepEqual(Object.keys(writer.readFactOrigins(root)), [writer.factIndex('x fact')]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the origins sidecar is not inlined into the prompt', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'session-not-in-prompt');
  writer.appendChatMemory({ root, facts: ['a durable fact'], sessionId: 'SECRET-SESSION-ID' });
  const block = memory.renderGraphifyMemory(
    { indexedRepos: [{ path: root, name: 'r' }] }, u, null, 'what do you know?');
  assert.ok(block.includes('a durable fact'));
  assert.ok(!block.includes('SECRET-SESSION-ID'), 'session ids never reach the model');
  assert.ok(!block.includes('chat-memory.origins'), 'the sidecar is not read as a memory file');
  fs.rmSync(root, { recursive: true, force: true });
});

test('persistTurnMemory attributes facts to the CHAT session id', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'session-persist');
  const runClaude = async () => JSON.stringify({
    facts: [{ category: 'tooling', key: 'build-cmd', fact: 'the build runs via build.sh' }],
    superseded: [],
  });
  await persist.persistTurnMemory({
    agentContext: {
      indexedRepos: [{ path: root, name: 'r' }],
      // sessionId is re-minted on every session switch; chatSessionId is the
      // stable one, and it must be what capture attributes to.
      sessionId: 'ephemeral-agent-session',
      chatSessionId: 'STABLE-CHAT-UUID',
    },
    userId: u, userMessage: 'how do I build?', reply: 'run build.sh', runClaude,
  });
  const origins = writer.readFactOrigins(root);
  assert.deepEqual(Object.values(origins), ['STABLE-CHAT-UUID']);
  // Deleting that chat forgets the fact.
  assert.equal(writer.forgetSessionMemory({ root, sessionId: 'STABLE-CHAT-UUID' }).removed, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('DELETE /kb/agent/session-memory forgets a session, gated by the allow-list', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'http-session-del');
  writer.appendChatMemory({ root, facts: ['chat A fact'], sessionId: 'A' });
  writer.appendChatMemory({ root, facts: ['chat B fact'], sessionId: 'B' });

  let res = mkRes();
  await handleAgentRoutes(
    mkReq('DELETE', '/kb/agent/session-memory', { repos: [root], sessionId: 'A' }),
    res, { userId: u, url: '/kb/agent/session-memory' },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removed, 1);
  assert.deepEqual(res.body.facts, ['chat B fact']);

  // Missing sessionId → 400 rather than silently wiping something.
  res = mkRes();
  await handleAgentRoutes(
    mkReq('DELETE', '/kb/agent/session-memory', { repos: [root] }),
    res, { userId: u, url: '/kb/agent/session-memory' },
  );
  assert.equal(res.statusCode, 400);

  // An unlisted repo touches no disk and reports nothing removed — a chat with
  // no project attached is deleted client-side regardless.
  res = mkRes();
  await handleAgentRoutes(
    mkReq('DELETE', '/kb/agent/session-memory', { repos: ['/tmp/nope'], sessionId: 'B' }),
    res, { userId: u, url: '/kb/agent/session-memory' },
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { facts: [], removed: 0, repo: null });
  assert.deepEqual(writer.readChatMemoryFacts(root), ['chat B fact'], 'untouched');
  fs.rmSync(root, { recursive: true, force: true });
});

test('sanitizeFacts keeps the tag inside MAX_FACT_CHARS so the writer never clips it', async () => {
  const { sanitizeFacts } = await import('../llm_agent/runtime/memory-extract.mjs');
  const long = 'w'.repeat(400);
  const [rendered] = sanitizeFacts([{ category: 'tooling', key: 'a-long-subject-id', fact: long }]);
  // The writer caps a stored line at 280 chars. If the tag were added on top of
  // a 280-char fact, the stored line would be clipped — and a clipped stored
  // line never equals the incoming one, so every later turn re-"updated" it.
  assert.ok(rendered.length <= 280, `rendered ${rendered.length} chars`);
  assert.ok(rendered.startsWith('[tooling|a-long-subject-id] '));
  assert.equal(writer.renderChatMemoryFile([rendered]).includes(rendered), true,
               'survives a write/render round-trip unclipped');
});

test('a long fact re-captured verbatim is a no-op, not a phantom update', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'no-phantom-update');
  const line = `[tooling|build] ${'b'.repeat(240)}`.slice(0, 280);
  writer.appendChatMemory({ root, facts: [line], sessionId: 'S' });
  const meta = {};
  writer.appendChatMemory({ root, facts: [line], sessionId: 'S', meta });
  assert.equal(meta.updated, 0, 'identical line must not count as an update');
  assert.equal(meta.added, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
