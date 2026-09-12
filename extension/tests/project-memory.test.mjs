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

// Facts as stored now carry a `(t:YYYY-MM-DD)` recency stamp (see
// graphkit/memory-writer.mjs). These round-trip assertions are about upsert,
// dedup and eviction — not about the metadata — so they read stamp-blind.
const { stripFactStamp, factStamp } = await import('../core/fact-key.mjs');
const factsOf = (root) => writer.readChatMemoryFacts(root).map(stripFactStamp);
const { handleAgentRoutes } = await import('../routes/agent.mjs');

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
  assert.deepEqual(factsOf(root), []);
  writer.appendChatMemory({ root, facts: ['Uses pnpm', 'Deploys via CI'] });
  const meta = {};
  // 'uses PNPM' has the SAME factKey as 'Uses pnpm' (case/space normalised), so
  // it's an update of that entry — not a duplicate to discard, and not a second
  // row. It keeps position 0; only 'New thing' is appended.
  writer.appendChatMemory({ root, facts: ['uses PNPM', 'New thing'], meta });
  const facts = factsOf(root);
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
  const facts = factsOf(root);
  assert.equal(facts.length, 3, 'no new row');
  assert.equal(stripFactStamp(facts[0]), '[tooling|server-port] the server binds to port 4000',
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
  assert.equal(factsOf(root).length, 2);
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
  assert.deepEqual(factsOf(root), ['exactly the same fact']);
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
  assert.deepEqual(factsOf(root), ['Uses pnpm workspaces']);

  // The first write materialises everything at the canonical path...
  writer.appendChatMemory({ root, facts: ['Deploys via CI'] });
  const canonical = path.join(root, 'system', 'memory', 'chat-memory.md');
  assert.deepEqual(factsOf(root), ['Uses pnpm workspaces', 'Deploys via CI']);
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

test('extractMemories rejects a superseded claim for a fact outside the shown slice', async () => {
  // The model may only retire facts it was SHOWN, so sanitizeSuperseded must
  // validate against the shown selection rather than the full on-disk list.
  //
  // The fixture inverted when selection became relevance-ranked: it used to
  // put the unshown fact at index 60 (past a blind first-60 slice), but with
  // no query-token match the ranking degrades to newest-first, which makes
  // the LAST fact the most likely to be shown and the OLDEST the one left
  // out. The property under test is unchanged; only which fact is unshown is.
  const existingFacts = Array.from({ length: 61 }, (_, i) => (
    `fact number ${i} distinct project convention`
  ));
  const unseenFact = existingFacts[0];   // oldest → outside the 20 shown
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
  assert.deepEqual(readChatMemoryFacts(root).map(stripFactStamp), ['a durable fact worth keeping']);
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
  assert.deepEqual(result.map(stripFactStamp), ['The API client lives in LlmIdeAPIClient.swift']);
  assert.deepEqual(writer.readChatMemoryFacts(root), result, 'the persisted list IS what was returned');
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
  assert.deepEqual(res.body.facts.map(stripFactStamp), ['Endpoint-visible fact']);
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
  assert.deepEqual(res.body.facts.map(stripFactStamp), ['Resolved from the allow-listed repo']);
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
  assert.deepEqual(res.body.facts.map(stripFactStamp), ['keep me']);
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

// The viewer sends the fact back verbatim, so the delete keys on factIndex —
// the store's own identity. factKey would strip the tag and leading filler and
// take same-text facts with DIFFERENT subject ids down with it.
test('DELETE /kb/agent/project-memory deletes only the clicked subject id', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'http-del-factindex');
  writer.appendChatMemory({
    root,
    facts: ['[db|engine] uses SQLite WAL', '[perf|store] the project uses SQLite WAL', 'keep me'],
  });
  const res = mkRes();
  await handleAgentRoutes(
    mkReq('DELETE', '/kb/agent/project-memory',
          { repo: root, fact: '[db|engine] uses SQLite WAL' }),
    res, { userId: u, url: '/kb/agent/project-memory' },
  );
  assert.equal(res.statusCode, 200);
  // Both facts share the factKey "uses sqlite wal"; only the clicked one goes.
  assert.deepEqual(res.body.facts.map(stripFactStamp), ['[perf|store] the project uses SQLite WAL', 'keep me']);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Session-scoped memory (kb/session-memory.mjs, a real DB table) ────
// Project memory (above) is durable and edit-only — it no longer carries any
// session attribution and is never auto-pruned by a chat's lifecycle. Session
// memory is the opposite: it's the thing that's SUPPOSED to disappear the
// moment its session is cleared or deleted, and it lives in `session_memory`,
// not a file.

const sessionMemory = await import('../kb/session-memory.mjs');

test('appendSessionMemory + listSessionMemory round-trip, oldest first', () => {
  reset();
  const u = provision();
  sessionMemory.appendSessionMemory(u, 'S', ['fact one']);
  sessionMemory.appendSessionMemory(u, 'S', ['fact two', 'fact three']);
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'S'), ['fact one', 'fact two', 'fact three']);
});

test('appendSessionMemory upserts by factIndex, keeping the row position', () => {
  reset();
  const u = provision();
  sessionMemory.appendSessionMemory(u, 'S', [
    'first fact', '[tooling|build-cmd] runs via make', 'third fact',
  ]);
  sessionMemory.appendSessionMemory(u, 'S', ['[tooling|build-cmd] runs via build.sh']);
  // Middle slot is rewritten in place — a delete + re-append would move it last.
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'S'), [
    'first fact', '[tooling|build-cmd] runs via build.sh', 'third fact',
  ]);
});

