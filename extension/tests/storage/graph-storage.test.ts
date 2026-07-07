// Tests for the graph storage layer.
//
// Covers: getGraphDir path, read/write round-trip, empty-graph default for
// missing files, recursive directory creation, atomic write (no leftover
// temp files), CORRUPTED typed error for invalid JSON, repo roots with
// spaces (percent-decoding), and doc-fingerprint read/write round-trip.
//
// Run: node --test tests/storage/graph-storage.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getGraphDir,
  readGraphFile,
  writeGraphFile,
  readDocFingerprint,
  writeDocFingerprint,
  GraphStorageError
} from '../../graphkit/storage/graph-storage.ts';
import type { GraphData } from '../../graphkit/types/graph.ts';

// Each test gets its own fresh temp repo root, cleaned up on teardown.
function makeRepo(): { root: URL; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'graphstore-'));
  return { root: pathToFileURL(dir), dir };
}

test('getGraphDir returns the .llm-ide/graph path under the repo root', () => {
  const { dir, root } = makeRepo();
  try {
    assert.equal(getGraphDir(root), join(dir, '.llm-ide', 'graph'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getGraphDir handles repo roots containing spaces (percent-decoded)', () => {
  // A repo path like "/Users/Jane Doe/project" is percent-encoded in a file:
  // URL ("/Jane%20Doe/..."). getGraphDir must decode it back to the real path;
  // using URL.pathname directly would keep the raw %20 and silently target a
  // non-existent directory.
  const dir = mkdtempSync(join(tmpdir(), 'graphstore with space-'));
  try {
    const root = pathToFileURL(dir);
    assert.equal(getGraphDir(root), join(dir, '.llm-ide', 'graph'));
    // And the encoded form must NOT leak through.
    assert.ok(!getGraphDir(root).includes('%20'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readGraphFile returns an empty graph when graph.json is absent', async () => {
  const { dir, root } = makeRepo();
  try {
    const result = await readGraphFile(root);

    assert.deepEqual(result, { nodes: [], edges: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeGraphFile then readGraphFile round-trips nodes and edges', async () => {
  const { dir, root } = makeRepo();
  try {
    const graph: GraphData = {
      nodes: [
        { id: '1', title: 'main.ts', kind: 'codeFile' },
        { id: '2', title: 'App', kind: 'codeSymbol' }
      ],
      edges: [{ fromId: '1', toId: '2', kind: 'partOf' }]
    };

    await writeGraphFile(root, graph);
    const result = await readGraphFile(root);

    assert.equal(result.nodes.length, 2);
    assert.equal(result.nodes[0].id, '1');
    assert.equal(result.nodes[0].kind, 'codeFile');
    assert.equal(result.nodes[1].id, '2');
    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0].fromId, '1');
    assert.equal(result.edges[0].toId, '2');
    assert.equal(result.edges[0].kind, 'partOf');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeGraphFile creates the graph directory if it is missing', async () => {
  const { dir, root } = makeRepo();
  try {
    await writeGraphFile(root, { nodes: [], edges: [] });

    assert.ok(existsSync(join(dir, '.llm-ide', 'graph', 'graph.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeGraphFile overwrites an existing graph atomically (no leftover temp files)', async () => {
  const { dir, root } = makeRepo();
  try {
    await writeGraphFile(root, { nodes: [], edges: [] });
    await writeGraphFile(root, {
      nodes: [{ id: '1', title: 'Test', kind: 'docPage' }],
      edges: []
    });

    const result = await readGraphFile(root);
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].id, '1');

    // Atomic write must leave no temp files behind in the graph dir.
    const graphDir = join(dir, '.llm-ide', 'graph');
    const entries = readdirSync(graphDir);
    assert.deepEqual(entries.sort(), ['graph.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeGraphFile writes to the real (decoded) path when the repo root has a space', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graphstore with space-'));
  try {
    const root = pathToFileURL(dir);

    await writeGraphFile(root, {
      nodes: [{ id: '1', title: 'Test', kind: 'codeFile' }],
      edges: []
    });

    // File must land at the decoded path on disk...
    assert.ok(
      existsSync(join(dir, '.llm-ide', 'graph', 'graph.json')),
      'file should exist at the decoded (space-containing) path'
    );
    // ...and read back through the same API.
    const result = await readGraphFile(root);
    assert.equal(result.nodes.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readGraphFile throws CORRUPTED for invalid JSON', async () => {
  const { dir, root } = makeRepo();
  try {
    const graphDir = getGraphDir(root);
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, 'graph.json'), 'invalid json');

    await assert.rejects(
      () => readGraphFile(root),
      (err: unknown) => {
        assert.ok(err instanceof GraphStorageError, 'should be GraphStorageError');
        assert.equal((err as GraphStorageError).code, 'CORRUPTED');
        assert.equal(
          (err as GraphStorageError).path,
          join(dir, '.llm-ide', 'graph', 'graph.json')
        );
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDocFingerprint returns null when the fingerprint is absent', async () => {
  const { dir, root } = makeRepo();
  try {
    const result = await readDocFingerprint(root);

    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeDocFingerprint then readDocFingerprint round-trips', async () => {
  const { dir, root } = makeRepo();
  try {
    await writeDocFingerprint(root, 'abc123');
    const result = await readDocFingerprint(root);

    assert.equal(result, 'abc123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeDocFingerprint creates the graph directory if it is missing', async () => {
  const { dir, root } = makeRepo();
  try {
    await writeDocFingerprint(root, 'abc123');

    assert.ok(existsSync(join(dir, '.llm-ide', 'graph', 'doc-fingerprint.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GraphStorageError carries its code, message, and path', () => {
  const err = new GraphStorageError('CORRUPTED', 'boom', '/x/y');
  assert.equal(err.code, 'CORRUPTED');
  assert.equal(err.message, 'boom');
  assert.equal(err.path, '/x/y');
  assert.equal(err.name, 'GraphStorageError');
  assert.ok(err instanceof Error);
});
