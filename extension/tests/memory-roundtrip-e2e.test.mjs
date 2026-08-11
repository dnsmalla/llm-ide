// End-to-end for the memory half, against the EXACT tree the Mac app generates
// (verified by mac/Tests/LlmIdeMacTests/KnowledgeGraphEndToEndTests.swift):
//
//   system/graph/index.md          overview
//   system/memory/graph-notes.md   cross-links + hubs
//   system/memory/doc-notes.md     doc sections
//   system/memory/chat-memory.md   curated facts (written by THIS side)
//   system/repo.md                 hand-authored facts
//
// Asserts the agent sees each artifact exactly once, and that a capture updates
// the single chat-memory file in place rather than accumulating copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_memory-e2e-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

const memory = await import('../graphkit/memory.mjs');
const writer = await import('../graphkit/memory-writer.mjs');
const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

const U = users.registerUser(db.getDb(), {
  email: `e2e-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'e',
}).id;

const repo = path.join(__dirname, `_memory-e2e-repo-${Date.now()}`);

// Byte-for-byte the shapes the Mac generator emits.
function seedGeneratedRepo() {
  const w = (rel, body) => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  w('system/graph/index.md',
    '# Codebase Index\n\n| Field | Value |\n|-------|-------|\n| **Files** | 2 |\n\n## Files by Role\n\n### Module (2 files)\n\n- `src/Database.swift` — 4 lines, 1 functions\n');
  w('system/graph/src/Database.swift.md', '# Database.swift\n\n## Functions\n\n| `backupTo` | L3 |\n');
  w('system/memory/graph-notes.md',
    '# Graph notes\n\n- Code nodes: 5\n- Doc nodes: 4\n- Edges: 7\n\n## Doc → code references\n- Architecture → Database\n');
  w('system/memory/doc-notes.md', '# Documentation memory\n\n2 documents · 2 sections.\n\n## architecture\n- Architecture\n');
  w('system/repo.md', '# Project facts\n\n## Stack\n\nSwift 6, SPM only.\n');
  db.addUserRepo(U, repo);
}

test('setup: a repo shaped exactly like a real generation', () => {
  seedGeneratedRepo();
});

test('every generated artifact reaches the agent exactly once', () => {
  const stats = [];
  const out = memory.renderGraphifyMemory({ indexedRepos: [{ path: repo, name: 'demo' }] }, U, stats, 'how do backups work?');

  // Content from each artifact is present…
  assert.match(out, /Codebase Index/);
  assert.match(out, /Doc → code references/);
  assert.match(out, /Documentation memory/);
  assert.match(out, /Swift 6, SPM only/);

  // …and each file is injected exactly once, under one label.
  const labels = stats.map((s) => s.file).sort();
  assert.deepEqual(labels, ['doc-notes.md', 'graph-notes.md', 'graph/index.md', 'system/repo.md']);
  assert.equal(new Set(labels).size, labels.length, 'no artifact injected twice');

  // The overview appears once, not once per copy.
  assert.equal(out.split('Codebase Index').length - 1, 1);
});

test('a captured fact is written to exactly one file and recalled next turn', () => {
  writer.appendChatMemory({ root: repo, facts: ['[tooling] Builds with swift build, never Xcode'] });

  // Exactly one chat-memory.md anywhere under the repo.
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'chat-memory.md') found.push(path.relative(repo, p));
    }
  };
  walk(repo);
  assert.deepEqual(found, [path.join('system', 'memory', 'chat-memory.md')]);

  // And it is recalled on the next render.
  const out = memory.renderGraphifyMemory({ indexedRepos: [{ path: repo, name: 'demo' }] }, U, null, 'how do I build?');
  assert.match(out, /Builds with swift build, never Xcode/);
});

test('a second capture UPDATES the same file — facts accumulate, files do not', () => {
  const before = fs.readFileSync(path.join(repo, 'system/memory/chat-memory.md'), 'utf8');
  writer.appendChatMemory({ root: repo, facts: ['[convention] Tests live in Tests/<Target>Tests'] });
  const after = fs.readFileSync(path.join(repo, 'system/memory/chat-memory.md'), 'utf8');

  assert.notEqual(before, after, 'the file was updated');
  const facts = writer.readChatMemoryFacts(repo);
  assert.equal(facts.length, 2, 'both facts retained in one file');
  assert.equal(fs.readdirSync(path.join(repo, 'system/memory')).filter((f) => f.startsWith('chat-memory')).length, 1,
    'no sibling/backup copy left behind');
});

test('re-capturing a known fact is a no-op (no duplicate line)', () => {
  const saved = writer.appendChatMemory({ root: repo, facts: ['the project builds with swift build, never Xcode'] });
  assert.equal(saved.length, 2, 'a paraphrase of a known fact must not be appended again');
});

test('a superseded fact is removed, not left alongside its replacement', () => {
  writer.appendChatMemory({
    root: repo,
    facts: ['[tooling] Builds with Bazel'],
    remove: ['[tooling] Builds with swift build, never Xcode'],
  });
  const facts = writer.readChatMemoryFacts(repo);
  assert.ok(facts.some((f) => f.includes('Bazel')));
  assert.ok(!facts.some((f) => f.includes('swift build')), 'outdated fact must be gone');
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  fs.rmSync(repo, { recursive: true, force: true });
});