test('appendSessionMemory reports how many rows it inserted or updated', () => {
  reset();
  const u = provision();
  assert.equal(sessionMemory.appendSessionMemory(u, 'S', ['a', 'b']), 2, 'two inserts');
  assert.equal(sessionMemory.appendSessionMemory(u, 'S', ['a']), 0, 'identical row is a no-op');
  assert.equal(
    sessionMemory.appendSessionMemory(u, 'S', ['[x|id1] one']), 1, 'new subject id inserts',
  );
  assert.equal(
    sessionMemory.appendSessionMemory(u, 'S', ['[x|id1] two']), 1, 'same subject id updates',
  );
});

test('appendSessionMemory removes superseded facts by factKey, not exact text', () => {
  reset();
  const u = provision();
  sessionMemory.appendSessionMemory(u, 'S', ['[tooling|pkg] uses npm workspaces', 'keep me']);
  sessionMemory.appendSessionMemory(u, 'S', ['[tooling|deploy] deploys via gitlab'], {
    // Neither the tag nor the "the project " lead-in is present: this only
    // matches if factKey normalisation is actually applied to both sides.
    remove: ['the project uses npm workspaces'],
  });
  assert.deepEqual(
    sessionMemory.listSessionMemory(u, 'S'),
    ['keep me', '[tooling|deploy] deploys via gitlab'],
  );
});

test('session memory is isolated per session id, not per user globally', () => {
  reset();
  const u = provision();
  sessionMemory.appendSessionMemory(u, 'A', ['from chat A']);
  sessionMemory.appendSessionMemory(u, 'B', ['from chat B']);
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'A'), ['from chat A']);
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'B'), ['from chat B']);
});

test('deleteSessionMemory drops only the deleted session\'s facts', () => {
  reset();
  const u = provision();
  sessionMemory.appendSessionMemory(u, 'A', ['from chat A']);
  sessionMemory.appendSessionMemory(u, 'B', ['from chat B']);
  const removed = sessionMemory.deleteSessionMemory(u, 'A');
  assert.equal(removed, 1);
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'A'), []);
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'B'), ['from chat B'], 'chat B\'s memory survives');
});

test('deleteSessionMemory is a safe no-op for an unknown or empty session', () => {
  reset();
  const u = provision();
  sessionMemory.appendSessionMemory(u, 'S', ['a fact']);
  assert.equal(sessionMemory.deleteSessionMemory(u, 'other'), 0);
  assert.equal(sessionMemory.deleteSessionMemory(u, ''), 0);
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'S'), ['a fact']);
});

test('resolveChatSessionId prefers the stable chatSessionId over the ephemeral sessionId', () => {
  assert.equal(sessionMemory.resolveChatSessionId({ chatSessionId: 'STABLE', sessionId: 'ephemeral' }), 'STABLE');
  assert.equal(sessionMemory.resolveChatSessionId({ sessionId: 'ephemeral' }), 'ephemeral');
  assert.equal(sessionMemory.resolveChatSessionId({}), undefined);
});

