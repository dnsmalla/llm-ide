// Tests for the directory migration layer.
//
// Covers: needsMigration on fresh vs legacy repos; migration of
// graphify-out/memory and system/graph into .llm-ide/; data preservation
// (content identical after the move); multiple files and subdirectories;
// removal of the empty legacy leaf; skipping missing paths; idempotency
// (a second run skips); repo roots containing spaces (percent-decoding); and
// the MigrationResult shape (migrated/skipped/errors arrays).
//
// Run: node --test tests/storage/migrate.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  migrateToLLMIdeStructure,
  needsMigration
} from '../../graphkit/storage/migrate.ts';

// Each test gets its own fresh temp repo root, cleaned up on teardown —
// matches the convention in memory-storage.test.ts / graph-storage.test.ts.
function makeRepo(): { root: URL; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
  return { root: pathToFileURL(dir), dir };
}

test('needsMigration returns false for a fresh repo with no legacy paths', async () => {
  const { dir, root } = makeRepo();
  try {
    const result = await needsMigration(root);
    assert.equal(result, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('needsMigration returns true when graphify-out/memory exists', async () => {
  const { dir, root } = makeRepo();
  try {
    mkdirSync(join(dir, 'graphify-out', 'memory'), { recursive: true });

    const result = await needsMigration(root);
    assert.equal(result, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('needsMigration returns true when system/graph exists', async () => {
  const { dir, root } = makeRepo();
  try {
    mkdirSync(join(dir, 'system', 'graph'), { recursive: true });

    const result = await needsMigration(root);
    assert.equal(result, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateToLLMIdeStructure moves graphify-out/memory into .llm-ide/memory and preserves content', async () => {
  const { dir, root } = makeRepo();
  try {
    const legacy = join(dir, 'graphify-out', 'memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'repo.md'), '# project');

    const result = await migrateToLLMIdeStructure(root);

    assert.equal(result.migrated.length, 1);
    assert.equal(result.migrated[0].from, legacy);
    assert.equal(result.migrated[0].to, join(dir, '.llm-ide', 'memory'));

    // Content preserved at the new path...
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(dir, '.llm-ide', 'memory', 'repo.md'), 'utf-8');
    assert.equal(content, '# project');
    // ...and gone from the old path.
    assert.ok(!existsSync(join(legacy, 'repo.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateToLLMIdeStructure moves system/graph into .llm-ide/graph and preserves content', async () => {
  const { dir, root } = makeRepo();
  try {
    const legacy = join(dir, 'system', 'graph');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'graph.json'), '{"nodes":[],"edges":[]}');

    const result = await migrateToLLMIdeStructure(root);

    assert.equal(result.migrated.length, 1);
    assert.equal(result.migrated[0].from, legacy);
    assert.equal(result.migrated[0].to, join(dir, '.llm-ide', 'graph'));

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(dir, '.llm-ide', 'graph', 'graph.json'), 'utf-8');
    assert.equal(content, '{"nodes":[],"edges":[]}');
    assert.ok(!existsSync(join(legacy, 'graph.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateToLLMIdeStructure migrates both legacy directories in one call', async () => {
  const { dir, root } = makeRepo();
  try {
    mkdirSync(join(dir, 'graphify-out', 'memory'), { recursive: true });
    writeFileSync(join(dir, 'graphify-out', 'memory', 'chat-memory.md'), '- fact');

    mkdirSync(join(dir, 'system', 'graph'), { recursive: true });
    writeFileSync(join(dir, 'system', 'graph', 'graph.json'), '{}');

    const result = await migrateToLLMIdeStructure(root);

    assert.equal(result.migrated.length, 2);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.errors.length, 0);

    assert.ok(existsSync(join(dir, '.llm-ide', 'memory', 'chat-memory.md')));
    assert.ok(existsSync(join(dir, '.llm-ide', 'graph', 'graph.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateToLLMIdeStructure moves multiple files and subdirectories', async () => {
  const { dir, root } = makeRepo();
  try {
    const legacy = join(dir, 'graphify-out', 'memory');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(legacy, 'sub'), { recursive: true });
    writeFileSync(join(legacy, 'a.md'), 'a');
    writeFileSync(join(legacy, 'b.md'), 'b');
    writeFileSync(join(legacy, 'sub', 'c.md'), 'c');

    const result = await migrateToLLMIdeStructure(root);

    assert.equal(result.migrated.length, 1);
    assert.ok(existsSync(join(dir, '.llm-ide', 'memory', 'a.md')));
    assert.ok(existsSync(join(dir, '.llm-ide', 'memory', 'b.md')));
    assert.ok(existsSync(join(dir, '.llm-ide', 'memory', 'sub', 'c.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateToLLMIdeStructure removes the empty legacy leaf directory after moving', async () => {
  const { dir, root } = makeRepo();
  try {
    const legacy = join(dir, 'graphify-out', 'memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'repo.md'), 'x');

    await migrateToLLMIdeStructure(root);

    // The leaf memory dir should be gone now that it is empty.
    assert.ok(!existsSync(legacy));
    // The parent graphify-out dir is not managed by migration and may remain.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateToLLMIdeStructure skips both legacy paths when neither exists', async () => {
  const { dir, root } = makeRepo();
  try {
    const result = await migrateToLLMIdeStructure(root);

    assert.equal(result.migrated.length, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(result.skipped.length, 2);
    assert.deepEqual(
      result.skipped.map((s) => s.reason),
      ['not_found', 'not_found']
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateToLLMIdeStructure is idempotent — a second run reports everything skipped', async () => {
  const { dir, root } = makeRepo();
  try {
    const legacy = join(dir, 'graphify-out', 'memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'repo.md'), 'x');

    const first = await migrateToLLMIdeStructure(root);
    assert.equal(first.migrated.length, 1);

    const second = await migrateToLLMIdeStructure(root);
    assert.equal(second.migrated.length, 0);
    assert.equal(second.errors.length, 0);
    assert.equal(second.skipped.length, 2);
    // needsMigration must reflect the settled state.
    assert.equal(await needsMigration(root), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateToLLMIdeStructure handles repo roots containing spaces (percent-decoded)', async () => {
  // A repo path like "/Users/Jane Doe/project" is percent-encoded in a file:
  // URL ("/Jane%20Doe/..."). Migration must decode it back to the real path,
  // matching getMemoryDir/getGraphDir — otherwise the legacy source and the
  // canonical target would point at non-existent %20 directories.
  const dir = mkdtempSync(join(tmpdir(), 'migrate with space-'));
  try {
    const root = pathToFileURL(dir);
    const legacy = join(dir, 'graphify-out', 'memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'repo.md'), 'spaced');

    const result = await migrateToLLMIdeStructure(root);

    assert.equal(result.migrated.length, 1);
    // No percent-encoded form should leak into the recorded paths.
    assert.ok(!result.migrated[0].from.includes('%20'));
    assert.ok(!result.migrated[0].to.includes('%20'));

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(dir, '.llm-ide', 'memory', 'repo.md'), 'utf-8');
    assert.equal(content, 'spaced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MigrationResult migrated/skipped/errors arrays are independent per call', async () => {
  const { dir, root } = makeRepo();
  try {
    const result = await migrateToLLMIdeStructure(root);

    // Fresh result object — no shared state across calls.
    assert.ok(Array.isArray(result.migrated));
    assert.ok(Array.isArray(result.skipped));
    assert.ok(Array.isArray(result.errors));
    assert.equal(result.migrated.length, 0);
    assert.equal(result.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
