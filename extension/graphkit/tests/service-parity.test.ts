// Cross-platform service parity tests (Phase 2, Task 7).
//
// These are INTEGRATION tests: they chain multiple services together against a
// real temp filesystem and verify the behaviors that must match the Swift Mac
// app's service tier (ServiceParityTests.swift) one-for-one. The per-service
// unit tests (memory/graph/automation-service.test.ts) already cover each
// service in isolation; this file covers the end-to-end workflows and the
// shared on-disk contract that both platforms depend on.
//
// Drift corrections vs. the original task template (forced by the SHIPPED
// Phase 1 surface — the sibling per-service test files document the same
// drift):
//   - The template imported `renderRepoMemory` from `../graphkit/memory.mjs`.
//     That symbol does not exist in the shipped module (see memory-service.ts
//     header); importing it would crash the module at load time. Removed.
//   - GraphNode uses `title` (not `label`), and GraphData is `{ nodes, edges }`
//     with no `mode` field. The template's `label`/`mode` literals would never
//     match `queryGraph` (which searches `title`) and would write a field no
//     reader expects. Corrected to `title`; `mode` dropped.
//   - Imports use `.ts` specifiers and `../services` / `../storage` paths (the
//     template's `../graphkit/services/index.js` path/extension was wrong both
//     ways) so the file loads under `node --test --experimental-strip-types`.
//   - Cleanup tracks the temp `dir` directly (`rm(dir)`). The template's
//     `rm(path.dirname(decodeURIComponent(root.pathname)))` would delete the
//     PARENT of the temp dir, since `path.dirname('/a/b/c/') === '/a/b'`.
//
// Run: `node --test --experimental-strip-types graphkit/tests/service-parity.test.ts`
// (the extension's `npm test` globs `tests/**`, which does not include
// `graphkit/tests/`, so graphkit tests are invoked directly — same as the
// sibling per-service test files).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { memoryService, graphService, automationService } from '../services/index.ts';
import { writeGraphFile } from '../storage/graph-storage.ts';
import { readChatMemory } from '../storage/memory-storage.ts';
import type { ChatMemoryFact } from '../types/memory.ts';
import type { GraphData } from '../types/graph.ts';

function makeRepo() {
  const dir = path.join(
    tmpdir(),
    `llm-ide-parity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const root = pathToFileURL(dir + '/');
  return { dir, root };
}

async function cleanup(dir: string) {
  await rm(dir, { recursive: true, force: true });
}

test('Parity: MemoryService read shape matches the cross-platform contract', async () => {
  const { dir, root } = makeRepo();
  try {
    // Fresh repo: readMemory must degrade gracefully and return the canonical
    // empty shape { facts, bugs, qa } — the Swift MemoryService returns the
    // same empty MemoryData(facts: [], bugs: [], qa: []).
    const empty = await memoryService.readMemory(root);
    assert.deepEqual(empty, { facts: [], bugs: [], qa: [] });

    // Seed a chat-memory.md via the storage layer (the on-disk format both
    // platforms read). The service must surface those facts.
    await mkdir(path.join(dir, '.llm-ide', 'memory'), { recursive: true });
    await writeFile(
      path.join(dir, '.llm-ide', 'memory', 'chat-memory.md'),
      '# Chat memory\n\n- This project uses TypeScript\n'
    );

    const populated = await memoryService.readMemory(root);
    assert.equal(populated.facts.length, 1);
    assert.equal(populated.facts[0].text, 'This project uses TypeScript');
    // bugs/qa are forward-looking placeholders, always empty today (parity).
    assert.equal(populated.bugs.length, 0);
    assert.equal(populated.qa.length, 0);
  } finally {
    await cleanup(dir);
  }
});

test('Parity: GraphService query matches the cross-platform contract', async () => {
  const { dir, root } = makeRepo();
  try {
    // Write a graph via the Phase 1 storage layer using the SHIPPED GraphData
    // shape (GraphNode.title, no mode field). queryGraph searches `title`
    // case-insensitively on both platforms.
    const graph: GraphData = {
      nodes: [
        { id: 'test.ts', title: 'test.ts', kind: 'file' },
        { id: 'other.ts', title: 'other.ts', kind: 'file' }
      ],
      edges: []
    };
    await writeGraphFile(root, graph);

    const results = await graphService.queryGraph(root, 'test', 10);

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'test.ts');
    assert.equal(results[0].title, 'test.ts');
  } finally {
    await cleanup(dir);
  }
});

test('Parity: AutomationService cleanup is safe on an empty repo', async () => {
  const { dir, root } = makeRepo();
  try {
    // No facts on disk — cleanup must not crash and must report nothing
    // removed/kept. The Swift AutomationService makes the same guarantee.
    const report = await automationService.cleanupStaleFacts(root, 30);

    assert.equal(report.removed.length, 0);
    assert.equal(report.kept.length, 0);
    assert.equal(report.errors.length, 0);
  } finally {
    await cleanup(dir);
  }
});

test('Parity: end-to-end write → read → validate → cleanup keeps a fresh, valid fact', async () => {
  const { dir, root } = makeRepo();
  try {
    // 1. Write a fresh, valid fact through MemoryService.
    const now = Date.now();
    const facts: ChatMemoryFact[] = [
      {
        text: 'This project uses TypeScript',
        category: 'tooling',
        timestamp: now,
        source: 'agent'
      }
    ];
    await memoryService.writeChatMemory(root, facts);

    // 2. Read it back through the storage layer directly, confirming the
    //    on-disk chat-memory.md line format that both platforms share.
    const stored = await readChatMemory(root);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].text, 'This project uses TypeScript');

    // 3. Validate the read-back fact: short text, no file refs -> valid.
    const readViaService = await memoryService.readChatMemory(root);
    assert.equal(readViaService.length, 1);
    const validation = await memoryService.validateFact(root, readViaService[0]);
    assert.equal(validation.valid, true);

    // 4. Cleanup with a 30-day cutoff must KEEP the fresh, valid fact (it is
    //    neither stale nor invalid). Parity with the Swift end-to-end test.
    const cleanupReport = await automationService.cleanupStaleFacts(root, 30);
    assert.equal(cleanupReport.kept.length, 1);
    assert.equal(cleanupReport.removed.length, 0);
    assert.equal(cleanupReport.kept[0].text, 'This project uses TypeScript');
  } finally {
    await cleanup(dir);
  }
});

test('Parity: AutomationService detects the cross-platform contradiction signature', async () => {
  // The contradiction pair ("uses npm" vs "does not use npm") is the canonical
  // fixture used by BOTH platforms' AutomationService tests. Verifying the TS
  // side flags it guarantees the same input yields a contradiction on Swift.
  const { dir, root } = makeRepo();
  try {
    const facts: ChatMemoryFact[] = [
      {
        text: 'This project uses npm for package management',
        category: 'tooling',
        timestamp: Date.now(),
        source: 'agent'
      },
      {
        text: 'This project does not use npm',
        category: 'tooling',
        timestamp: Date.now(),
        source: 'agent'
      }
    ];
    await memoryService.writeChatMemory(root, facts);

    const report = await automationService.detectContradictions(root);

    assert.ok(
      report.contradictions.length > 0,
      'expected the uses/does-not-use npm pair to be flagged as a contradiction'
    );
  } finally {
    await cleanup(dir);
  }
});