test('persistTurnMemory writes the SAME extracted facts into project memory AND session memory', async () => {
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
      // stable one, and it must be what session memory is keyed on.
      sessionId: 'ephemeral-agent-session',
      chatSessionId: 'STABLE-CHAT-UUID',
    },
    userId: u, userMessage: 'how do I build?', reply: 'run build.sh', runClaude,
  });
  assert.deepEqual(factsOf(root), ['[tooling|build-cmd] the build runs via build.sh']);
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'STABLE-CHAT-UUID'), ['[tooling|build-cmd] the build runs via build.sh']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('project memory outlives its session being deleted — only session memory goes away', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'project-memory-outlives-session');
  const runClaude = async () => JSON.stringify({
    facts: [{ category: 'tooling', key: 'build-cmd', fact: 'the build runs via build.sh' }],
    superseded: [],
  });
  await persist.persistTurnMemory({
    agentContext: { indexedRepos: [{ path: root, name: 'r' }], chatSessionId: 'DOOMED-CHAT' },
    userId: u, userMessage: 'how do I build?', reply: 'run build.sh', runClaude,
  });
  sessionMemory.deleteSessionMemory(u, 'DOOMED-CHAT');
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'DOOMED-CHAT'), [], 'session memory is gone');
  assert.deepEqual(factsOf(root), ['[tooling|build-cmd] the build runs via build.sh'],
    'project memory survives — it is only ever edited via its own viewer, never by session lifecycle');
  fs.rmSync(root, { recursive: true, force: true });
});

