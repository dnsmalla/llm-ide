// Tests for GraphService (Phase 2 service layer).
//
// These exercise the service against a real temp filesystem via the Phase 1
// storage layer. Assertion data follows the shipped Phase 1 types: GraphNode
// uses `title` (not `label`) and GraphData is `{ nodes, edges }` with no
// `mode` field. Cleanup tracks the temp dir directly (rm -r of the parent, as
// in some drafts, would delete the whole per-user temp root since
// path.dirname('/a/b/c/') === '/a/b').

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { graphService } from '../services/graph-service.ts';
import { writeGraphFile, readDocFingerprint } from '../storage/graph-storage.ts';
import type { GraphData } from '../types/graph.ts';

function makeRepo() {
  const dir = path.join(
    tmpdir(),
    `llm-ide-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const root = pathToFileURL(dir + '/');
  return { dir, root };
}

async function cleanup(dir: string) {
  await rm(dir, { recursive: true, force: true });
}

test('GraphService.generateGraph returns empty graph for new repo', async () => {
  const { dir, root } = makeRepo();
  try {
    const result = await graphService.generateGraph(root, 'code');
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
  } finally {
    await cleanup(dir);
  }
});

test('GraphService.generateGraph reads existing graph', async () => {
  const { dir, root } = makeRepo();
  try {
    const existingGraph: GraphData = {
      nodes: [{ id: 'test', title: 'Test', kind: 'file' }],
      edges: []
    };
    await writeGraphFile(root, existingGraph);

    const result = await graphService.generateGraph(root, 'code');

    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].id, 'test');
  } finally {
    await cleanup(dir);
  }
});

test('GraphService.queryGraph finds matching nodes', async () => {
  const { dir, root } = makeRepo();
  try {
    const graph: GraphData = {
      nodes: [
        { id: 'file1', title: 'Component', kind: 'file' },
        { id: 'file2', title: 'TestFile', kind: 'file' }
      ],
      edges: []
    };
    await writeGraphFile(root, graph);

    const results = await graphService.queryGraph(root, 'component');

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'file1');
  } finally {
    await cleanup(dir);
  }
});

test('GraphService.queryGraph respects limit', async () => {
  const { dir, root } = makeRepo();
  try {
    const graph: GraphData = {
      nodes: Array.from({ length: 20 }, (_, i) => ({
        id: `file${i}`,
        title: `Component${i}`,
        kind: 'file' as const
      })),
      edges: []
    };
    await writeGraphFile(root, graph);

    const results = await graphService.queryGraph(root, 'component', 5);

    assert.equal(results.length, 5);
  } finally {
    await cleanup(dir);
  }
});

test('GraphService.queryGraph returns empty for empty query', async () => {
  const { dir, root } = makeRepo();
  try {
    const graph: GraphData = {
      nodes: [{ id: 'file1', title: 'Component', kind: 'file' }],
      edges: []
    };
    await writeGraphFile(root, graph);

    const results = await graphService.queryGraph(root, '');

    assert.equal(results.length, 0);
  } finally {
    await cleanup(dir);
  }
});

test('GraphService.findRelatedCode returns empty list (stub)', async () => {
  const { dir, root } = makeRepo();
  try {
    const results = await graphService.findRelatedCode(root, 'anything');
    assert.deepEqual(results, []);
  } finally {
    await cleanup(dir);
  }
});

test('GraphService.regenerateGraph writes fingerprint', async () => {
  const { dir, root } = makeRepo();
  try {
    await graphService.regenerateGraph(root);

    const fingerprint = await readDocFingerprint(root);

    assert.ok(fingerprint, 'expected a doc fingerprint to be written');
  } finally {
    await cleanup(dir);
  }
});

test('GraphService.queryGraph degrades gracefully when storage throws', async () => {
  // repoRoot points at a file (not a dir) so the graph-dir read throws a
  // non-ENOENT error, exercising the catch-and-return-empty branch.
  const { dir, root } = makeRepo();
  try {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(dir), { recursive: true });
    await writeFile(dir, 'i am a file, not a directory');

    const results = await graphService.queryGraph(root, 'component');

    assert.deepEqual(results, []);
  } finally {
    await cleanup(dir);
  }
});
