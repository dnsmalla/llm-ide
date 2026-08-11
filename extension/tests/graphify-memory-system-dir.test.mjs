// The Mac app's MemoryStore writes curated + archived memory under
// `<repo>/system/` — hand-authored `repo.md` project facts, `faults/` reports,
// and saved `q&a/` entries. The reader used to look for `bugs/` and `q&a/`
// inside `graphify-out/memory/`, a path NOTHING has ever written, so all three
// were silently invisible to the agent. These tests pin the real locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_graphify-sysdir-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { renderGraphifyMemory } = await import('../graphkit/memory.mjs');
const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function cleanupDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

function freshUser(tag) {
  cleanupDb();
  db.getDb();
  return users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
}

// Build a repo with the given `<relative path>: contents` map and run the
// renderer against it as an allow-listed indexed repo.
function withRepo(tag, files, assertions) {
  const U = freshUser(tag);
  const repoAbs = path.join(__dirname, `_graphify-sysdir-repo-${tag}-${Date.now()}`);
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(repoAbs, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    db.addUserRepo(U, repoAbs);
    assertions(renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: tag }] }, U));
  } finally {
    cleanupDb();
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
}

test('curated system/repo.md project facts reach the agent', () => {
  withRepo('facts', {
    'system/repo.md': '# Project facts\n\n## Stack\n\nSwift 6, SPM only — never CocoaPods.\n',
  }, (out) => {
    assert.match(out, /system\/repo\.md/);
    assert.match(out, /never CocoaPods/);
  });
});

test('system/faults and system/q&a entries reach the agent', () => {
  withRepo('faults', {
    'system/faults/2026-01-01-caption-drop.md': '# Captions dropped on rejoin\nstatus: open\n',
    'system/q&a/2026-01-02-why-wal.md': '# Why WAL mode\nReaders never block writers.\n',
  }, (out) => {
    assert.match(out, /faults\/ \(1\)/);
    assert.match(out, /Captions dropped on rejoin/);
    assert.match(out, /q&a\/ \(1\)/);
    assert.match(out, /Readers never block writers/);
  });
});

test('curated project facts and the generated overview are separate, single files', () => {
  withRepo('both', {
    'system/repo.md': '# Project facts\n\nHAND WRITTEN FACT\n',
    // The generated overview lives ONLY here — it used to also be copied to
    // `graphify-out/memory/repo.md`, colliding by name with the curated file.
    'system/graph/index.md': '# Codebase Index\n\nGENERATED OVERVIEW\n',
  }, (out) => {
    assert.match(out, /### system\/repo\.md/);
    assert.match(out, /### graph\/index\.md/);
    assert.match(out, /HAND WRITTEN FACT/);
    assert.match(out, /GENERATED OVERVIEW/);
  });
});

test('memory left in the legacy graphify-out tree is still read', () => {
  // A repo the Mac app hasn't regenerated since the consolidation. Read-only
  // fallback — nothing writes there any more.
  withRepo('legacy', {
    'graphify-out/memory/graph-notes.md': '# Graph notes\n\nLEGACY GRAPH NOTES\n',
    'graphify-out/memory/chat-memory.md': '# Chat memory\n- LEGACY FACT\n',
  }, (out) => {
    assert.match(out, /LEGACY GRAPH NOTES/);
    assert.match(out, /LEGACY FACT/);
  });
});

test('the canonical file wins when both locations somehow hold one', () => {
  withRepo('shadow', {
    'system/memory/graph-notes.md': '# Graph notes\n\nCANONICAL\n',
    'graphify-out/memory/graph-notes.md': '# Graph notes\n\nSTALE LEGACY\n',
  }, (out) => {
    assert.match(out, /CANONICAL/);
    assert.doesNotMatch(out, /STALE LEGACY/);
  });
});

test('fault listing keeps the NEWEST entries, not the oldest', () => {
  // Filenames are ISO-timestamp prefixed, so ascending order is oldest-first.
  // Ten faults with a cap of eight must drop the two oldest.
  const files = {};
  for (let i = 1; i <= 10; i += 1) {
    const day = String(i).padStart(2, '0');
    files[`system/faults/2026-01-${day}-fault.md`] = `# FAULT-${day}\n`;
  }
  withRepo('newest', files, (out) => {
    assert.match(out, /faults\/ \(8\)/);
    assert.doesNotMatch(out, /FAULT-01/);
    assert.doesNotMatch(out, /FAULT-02/);
    assert.match(out, /FAULT-03/);
    assert.match(out, /FAULT-10/);
  });
});

test('a repo with only system/ memory still renders a block', () => {
  // Previously a repo with faults but no graphify-out/ fell through to the
  // "no memory generated yet" placeholder.
  withRepo('sysonly', {
    'system/faults/2026-01-01-x.md': '# Only a fault report here\n',
  }, (out) => {
    assert.match(out, /Only a fault report here/);
    assert.doesNotMatch(out, /No code-graph memory generated/);
  });
});
