// Project memory's CONTENT stays in chat-memory.md (the reader, the viewer and
// a hand edit all work on that file). The ledger is the typed record ABOUT
// each fact the file cannot carry: category, when it was first learned and
// last confirmed, how many turns confirmed it, which chat taught it, and
// whether it was superseded. A byte-identical restatement — deliberately a
// no-op for the file, or the extractor would rewrite it every turn — is a
// confirmation here, and the reader ranks a re-confirmed fact ahead of a
// stale one of equal relevance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_memory-ledger-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { recordMemoryLedger, memoryLedgerFor, ledgerKey, pruneMemoryLedger } = await import('../kb/memory-ledger.mjs');
const { rankFactsByRelevance } = await import('../graphkit/memory.mjs');
const writer = await import('../graphkit/memory-writer.mjs');
const persist = await import('../llm_agent/runtime/memory-persist.mjs');

const newUser = (tag) => users.registerUser(db.getDb(), {
  email: `ml-${tag}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: tag,
}).id;
const ROOT = '/repo/ledger';

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('a fact is recorded once and every later mention confirms it', () => {
  const U = newUser('confirm');
  recordMemoryLedger(U, ROOT, { confirmed: ['[convention|pnpm] uses pnpm (t:2026-09-01)'], chatSessionId: 'chat-a' });
  recordMemoryLedger(U, ROOT, { confirmed: ['[convention|pnpm] uses pnpm workspaces'], chatSessionId: 'chat-b' });
  const row = memoryLedgerFor(U, ROOT).get(ledgerKey('[convention|pnpm] anything'));
  assert.equal(row.category, 'convention');
  assert.equal(row.confirmations, 2, 'a restatement (even reworded under the same id) is a confirmation');
  assert.equal(row.sourceChatSession, 'chat-a', 'the chat that FIRST taught it is kept');
  assert.equal(row.lastChatSession, 'chat-b');
  assert.equal(row.status, 'active');
  assert.ok(row.lastConfirmedAt >= row.firstSeenAt);
});

test('a superseded fact is marked, not deleted, and a later confirmation revives it', () => {
  const U = newUser('supersede');
  recordMemoryLedger(U, ROOT, { confirmed: ['the server binds to :3456'] });
  recordMemoryLedger(U, ROOT, { removed: ['The server binds to :3456'] });
  assert.equal(memoryLedgerFor(U, ROOT).get(ledgerKey('the server binds to :3456')).status, 'superseded');
  recordMemoryLedger(U, ROOT, { confirmed: ['the server binds to :3456'] });
  assert.equal(memoryLedgerFor(U, ROOT).get(ledgerKey('the server binds to :3456')).status, 'active');
});

test('the ledger is scoped per user and per repo, and goes with the user', () => {
  const A = newUser('a');
  const B = newUser('b');
  recordMemoryLedger(A, ROOT, { confirmed: ['fact one'] });
  assert.equal(memoryLedgerFor(B, ROOT).size, 0);
  assert.equal(memoryLedgerFor(A, '/repo/other').size, 0);
  db.deleteUserCascade(A);
  assert.equal(memoryLedgerFor(A, ROOT).size, 0);
});

test('equal relevance: the more recently confirmed fact ranks first, then the more confirmed one', () => {
  const facts = ['old but reconfirmed fact (t:2026-01-01)', 'newer unconfirmed fact (t:2026-06-01)'];
  const ledger = new Map([
    [ledgerKey(facts[0]), { lastConfirmedAt: '2026-09-30 10:00:00', confirmations: 5, status: 'active' }],
    [ledgerKey(facts[1]), { lastConfirmedAt: '2026-06-01 10:00:00', confirmations: 1, status: 'active' }],
  ]);
  assert.deepEqual(rankFactsByRelevance(facts, { userMessage: '', ledger })[0], facts[0]);
  assert.deepEqual(rankFactsByRelevance(facts, { userMessage: '' })[0], facts[1], 'without a ledger: the stamp, as before');
  const relevant = rankFactsByRelevance(facts, { userMessage: 'newer unconfirmed', ledger });
  assert.equal(relevant[0], facts[1], 'relevance still decides first');
});

test('persistTurnMemory: restating a stored fact leaves the file untouched and confirms it in the ledger', async () => {
  const U = newUser('persist');
  const root = fs.mkdtempSync(path.join(__dirname, '_ml-repo-'));
  try {
    db.addUserRepo(U, root);
    const runClaude = async () => '["Tests run with node --test"]';
    const turn = () => persist.persistTurnMemory({
      agentContext: { indexedRepos: [{ path: root, name: 'r' }], chatSessionId: 'chat-p' },
      userId: U, userMessage: 'how do I run tests', reply: 'node --test', runClaude,
    });
    await turn();
    const file = path.join(root, 'system', 'memory', 'chat-memory.md');
    const before = fs.readFileSync(file, 'utf8');
    await turn();
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file is not rewritten for a restatement');
    assert.deepEqual(writer.readChatMemoryFacts(root).length, 1);
    const real = fs.realpathSync(root);
    const key = ledgerKey('Tests run with node --test');
    const row = memoryLedgerFor(U, real).get(key) ?? memoryLedgerFor(U, root).get(key);
    assert.equal(row?.confirmations, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Review fixes on the ledger itself.
test('the ledger never stores fact TEXT — an untagged fact\'s key is its text, so it is hashed', () => {
  const U = newUser('hash');
  recordMemoryLedger(U, ROOT, { confirmed: ['The deploy password lives in 1Password'] });
  const raw = db.getDb().prepare('SELECT * FROM project_memory_ledger WHERE user_id = ?').all(U);
  assert.equal(raw.length, 1);
  assert.doesNotMatch(JSON.stringify(raw), /password/i);
});

test('a fact revised AND listed as superseded in the same turn stays active', () => {
  const U = newUser('same-turn');
  recordMemoryLedger(U, ROOT, {
    confirmed: ['[tooling|server-port] the server binds to :4000'],
    removed: ['[tooling|server-port] the server binds to :3456'],
  });
  assert.equal(memoryLedgerFor(U, ROOT).get(ledgerKey('[tooling|server-port] x')).status, 'active');
});

test('rows for facts no longer in the file (viewer delete, eviction) are pruned', () => {
  const U = newUser('prune');
  recordMemoryLedger(U, ROOT, { confirmed: ['kept fact', 'deleted in the viewer'] });
  pruneMemoryLedger(U, ROOT, ['kept fact (t:2026-10-02)']);
  const keys = [...memoryLedgerFor(U, ROOT).keys()];
  assert.deepEqual(keys, [ledgerKey('kept fact')]);
});

test('timestamps are local time, like the file\'s (t:YYYY-MM-DD) stamps', () => {
  const U = newUser('local');
  recordMemoryLedger(U, ROOT, { confirmed: ['local fact'] });
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  assert.equal(memoryLedgerFor(U, ROOT).get(ledgerKey('local fact')).lastConfirmedAt.slice(0, 10), today);
});
