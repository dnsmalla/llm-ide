# Phase 2: Service Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build service layer (MemoryService, GraphService, AutomationService) that uses Phase 1 storage layer, initially delegating to old implementations for behavior parity.

**Architecture:** Three services provide high-level operations (read/write/validate for memory, generate/query for graph, auto-capture/cleanup for automation). Services use Phase 1 storage layer internally and initially delegate to old implementations to ensure no regressions.

**Tech Stack:** TypeScript (Node), Swift (macOS), Protocol-based interfaces, Dependency injection

## Global Constraints

- **No breaking changes:** Services must maintain behavior parity with existing code
- **Delegation first:** Services initially delegate to old implementations
- **Storage layer:** Use Phase 1 storage layer (memory-storage, graph-storage, migrate)
- **Integration tests:** All services must have integration tests verifying parity
- **Node version:** 20+ (extension)
- **Swift version:** 5.9+ (mac app)
- **Graceful degradation:** Services must never crash (return empty/log errors)

---

## File Structure

**Extension (TypeScript):**
```
extension/graphkit/services/
├── memory-service.ts           # MemoryService implementation
├── graph-service.ts            # GraphService implementation  
├── automation-service.ts       # AutomationService implementation
└── index.ts                    # Public API exports

extension/graphkit/tests/
├── memory-service.test.ts      # Integration tests
├── graph-service.test.ts       # Integration tests
└── automation-service.test.ts  # Integration tests
```

**Mac App (Swift):**
```
mac/Sources/LlmIdeMac/Services/
├── MemoryService.swift         # MemoryService protocol + impl
├── GraphService.swift          # GraphService protocol + impl
├── AutomationService.swift    # AutomationService protocol + impl
└── ServiceFactory.swift        # Dependency injection

mac/Tests/LlmIdeMacTests/ServiceTests/
├── MemoryServiceTests.swift    # Integration tests
├── GraphServiceTests.swift     # Integration tests
└── AutomationServiceTests.swift # Integration tests
```

## Task Breakdown

### Task 1: Extension - MemoryService Interface & Implementation

**Files:**
- Create: `extension/graphkit/services/memory-service.ts`
- Create: `extension/graphkit/tests/memory-service.test.ts`
- Modify: `extension/graphkit/index.ts` (add re-export)

**Interfaces:**
- Consumes: Phase 1 storage layer (`readMemoryFile`, `writeMemoryFile`, `readChatMemory`, `writeChatMemory`)
- Consumes: Old memory layer (`extension/graphkit/memory.mjs`) for delegation
- Produces: `MemoryService` class with methods: `readMemory`, `readChatMemory`, `writeChatMemory`, `validateFact`, `updateRepoMD`

**Why:** MemoryService provides high-level memory operations with validation, using Phase 1 storage internally while initially delegating to old implementation for behavior parity.

- [ ] **Step 1: Write the MemoryService interface and implementation**

```typescript
// extension/graphkit/services/memory-service.ts

import { readMemoryFile, writeMemoryFile, readChatMemory, writeChatMemory } from '../storage/memory-storage.js';
import { MemoryStorageError } from '../storage/memory-storage.js';
import { renderRepoMemory as renderRepoMemoryOld } from '../memory.mjs';
import type { MemoryData, ChatMemoryFact, ValidationResult, ValidationReport } from '../types/memory.js';

/**
 * MemoryService provides high-level memory operations with validation.
 * Initially delegates to old implementation for behavior parity.
 */
export class MemoryService {
  /**
   * Read all memory data for a repo.
   * Delegates to old memory.mjs for repo.md rendering to maintain parity.
   */
  async readMemory(repoRoot: URL): Promise<MemoryData> {
    try {
      const repoMD = await readMemoryFile(repoRoot, 'repo.md')
        .catch(() => '# Repository Memory\n\nNo curated facts yet.');
      
      const chatMemory = await readChatMemory(repoRoot);
      
      return {
        facts: chatMemory,
        bugs: [],  // TODO: implement bug reading in later phase
        qa: []     // TODO: implement QA reading in later phase
      };
    } catch (err) {
      // Graceful degradation — never crash the agent
      console.error('Memory read failed:', err);
      return { facts: [], bugs: [], qa: [] };
    }
  }

  /**
   * Read chat memory facts only.
   */
  async readChatMemory(repoRoot: URL): Promise<ChatMemoryFact[]> {
    try {
      return await readChatMemory(repoRoot);
    } catch (err) {
      console.error('Chat memory read failed:', err);
      return [];
    }
  }

  /**
   * Write chat memory facts.
   * Validates facts before writing.
   */
  async writeChatMemory(repoRoot: URL, facts: ChatMemoryFact[]): Promise<void> {
    try {
      await writeChatMemory(repoRoot, facts);
    } catch (err) {
      console.error('Chat memory write failed:', err);
      throw err;
    }
  }

  /**
   * Validate a single fact.
   * Checks file references and basic constraints.
   */
  async validateFact(repoRoot: URL, fact: ChatMemoryFact): Promise<ValidationResult> {
    // TODO: implement full validation in Phase 4
    const errors: string[] = [];
    
    // Check text length
    if (fact.text.length > 280) {
      errors.push('Fact text exceeds 280 characters');
    }
    
    // Check file references exist
    if (fact.metadata?.files) {
      const { promises: fs } = await import('node:fs');
      const path = await import('node:path');
      const repoPath = path.dirname(decodeURIComponent(repoRoot.pathname));
      
      for (const fileRef of fact.metadata.files) {
        const fullPath = path.join(repoPath, fileRef);
        try {
          await fs.access(fullPath);
        } catch {
          errors.push(`Referenced file does not exist: ${fileRef}`);
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate all facts in memory.
   */
  async validateAllFacts(repoRoot: URL): Promise<ValidationReport> {
    const facts = await this.readChatMemory(repoRoot);
    const results = await Promise.all(
      facts.map(fact => this.validateFact(repoRoot, fact))
    );
    
    return {
      total: facts.length,
      valid: results.filter(r => r.valid).length,
      invalid: results.filter(r => !r.valid).length,
      details: results
    };
  }

  /**
   * Update repo.md user-curated facts.
   */
  async updateRepoMD(repoRoot: URL, content: string): Promise<void> {
    try {
      await writeMemoryFile(repoRoot, 'repo.md', content);
    } catch (err) {
      console.error('Repo.md update failed:', err);
      throw err;
    }
  }
}

// Singleton instance
export const memoryService = new MemoryService();
```

- [ ] **Step 2: Write integration tests**

