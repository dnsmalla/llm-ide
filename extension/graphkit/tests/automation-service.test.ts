// Tests for AutomationService (Phase 2 service layer).
//
// These exercise the service against a real temp filesystem via the Phase 1
// storage layer (capture/regenerate/contradiction/validation-cleanup tests)
// AND via an injected stub MemoryService for the age-based cleanup test.
//
// Why a stub for the age test: the Phase 1 storage layer only persists each
// fact's `text` (as `- text` lines) and rebuilds every fact on read with
// `timestamp: Date.now()`. A fact written "40 days ago" therefore comes back
// fresh, so the age branch of cleanupStaleFacts cannot be exercised through
// the public write/read cycle. AutomationService's dependencies are
// constructor-injectable precisely so this branch can be unit-tested with
// controlled timestamps. The default singleton still uses the real services.
//
// The cleanup helper removes the temp dir directly (`rm(dir)`); doing
// `rm(path.dirname(root.pathname))` (as in some drafts) would delete the
// PARENT of the temp dir, since `path.dirname('/a/b/c/') === '/a/b'`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AutomationService, automationService } from '../services/automation-service.ts';
import { memoryService } from '../services/memory-service.ts';
import type { ChatMemoryFact, ValidationResult } from '../types/memory.ts';

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

/**
 * Minimal in-memory MemoryService stub for unit-testing cleanup logic with
 * controlled timestamps (see file header). Structurally compatible with the
 * MemoryPort the AutomationService constructor accepts.
 */
function makeStubMemory(initial: ChatMemoryFact[]) {
  let stored = initial.slice();
  return {
    async readChatMemory(): Promise<ChatMemoryFact[]> {
      return stored.slice();
    },
    async writeChatMemory(_root: URL, facts: ChatMemoryFact[]): Promise<void> {
      stored = facts.slice();
    },
    async validateFact(): Promise<ValidationResult> {
      return { valid: true };
    }
  };
}

test('AutomationService.captureFromAgentTurn does not crash', async () => {
  const { dir, root } = makeRepo();
  try {
    const context = {
      repoRoot: root,
      userMessage: 'How do I deploy?',
      agentReply: 'Run fly deploy',
      timestamp: Date.now()
    };

    // Should not throw.
    await automationService.captureFromAgentTurn(context);
  } finally {
    await cleanup(dir);
  }
});

test('AutomationService.captureFromUI does not crash', async () => {
  const { dir } = makeRepo();
  try {
    const action = { type: 'fileViewed' as const, file: new URL('file:///test.ts') };

    // Should not throw.
    await automationService.captureFromUI(action);
  } finally {
    await cleanup(dir);
  }
});

test('AutomationService.cleanupStaleFacts removes old facts (stub-backed age test)', async () => {
  // Uses an injected stub MemoryService so the original timestamps survive
  // (the real storage layer resets timestamp to Date.now() on read).
  const root = pathToFileURL('file:///nonexistent-stub-repo/');
  const oldFact: ChatMemoryFact = {
    text: 'Old fact',
    category: 'convention',
    timestamp: Date.now() - (40 * 24 * 60 * 60 * 1000), // 40 days ago
    source: 'agent'
  };
  const newFact: ChatMemoryFact = {
    text: 'New fact',
    category: 'convention',
    timestamp: Date.now(),
    source: 'agent'
  };

  const stub = makeStubMemory([oldFact, newFact]);
  const service = new AutomationService(stub);

  const report = await service.cleanupStaleFacts(root, 30);

  assert.equal(report.removed.length, 1);
  assert.equal(report.kept.length, 1);
  assert.equal(report.removed[0].reason, 'stale_age');
  assert.equal(report.removed[0].fact.text, 'Old fact');
  assert.equal(report.kept[0].text, 'New fact');

  // Cleanup should have written the kept set back through the stub.
  const after = await stub.readChatMemory();
  assert.equal(after.length, 1);
  assert.equal(after[0].text, 'New fact');
});

