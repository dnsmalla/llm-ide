// Tests for the memory storage layer.
//
// Covers: getMemoryDir path, read/write round-trip, NOT_FOUND typed error,
// recursive directory creation, atomic write (no leftover temp files),
// readRepoMD default, and chat-memory parse/format round-trip.
//
// Run: npm test -- tests/storage/memory-storage.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getMemoryDir,
  readMemoryFile,
  writeMemoryFile,
  readRepoMD,
  readChatMemory,
  writeChatMemory,
  MemoryStorageError
} from '../../graphkit/storage/memory-storage.ts';

// Each test gets its own fresh temp repo root, cleaned up on teardown.
function makeRepo(): { root: URL; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'memstore-'));
  return { root: pathToFileURL(dir), dir };
}

test('getMemoryDir returns the .llm-ide/memory path under the repo root', () => {
  const { dir, root } = makeRepo();
  try {
    assert.equal(getMemoryDir(root), join(dir, '.llm-ide', 'memory'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getMemoryDir handles repo roots containing spaces (percent-decoded)', () => {
  // A repo path like "/Users/Jane Doe/project" is percent-encoded in a file:
  // URL ("/Jane%20Doe/..."). getMemoryDir must decode it back to the real path;
  // using URL.pathname directly would keep the raw %20 and silently target a
  // non-existent directory.
  const dir = mkdtempSync(join(tmpdir(), 'memstore with space-'));
  try {
    const root = pathToFileURL(dir);
    assert.equal(getMemoryDir(root), join(dir, '.llm-ide', 'memory'));
    // And the encoded form must NOT leak through.
    assert.ok(!getMemoryDir(root).includes('%20'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMemoryFile writes to the real (decoded) path when the repo root has a space', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memstore with space-'));
  try {
    const root = pathToFileURL(dir);

    await writeMemoryFile(root, 'test.md', 'content');

    // File must land at the decoded path on disk...
    assert.ok(
      existsSync(join(dir, '.llm-ide', 'memory', 'test.md')),
      'file should exist at the decoded (space-containing) path'
    );
    // ...and read back through the same API.
    const result = await readMemoryFile(root, 'test.md');
    assert.equal(result, 'content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMemoryFile creates the memory directory if it is missing', async () => {
  const { dir, root } = makeRepo();
  try {
    await writeMemoryFile(root, 'test.md', 'content');

    const result = await readMemoryFile(root, 'test.md');
    assert.equal(result, 'content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMemoryFile throws NOT_FOUND for a missing file', async () => {
  const { dir, root } = makeRepo();
  try {
    await assert.rejects(
      () => readMemoryFile(root, 'missing.md'),
      (err: unknown) => {
        assert.ok(err instanceof MemoryStorageError, 'should be MemoryStorageError');
        assert.equal((err as MemoryStorageError).code, 'NOT_FOUND');
        assert.equal(
          (err as MemoryStorageError).path,
          join(dir, '.llm-ide', 'memory', 'missing.md')
        );
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMemoryFile throws NOT_FOUND when the memory dir itself is absent', async () => {
  const { dir, root } = makeRepo();
  try {
    // No write performed -> directory never created.
    await assert.rejects(
      () => readMemoryFile(root, 'anything.md'),
      (err: unknown) => {
        assert.ok(err instanceof MemoryStorageError);
        assert.equal((err as MemoryStorageError).code, 'NOT_FOUND');
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMemoryFile overwrites an existing file atomically (no leftover temp files)', async () => {
  const { dir, root } = makeRepo();
  try {
    await writeMemoryFile(root, 'test.md', 'first');
    await writeMemoryFile(root, 'test.md', 'second');

    const result = await readMemoryFile(root, 'test.md');
    assert.equal(result, 'second');

    // Atomic write must leave no temp files behind in the memory dir.
    const memDir = join(dir, '.llm-ide', 'memory');
    const entries = readdirSync(memDir);
    assert.deepEqual(entries.sort(), ['test.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRepoMD returns empty string when repo.md is absent', async () => {
  const { dir, root } = makeRepo();
  try {
    const result = await readRepoMD(root);
    assert.equal(result, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRepoMD returns file content when repo.md exists', async () => {
  const { dir, root } = makeRepo();
  try {
    await writeMemoryFile(root, 'repo.md', '# My Repo\nA project.');

    const result = await readRepoMD(root);
    assert.equal(result, '# My Repo\nA project.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readChatMemory returns an empty array when chat-memory.md is absent', async () => {
  const { dir, root } = makeRepo();
  try {
    const facts = await readChatMemory(root);
    assert.deepEqual(facts, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readChatMemory parses bullet lines into facts, ignoring the header', async () => {
  const { dir, root } = makeRepo();
  try {
    await writeMemoryFile(
      root,
      'chat-memory.md',
      '# Chat memory\n_Auto-captured._\n\n- fact 1\n- fact 2\n'
    );

    const facts = await readChatMemory(root);

    assert.equal(facts.length, 2);
    assert.equal(facts[0].text, 'fact 1');
    assert.equal(facts[1].text, 'fact 2');
    // Defaulted parser fields
    assert.equal(facts[0].category, 'convention');
    assert.equal(facts[0].source, 'agent');
    assert.equal(typeof facts[0].timestamp, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeChatMemory writes facts with the canonical header', async () => {
  const { dir, root } = makeRepo();
  try {
    const facts = [
      {
        text: 'fact 1',
        category: 'convention' as const,
        timestamp: Date.now(),
        source: 'agent' as const
      }
    ];

    await writeChatMemory(root, facts);

    const content = await readMemoryFile(root, 'chat-memory.md');
    assert.ok(content.includes('# Chat memory'), 'has header');
    assert.ok(content.includes('- fact 1'), 'has the fact bullet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeChatMemory output round-trips back through readChatMemory', async () => {
  const { dir, root } = makeRepo();
  try {
    const facts = [
      {
        text: 'use pnpm not npm',
        category: 'tooling' as const,
        timestamp: Date.now(),
        source: 'ui' as const
      },
      {
        text: 'api lives under /api/v2',
        category: 'architecture' as const,
        timestamp: Date.now(),
        source: 'agent' as const
      }
    ];

    await writeChatMemory(root, facts);
    const parsed = await readChatMemory(root);

    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].text, 'use pnpm not npm');
    assert.equal(parsed[1].text, 'api lives under /api/v2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MemoryStorageError carries its code, message, and path', () => {
  const err = new MemoryStorageError('MIGRATION_FAILED', 'boom', '/x/y');
  assert.equal(err.code, 'MIGRATION_FAILED');
  assert.equal(err.message, 'boom');
  assert.equal(err.path, '/x/y');
  assert.equal(err.name, 'MemoryStorageError');
  assert.ok(err instanceof Error);
});