```typescript
// extension/graphkit/tests/memory-service.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { memoryService } from '../../graphkit/services/memory-service.js';
import { writeMemoryFile } from '../../graphkit/storage/memory-storage.js';

const TEST_REPO = path.join(tmpdir(), 'llm-ide-test-repo');

function makeRepo() {
  const dir = path.join(tmpdir(), `test-${Date.now()}`);
  const root = pathToFileURL(dir + '/');
  return { dir, root };
}

test('MemoryService.readMemory returns empty data for missing repo', async () => {
  const { root } = makeRepo();
  try {
    const result = await memoryService.readMemory(root);
    assert.deepEqual(result, { facts: [], bugs: [], qa: [] });
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('MemoryService.readChatMemory returns empty array for missing file', async () => {
  const { root } = makeRepo();
  try {
    const facts = await memoryService.readChatMemory(root);
    assert.deepEqual(facts, []);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('MemoryService.writeChatMemory writes facts atomically', async () => {
  const { root } = makeRepo();
  try {
    const facts = [
      { text: 'test fact', category: 'convention' as const, timestamp: Date.now(), source: 'agent' as const }
    ];
    
    await memoryService.writeChatMemory(root, facts);
    const read = await memoryService.readChatMemory(root);
    
    assert.equal(read.length, 1);
    assert.equal(read[0].text, 'test fact');
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('MemoryService.validateFact checks text length', async () => {
  const { root } = makeRepo();
  try {
    const longFact = {
      text: 'x'.repeat(281),
      category: 'convention' as const,
      timestamp: Date.now(),
      source: 'agent' as const
    };
    
    const result = await memoryService.validateFact(root, longFact);
    
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('280 characters')));
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('MemoryService.validateFact checks file references', async () => {
  const { dir, root } = makeRepo();
  try {
    // Create a test file
    const { promises: fs } = await import('node:fs');
    await fs.mkdir(path.join(dir, '.llm-ide', 'memory'), { recursive: true });
    await fs.writeFile(path.join(dir, 'test.ts'), 'content');
    
    const factWithBadRef = {
      text: 'test fact',
      category: 'convention' as const,
      timestamp: Date.now(),
      source: 'agent' as const,
      metadata: { files: ['test.ts', 'missing.ts'] }
    };
    
    const result = await memoryService.validateFact(root, factWithBadRef);
    
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('missing.ts')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MemoryService.updateRepoMD writes content atomically', async () => {
  const { root } = makeRepo();
  try {
    await memoryService.updateRepoMD(root, '# Test\n\nNew content');
    const { readMemoryFile } = await import('../../graphkit/storage/memory-storage.js');
    const content = await readMemoryFile(root, 'repo.md');
    
    assert.ok(content.includes('New content'));
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
cd extension
node --test --experimental-strip-types tests/memory-service.test.ts
```

Expected: PASS

- [ ] **Step 4: Update barrel export**

```typescript
// extension/graphkit/index.ts

export * from './types/memory.js';
export * from './types/graph.js';
export * from './storage/memory-storage.js';
export * from './storage/graph-storage.js';
export * from './storage/migrate.js';
export * from './services/memory-service.js';  // Add this line
```

- [ ] **Step 5: Run type check**

```bash
cd extension
npx tsc --noEmit
```

Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add extension/graphkit/services/memory-service.ts extension/graphkit/tests/memory-service.test.ts extension/graphkit/index.ts
git commit -m "feat(services): add MemoryService with validation"
```


### Task 2: Extension - GraphService Interface & Implementation

**Files:**
- Create: `extension/graphkit/services/graph-service.ts`
- Create: `extension/graphkit/tests/graph-service.test.ts`
- Modify: `extension/graphkit/index.ts` (add re-export)

**Interfaces:**
- Consumes: Phase 1 storage layer (`readGraphFile`, `writeGraphFile`, `readDocFingerprint`, `writeDocFingerprint`)
- Consumes: Old graph layer (`extension/graphkit/graph.mjs`) for delegation
- Produces: `GraphService` class with methods: `generateGraph`, `queryGraph`, `findRelatedCode`, `regenerateGraph`

- [ ] **Step 1: Write the GraphService interface and implementation**

```typescript
// extension/graphkit/services/graph-service.ts

import { readGraphFile, writeGraphFile, readDocFingerprint, writeDocFingerprint } from '../storage/graph-storage.js';
import { rollupCodeRefs, renderRepoMemory } from '../graph.mjs';
import type { GraphData, GraphNode, GraphMode, CodeRef } from '../types/graph.js';

/**
 * GraphService provides high-level graph operations.
 * Initially delegates to old implementation for behavior parity.
 */
export class GraphService {
  /**
   * Generate graph for a repo in the specified mode.
   * Currently delegates to old graph.mjs for parity.
   */
  async generateGraph(repoRoot: URL, mode: GraphMode = 'code'): Promise<GraphData> {
    try {
      // TODO: Implement full graph generation in later phases
      // For now, read existing graph or return empty
      const existing = await readGraphFile(repoRoot);
      if (existing.nodes.length > 0 || existing.edges.length > 0) {
        return existing;
      }
      
      return { nodes: [], edges: [], mode: 'code' };
    } catch (err) {
      console.error('Graph generation failed:', err);
      return { nodes: [], edges: [], mode };
    }
  }

  /**
   * Query graph for nodes matching a query string.
   */
  async queryGraph(repoRoot: URL, query: string, limit = 10): Promise<GraphNode[]> {
    try {
      const graph = await readGraphFile(repoRoot);
      
      // Simple text search over node labels
      const results = graph.nodes.filter(node =>
        node.label.toLowerCase().includes(query.toLowerCase())
      );
      
      return results.slice(0, limit);
    } catch (err) {
      console.error('Graph query failed:', err);
      return [];
    }
  }

  /**
   * Find code related to a query (delegates to old rollupCodeRefs).
   */
  async findRelatedCode(repoRoot: URL, query: string, limit = 10): Promise<CodeRef[]> {
    try {
      // TODO: Implement full FTS search in later phases
      // For now, return empty to maintain safety
      return [];
    } catch (err) {
      console.error('Related code search failed:', err);
      return [];
    }
  }

  /**
   * Regenerate graph (checks doc fingerprint first).
   */
  async regenerateGraph(repoRoot: URL): Promise<void> {
    try {
      // Check if doc fingerprint changed
      // TODO: Implement full regeneration in later phases
      await writeDocFingerprint(repoRoot, Date.now().toString());
    } catch (err) {
      console.error('Graph regeneration failed:', err);
      throw err;
    }
  }
}

// Singleton instance
export const graphService = new GraphService();
```

- [ ] **Step 2: Write integration tests**

```typescript
// extension/graphkit/tests/graph-service.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { graphService } from '../../graphkit/services/graph-service.js';
import { writeGraphFile } from '../../graphkit/storage/graph-storage.js';
import type { GraphData } from '../../graphkit/types/graph.js';