test('DELETE /kb/agent/session-memory deletes a session\'s facts, no repo/allow-list needed', async () => {
  reset();
  const u = provision();
  sessionMemory.appendSessionMemory(u, 'A', ['chat A fact']);
  sessionMemory.appendSessionMemory(u, 'B', ['chat B fact']);

  let res = mkRes();
  await handleAgentRoutes(
    mkReq('DELETE', '/kb/agent/session-memory', { sessionId: 'A' }),
    res, { userId: u, url: '/kb/agent/session-memory' },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removed, 1);
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'A'), []);
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'B'), ['chat B fact'], 'untouched');

  // Missing sessionId → 400 rather than silently wiping something.
  res = mkRes();
  await handleAgentRoutes(
    mkReq('DELETE', '/kb/agent/session-memory', {}),
    res, { userId: u, url: '/kb/agent/session-memory' },
  );
  assert.equal(res.statusCode, 400);
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
  writer.appendChatMemory({ root, facts: [line] });
  const meta = {};
  writer.appendChatMemory({ root, facts: [line], meta });
  assert.equal(meta.updated, 0, 'identical line must not count as an update');
  assert.equal(meta.added, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

// Extraction model: chain-derived default (never a hard-coded literal) and
// overridable per turn, so a non-anthropic chat extracts on its own
// provider's fast tier instead of forcing an Anthropic call.
test('extractMemories model: chain-derived default; opts.model overrides per turn', async () => {
  const { fastModelFor } = await import('../kb/usage.mjs');
  const { EXTRACT_MODEL } = extract;
  assert.equal(EXTRACT_MODEL,
    process.env.LLMIDE_SUMMARIZE_MODEL || process.env.LLMIDE_MODEL || fastModelFor('anthropic'));

  const seen = [];
  const fake = async (p, opts) => { seen.push(opts.model); return '{"facts":[],"superseded":[]}'; };
  await extract.extractMemories({
    userMessage: 'we switched to uv for python deps management going forward',
    reply: 'Noted, uv it is — updating the setup docs accordingly.',
    existingFacts: [], runClaude: fake, userId: 'u1', model: 'o3-mini',
  });
  assert.deepEqual(seen, ['o3-mini'], 'a per-turn model override must reach runClaude');
  await extract.extractMemories({
    userMessage: 'we switched to uv for python deps management going forward',
    reply: 'Noted, uv it is — updating the setup docs accordingly.',
    existingFacts: [], runClaude: fake, userId: 'u1',
  });
  assert.equal(seen[1], EXTRACT_MODEL, 'without an override the chain-derived default rides');
});

// ── per-fact recency (timestamps) ────────────────────────────────────────────
//
// Recency used to be a fact's POSITION in the file, and an updated fact kept
// its original slot. Both consumers of position then read it backwards:
// selectChatMemoryFacts breaks score ties with `b.index - a.index` ("newer
// wins"), and writeChatMemoryFacts evicts from the FRONT when over budget.
// So a fact the model kept re-confirming ranked LOWEST on ties and was the
// FIRST to be deleted — the exact opposite of what the supersede/UPDATE path
// was built for.
//
// Position stays where it is (diff-friendly, as the writer intended); the
// recency SIGNAL moves to an explicit `(t:YYYY-MM-DD)` suffix. Day granularity
// on purpose: a fact re-confirmed twice in one day must not churn the file.

test('factKey/factIndex ignore the timestamp suffix, so identity survives a re-stamp', async () => {
  const { factKey, factIndex } = await import('../core/fact-key.mjs');
  // Same fact, different stamp → same identity, or every re-confirmation
  // would land as a NEW row and the whole upsert path would break.
  assert.equal(factKey('[db] uses SQLite (t:2026-09-07)'), factKey('[db] uses SQLite (t:2026-01-01)'));
  assert.equal(factKey('[db] uses SQLite (t:2026-09-07)'), factKey('[db] uses SQLite'));
  // And for a fact carrying a subject id, the id still wins.
  assert.equal(factIndex('[db|engine] binds :3456 (t:2026-09-07)'), '#engine');
  assert.equal(
    factIndex('[db|engine] binds :4000 (t:2026-02-02)'),
    factIndex('[db|engine] binds :3456 (t:2026-09-07)'),
    'a value change with a new stamp is still the same fact',
  );
});

test('appendChatMemory stamps new facts and re-stamps updated ones, keeping position', () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'stamp');
  writer.appendChatMemory({ root, facts: ['[db|engine] binds :3456', '[ci|runner] uses GitHub Actions'] });
  let facts = writer.readChatMemoryFacts(root);
  // LOCAL date, computed the same way memory-writer's todayStamp() computes
  // it — NOT toISOString(), which is UTC. The two differ for the nine hours
  // after midnight JST (UTC+9), so a UTC "today" here made this test fail
  // every morning in the timezone this product is primarily used in. It
  // passed on the day it was written only because both dates happened to
  // agree at that hour.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  assert.ok(facts.every((f) => f.includes(`(t:${today})`)), `new facts stamped: ${JSON.stringify(facts)}`);

  // Update the FIRST fact. It keeps slot 0 (diff-friendly) but must carry a
  // fresh stamp, which is what makes it rank as recent rather than oldest.
  writer.appendChatMemory({ root, facts: ['[db|engine] binds :4000'] });
  facts = writer.readChatMemoryFacts(root);
  assert.equal(facts.length, 2, 'an update is not a new row');
  assert.match(facts[0], /binds :4000/, 'updated in place, position preserved');
  assert.match(facts[0], new RegExp(`\\(t:${today}\\)`), 'and re-stamped');
});

test('selectChatMemoryFacts ranks by timestamp, not file position', async () => {
  // The regression: the OLDEST fact sits at index 0, so with position-based
  // recency it lost every tie; give it the NEWEST stamp and it must now win.
  const older = '[a|one] alpha shared-token (t:2020-01-01)';
  const newer = '[b|two] beta shared-token (t:2030-01-01)';
  // Takes raw file CONTENT (it parses the bullets itself) plus options.
  const content = `- ${newer}\n- ${older}\n`;
  const text = memory.selectChatMemoryFacts(content, { userMessage: 'shared-token', room: 10_000 });
  const posNewer = text.indexOf('beta');
  const posOlder = text.indexOf('alpha');
  assert.ok(posNewer >= 0 && posOlder >= 0, `both facts selected: ${text}`);
  assert.ok(posNewer < posOlder, `the newer-STAMPED fact must rank first, got: ${text}`);
});

test('an undated fact ranks below a dated one (no migration, self-heals on re-confirm)', async () => {
  const dated = '[b|two] beta shared-token (t:2026-09-07)';
  const undated = '[a|one] alpha shared-token';
  // DATED first, undated second: the old rule broke ties by higher index, so
  // position favours the UNDATED one here. Ordering them the other way would
  // let this pass under the old code too, proving nothing.
  const content = `- ${dated}\n- ${undated}\n`;
  const text = memory.selectChatMemoryFacts(content, { userMessage: 'shared-token', room: 10_000 });
  assert.ok(text.indexOf('beta') < text.indexOf('alpha'),
    `a dated fact outranks an undated one of equal relevance: ${text}`);
});