test('AutomationService.cleanupStaleFacts removes invalid facts via real storage', async () => {
  // Integration path through the real storage layer: text round-trips, so a
  // 281-char fact trips the 280-char validation check and is removed.
  const { dir, root } = makeRepo();
  try {
    const facts: ChatMemoryFact[] = [
      { text: 'good short fact', category: 'convention', timestamp: Date.now(), source: 'agent' },
      {
        text: 'x'.repeat(281),
        category: 'convention',
        timestamp: Date.now(),
        source: 'agent'
      }
    ];

    await memoryService.writeChatMemory(root, facts);
    const report = await automationService.cleanupStaleFacts(root, 30);

    assert.equal(report.removed.length, 1);
    assert.equal(report.kept.length, 1);
    assert.equal(report.kept[0].text, 'good short fact');
    assert.ok(
      typeof report.removed[0].reason === 'string' && report.removed[0].reason.includes('280'),
      `expected removal reason to mention the 280-char limit, got: ${report.removed[0].reason}`
    );
  } finally {
    await cleanup(dir);
  }
});

test('AutomationService.cleanupStaleFacts keeps everything when nothing is stale/invalid', async () => {
  const { dir, root } = makeRepo();
  try {
    const facts: ChatMemoryFact[] = [
      { text: 'a normal fact', category: 'convention', timestamp: Date.now(), source: 'agent' },
      { text: 'another fact', category: 'tooling', timestamp: Date.now(), source: 'agent' }
    ];
    await memoryService.writeChatMemory(root, facts);

    const report = await automationService.cleanupStaleFacts(root, 30);

    assert.equal(report.removed.length, 0);
    assert.equal(report.kept.length, 2);
    assert.equal(report.errors.length, 0);
  } finally {
    await cleanup(dir);
  }
});

test('AutomationService.detectContradictions finds conflicting facts', async () => {
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
      'expected at least one contradiction between "uses npm" and "does not use npm"'
    );
  } finally {
    await cleanup(dir);
  }
});

test('AutomationService.detectContradictions returns empty when no conflict', async () => {
  const { dir, root } = makeRepo();
  try {
    const facts: ChatMemoryFact[] = [
      { text: 'This project uses npm', category: 'tooling', timestamp: Date.now(), source: 'agent' },
      { text: 'Tests live in tests/', category: 'convention', timestamp: Date.now(), source: 'agent' }
    ];
    await memoryService.writeChatMemory(root, facts);

    const report = await automationService.detectContradictions(root);

    assert.equal(report.contradictions.length, 0);
  } finally {
    await cleanup(dir);
  }
});

test('AutomationService.regenerateOnDocChange calls graph service', async () => {
  const { dir, root } = makeRepo();
  try {
    // Should not throw; delegates to graphService.regenerateGraph.
    await automationService.regenerateOnDocChange(root);
  } finally {
    await cleanup(dir);
  }
});

test('AutomationService.regenerateOnCodeChange calls graph service', async () => {
  const { dir, root } = makeRepo();
  try {
    // Should not throw; delegates to graphService.regenerateGraph.
    await automationService.regenerateOnCodeChange(root);
  } finally {
    await cleanup(dir);
  }
});

test('AutomationService degrades gracefully when given a repo root that errors', async () => {
  // Point repoRoot at a path whose parent is a file (not a dir) so storage
  // reads throw a non-ENOENT error; the service must catch and return an
  // empty report rather than crash.
  const { dir } = makeRepo();
  const { writeFile, mkdir } = await import('node:fs/promises');
  try {
    await mkdir(path.dirname(dir), { recursive: true });
    await writeFile(dir, 'i am a file, not a directory');
    const root = pathToFileURL(dir + '/');

    const report = await automationService.cleanupStaleFacts(root, 30);
    assert.equal(report.removed.length, 0);
    assert.equal(report.kept.length, 0);

    const contradictions = await automationService.detectContradictions(root);
    assert.equal(contradictions.contradictions.length, 0);
  } finally {
    await cleanup(dir);
  }
});