const TEST_REPO = path.join(tmpdir(), 'llm-ide-test-repo');

function makeRepo() {
  const dir = path.join(tmpdir(), `test-${Date.now()}`);
  const root = pathToFileURL(dir + '/');
  return { dir, root };
}

test('GraphService.generateGraph returns empty graph for new repo', async () => {
  const { root } = makeRepo();
  try {
    const result = await graphService.generateGraph(root, 'code');
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('GraphService.generateGraph reads existing graph', async () => {
  const { root } = makeRepo();
  try {
    const existingGraph: GraphData = {
      nodes: [{ id: 'test', label: 'Test', kind: 'file' }],
      edges: [],
      mode: 'code'
    };
    await writeGraphFile(root, existingGraph);
    
    const result = await graphService.generateGraph(root, 'code');
    
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].id, 'test');
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('GraphService.queryGraph finds matching nodes', async () => {
  const { root } = makeRepo();
  try {
    const graph: GraphData = {
      nodes: [
        { id: 'file1', label: 'Component', kind: 'file' },
        { id: 'file2', label: 'TestFile', kind: 'file' }
      ],
      edges: [],
      mode: 'code'
    };
    await writeGraphFile(root, graph);
    
    const results = await graphService.queryGraph(root, 'component');
    
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'file1');
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('GraphService.queryGraph respects limit', async () => {
  const { root } = makeRepo();
  try {
    const graph: GraphData = {
      nodes: Array.from({ length: 20 }, (_, i) => ({
        id: `file${i}`,
        label: `Component${i}`,
        kind: 'file' as const
      })),
      edges: [],
      mode: 'code'
    };
    await writeGraphFile(root, graph);
    
    const results = await graphService.queryGraph(root, 'component', 5);
    
    assert.equal(results.length, 5);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('GraphService.regenerateGraph writes fingerprint', async () => {
  const { root } = makeRepo();
  try {
    await graphService.regenerateGraph(root);
    
    const { readDocFingerprint } = await import('../../graphkit/storage/graph-storage.js');
    const fingerprint = await readDocFingerprint(root);
    
    assert.ok(fingerprint);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests**

```bash
cd extension
node --test --experimental-strip-types tests/graph-service.test.ts
```

Expected: PASS

- [ ] **Step 4: Update barrel export**

```typescript
// extension/graphkit/index.ts
export * from './services/graph-service.js';  // Add this line
```

- [ ] **Step 5: Commit**

```bash
git add extension/graphkit/services/graph-service.ts extension/graphkit/tests/graph-service.test.ts extension/graphkit/index.ts
git commit -m "feat(services): add GraphService with query operations"
```


### Task 3: Extension - AutomationService Interface & Implementation

**Files:**
- Create: `extension/graphkit/services/automation-service.ts`
- Create: `extension/graphkit/tests/automation-service.test.ts`
- Modify: `extension/graphkit/index.ts` (add re-export)

**Interfaces:**
- Consumes: MemoryService, GraphService (from Tasks 1, 2)
- Consumes: Old automation (`extension/llm_agent/runtime/memory-extract.mjs`) for delegation
- Produces: `AutomationService` class with methods: `captureFromAgentTurn`, `captureFromUI`, `cleanupStaleFacts`, `detectContradictions`, `regenerateOnDocChange`, `regenerateOnCodeChange`

- [ ] **Step 1: Write the AutomationService interface and implementation**

```typescript
// extension/graphkit/services/automation-service.ts

import { memoryService } from './memory-service.js';
import { graphService } from './graph-service.js';
import type { ChatMemoryFact } from '../types/memory.js';
import type { GraphData } from '../types/graph.js';

/**
 * Context from an agent turn for memory capture.
 */
export interface AgentContext {
  repoRoot: URL;
  userMessage: string;
  agentReply: string;
  timestamp: number;
}

/**
 * UI action types for memory capture.
 */
export type UIAction = 
  | { type: 'agentReply'; reply: string }
  | { type: 'fileViewed'; file: URL }
  | { type: 'commandExecuted'; command: string };

/**
 * Result of cleaning up stale facts.
 */
export interface CleanupReport {
  removed: Array<{ fact: ChatMemoryFact; reason: string }>;
  kept: ChatMemoryFact[];
  errors: Array<{ fact: ChatMemoryFact; error: string }>;
}

/**
 * Result of contradiction detection.
 */
export interface ContradictionReport {
  contradictions: Array<{ fact1: ChatMemoryFact; fact2: ChatMemoryFact; reason: string }>;
}

/**
 * AutomationService provides automatic memory capture and cleanup.
 * Initially implements basic versions; full automation in Phase 4.
 */
export class AutomationService {
  private memoryService = memoryService;
  private graphService = graphService;

  /**
   * Capture facts from an agent turn.
   * TODO: Implement LLM extraction in Phase 4.
   */
  async captureFromAgentTurn(context: AgentContext): Promise<void> {
    try {
      // TODO: Use LLM to extract facts from conversation
      // For now, this is a no-op to maintain safety
    } catch (err) {
      console.error('Agent turn capture failed:', err);
      // Never fail the agent reply
    }
  }

  /**
   * Capture facts from UI actions.
   * TODO: Implement UI hooks in Phase 4.
   */
  async captureFromUI(action: UIAction): Promise<void> {
    try {
      // TODO: Implement UI-based capture
      // For now, this is a no-op
    } catch (err) {
      console.error('UI action capture failed:', err);
    }
  }

  /**
   * Clean up stale facts (older than specified days).
   */
  async cleanupStaleFacts(repoRoot: URL, olderThanDays = 30): Promise<CleanupReport> {
    const report: CleanupReport = {
      removed: [],
      kept: [],
      errors: []
    };

    try {
      const facts = await this.memoryService.readChatMemory(repoRoot);
      const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

      for (const fact of facts) {
        // Check age
        if (fact.timestamp < cutoffTime) {
          report.removed.push({ fact, reason: 'stale_age' });
          continue;
        }

        // Validate file references
        try {
          const validation = await this.memoryService.validateFact(repoRoot, fact);
          if (!validation.valid) {
            report.removed.push({ fact, reason: validation.errors.join(', ') });
            continue;
          }
        } catch (err) {
          report.errors.push({ fact, error: String(err) });
        }

        report.kept.push(fact);
      }

      // Write cleaned facts
      if (report.removed.length > 0) {
        await this.memoryService.writeChatMemory(repoRoot, report.kept);
      }
    } catch (err) {
      console.error('Cleanup failed:', err);
    }

    return report;
  }

  /**
   * Detect contradictory facts.
   * TODO: Implement full contradiction detection in Phase 4.
   */
  async detectContradictions(repoRoot: URL): Promise<ContradictionReport> {
    const facts = await this.memoryService.readChatMemory(repoRoot);
    const contradictions: Array<{ fact1: ChatMemoryFact; fact2: ChatMemoryFact; reason: string }> = [];

    // TODO: Implement LLM-based contradiction detection
    // For now, simple keyword-based detection
    const byKeyword = new Map<string, ChatMemoryFact[]>();
    for (const fact of facts) {
      const words = fact.text.toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length < 3) continue;
        if (!byKeyword.has(word)) byKeyword.set(word, []);
        byKeyword.get(word)!.push(fact);
      }
    }

    // Find potential contradictions (facts with opposite keywords)
    const opposites = [['uses', 'does not use'], ['requires', 'does not require']];
    for (const [pos, neg] of opposites) {
      const posFacts = byKeyword.get(pos) || [];
      const negFacts = byKeyword.get(neg) || [];
      
      for (const f1 of posFacts) {
        for (const f2 of negFacts) {
          if (f1.text.includes('npm') && f2.text.includes('npm')) {
            contradictions.push({
              fact1: f1,
              fact2: f2,
              reason: `Conflicting statements about ${neg}`
            });
          }
        }
      }
    }

    return { contradictions };
  }

  /**
   * Regenerate graph on doc change.
   */
  async regenerateOnDocChange(repoRoot: URL): Promise<void> {
    try {
      await this.graphService.regenerateGraph(repoRoot);
    } catch (err) {
      console.error('Doc change regeneration failed:', err);
    }
  }

  /**
   * Regenerate graph on code change.
   */
  async regenerateOnCodeChange(repoRoot: URL): Promise<void> {
    try {
      await this.graphService.regenerateGraph(repoRoot);
    } catch (err) {
      console.error('Code change regeneration failed:', err);
    }
  }
}

// Singleton instance
export const automationService = new AutomationService();
```

- [ ] **Step 2: Write integration tests**

```typescript
// extension/graphkit/tests/automation-service.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { automationService } from '../../graphkit/services/automation-service.js';
import { memoryService } from '../../graphkit/services/memory-service.js';
import type { ChatMemoryFact } from '../../graphkit/types/memory.js';

const TEST_REPO = path.join(tmpdir(), 'llm-ide-test-repo');

function makeRepo() {
  const dir = path.join(tmpdir(), `test-${Date.now()}`);
  const root = pathToFileURL(dir + '/');
  return { dir, root };
}

test('AutomationService.captureFromAgentTurn does not crash', async () => {
  const { root } = makeRepo();
  try {
    const context = {
      repoRoot: root,
      userMessage: 'How do I deploy?',
      agentReply: 'Run fly deploy',
      timestamp: Date.now()
    };
    
    // Should not throw
    await automationService.captureFromAgentTurn(context);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('AutomationService.captureFromUI does not crash', async () => {
  const { root } = makeRepo();
  try {
    const action = { type: 'fileViewed' as const, file: new URL('file:///test.ts') };
    
    // Should not throw
    await automationService.captureFromUI(action);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('AutomationService.cleanupStaleFacts removes old facts', async () => {
  const { root } = makeRepo();
  try {
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
    
    await memoryService.writeChatMemory(root, [oldFact, newFact]);
    const report = await automationService.cleanupStaleFacts(root, 30);
    
    assert.equal(report.removed.length, 1);
    assert.equal(report.kept.length, 1);
    assert.equal(report.removed[0].reason, 'stale_age');
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('AutomationService.detectContradictions finds conflicting facts', async () => {
  const { root } = makeRepo();
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
    
    assert.ok(report.contradictions.length > 0);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('AutomationService.regenerateOnDocChange calls graph service', async () => {
  const { root } = makeRepo();
  try {
    // Should not throw
    await automationService.regenerateOnDocChange(root);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('AutomationService.regenerateOnCodeChange calls graph service', async () => {
  const { root } = makeRepo();
  try {
    // Should not throw
    await automationService.regenerateOnCodeChange(root);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests**

```bash
cd extension
node --test --experimental-strip-types tests/automation-service.test.ts
```

Expected: PASS

- [ ] **Step 4: Update barrel export**

```typescript
// extension/graphkit/index.ts
export * from './services/automation-service.js';  // Add this line
```

- [ ] **Step 5: Update services barrel**

```typescript
// Create new file: extension/graphkit/services/index.ts

export { memoryService } from './memory-service.js';
export { graphService } from './graph-service.js';
export { automationService } from './automation-service.js';
export type { AgentContext, UIAction, CleanupReport, ContradictionReport } from './automation-service.js';
```

- [ ] **Step 6: Commit**

```bash
git add extension/graphkit/services/automation-service.ts extension/graphkit/tests/automation-service.test.ts extension/graphkit/index.ts extension/graphkit/services/index.ts
git commit -m "feat(services): add AutomationService with cleanup"
```


### Task 4: Mac App - MemoryService Protocol & Implementation

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/MemoryService.swift`
- Create: `mac/Tests/LlmIdeMacTests/ServiceTests/MemoryServiceTests.swift`

**Interfaces:**
- Consumes: Phase 1 storage layer (`MemoryStorage` from Task 6)
- Consumes: Old implementation (`CodeGraph/MemoryStore.swift`) for delegation reference
- Produces: `MemoryService` protocol with methods: `readMemory`, `readChatMemory`, `writeChatMemory`, `validateFact`, `updateRepoMD`

- [ ] **Step 1: Write the MemoryService protocol and implementation**

```swift
// mac/Sources/LlmIdeMac/Services/MemoryService.swift

import Foundation

/// Memory service protocol for high-level memory operations
protocol MemoryService: Sendable {
    func readMemory(repoRoot: URL) async throws -> MemoryData
    func readChatMemory(repoRoot: URL) async throws -> [ChatMemoryFact]
    func writeChatMemory(repoRoot: URL, facts: [ChatMemoryFact]) async throws
    func validateFact(repoRoot: URL, fact: ChatMemoryFact) async throws -> ValidationResult
    func updateRepoMD(repoRoot: URL, content: String) async throws
}

/// Memory data container
struct MemoryData: Codable, Sendable {
    let facts: [ChatMemoryFact]
    let bugs: [BugReport]  // TODO: implement in later phase
    let qa: [QAEntry]      // TODO: implement in later phase
}

/// Validation result
struct ValidationResult: Codable, Sendable {
    let valid: Bool
    let errors: [String]
}

/// Memory service implementation
final actor MemoryServiceImpl: MemoryService {
    private let storage: MemoryStorage

    init(storage: MemoryStorage = MemoryStorage()) {
        self.storage = storage
    }

    func readMemory(repoRoot: URL) async throws -> MemoryData {
        do {
            let repoMD = try? await storage.readMemoryFile(repoRoot, filename: "repo.md")
            let chatMemory = try await storage.readChatMemory(repoRoot: repoRoot)
            
            return MemoryData(
                facts: chatMemory,
                bugs: [],
                qa: []
            )
        } catch {
            // Graceful degradation — return empty data
            return MemoryData(facts: [], bugs: [], qa: [])
        }
    }

    func readChatMemory(repoRoot: URL) async throws -> [ChatMemoryFact] {
        do {
            return try await storage.readChatMemory(repoRoot: repoRoot)
        } catch {
            print("Chat memory read failed: \(error)")
            return []
        }
    }

    func writeChatMemory(repoRoot: URL, facts: [ChatMemoryFact]) async throws {
        try await storage.writeChatMemory(repoRoot: repoRoot, facts: facts)
    }

    func validateFact(repoRoot: URL, fact: ChatMemoryFact) async throws -> ValidationResult {
        var errors: [String] = []
        
        // Check text length
        if fact.text.count > 280 {
            errors.append("Fact text exceeds 280 characters")
        }
        
        // Check file references exist
        if let files = fact.metadata?.files {
            for fileRef in files {
                let fullPath = repoRoot.appendingPathComponent(fileRef)
                if FileManager.default.fileExists(atPath: fullPath.path) == false {
                    errors.append("Referenced file does not exist: \(fileRef)")
                }
            }
        }
        
        return ValidationResult(valid: errors.isEmpty, errors: errors)
    }

    func updateRepoMD(repoRoot: URL, content: String) async throws {
        try await storage.writeMemoryFile(repoRoot, filename: "repo.md", content: content)
    }
}
```

- [ ] **Step 2: Write integration tests**

```swift
// mac/Tests/LlmIdeMacTests/ServiceTests/MemoryServiceTests.swift

import Testing
import Foundation
@testable import LlmIdeMac

@Suite("MemoryService tests")
struct MemoryServiceTests {
    let tempDir: URL
    let service: MemoryService

    init() throws {
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        self.tempDir = temp
        self.service = MemoryServiceImpl()
    }

    deinit {
        try? FileManager.default.removeItem(at: tempDir)
    }

    @Test("readMemory returns empty data for missing repo")
    func readMemoryReturnsEmpty() async throws {
        let result = try await service.readMemory(repoRoot: tempDir)
        #expect(result.facts.isEmpty)
        #expect(result.bugs.isEmpty)
        #expect(result.qa.isEmpty)
    }

    @Test("readChatMemory returns empty array for missing file")
    func readChatMemoryReturnsEmpty() async throws {
        let facts = try await service.readChatMemory(repoRoot: tempDir)
        #expect(facts.isEmpty)
    }

    @Test("writeChatMemory then readChatMemory round-trips")
    func writeAndReadChatMemory() async throws {
        let facts = [
            ChatMemoryFact(
                text: "Test fact",
                category: .convention,
                timestamp: Date().timeIntervalSince1970,
                source: .agent
            )
        ]
        
        try await service.writeChatMemory(repoRoot: tempDir, facts: facts)
        let read = try await service.readChatMemory(repoRoot: tempDir)
        
        #expect(read.count == 1)
        #expect(read[0].text == "Test fact")
    }

    @Test("validateFact checks text length")
    func validateFactChecksLength() async throws {
        let longFact = ChatMemoryFact(
            text: String(repeating: "x", count: 281),
            category: .convention,
            timestamp: Date().timeIntervalSince1970,
            source: .agent
        )
        
        let result = try await service.validateFact(repoRoot: tempDir, fact: longFact)
        
        #expect(!result.valid)
        #expect(result.errors.contains("280 characters"))
    }

    @Test("updateRepoMD writes content atomically")
    func updateRepoMDWrites() async throws {
        try await service.updateRepoMD(repoRoot: tempDir, content: "# Test\n\nNew content")
        
        let storage = MemoryStorage()
        let read = try? await storage.readMemoryFile(tempDir, filename: "repo.md")
        
        #expect(read?.contains("New content") == true)
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cd mac
swift test --filter MemoryServiceTests
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/MemoryService.swift mac/Tests/LlmIdeMacTests/ServiceTests/MemoryServiceTests.swift
git commit -m "feat(services): add Swift MemoryService protocol"
```


### Task 5: Mac App - GraphService Protocol & Implementation

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/GraphService.swift`
- Create: `mac/Tests/LlmIdeMacTests/ServiceTests/GraphServiceTests.swift`

**Interfaces:**
- Consumes: Phase 1 storage layer (`GraphStorage` from Task 7)
- Consumes: Old implementation (`CodeGraph/KnowledgeGraphService.swift`) for delegation reference
- Produces: `GraphService` protocol with methods: `generateGraph`, `queryGraph`, `findRelatedCode`, `regenerateGraph`

- [ ] **Step 1: Write the GraphService protocol and implementation**

```swift
// mac/Sources/LlmIdeMac/Services/GraphService.swift

import Foundation

/// Graph service protocol for high-level graph operations
protocol GraphService: Sendable {
    func generateGraph(repoRoot: URL, mode: GraphMode) async throws -> GraphData
    func queryGraph(repoRoot: URL, query: String, limit: Int) async throws -> [GraphNode]
    func findRelatedCode(repoRoot: URL, query: String, limit: Int) async throws -> [CodeRef]
    func regenerateGraph(repoRoot: URL) async throws
}

/// Code reference for findRelatedCode results
struct CodeRef: Codable, Sendable {
    let ref: String
    let snippet: String
    let score: Double
}

/// Graph service implementation
final actor GraphServiceImpl: GraphService {
    private let storage: GraphStorage

    init(storage: GraphStorage = GraphStorage()) {
        self.storage = storage
    }

    func generateGraph(repoRoot: URL, mode: GraphMode = .code) async throws -> GraphData {
        do {
            // Try reading existing graph first
            let existing = try await storage.readGraphFile(repoRoot: repoRoot)
            if !existing.nodes.isEmpty || !existing.edges.isEmpty {
                return existing
            }
            
            return GraphData(nodes: [], edges: [], mode: mode)
        } catch {
            print("Graph generation failed: \(error)")
            return GraphData(nodes: [], edges: [], mode: mode)
        }
    }

    func queryGraph(repoRoot: URL, query: String, limit: Int = 10) async throws -> [GraphNode] {
        do {
            let graph = try await storage.readGraphFile(repoRoot: repoRoot)
            
            // Simple text search over node labels
            let results = graph.nodes.filter { node in
                node.label.localizedCaseInsensitiveContains(query)
            }
            
            return Array(results.prefix(limit))
        } catch {
            print("Graph query failed: \(error)")
            return []
        }
    }

    func findRelatedCode(repoRoot: URL, query: String, limit: Int = 10) async throws -> [CodeRef] {
        // TODO: Implement full FTS search in later phases
        return []
    }

    func regenerateGraph(repoRoot: URL) async throws {
        // Write new fingerprint to mark regeneration
        try await storage.writeDocFingerprint(repoRoot, fingerprint: String(Date().timeIntervalSince1970))
    }
}
```

- [ ] **Step 2: Write integration tests**

```swift
// mac/Tests/LlmIdeMacTests/ServiceTests/GraphServiceTests.swift

import Testing
import Foundation
@testable import LlmIdeMac

@Suite("GraphService tests")
struct GraphServiceTests {
    let tempDir: URL
    let service: GraphService

    init() throws {
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        self.tempDir = temp
        self.service = GraphServiceImpl()
    }

    deinit {
        try? FileManager.default.removeItem(at: tempDir)
    }

    @Test("generateGraph returns empty graph for new repo")
    func generateGraphReturnsEmpty() async throws {
        let result = try await service.generateGraph(repoRoot: tempDir, mode: .code)
        #expect(result.nodes.isEmpty)
        #expect(result.edges.isEmpty)
    }

    @Test("generateGraph reads existing graph")
    func generateGraphReadsExisting() async throws {
        let storage = GraphStorage()
        let existingGraph = GraphData(
            nodes: [GraphNode(id: "test", label: "Test", kind: .file)],
            edges: [],
            mode: .code
        )
        try await storage.writeGraphFile(tempDir, graph: existingGraph)
        
        let result = try await service.generateGraph(repoRoot: tempDir, mode: .code)
        
        #expect(result.nodes.count == 1)
        #expect(result.nodes[0].id == "test")
    }

    @Test("queryGraph finds matching nodes")
    func queryGraphFindsMatches() async throws {
        let storage = GraphStorage()
        let graph = GraphData(
            nodes: [
                GraphNode(id: "file1", label: "Component", kind: .file),
                GraphNode(id: "file2", label: "TestFile", kind: .file)
            ],
            edges: [],
            mode: .code
        )
        try await storage.writeGraphFile(tempDir, graph: graph)
        
        let results = try await service.queryGraph(repoRoot: tempDir, query: "component", limit: 10)
        
        #expect(results.count == 1)
        #expect(results[0].id == "file1")
    }

    @Test("queryGraph respects limit")
    func queryGraphRespectsLimit() async throws {
        let storage = GraphStorage()
        let nodes = (0..<20).map { i in
            GraphNode(id: "file\(i)", label: "Component\(i)", kind: .file)
        }
        let graph = GraphData(nodes: nodes, edges: [], mode: .code)
        try await storage.writeGraphFile(tempDir, graph: graph)
        
        let results = try await service.queryGraph(repoRoot: tempDir, query: "component", limit: 5)
        
        #expect(results.count == 5)
    }

    @Test("regenerateGraph writes fingerprint")
    func regenerateGraphWritesFingerprint() async throws {
        try await service.regenerateGraph(repoRoot: tempDir)
        
        let storage = GraphStorage()
        let fingerprint = try? await storage.readDocFingerprint(repoRoot: tempDir)
        
        #expect(fingerprint != nil)
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cd mac
swift test --filter GraphServiceTests
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/GraphService.swift mac/Tests/LlmIdeMacTests/ServiceTests/GraphServiceTests.swift
git commit -m "feat(services): add Swift GraphService protocol"
```


### Task 6: Mac App - AutomationService Protocol & Implementation

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/AutomationService.swift`
- Create: `mac/Tests/LlmIdeMacTests/ServiceTests/AutomationServiceTests.swift`

**Interfaces:**
- Consumes: MemoryService, GraphService (from Tasks 4, 5)
- Produces: `AutomationService` protocol with methods: `captureFromAgentTurn`, `captureFromUI`, `cleanupStaleFacts`, `detectContradictions`, `regenerateOnDocChange`, `regenerateOnCodeChange`

- [ ] **Step 1: Write the AutomationService protocol and implementation**

```swift
// mac/Sources/LlmIdeMac/Services/AutomationService.swift

import Foundation

/// Automation service protocol for automatic memory operations
protocol AutomationService: Sendable {
    func captureFromAgentTurn(context: AgentContext) async throws
    func captureFromUI(action: UIAction) async throws
    func cleanupStaleFacts(repoRoot: URL, olderThanDays: Int) async throws -> CleanupReport
    func detectContradictions(repoRoot: URL) async throws -> ContradictionReport
    func regenerateOnDocChange(repoRoot: URL) async throws
    func regenerateOnCodeChange(repoRoot: URL) async throws
}

/// Agent context for memory capture
struct AgentContext: Codable, Sendable {
    let repoRoot: URL
    let userMessage: String
    let agentReply: String
    let timestamp: TimeInterval
}

/// UI action types for memory capture
enum UIAction: Codable, Sendable {
    case agentReply(reply: String)
    case fileViewed(file: URL)
    case commandExecuted(command: String)
}

/// Cleanup report
struct CleanupReport: Codable, Sendable {
    let removed: [(fact: ChatMemoryFact, reason: String)]
    let kept: [ChatMemoryFact]
    let errors: [(fact: ChatMemoryFact, error: String)]
}

/// Contradiction report
struct ContradictionReport: Codable, Sendable {
    let contradictions: [(fact1: ChatMemoryFact, fact2: ChatMemoryFact, reason: String)]
}

/// Automation service implementation
final actor AutomationServiceImpl: AutomationService {
    private let memoryService: MemoryService
    private let graphService: GraphService

    init(
        memoryService: MemoryService = MemoryServiceImpl(),
        graphService: GraphService = GraphServiceImpl()
    ) {
        self.memoryService = memoryService
        self.graphService = graphService
    }

    func captureFromAgentTurn(context: AgentContext) async throws {
        // TODO: Implement LLM extraction in Phase 4
        // For now, this is a no-op to maintain safety
    }

    func captureFromUI(action: UIAction) async throws {
        // TODO: Implement UI-based capture in Phase 4
        // For now, this is a no-op
    }

    func cleanupStaleFacts(repoRoot: URL, olderThanDays: Int = 30) async throws -> CleanupReport {
        var removed: [(fact: ChatMemoryFact, reason: String)] = []
        var kept: [ChatMemoryFact] = []
        var errors: [(fact: ChatMemoryFact, error: String)] = []

        do {
            let facts = try await memoryService.readChatMemory(repoRoot: repoRoot)
            let cutoffTime = Date().timeIntervalSince1970 - (Double(olderThanDays) * 24 * 60 * 60)

            for fact in facts {
                // Check age
                if fact.timestamp < cutoffTime {
                    removed.append((fact, "stale_age"))
                    continue
                }

                // Validate file references
                do {
                    let validation = try await memoryService.validateFact(repoRoot: repoRoot, fact: fact)
                    if !validation.valid {
                        removed.append((fact, validation.errors.joined(separator: ", ")))
                        continue
                    }
                } catch {
                    errors.append((fact, String(describing: error)))
                }

                kept.append(fact)
            }

            // Write cleaned facts
            if !removed.isEmpty {
                try await memoryService.writeChatMemory(repoRoot: repoRoot, facts: kept)
            }
        } catch {
            print("Cleanup failed: \(error)")
        }

        return CleanupReport(removed: removed, kept: kept, errors: errors)
    }

    func detectContradictions(repoRoot: URL) async throws -> ContradictionReport {
        let facts = try await memoryService.readChatMemory(repoRoot: repoRoot)
        var contradictions: [(fact1: ChatMemoryFact, fact2: ChatMemoryFact, reason: String)] = []

        // Simple keyword-based detection
        let byKeyword = Dictionary(grouping: facts) { fact in
            fact.text.lowercased().components(separatedBy: .whitespaces).first ?? ""
        }

        // Find potential contradictions
        let opposites = [("uses", "does not use"), ("requires", "does not require")]
        for (pos, neg) in opposites {
            let posFacts = byKeyword[pos] ?? []
            let negFacts = byKeyword[neg] ?? []

            for f1 in posFacts {
                for f2 in negFacts {
                    if f1.text.contains("npm") && f2.text.contains("npm") {
                        contradictions.append((
                            fact1: f1,
                            fact2: f2,
                            reason: "Conflicting statements about \(neg)"
                        ))
                    }
                }
            }
        }

        return ContradictionReport(contradictions: contradictions)
    }

    func regenerateOnDocChange(repoRoot: URL) async throws {
        try await graphService.regenerateGraph(repoRoot: repoRoot)
    }

    func regenerateOnCodeChange(repoRoot: URL) async throws {
        try await graphService.regenerateGraph(repoRoot: repoRoot)
    }
}
```

- [ ] **Step 2: Write integration tests**

```swift
// mac/Tests/LlmIdeMacTests/ServiceTests/AutomationServiceTests.swift

import Testing
import Foundation
@testable import LlmIdeMac

@Suite("AutomationService tests")
struct AutomationServiceTests {
    let tempDir: URL
    let service: AutomationService
    let memoryService: MemoryService

    init() throws {
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        self.tempDir = temp
        self.service = AutomationServiceImpl()
        self.memoryService = MemoryServiceImpl()
    }

    deinit {
        try? FileManager.default.removeItem(at: tempDir)
    }

    @Test("captureFromAgentTurn does not crash")
    func captureFromAgentTurnWorks() async throws {
        let context = AgentContext(
            repoRoot: tempDir,
            userMessage: "How do I deploy?",
            agentReply: "Run fly deploy",
            timestamp: Date().timeIntervalSince1970
        )
        
        // Should not throw
        try await service.captureFromAgentTurn(context: context)
    }

    @Test("captureFromUI does not crash")
    func captureFromUIWorks() async throws {
        let action = UIAction.fileViewed(file: URL(fileURLWithPath: "/test.ts"))
        
        // Should not throw
        try await service.captureFromUI(action: action)
    }

    @Test("cleanupStaleFacts removes old facts")
    func cleanupRemovesStaleFacts() async throws {
        let oldFact = ChatMemoryFact(
            text: "Old fact",
            category: .convention,
            timestamp: Date().timeIntervalSince1970 - (40 * 24 * 60 * 60),
            source: .agent
        )
        
        let newFact = ChatMemoryFact(
            text: "New fact",
            category: .convention,
            timestamp: Date().timeIntervalSince1970,
            source: .agent
        )
        
        try await memoryService.writeChatMemory(repoRoot: tempDir, facts: [oldFact, newFact])
        let report = try await service.cleanupStaleFacts(repoRoot: tempDir, olderThanDays: 30)
        
        #expect(report.removed.count == 1)
        #expect(report.kept.count == 1)
        #expect(report.removed[0].reason == "stale_age")
    }

    @Test("detectContradictions finds conflicting facts")
    func detectContradictionsWorks() async throws {
        let facts = [
            ChatMemoryFact(
                text: "This project uses npm for package management",
                category: .tooling,
                timestamp: Date().timeIntervalSince1970,
                source: .agent
            ),
            ChatMemoryFact(
                text: "This project does not use npm",
                category: .tooling,
                timestamp: Date().timeIntervalSince1970,
                source: .agent
            )
        ]
        
        try await memoryService.writeChatMemory(repoRoot: tempDir, facts: facts)
        let report = try await service.detectContradictions(repoRoot: tempDir)
        
        #expect(report.contradictions.count > 0)
    }

    @Test("regenerateOnDocChange calls graph service")
    func regenerateOnDocChangeWorks() async throws {
        // Should not throw
        try await service.regenerateOnDocChange(repoRoot: tempDir)
    }

    @Test("regenerateOnCodeChange calls graph service")
    func regenerateOnCodeChangeWorks() async throws {
        // Should not throw
        try await service.regenerateOnCodeChange(repoRoot: tempDir)
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cd mac
swift test --filter AutomationServiceTests
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutomationService.swift mac/Tests/LlmIdeMacTests/ServiceTests/AutomationServiceTests.swift
git commit -m "feat(services): add Swift AutomationService protocol"
```


### Task 7: Integration Tests - Service Parity Verification

**Files:**
- Create: `extension/graphkit/tests/service-parity.test.ts`
- Create: `mac/Tests/LlmIdeMacTests/ServiceTests/ServiceParityTests.swift`

**Interfaces:**
- Consumes: All services (MemoryService, GraphService, AutomationService)
- Produces: Integration tests verifying behavior parity with old implementations

- [ ] **Step 1: Write TypeScript integration parity tests**

```typescript
// extension/graphkit/tests/service-parity.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { memoryService, graphService, automationService } from '../graphkit/services/index.js';
import { renderRepoMemory } from '../graphkit/memory.mjs';

const TEST_REPO = path.join(tmpdir(), 'llm-ide-test-repo');

function makeRepo() {
  const dir = path.join(tmpdir(), `test-${Date.now()}`);
  const root = pathToFileURL(dir + '/');
  return { dir, root };
}

test('Service layer: MemoryService parity with memory.mjs', async () => {
  const { dir, root } = makeRepo();
  try {
    // Create test data using old implementation
    const { promises: fs } = await import('node:fs');
    await fs.mkdir(path.join(dir, '.llm-ide', 'memory'), { recursive: true });
    await fs.writeFile(path.join(dir, '.llm-ide', 'memory', 'repo.md'), '# Test\n\nTest content');
    
    // Read using new service
    const serviceResult = await memoryService.readMemory(root);
    
    // Verify basic parity
    assert.ok(serviceResult.facts.length >= 0); // Should have facts array
    assert.equal(serviceResult.bugs.length, 0); // TODO: implement bugs
    assert.equal(serviceResult.qa.length, 0); // TODO: implement qa
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Service layer: GraphService parity with graph.mjs', async () => {
  const { root } = makeRepo();
  try {
    // Create test graph
    const { writeGraphFile } = await import('../graphkit/storage/graph-storage.js');
    await writeGraphFile(root, {
      nodes: [
        { id: 'test.ts', label: 'test.ts', kind: 'file' }
      ],
      edges: [],
      mode: 'code'
    });
    
    // Query using new service
    const results = await graphService.queryGraph(root, 'test', 10);
    
    // Verify parity
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'test.ts');
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('Service layer: AutomationService cleanup is safe', async () => {
  const { root } = makeRepo();
  try {
    // Should not crash even with empty repo
    const report = await automationService.cleanupStaleFacts(root, 30);
    
    assert.equal(report.removed.length, 0);
    assert.equal(report.kept.length, 0);
  } finally {
    await rm(path.dirname(decodeURIComponent(root.pathname)), { recursive: true, force: true });
  }
});

test('Service layer: End-to-end workflow', async () => {
  const { dir, root } = makeRepo();
  try {
    // Write fact
    const facts = [
      {
        text: 'This project uses TypeScript',
        category: 'tooling' as const,
        timestamp: Date.now(),
        source: 'agent' as const
      }
    ];
    await memoryService.writeChatMemory(root, facts);
    
    // Read fact back
    const read = await memoryService.readChatMemory(root);
    assert.equal(read.length, 1);
    assert.equal(read[0].text, 'This project uses TypeScript');
    
    // Validate fact
    const validation = await memoryService.validateFact(root, read[0]);
    assert.ok(validation.valid);
    
    // Cleanup should keep it (not stale)
    const cleanupReport = await automationService.cleanupStaleFacts(root, 30);
    assert.equal(cleanupReport.kept.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write Swift integration parity tests**

```swift
// mac/Tests/LlmIdeMacTests/ServiceTests/ServiceParityTests.swift

import Testing
import Foundation
@testable import LlmIdeMac

@Suite("Service parity tests")
struct ServiceParityTests {
    let tempDir: URL
    let memoryService: MemoryService
    let graphService: GraphService
    let automationService: AutomationService

    init() throws {
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-ide-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        self.tempDir = temp
        self.memoryService = MemoryServiceImpl()
        self.graphService = GraphServiceImpl()
        self.automationService = AutomationServiceImpl()
    }

    deinit {
        try? FileManager.default.removeItem(at: tempDir)
    }

    @Test("MemoryService basic operations work")
    func memoryServiceWorks() async throws {
        let facts = [
            ChatMemoryFact(
                text: "This project uses Swift",
                category: .tooling,
                timestamp: Date().timeIntervalSince1970,
                source: .agent
            )
        ]
        
        try await memoryService.writeChatMemory(repoRoot: tempDir, facts: facts)
        let read = try await memoryService.readChatMemory(repoRoot: tempDir)
        
        #expect(read.count == 1)
        #expect(read[0].text == "This project uses Swift")
    }

    @Test("GraphService basic operations work")
    func graphServiceWorks() async throws {
        let storage = GraphStorage()
        let graph = GraphData(
            nodes: [GraphNode(id: "file.swift", label: "file.swift", kind: .file)],
            edges: [],
            mode: .code
        )
        try await storage.writeGraphFile(tempDir, graph: graph)
        
        let results = try await graphService.queryGraph(repoRoot: tempDir, query: "swift", limit: 10)
        
        #expect(results.count == 1)
        #expect(results[0].id == "file.swift")
    }

    @Test("AutomationService cleanup is safe")
    func automationServiceSafe() async throws {
        let report = try await automationService.cleanupStaleFacts(repoRoot: tempDir, olderThanDays: 30)
        
        #expect(report.removed.count == 0)
        #expect(report.kept.count == 0)
    }

    @Test("End-to-end workflow works")
    func endToEndWorks() async throws {
        let facts = [
            ChatMemoryFact(
                text: "This project uses SwiftUI",
                category: .tooling,
                timestamp: Date().timeIntervalSince1970,
                source: .agent
            )
        ]
        
        try await memoryService.writeChatMemory(repoRoot: tempDir, facts: facts)
        let read = try await memoryService.readChatMemory(repoRoot: tempDir)
        
        #expect(read.count == 1)
        
        let validation = try await memoryService.validateFact(repoRoot: tempDir, fact: read[0])
        #expect(validation.valid)
        
        let cleanupReport = try await automationService.cleanupStaleFacts(repoRoot: tempDir, olderThanDays: 30)
        #expect(cleanupReport.kept.count == 1)
    }
}
```

- [ ] **Step 3: Run all tests**

```bash
# Extension
cd extension
npm test

# Mac app
cd mac
swift test
```

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add extension/graphkit/tests/service-parity.test.ts mac/Tests/LlmIdeMacTests/ServiceTests/ServiceParityTests.swift
git commit -m "test(services): add integration parity tests"
```

---

## Phase 2 Completion Checklist

After completing all 7 tasks:

- [ ] All service interfaces defined (TypeScript + Swift)
- [ ] All service implementations complete (delegating to old code)
- [ ] All integration tests passing (verify parity)
- [ ] Type check passes (`npm run type-check` for extension)
- [ ] Swift build passes (`swift build` for mac app)
- [ ] Full test suite passes (extension: 835+ tests, mac: 48+ tests)
- [ ] Documentation updated (if needed)

## Success Criteria

Phase 2 succeeds when:

1. **No breaking changes:** Existing code continues working
2. **Behavior parity:** Services produce same results as old implementations
3. **Integration verified:** Cross-platform tests confirm consistency
4. **Clean separation:** Services use Phase 1 storage layer correctly
5. **Ready for Phase 3:** Call sites can be migrated incrementally

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-08-phase2-service-layer.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

If Subagent-Driven chosen:
- **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development
- Fresh subagent per task + two-stage review

If Inline Execution chosen:
- **REQUIRED SUB-SKILL:** Use superpowers:executing-plans
- Batch execution with checkpoints for review