// ── overflow eviction is stamp-based, not position-based (renderChatMemoryFile) ─
//
// 919f4595 fixed selectChatMemoryFacts to rank by stamp instead of position but
// left renderChatMemoryFile's fact-count evictor doing `list.slice(list.length
// - MAX_FACTS)` — a pure FIFO trim by array index. Since an UPDATE preserves a
// fact's slot on purpose, a fact re-confirmed TODAY but still sitting near
// index 0 was the first one dropped once the store passed
// config.memory.maxFacts. This test pins the fix directly against
// renderChatMemoryFile (the pure function the bug lives in) with a small
// LLMIDE_MEM_MAX_FACTS so it doesn't need to write 1000+ facts — config.mjs
// reads env once at import time, so the cap must be set in a FRESH child
// process (same pattern as the "clamps out-of-range env values" test above).
test('renderChatMemoryFile evicts the OLDEST fact by stamp, not the one at index 0', () => {
  const r = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { renderChatMemoryFile, parseChatMemoryFacts } from './graphkit/memory-writer.mjs';
    // 5 facts, cap 4 → exactly one eviction. Index 0 carries the NEWEST
    // stamp of the batch; the rest are undated (unknown age → oldest by
    // definition). Only an undated fact may be dropped; index 0 must survive
    // despite sitting at the front of the array.
    const facts = [
      'alpha fact (t:2030-01-01)',
      'beta fact',
      'gamma fact',
      'delta fact',
      'epsilon fact',
    ];
    const out = renderChatMemoryFile(facts);
    console.log(JSON.stringify(parseChatMemoryFacts(out)));
    `,
  ], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      LLMIDE_JWT_SECRET: 'a'.repeat(48),
      LLMIDE_VAULT_KEY: 'b'.repeat(48),
      NODE_ENV: 'test',
      LLMIDE_MEM_MAX_FACTS: '4',
    },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const kept = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(kept.length, 4, 'capped to MAX_FACTS');
  assert.ok(kept.some((f) => f.startsWith('alpha fact')),
    `the newest-stamped fact at index 0 must survive even though it is oldest by position: ${JSON.stringify(kept)}`);
  assert.ok(!kept.some((f) => f.startsWith('beta fact')),
    `the first UNDATED (unknown-age) fact must be the one evicted, not index 0: ${JSON.stringify(kept)}`);
});

// ── stamp corruption on truncation (renderChatMemoryFile / withStamp) ──────────
//
// withStamp appends a 15-char " (t:YYYY-MM-DD)" suffix AFTER sanitizeFacts
// (llm_agent/runtime/memory-extract.mjs) already budgeted the fact to exactly
// MAX_FACT_CHARS (280). renderChatMemoryFile then re-slices to 280. Any fact
// whose combined length landed in [266, 279] had its stamp cut mid-string —
// e.g. "...(t:2026-09-0" with no closing paren — which stripFactStamp's regex
// cannot match, so the corrupt tail became permanent, visible fact text.

test('appendChatMemory: a fact near the length cap keeps an intact, well-formed stamp', () => {
  reset();
  const u = provision('pm-stamp-nearcap@example.test');
  const root = tmpRepo(u, 'stamp-nearcap');
  // 279 chars of text: combined with the 15-char stamp this lands squarely in
  // the corruption band the reviewer identified (a blind slice(0, 280) would
  // cut off the stamp's last few characters).
  const fact = 'z'.repeat(279);
  writer.appendChatMemory({ root, facts: [fact] });
  const [stored] = writer.readChatMemoryFacts(root);
  assert.ok(stored, 'fact persisted');
  assert.ok(stored.length <= 280, `stored line must respect the cap: ${stored.length}`);
  assert.ok(stored.endsWith(')'), `stamp must not be truncated mid-string: ${JSON.stringify(stored)}`);
  assert.ok(factStamp(stored), `factStamp must still parse a well-formed date: ${JSON.stringify(stored)}`);
});

test('appendChatMemory: an overlong fact is capped on TEXT, never on the stamp', () => {
  reset();
  const u = provision('pm-stamp-overlong@example.test');
  const root = tmpRepo(u, 'stamp-overlong');
  const fact = 'q'.repeat(400);
  writer.appendChatMemory({ root, facts: [fact] });
  const [stored] = writer.readChatMemoryFacts(root);
  const stamp = factStamp(stored);
  assert.ok(stamp, 'stamp intact on an overlong fact');
  assert.ok(stored.length <= 280, `total line must still respect the 280 cap: ${stored.length}`);
  const text = stripFactStamp(stored);
  assert.equal(text.length, 280 - ` (t:${stamp})`.length,
    'fact TEXT is capped to leave exact room for the stamp, not the other way round');
});

// ── session memory: its own extraction bucket, its own gate, its own route ──
//
// Until this, session memory received ONLY what the project extractor
// judged durable — and that prompt is (rightly) biased toward returning
// nothing: "will this still be true next week?". The facts a session runs on
// (the decision just made, the option chosen, the phase the work is in) fail
// that bar by definition, so the table sat empty for two weeks of chats.

test('extractMemories returns the session bucket alongside project facts', async () => {
  const runClaude = async () => JSON.stringify({
    facts: [{ category: 'tooling', key: 'test-command', fact: 'Tests run via npm test' }],
    session: ['User chose the phased approach over a single sweep', 'Design is saved; the plan is not yet written'],
    superseded: [],
  });
  const out = await extract.extractMemories({ userMessage: 'q', reply: 'a', existingFacts: [], runClaude, userId: 'u' });
  assert.deepEqual(out.facts, ['[tooling|test-command] Tests run via npm test']);
  assert.deepEqual(out.sessionFacts, [
    'User chose the phased approach over a single sweep',
    'Design is saved; the plan is not yet written',
  ]);
});

test('extractMemories: the legacy bare-array shape still parses, with an empty session bucket', async () => {
  const out = await extract.extractMemories({ reply: 'a', runClaude: async () => '["Only durable fact"]' });
  assert.deepEqual(out.facts, ['Only durable fact']);
  assert.deepEqual(out.sessionFacts, []);
});

test('sanitizeSessionFacts: trims, collapses whitespace, drops junk, dedupes, caps at six', () => {
  const out = extract.sanitizeSessionFacts([
    '  User picked   option B  ', 'User picked option B', 'x', 42, null,
    // Each ≥ 4 chars so only the CAP removes them, not the junk floor.
    'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
  ]);
  assert.equal(out[0], 'User picked option B', 'whitespace collapsed');
  assert.equal(out.filter((f) => f === 'User picked option B').length, 1, 'deduped');
  assert.ok(!out.includes('x'), 'junk dropped');
  assert.equal(out.length, 6, 'capped');
  assert.deepEqual(extract.sanitizeSessionFacts('not an array'), []);
});

test('persistTurnMemory writes session memory even when NO project root resolves', async () => {
  reset();
  const u = provision();
  // No indexed repos, no workspace — the case that used to skip everything
  // before extraction ran. The chat session id alone is enough for the
  // session store.
  const runClaude = async () => JSON.stringify({
    facts: [], session: ['User wants the plan in one file'], superseded: [],
  });
  const result = await persist.persistTurnMemory({
    agentContext: { chatSessionId: 'CHAT-NO-ROOT' },
    userId: u, userMessage: 'keep it in one file', reply: 'Understood — one file.', runClaude,
  });
  assert.equal(result, null, 'nothing was written to project memory (there is no project)');
  assert.deepEqual(sessionMemory.listSessionMemory(u, 'CHAT-NO-ROOT'), ['User wants the plan in one file']);
});

test('persistTurnMemory with a root writes project facts to disk and BOTH buckets to the session', async () => {
  reset();
  const u = provision();
  const root = tmpRepo(u, 'both-buckets');
  const runClaude = async () => JSON.stringify({
    facts: [{ category: 'convention', key: 'plan-location', fact: 'Plans live in llm-doc/plans' }],
    session: ['Phase 1 is approved; phase 2 is being planned'],
    superseded: [],
  });
  const result = await persist.persistTurnMemory({
    agentContext: { indexedRepos: [{ path: root, name: 'r' }], chatSessionId: 'CHAT-ROOT' },
    userId: u, userMessage: 'q', reply: 'a', runClaude,
  });
  assert.deepEqual(result.map(stripFactStamp), ['[convention|plan-location] Plans live in llm-doc/plans']);
  const session = sessionMemory.listSessionMemory(u, 'CHAT-ROOT');
  assert.ok(session.some((f) => /Plans live in llm-doc\/plans/.test(f)), 'the project fact this chat taught');
  assert.ok(session.includes('Phase 1 is approved; phase 2 is being planned'), 'the conversation-state sentence');
  assert.ok(!writer.readChatMemoryFacts(root).some((f) => /Phase 1 is approved/.test(f)),
    'a session sentence must NOT leak into durable project memory');
  fs.rmSync(root, { recursive: true, force: true });
});

test('persistTurnMemory still skips entirely with neither a root nor a chat session', async () => {
  reset();
  const u = provision();
  let called = 0;
  const runClaude = async () => { called += 1; return '["x"]'; };
  assert.equal(await persist.persistTurnMemory({ agentContext: {}, userId: u, reply: 'a', runClaude }), null);
  assert.equal(called, 0, 'no extraction call is spent when there is nowhere to write');
});

test('GET /kb/agent/session-memory lists a chat\'s facts and requires sessionId', async () => {
  reset();
  const u = provision();
  sessionMemory.appendSessionMemory(u, 'CHAT-GET', ['User chose option B', 'Plan title is Dead Code Removal']);
  const okUrl = '/kb/agent/session-memory?sessionId=CHAT-GET';
  let res = mkRes();
  assert.equal(await handleAgentRoutes(mkReq('GET', okUrl), res, { userId: u, url: okUrl }), true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { facts: ['User chose option B', 'Plan title is Dead Code Removal'] });

  // Another user's session id yields nothing — rows are per user. Registered
  // directly: provision() uses one fixed email, so a second call conflicts.
  const other = users.registerUser(db.getDb(), {
    email: 'other-session-memory@example.com', password: 'CorrectHorseBattery', displayName: 'o',
  }).id;
  res = mkRes();
  await handleAgentRoutes(mkReq('GET', okUrl), res, { userId: other, url: okUrl });
  assert.deepEqual(res.body, { facts: [] });

  const badUrl = '/kb/agent/session-memory';
  res = mkRes();
  await handleAgentRoutes(mkReq('GET', badUrl), res, { userId: u, url: badUrl });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'SESSION_ID_REQUIRED');
});

// ── the extractor's known-facts list is bounded and relevance-ranked ──────
//
// This call runs after every substantive turn, and the known-facts list was a
// blind `.slice(0, 60)` of everything stored — so its cost grew as the
// project learned: ~2.1K input tokens with an empty memory, ~6.1K at the cap.
// It is now the 20 most relevant, which is both cheaper and better targeted.
test('extraction shows at most 20 known facts, and the most relevant ones', async () => {
  const many = Array.from({ length: 60 }, (_, i) => `[convention|key-${i}] Fact number ${i} about widgets`);
  many.push('[tooling|pnpm] The project uses pnpm workspaces for dependency management');
  let prompt = '';
  await extract.extractMemories({
    userMessage: 'how does pnpm handle our workspaces?',
    reply: 'It links them.',
    existingFacts: many,
    userId: 'u',
    runClaude: async (p) => { prompt = p; return '{"facts":[],"session":[],"superseded":[]}'; },
  });
  const shown = prompt.split('\n').filter((l) => l.startsWith('- [')).length;
  assert.equal(shown, 20, 'the list is capped');
  assert.match(prompt, /pnpm workspaces/, 'the fact this turn is about must be shown, not lost at index 60');
});

test('with fewer facts than the cap, every one is still shown', async () => {
  let prompt = '';
  await extract.extractMemories({
    userMessage: 'q', reply: 'a',
    existingFacts: ['[tooling|a] Alpha', '[tooling|b] Beta'],
    userId: 'u',
    runClaude: async (p) => { prompt = p; return '{"facts":[],"session":[],"superseded":[]}'; },
  });
  assert.match(prompt, /Alpha/);
  assert.match(prompt, /Beta/);
});
