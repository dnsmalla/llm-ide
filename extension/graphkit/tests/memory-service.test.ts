// Tests for MemoryService (Phase 2 service layer).
//
// These exercise the service against a real temp filesystem via the Phase 1
// storage layer. Assertion field names follow the shipped Phase 1 types:
// ValidationResult carries detail in `details` (string), not `errors[]`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { memoryService } from '../services/memory-service.ts';
import { readMemoryFile } from '../storage/memory-storage.ts';

function makeRepo() {
  const dir = path.join(tmpdir(), `llm-ide-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const root = pathToFileURL(dir + '/');
  return { dir, root };
}

async function cleanup(dir: string) {
  await rm(dir, { recursive: true, force: true });
}

test('MemoryService.readMemory returns empty data for missing repo', async () => {
  const { dir, root } = makeRepo();
  try {
    const result = await memoryService.readMemory(root);
    assert.deepEqual(result, { facts: [], bugs: [], qa: [] });
  } finally {
    await cleanup(dir);
  }
});

test('MemoryService.readChatMemory returns empty array for missing file', async () => {
  const { dir, root } = makeRepo();
  try {
    const facts = await memoryService.readChatMemory(root);
    assert.deepEqual(facts, []);
  } finally {
    await cleanup(dir);
  }
});

test('MemoryService.writeChatMemory writes facts atomically', async () => {
  const { dir, root } = makeRepo();
  try {
    const facts = [
      { text: 'test fact', category: 'convention' as const, timestamp: Date.now(), source: 'agent' as const }
    ];

    await memoryService.writeChatMemory(root, facts);
    const read = await memoryService.readChatMemory(root);

    assert.equal(read.length, 1);
    assert.equal(read[0].text, 'test fact');
  } finally {
    await cleanup(dir);
  }
});

test('MemoryService.validateFact flags text longer than 280 characters', async () => {
  const { dir, root } = makeRepo();
  try {
    const longFact = {
      text: 'x'.repeat(281),
      category: 'convention' as const,
      timestamp: Date.now(),
      source: 'agent' as const
    };

    const result = await memoryService.validateFact(root, longFact);

    assert.equal(result.valid, false);
    assert.ok(
      typeof result.details === 'string' && result.details.includes('280 characters'),
      `expected details to mention the 280-character limit, got: ${result.details}`
    );
  } finally {
    await cleanup(dir);
  }
});

test('MemoryService.validateFact checks file references', async () => {
  const { dir, root } = makeRepo();
  try {
    await mkdir(path.join(dir, '.llm-ide', 'memory'), { recursive: true });
    await writeFile(path.join(dir, 'test.ts'), 'content');

    const factWithBadRef = {
      text: 'test fact',
      category: 'convention' as const,
      timestamp: Date.now(),
      source: 'agent' as const,
      metadata: { files: ['test.ts', 'missing.ts'] }
    };

    const result = await memoryService.validateFact(root, factWithBadRef);

    assert.equal(result.valid, false);
    assert.equal(result.reason, 'file_not_found');
    assert.ok(
      typeof result.details === 'string' && result.details.includes('missing.ts'),
      `expected details to reference missing.ts, got: ${result.details}`
    );
  } finally {
    await cleanup(dir);
  }
});

test('MemoryService.validateFact passes a valid fact', async () => {
  const { dir, root } = makeRepo();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'real.ts'), 'content');
    const fact = {
      text: 'uses path aliases',
      category: 'convention' as const,
      timestamp: Date.now(),
      source: 'agent' as const,
      metadata: { files: ['real.ts'] }
    };
    const result = await memoryService.validateFact(root, fact);
    assert.equal(result.valid, true);
    assert.equal(result.details, undefined);
  } finally {
    await cleanup(dir);
  }
});

test('MemoryService.validateAllFacts reports counts and errors', async () => {
  const { dir, root } = makeRepo();
  try {
    // NOTE: Phase 1 writeChatMemory/readChatMemory only persist the `text`
    // field (as "- text" lines); metadata/category/source do NOT round-trip.
    // So we use a too-long-text fact as the invalid case — text survives the
    // round-trip and trips the 280-char check on re-validation.
    const facts = [
      { text: 'good fact', category: 'convention' as const, timestamp: Date.now(), source: 'agent' as const },
      { text: 'x'.repeat(281), category: 'convention' as const, timestamp: Date.now(), source: 'agent' as const }
    ];
    await memoryService.writeChatMemory(root, facts);

    const report = await memoryService.validateAllFacts(root);

    assert.equal(report.valid, 1);
    assert.equal(report.invalid, 1);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].fact.text.length, 281);
    assert.equal(report.errors[0].reason, 'Fact text exceeds 280 characters');
  } finally {
    await cleanup(dir);
  }
});

test('MemoryService.updateRepoMD writes content atomically', async () => {
  const { dir, root } = makeRepo();
  try {
    await memoryService.updateRepoMD(root, '# Test\n\nNew content');
    const content = await readMemoryFile(root, 'repo.md');

    assert.ok(content.includes('New content'));
  } finally {
    await cleanup(dir);
  }
});

test('MemoryService.readMemory degrades gracefully when storage throws a non-NOT_FOUND error', async () => {
  // A path that exists as a file (not a dir) makes the memory-dir read throw a
  // non-ENOENT error, exercising the catch-and-return-empty branch.
  const { dir, root } = makeRepo();
  try {
    await mkdir(path.dirname(dir), { recursive: true });
    await writeFile(dir, 'i am a file, not a directory'); // repoRoot points at a file
    const result = await memoryService.readMemory(root);
    assert.deepEqual(result, { facts: [], bugs: [], qa: [] });
  } finally {
    await cleanup(dir);
  }
});
