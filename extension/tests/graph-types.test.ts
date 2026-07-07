// Test graph type definitions
// This file validates that the types are properly defined and can be used

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import type definitions - use `import type` since these are TypeScript-only
// interfaces that are erased at runtime by --experimental-strip-types
import type {
  GraphData,
  GraphNode,
  GraphEdge,
  GraphNodeKind,
  GraphEdgeKind,
  GraphMode,
  CodeRef
} from '../graphkit/types/graph.ts';

test('graph types - GraphData structure', () => {
  const graphData: GraphData = {
    nodes: [],
    edges: []
  };

  assert(Array.isArray(graphData.nodes));
  assert(Array.isArray(graphData.edges));
});

test('graph types - GraphNode structure', () => {
  const node: GraphNode = {
    id: 'node-1',
    title: 'App.ts',
    kind: 'file',
    metadata: {
      path: '/src/App.ts',
      language: 'typescript'
    }
  };

  assert.strictEqual(typeof node.id, 'string');
  assert.strictEqual(typeof node.title, 'string');
  assert.strictEqual(node.kind, 'file');
  assert(node.metadata !== undefined);
  assert.strictEqual(typeof node.metadata.path, 'string');
});

test('graph types - GraphNode without metadata', () => {
  const node: GraphNode = {
    id: 'node-2',
    title: 'README.md',
    kind: 'docPage'
  };

  assert.strictEqual(typeof node.id, 'string');
  assert.strictEqual(node.title, 'README.md');
  assert.strictEqual(node.kind, 'docPage');
  assert.strictEqual(node.metadata, undefined);
});

test('graph types - GraphEdge structure', () => {
  const edge: GraphEdge = {
    fromId: 'node-1',
    toId: 'node-2',
    kind: 'imports'
  };

  assert.strictEqual(typeof edge.fromId, 'string');
  assert.strictEqual(typeof edge.toId, 'string');
  assert.strictEqual(edge.kind, 'imports');
});

test('graph types - GraphNodeKind with all values', () => {
  const kinds: GraphNodeKind[] = [
    'file',
    'symbol',
    'docPage',
    'memoryChunk',
    'memoryDoc'
  ];

  kinds.forEach((kind) => {
    const node: GraphNode = {
      id: `node-${kind}`,
      title: `Test ${kind}`,
      kind
    };
    assert.strictEqual(node.kind, kind);
  });
});

test('graph types - GraphEdgeKind with all values', () => {
  const kinds: GraphEdgeKind[] = [
    'imports',
    'references',
    'contains',
    'relatedTo'
  ];

  kinds.forEach((kind) => {
    const edge: GraphEdge = {
      fromId: 'node-1',
      toId: 'node-2',
      kind
    };
    assert.strictEqual(edge.kind, kind);
  });
});

test('graph types - GraphMode with all values', () => {
  const modes: GraphMode[] = ['code', 'doc', 'all'];

  modes.forEach((mode) => {
    const testMode: GraphMode = mode;
    assert.strictEqual(testMode, mode);
  });
});

test('graph types - CodeRef structure', () => {
  const codeRef: CodeRef = {
    ref: 'src/app.ts:15-25',
    title: 'authenticate function',
    bodyExcerpt: 'export function authenticate(user: User): boolean {',
    rank: 0.95
  };

  assert.strictEqual(typeof codeRef.ref, 'string');
  assert.strictEqual(typeof codeRef.title, 'string');
  assert.strictEqual(typeof codeRef.bodyExcerpt, 'string');
  assert.strictEqual(typeof codeRef.rank, 'number');
  assert.strictEqual(codeRef.rank, 0.95);
});

test('graph types - complete graph example', () => {
  const graphData: GraphData = {
    nodes: [
      {
        id: 'node-1',
        title: 'App.ts',
        kind: 'file',
        metadata: { path: '/src/App.ts' }
      },
      {
        id: 'node-2',
        title: 'authenticate',
        kind: 'symbol',
        metadata: {
          container: 'App.ts',
          line: 15
        }
      },
      {
        id: 'node-3',
        title: 'README.md',
        kind: 'docPage',
        metadata: { path: '/README.md' }
      }
    ],
    edges: [
      {
        fromId: 'node-2',
        toId: 'node-1',
        kind: 'contains'
      },
      {
        fromId: 'node-3',
        toId: 'node-1',
        kind: 'relatedTo'
      }
    ]
  };

  assert.strictEqual(graphData.nodes.length, 3);
  assert.strictEqual(graphData.edges.length, 2);
  assert.strictEqual(graphData.nodes[0].kind, 'file');
  assert.strictEqual(graphData.edges[0].kind, 'contains');
});

test('graph types - GraphData with memory nodes', () => {
  const graphData: GraphData = {
    nodes: [
      {
        id: 'node-1',
        title: 'Memory Chunk 1',
        kind: 'memoryChunk',
        metadata: { source: 'agent-turn-45' }
      },
      {
        id: 'node-2',
        title: 'Architecture Doc',
        kind: 'memoryDoc',
        metadata: { path: '/memory/architecture.md' }
      }
    ],
    edges: [
      {
        fromId: 'node-1',
        toId: 'node-2',
        kind: 'contains'
      }
    ]
  };

  assert.strictEqual(graphData.nodes[0].kind, 'memoryChunk');
  assert.strictEqual(graphData.nodes[1].kind, 'memoryDoc');
  assert.strictEqual(graphData.edges[0].kind, 'contains');
});

test('graph types - CodeRef rank boundaries', () => {
  const lowRank: CodeRef = {
    ref: 'file.ts:1',
    title: 'Low relevance',
    bodyExcerpt: 'code',
    rank: 0.1
  };

  const highRank: CodeRef = {
    ref: 'file.ts:2',
    title: 'High relevance',
    bodyExcerpt: 'code',
    rank: 0.99
  };

  assert(lowRank.rank < highRank.rank);
  assert.strictEqual(lowRank.rank, 0.1);
  assert.strictEqual(highRank.rank, 0.99);
});
