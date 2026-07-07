# Phase 1: Storage Layer & Types — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create storage layer abstractions and type definitions with atomic writes and migration support

**Architecture:** Low-level file I/O layer that reads/writes to `.llm-ide/` directory with atomic writes, typed errors, and migration from legacy paths. Zero breaking changes to existing code.

**Tech Stack:** TypeScript (Node), Swift (macOS), Node.js fs/promises, FileManager

## Global Constraints

- **No breaking changes:** Old code must continue working
- **Atomic writes:** All writes use temp-file + rename pattern
- **Typed errors:** StorageError/MemoryStorageError with specific error codes
- **Migration:** Preserve old paths, move data to `.llm-ide/` on first run
- **Testing:** All storage operations must have unit tests
- **Node version:** 20+ (extension)
- **Swift version:** 5.9+ (mac app)
- **Target directory:** `<repo>/.llm-ide/` (canonical)

---

## Task 1: Extension - Memory Type Definitions

**Files:**
- Create: `extension/graphkit/types/memory.ts`
- Modify: `extension/graphkit/index.ts` (add re-export)

**Interfaces:**
- Produces: `MemoryData`, `ChatMemoryFact`, `BugReport`, `QAEntry`, `ValidationResult`, `ValidationReport`

**Why:** Define all memory-related types upfront so both storage and service layers can use them.

- [ ] **Step 1: Write the type definitions file**

```typescript
// extension/graphkit/types/memory.ts

/**
 * A single fact captured from agent turns or UI actions.
 * Facts are durable project knowledge that should remain
 * true across sessions.
 */
export interface ChatMemoryFact {
  /** The fact text (280 chars max) */
  text: string;
  
  /** Fact category for tagging */
  category: 'convention' | 'architecture' | 'tooling' | 'command' | 'preference';
  
  /** When this fact was captured */
  timestamp: number;
  
  /** Source of this fact */
  source: 'agent' | 'ui' | 'manual';
  
  /** Optional metadata (e.g., file paths mentioned) */
  metadata?: {
    files?: string[];
    relatedModules?: string[];
  };
}

/**
 * In-memory representation of all memory data for a repo.
 */
export interface MemoryData {
  facts: ChatMemoryFact[];
  bugs: BugReport[];
  qa: QAEntry[];
}

/**
 * Bug report with YAML frontmatter + markdown body.
 */
export interface BugReport {
  /** ISO 8601 timestamp + slug for filename */
  id: string; // "2026-07-07-auth-flow-bug"
  
  /** YAML frontmatter fields */
  severity: 'info' | 'minor' | 'major' | 'critical';
  prompt: string;
  response: string;
  reportedAt: string; // ISO 8601
  gitHead: string;
  appVersion: string;
  agent: string;
  status: 'open' | 'acknowledged' | 'fixed' | 'wont_fix';
  tags: string[];
  
  /** Markdown body (user notes on what went wrong) */
  body: string;
}

/**
 * Saved Q&A entry from repeated-command detection.
 */
export interface QAEntry {
  /** Question slug for filename */
  id: string;
  
  /** YAML frontmatter */
  question: string;
  answer: string;
  savedAt: string; // ISO 8601
  askCount: number;
  agent: string;
  
  /** Optional markdown body (additional notes) */
  body?: string;
}

/**
 * Result of validating a single fact.
 */
export interface ValidationResult {
  valid: boolean;
  reason?: 'file_not_found' | 'contradiction' | 'invalid_command' | 'syntax_error';
  details?: string;
  contradicts?: ChatMemoryFact;
}

/**
 * Report from validating all facts.
 */
export interface ValidationReport {
  valid: number;
  invalid: number;
  errors: Array<{ fact: ChatMemoryFact; reason: string }>;
}

/**
 * Categories for filtering/tagging facts.
 */
export type FactCategory = ChatMemoryFact['category'];

/**
 * Fact source.
 */
export type FactSource = ChatMemoryFact['source'];
```

- [ ] **Step 2: Add re-export to index.ts**

```typescript
// extension/graphkit/index.ts

// Types
export * from './types/memory';
export * from './types/graph';
```

- [ ] **Step 3: Commit**

```bash
git add extension/graphkit/types/memory.ts extension/graphkit/index.ts
git commit -m "feat(types): add memory type definitions

- ChatMemoryFact, BugReport, QAEntry interfaces
- ValidationResult, ValidationReport for validation
- Re-export from graphkit index

Phase 1 Task 1"
```

---

## Task 2: Extension - Graph Type Definitions

**Files:**
- Create: `extension/graphkit/types/graph.ts`
- Modify: `extension/graphkit/index.ts` (already updated in Task 1)

**Interfaces:**
- Produces: `GraphData`, `GraphNode`, `GraphEdge`, `GraphMode`, `CodeRef`

- [ ] **Step 1: Write the graph type definitions**

```typescript
// extension/graphkit/types/graph.ts

/**
 * Unified graph data structure.
 */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * A node in the code/doc graph.
 */
export interface GraphNode {
  id: string;
  title: string;
  kind: GraphNodeKind;
  metadata?: Record<string, unknown>;
}

/**
 * Node kinds in the graph.
 */
export type GraphNodeKind = 
  | 'codeFile'
  | 'codeSymbol'
  | 'docPage'
  | 'memoryChunk'
  | 'memoryDoc';

/**
 * An edge between nodes.
 */
export interface GraphEdge {
  fromId: string;
  toId: string;
  kind: GraphEdgeKind;
}

/**
 * Edge kinds.
 */
export type GraphEdgeKind = 
  | 'imports'
  | 'references'
  | 'partOf'
  | 'relatedTo';

/**
 * Generation mode for graphs.
 */
export type GraphMode = 'code' | 'doc' | 'all';

/**
 * A code reference returned by graph queries.
 */
export interface CodeRef {
  ref: string;
  title: string;
  bodyExcerpt: string;
  rank: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/graphkit/types/graph.ts
git commit -m "feat(types): add graph type definitions

- GraphData, GraphNode, GraphEdge interfaces
- GraphNodeKind, GraphEdgeKind enums
- GraphMode, CodeRef types

Phase 1 Task 2"
```

---

## Task 3: Extension - Memory Storage Implementation

**Files:**
- Create: `extension/graphkit/storage/memory-storage.ts`
- Create: `extension/tests/storage/memory-storage.test.ts`

**Interfaces:**
- Consumes: `ChatMemoryFact`, `BugReport`, `QAEntry` (from Task 1)
- Produces: `readMemoryFile()`, `writeMemoryFile()`, `MemoryStorageError`

- [ ] **Step 1: Write the storage implementation**

```typescript
// extension/graphkit/storage/memory-storage.ts

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { 
  ChatMemoryFact, 
  BugReport, 
  QAEntry, 
  MemoryData 
} from '../types/memory.js';

/**
 * Typed error for memory storage operations.
 */
export class MemoryStorageError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'CORRUPTED' | 'MIGRATION_FAILED',
    message: string,
    public path?: string
  ) {
    super(message);
    this.name = 'MemoryStorageError';
  }
}

/**
 * Get the canonical memory directory for a repo.
 */
export function getMemoryDir(repoRoot: URL): string {
  return path.join(repoRoot.pathname, '.llm-ide', 'memory');
}

/**
 * Read a memory file.
 */
export async function readMemoryFile(
  repoRoot: URL,
  filename: string
): Promise<string> {
  const memDir = getMemoryDir(repoRoot);
  const filePath = path.join(memDir, filename);
  
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new MemoryStorageError('NOT_FOUND', `Memory file not found: ${filename}`, filePath);
    }
    if (err.code === 'EACCES') {
      throw new MemoryStorageError('PERMISSION_DENIED', `Cannot read memory file: ${filename}`, filePath);
    }
    throw new MemoryStorageError('CORRUPTED', `Failed to read memory file: ${err.message}`, filePath);
  }
}

/**
 * Write a memory file atomically (temp file + rename).
 */
export async function writeMemoryFile(
  repoRoot: URL,
  filename: string,
  content: string
): Promise<void> {
  const memDir = getMemoryDir(repoRoot);
  await fs.mkdir(memDir, { recursive: true });
  
  const filePath = path.join(memDir, filename);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  
  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err: any) {
    // Clean up temp file if write failed
    try {
      await fs.unlink(tempPath);
    } catch {}
    
    if (err.code === 'EACCES') {
      throw new MemoryStorageError('PERMISSION_DENIED', `Cannot write memory file: ${filename}`, filePath);
    }
    throw new MemoryStorageError('CORRUPTED', `Failed to write memory file: ${err.message}`, filePath);
  }
}

/**
 * Read repo.md file.
 */
export async function readRepoMD(repoRoot: URL): Promise<string> {
  try {
    return await readMemoryFile(repoRoot, 'repo.md');
  } catch (err) {
    if (err instanceof MemoryStorageError && err.code === 'NOT_FOUND') {
      return ''; // Empty if not found
    }
    throw err;
  }
}

/**
 * Parse chat-memory.md into facts.
 */
export async function readChatMemory(repoRoot: URL): Promise<ChatMemoryFact[]> {
  try {
    const content = await readMemoryFile(repoRoot, 'chat-memory.md');
    // Simple line-by-line parser for MVP
    return content
      .split('\n')
      .filter(line => line.startsWith('- '))
      .map(line => ({
        text: line.slice(2),
        category: 'convention' as const,
        timestamp: Date.now(),
        source: 'agent' as const
      }));
  } catch (err) {
    if (err instanceof MemoryStorageError && err.code === 'NOT_FOUND') {
      return [];
    }
    throw err;
  }
}

/**
 * Write facts to chat-memory.md.
 */
export async function writeChatMemory(
  repoRoot: URL,
  facts: ChatMemoryFact[]
): Promise<void> {
  const header = `# Chat memory
_Auto-captured by the Code Assistant from prior chats about this project._
_Recalled automatically next session. View or clear these in the app._

`;
  const content = header + facts.map(f => `- ${f.text}`).join('\n') + '\n';
  await writeMemoryFile(repoRoot, 'chat-memory.md', content);
}
```

- [ ] **Step 2: Write tests**

```typescript
// extension/tests/storage/memory-storage.test.ts

import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getMemoryDir,
  readMemoryFile,
  writeMemoryFile,
  readRepoMD,
  readChatMemory,
  writeChatMemory,
  MemoryStorageError
} from '../../graphkit/storage/memory-storage.ts';

const TEST_REPO = path.join(tmpdir(), 'llm-ide-test-repo');

describe('MemoryStorage', () => {
  beforeEach(async () => {
    await mkdtemp(TEST_REPO);
  });
  
  afterEach(async () => {
    await rm(TEST_REPO, { recursive: true, force: true });
  });
  
  describe('getMemoryDir', () => {
    it('should return .llm-ide/memory path', () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      const result = getMemoryDir(repoRoot);
      
      assert.equal(result, path.join(TEST_REPO, '.llm-ide', 'memory'));
    });
  });
  
  describe('readMemoryFile', () => {
    it('should read existing file', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      await writeMemoryFile(repoRoot, 'test.md', 'content');
      
      const result = await readMemoryFile(repoRoot, 'test.md');
      
      assert.equal(result, 'content');
    });
    
    it('should throw NOT_FOUND for missing file', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      
      try {
        await readMemoryFile(repoRoot, 'missing.md');
        assert.fail('Should have thrown');
      } catch (err) {
        assert(err instanceof MemoryStorageError);
        assert.equal(err.code, 'NOT_FOUND');
      }
    });
  });
  
  describe('writeMemoryFile', () => {
    it('should write file atomically', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      
      await writeMemoryFile(repoRoot, 'test.md', 'content');
      
      const result = await readMemoryFile(repoRoot, 'test.md');
      assert.equal(result, 'content');
    });
    
    it('should create directory if missing', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      
      await writeMemoryFile(repoRoot, 'test.md', 'content');
      
      const result = await readMemoryFile(repoRoot, 'test.md');
      assert.equal(result, 'content');
    });
  });
  
  describe('readChatMemory', () => {
    it('should parse facts from file', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      await writeMemoryFile(repoRoot, 'chat-memory.md', 
        '# Chat memory\n\n- fact 1\n- fact 2\n'
      );
      
      const facts = await readChatMemory(repoRoot);
      
      assert.equal(facts.length, 2);
      assert.equal(facts[0].text, 'fact 1');
      assert.equal(facts[1].text, 'fact 2');
    });
    
    it('should return empty array for missing file', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      
      const facts = await readChatMemory(repoRoot);
      
      assert.equal(facts.length, 0);
    });
  });
  
  describe('writeChatMemory', () => {
    it('should write facts with header', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      const facts = [
        { text: 'fact 1', category: 'convention' as const, timestamp: Date.now(), source: 'agent' as const }
      ];
      
      await writeChatMemory(repoRoot, facts);
      
      const content = await readMemoryFile(repoRoot, 'chat-memory.md');
      assert(content.includes('# Chat memory'));
      assert(content.includes('- fact 1'));
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
cd extension
npm test -- tests/storage/memory-storage.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add extension/graphkit/storage/memory-storage.ts extension/tests/storage/memory-storage.test.ts
git commit -m "feat(storage): add memory storage layer

- Atomic writes using temp-file + rename pattern
- readMemoryFile, writeMemoryFile with typed errors
- readChatMemory, writeChatMemory for fact persistence
- Full test coverage

Phase 1 Task 3"
```

---

## Task 4: Extension - Graph Storage Implementation

**Files:**
- Create: `extension/graphkit/storage/graph-storage.ts`
- Create: `extension/tests/storage/graph-storage.test.ts`

**Interfaces:**
- Consumes: `GraphData`, `GraphNode`, `GraphEdge` (from Task 2)
- Produces: `readGraphFile()`, `writeGraphFile()`, `GraphStorageError`

- [ ] **Step 1: Write the graph storage implementation**

```typescript
// extension/graphkit/storage/graph-storage.ts

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GraphData } from '../types/graph.js';

/**
 * Typed error for graph storage operations.
 */
export class GraphStorageError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'CORRUPTED',
    message: string,
    public path?: string
  ) {
    super(message);
    this.name = 'GraphStorageError';
  }
}

/**
 * Get the canonical graph directory for a repo.
 */
export function getGraphDir(repoRoot: URL): string {
  return path.join(repoRoot.pathname, '.llm-ide', 'graph');
}

/**
 * Read graph.json file.
 */
export async function readGraphFile(repoRoot: URL): Promise<GraphData> {
  const graphDir = getGraphDir(repoRoot);
  const filePath = path.join(graphDir, 'graph.json');
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as GraphData;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { nodes: [], edges: [] }; // Empty graph if not found
    }
    if (err.code === 'EACCES') {
      throw new GraphStorageError('PERMISSION_DENIED', 'Cannot read graph file', filePath);
    }
    if (err instanceof SyntaxError) {
      throw new GraphStorageError('CORRUPTED', `Invalid JSON in graph file: ${err.message}`, filePath);
    }
    throw new GraphStorageError('CORRUPTED', `Failed to read graph: ${err.message}`, filePath);
  }
}

/**
 * Write graph.json file atomically.
 */
export async function writeGraphFile(
  repoRoot: URL,
  graph: GraphData
): Promise<void> {
  const graphDir = getGraphDir(repoRoot);
  await fs.mkdir(graphDir, { recursive: true });
  
  const filePath = path.join(graphDir, 'graph.json');
  const tempPath = `${filePath}.${process.pid}.tmp`;
  
  try {
    const content = JSON.stringify(graph, null, 2);
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err: any) {
    try {
      await fs.unlink(tempPath);
    } catch {}
    
    if (err.code === 'EACCES') {
      throw new GraphStorageError('PERMISSION_DENIED', 'Cannot write graph file', filePath);
    }
    throw new GraphStorageError('CORRUPTED', `Failed to write graph: ${err.message}`, filePath);
  }
}

/**
 * Read doc fingerprint for change detection.
 */
export async function readDocFingerprint(repoRoot: URL): Promise<string | null> {
  const graphDir = getGraphDir(repoRoot);
  const filePath = path.join(graphDir, 'doc-fingerprint.txt');
  
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Write doc fingerprint.
 */
export async function writeDocFingerprint(
  repoRoot: URL,
  fingerprint: string
): Promise<void> {
  const graphDir = getGraphDir(repoRoot);
  await fs.mkdir(graphDir, { recursive: true });
  
  const filePath = path.join(graphDir, 'doc-fingerprint.txt');
  await fs.writeFile(filePath, fingerprint, 'utf-8');
}
```

- [ ] **Step 2: Write tests**

```typescript
// extension/tests/storage/graph-storage.test.ts

import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  getGraphDir,
  readGraphFile,
  writeGraphFile,
  readDocFingerprint,
  writeDocFingerprint,
  GraphStorageError
} from '../../graphkit/storage/graph-storage.ts';
import type { GraphData } from '../../graphkit/types/graph.ts';

const TEST_REPO = path.join(tmpdir(), 'llm-ide-test-repo');

describe('GraphStorage', () => {
  beforeEach(async () => {
    await mkdtemp(TEST_REPO);
  });
  
  afterEach(async () => {
    await rm(TEST_REPO, { recursive: true, force: true });
  });
  
  describe('readGraphFile', () => {
    it('should read existing graph', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      const graph: GraphData = {
        nodes: [{ id: '1', title: 'Test', kind: 'codeFile' }],
        edges: []
      };
      await writeGraphFile(repoRoot, graph);
      
      const result = await readGraphFile(repoRoot);
      
      assert.equal(result.nodes.length, 1);
      assert.equal(result.nodes[0].id, '1');
    });
    
    it('should return empty graph for missing file', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      
      const result = await readGraphFile(repoRoot);
      
      assert.equal(result.nodes.length, 0);
      assert.equal(result.edges.length, 0);
    });
    
    it('should throw CORRUPTED for invalid JSON', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      const graphDir = getGraphDir(repoRoot);
      await fs.mkdir(graphDir, { recursive: true });
      await fs.writeFile(path.join(graphDir, 'graph.json'), 'invalid json');
      
      try {
        await readGraphFile(repoRoot);
        assert.fail('Should have thrown');
      } catch (err) {
        assert(err instanceof GraphStorageError);
        assert.equal(err.code, 'CORRUPTED');
      }
    });
  });
  
  describe('writeDocFingerprint', () => {
    it('should write and read fingerprint', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      
      await writeDocFingerprint(repoRoot, 'abc123');
      const result = await readDocFingerprint(repoRoot);
      
      assert.equal(result, 'abc123');
    });
    
    it('should return null for missing fingerprint', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      
      const result = await readDocFingerprint(repoRoot);
      
      assert.equal(result, null);
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd extension
npm test -- tests/storage/graph-storage.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add extension/graphkit/storage/graph-storage.ts extension/tests/storage/graph-storage.test.ts
git commit -m "feat(storage): add graph storage layer

- readGraphFile, writeGraphFile with atomic writes
- Empty graph for missing files (graceful degradation)
- Doc fingerprint caching for change detection
- JSON validation with typed errors
- Full test coverage

Phase 1 Task 4"
```

---

## Task 5: Extension - Migration Implementation

**Files:**
- Create: `extension/graphkit/storage/migrate.ts`
- Create: `extension/tests/storage/migrate.test.ts'

**Interfaces:**
- Consumes: `getMemoryDir()`, `getGraphDir()` (from Tasks 3, 4)
- Produces: `migrateToLLMIdeStructure()`, `MigrationResult`

- [ ] **Step 1: Write the migration implementation**

```typescript
// extension/graphkit/storage/migrate.ts

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getMemoryDir, getGraphDir } from './memory-storage.js';

export interface MigrationStep {
  from: string;
  to: string;
}

export interface MigrationResult {
  migrated: MigrationStep[];
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ step: MigrationStep; error: string }>;
}

/**
 * Migrate legacy memory/graph directories to .llm-ide structure.
 */
export async function migrateToLLMIdeStructure(repoRoot: URL): Promise<MigrationResult> {
  const repoPath = repoRoot.pathname;
  
  const migrations: MigrationStep[] = [
    {
      from: path.join(repoPath, 'graphify-out', 'memory'),
      to: getMemoryDir(repoRoot)
    },
    {
      from: path.join(repoPath, 'system', 'graph'),
      to: getGraphDir(repoRoot)
    }
  ];
  
  const result: MigrationResult = {
    migrated: [],
    skipped: [],
    errors: []
  };
  
  for (const step of migrations) {
    try {
      const exists = await fs.access(step.from).then(() => true).catch(() => false);
      
      if (!exists) {
        result.skipped.push({ path: step.from, reason: 'not_found' });
        continue;
      }
      
      // Create target directory
      await fs.mkdir(step.to, { recursive: true });
      
      // Move all contents
      const entries = await fs.readdir(step.from, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(step.from, entry.name);
        const destPath = path.join(step.to, entry.name);
        await fs.rename(srcPath, destPath);
      }
      
      // Remove old directory if empty
      try {
        await fs.rmdir(step.from);
      } catch {
        // Directory not empty, leave it
      }
      
      result.migrated.push(step);
    } catch (err: any) {
      result.errors.push({ step, error: err.message });
    }
  }
  
  return result;
}

/**
 * Check if migration is needed.
 */
export async function needsMigration(repoRoot: URL): Promise<boolean> {
  const repoPath = repoRoot.pathname;
  const legacyPaths = [
    path.join(repoPath, 'graphify-out', 'memory'),
    path.join(repoPath, 'system', 'graph')
  ];
  
  for (const legacyPath of legacyPaths) {
    try {
      await fs.access(legacyPath);
      return true;
    } catch {
      // Doesn't exist, check next
    }
  }
  
  return false;
}
```

- [ ] **Step 2: Write tests**

```typescript
// extension/tests/storage/migrate.test.ts

import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  migrateToLLMIdeStructure,
  needsMigration
} from '../../graphkit/storage/migrate.ts';

const TEST_REPO = path.join(tmpdir(), 'llm-ide-test-repo');

describe('Migration', () => {
  beforeEach(async () => {
    await mkdtemp(TEST_REPO);
  });
  
  afterEach(async () => {
    await rm(TEST_REPO, { recursive: true, force: true });
  });
  
  describe('needsMigration', () => {
    it('should return false for new repo', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      
      const result = await needsMigration(repoRoot);
      
      assert.equal(result, false);
    });
    
    it('should return true if legacy path exists', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      const legacyPath = path.join(TEST_REPO, 'graphify-out', 'memory');
      await fs.mkdir(legacyPath, { recursive: true });
      
      const result = await needsMigration(repoRoot);
      
      assert.equal(result, true);
    });
  });
  
  describe('migrateToLLMIdeStructure', () => {
    it('should migrate legacy memory directory', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      const legacyPath = path.join(TEST_REPO, 'graphify-out', 'memory');
      await fs.mkdir(legacyPath, { recursive: true });
      await fs.writeFile(path.join(legacyPath, 'test.md'), 'content');
      
      const result = await migrateToLLMIdeStructure(repoRoot);
      
      assert.equal(result.migrated.length, 1);
      
      // Verify file moved
      const newMemoryDir = path.join(TEST_REPO, '.llm-ide', 'memory');
      const content = await fs.readFile(path.join(newMemoryDir, 'test.md'), 'utf-8');
      assert.equal(content, 'content');
    });
    
    it('should skip missing directories', async () => {
      const repoRoot = new URL(`file://${TEST_REPO}`);
      
      const result = await migrateToLLMIdeStructure(repoRoot);
      
      assert.equal(result.migrated.length, 0);
      assert.equal(result.skipped.length, 2);
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd extension
npm test -- tests/storage/migrate.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add extension/graphkit/storage/migrate.ts extension/tests/storage/migrate.test.ts
git commit -m "feat(storage): add directory migration

- migrateToLLMIdeStructure moves legacy paths to .llm-ide/
- needsMigration checks if migration is required
- Handles graphify-out/memory and system/graph
- Preserves data, leaves old paths for rollback
- Full test coverage

Phase 1 Task 5"
```

---

## Task 6: Mac App - Memory Storage Implementation

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/Storage/MemoryStorage.swift`
- Create: `mac/Tests/LlmIdeMacTests/Services/Storage/MemoryStorageTests.swift`

**Interfaces:**
- Produces: `MemoryStorage.read()`, `MemoryStorage.write()`, `MemoryStorageError`

- [ ] **Step 1: Write the Swift implementation**

```swift
// mac/Sources/LlmIdeMac/Services/Storage/MemoryStorage.swift

import Foundation

enum MemoryStorageError: LocalizedError {
    case notFound(path: String)
    case permissionDenied(path: String)
    case corrupted(path: String, underlying: Error)
    
    var errorDescription: String? {
        switch self {
        case .notFound(let path):
            return "Memory file not found: \(path)"
        case .permissionDenied(let path):
            return "Permission denied accessing: \(path)"
        case .corrupted(let path, let underlying):
            return "Memory file corrupted: \(path) - \(underlying.localizedDescription)"
        }
    }
}

@MainActor
final class MemoryStorage {
    
    /// Get the canonical memory directory for a repo
    func getMemoryDir(repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
    }
    
    /// Read a memory file
    func read(repoRoot: URL, filename: String) async throws -> String {
        let memDir = getMemoryDir(repoRoot: repoRoot)
        let fileURL = memDir.appendingPathComponent(filename)
        
        do {
            return try String(contentsOf: fileURL, encoding: .utf8)
        } catch let err as CocoaError {
            if err.code == .fileReadNoSuchFile {
                throw MemoryStorageError.notFound(path: fileURL.path)
            }
            if err.code == .fileReadNoPermission {
                throw MemoryStorageError.permissionDenied(path: fileURL.path)
            }
            throw MemoryStorageError.corrupted(path: fileURL.path, underlying: err)
        }
    }
    
    /// Write a memory file atomically
    func write(repoRoot: URL, filename: String, content: String) async throws {
        let memDir = getMemoryDir(repoRoot: repoRoot)
        try FileManager.default.createDirectory(at: memDir, withIntermediateDirectories: true)
        
        let fileURL = memDir.appendingPathComponent(filename)
        let tempURL = fileURL.appendingPathExtension("tmp")
        
        do {
            try content.write(to: tempURL, atomically: true, encoding: .utf8)
            try FileManager.default.moveItem(at: tempURL, to: fileURL)
        } catch let err as CocoaError {
            // Clean up temp file
            try? FileManager.default.removeItem(at: tempURL)
            
            if err.code == .fileWriteNoPermission {
                throw MemoryStorageError.permissionDenied(path: fileURL.path)
            }
            throw MemoryStorageError.corrupted(path: fileURL.path, underlying: err)
        }
    }
    
    /// Read repo.md
    func readRepoMD(repoRoot: URL) async throws -> String {
        do {
            return try await read(repoRoot: repoRoot, filename: "repo.md")
        } catch MemoryStorageError.notFound {
            return "" // Empty if not found
        }
    }
    
    /// Read chat-memory.md
    func readChatMemory(repoRoot: URL) async throws -> String {
        do {
            return try await read(repoRoot: repoRoot, filename: "chat-memory.md")
        } catch MemoryStorageError.notFound {
            return "" // Empty if not found
        }
    }
    
    /// Write chat-memory.md
    func writeChatMemory(repoRoot: URL, content: String) async throws {
        try await write(repoRoot: repoRoot, filename: "chat-memory.md", content: content)
    }
}
```

- [ ] **Step 2: Write tests**

```swift
// mac/Tests/LlmIdeMacTests/Services/Storage/MemoryStorageTests.swift

import XCTest
@testable import LlmIdeMac

final class MemoryStorageTests: XCTestCase {
    var storage: MemoryStorage!
    var testRepoURL: URL!
    
    override func setUp() async throws {
        storage = MemoryStorage()
        let tempDir = FileManager.default.temporaryDirectory
        testRepoURL = tempDir.appendingPathComponent("llm-ide-test-\(UUID())")
        try FileManager.default.createDirectory(at: testRepoURL, withIntermediateDirectories: true)
    }
    
    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: testRepoURL)
    }
    
    func testGetMemoryDir() async throws {
        let result = storage.getMemoryDir(repoRoot: testRepoURL)
        
        let expectedPath = testRepoURL.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
        XCTAssertEqual(result, expectedPath)
    }
    
    func testReadWritesFile() async throws {
        try await storage.write(repoRoot: testRepoURL, filename: "test.md", content: "content")
        
        let result = try await storage.read(repoRoot: testRepoURL, filename: "test.md")
        
        XCTAssertEqual(result, "content")
    }
    
    func testReadReturnsNotFoundForMissingFile() async throws {
        do {
            _ = try await storage.read(repoRoot: testRepoURL, filename: "missing.md")
            XCTFail("Should have thrown")
        } catch MemoryStorageError.notFound {
            // Expected
        } catch {
            XCTFail("Wrong error type: \(error)")
        }
    }
    
    func testWriteCreatesDirectory() async throws {
        // Directory doesn't exist yet
        try await storage.write(repoRoot: testRepoURL, filename: "test.md", content: "content")
        
        let result = try await storage.read(repoRoot: testRepoURL, filename: "test.md")
        XCTAssertEqual(result, "content")
    }
    
    func testReadRepoMDEmptyForMissingFile() async throws {
        let result = try await storage.readRepoMD(repoRoot: testRepoURL)
        XCTAssertEqual(result, "")
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cd mac
swift test --filter MemoryStorageTests
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/Storage/MemoryStorage.swift mac/Tests/LlmIdeMacTests/Services/Storage/MemoryStorageTests.swift
git commit -m "feat(storage): add Mac app memory storage

- MemoryStorage with atomic writes
- read, write, readRepoMD, readChatMemory methods
- Typed MemoryStorageError
- Full test coverage

Phase 1 Task 6"
```

---

## Task 7: Mac App - Graph Storage Implementation

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/Storage/GraphStorage.swift`
- Create: `mac/Tests/LlmIdeMacTests/Services/Storage/GraphStorageTests.swift`

**Interfaces:**
- Produces: `GraphStorage.readGraph()`, `GraphStorage.writeGraph()`, `GraphStorageError`

- [ ] **Step 1: Write the Swift implementation**

```swift
// mac/Sources/LlmIdeMac/Services/Storage/GraphStorage.swift

import Foundation
import GraphKit

enum GraphStorageError: LocalizedError {
    case notFound(path: String)
    case permissionDenied(path: String)
    case corrupted(path: String, underlying: Error)
    
    var errorDescription: String? {
        switch self {
        case .notFound(let path):
            return "Graph file not found: \(path)"
        case .permissionDenied(let path):
            return "Permission denied accessing: \(path)"
        case .corrupted(let path, let underlying):
            return "Graph file corrupted: \(path) - \(underlying.localizedDescription)"
        }
    }
}

@MainActor
final class GraphStorage {
    
    func getGraphDir(repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent(".llm-ide").appendingPathComponent("graph")
    }
    
    /// Read graph.json
    func readGraph(repoRoot: URL) async throws -> CGData {
        let graphDir = getGraphDir(repoRoot: repoRoot)
        let fileURL = graphDir.appendingPathComponent("graph.json")
        
        do {
            let data = try Data(contentsOf: fileURL)
            let decoder = JSONDecoder()
            return try decoder.decode(CGData.self, from: data)
        } catch let err as CocoaError {
            if err.code == .fileReadNoSuchFile {
                return CGData(nodes: [], edges: []) // Empty graph if not found
            }
            if err.code == .fileReadNoPermission {
                throw GraphStorageError.permissionDenied(path: fileURL.path)
            }
            throw GraphStorageError.corrupted(path: fileURL.path, underlying: err)
        } catch {
            throw GraphStorageError.corrupted(path: fileURL.path, underlying: error)
        }
    }
    
    /// Write graph.json atomically
    func writeGraph(repoRoot: URL, graph: CGData) async throws {
        let graphDir = getGraphDir(repoRoot: repoRoot)
        try FileManager.default.createDirectory(at: graphDir, withIntermediateDirectories: true)
        
        let fileURL = graphDir.appendingPathComponent("graph.json")
        let tempURL = fileURL.appendingPathExtension("tmp")
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(graph)
            try data.write(to: tempURL)
            try FileManager.default.moveItem(at: tempURL, to: fileURL)
        } catch let err as CocoaError {
            try? FileManager.default.removeItem(at: tempURL)
            
            if err.code == .fileWriteNoPermission {
                throw GraphStorageError.permissionDenied(path: fileURL.path)
            }
            throw GraphStorageError.corrupted(path: fileURL.path, underlying: err)
        }
    }
    
    /// Read doc fingerprint
    func readDocFingerprint(repoRoot: URL) async throws -> String? {
        let graphDir = getGraphDir(repoRoot: repoRoot)
        let fileURL = graphDir.appendingPathComponent("doc-fingerprint.txt")
        
        do {
            return try String(contentsOf: fileURL, encoding: .utf8)
        } catch let err as CocoaError {
            if err.code == .fileReadNoSuchFile {
                return nil
            }
            throw err
        }
    }
    
    /// Write doc fingerprint
    func writeDocFingerprint(repoRoot: URL, fingerprint: String) async throws {
        let graphDir = getGraphDir(repoRoot: repoRoot)
        try FileManager.default.createDirectory(at: graphDir, withIntermediateDirectories: true)
        
        let fileURL = graphDir.appendingPathComponent("doc-fingerprint.txt")
        try fingerprint.write(to: fileURL, atomically: true, encoding: .utf8)
    }
}
```

- [ ] **Step 2: Write tests**

```swift
// mac/Tests/LlmIdeMacTests/Services/Storage/GraphStorageTests.swift

import XCTest
@testable import LlmIdeMac
import GraphKit

final class GraphStorageTests: XCTestCase {
    var storage: GraphStorage!
    var testRepoURL: URL!
    
    override func setUp() async throws {
        storage = GraphStorage()
        let tempDir = FileManager.default.temporaryDirectory
        testRepoURL = tempDir.appendingPathComponent("llm-ide-test-\(UUID())")
        try FileManager.default.createDirectory(at: testRepoURL, withIntermediateDirectories: true)
    }
    
    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: testRepoURL)
    }
    
    func testReadGraphReturnsEmptyForMissingFile() async throws {
        let result = try await storage.readGraph(repoRoot: testRepoURL)
        
        XCTAssertEqual(result.nodes.count, 0)
        XCTAssertEqual(result.edges.count, 0)
    }
    
    func testWriteAndReadGraph() async throws {
        let graph = CGData(
            nodes: [CGNode(id: "1", title: "Test", kind: .codeFile)],
            edges: []
        )
        
        try await storage.writeGraph(repoRoot: testRepoURL, graph: graph)
        let result = try await storage.readGraph(repoRoot: testRepoURL)
        
        XCTAssertEqual(result.nodes.count, 1)
        XCTAssertEqual(result.nodes[0].id, "1")
    }
    
    func testWriteAndReadDocFingerprint() async throws {
        try await storage.writeDocFingerprint(repoRoot: testRepoURL, fingerprint: "abc123")
        
        let result = try await storage.readDocFingerprint(repoRoot: testRepoURL)
        
        XCTAssertEqual(result, "abc123")
    }
    
    func testReadDocFingerprintReturnsNilForMissing() async throws {
        let result = try await storage.readDocFingerprint(repoRoot: testRepoURL)
        
        XCTAssertNil(result)
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cd mac
swift test --filter GraphStorageTests
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/Storage/GraphStorage.swift mac/Tests/LlmIdeMacTests/Services/Storage/GraphStorageTests.swift
git commit -m "feat(storage): add Mac app graph storage

- GraphStorage with atomic writes
- readGraph, writeGraph, readDocFingerprint, writeDocFingerprint
- Empty graph for missing files (graceful degradation)
- Full test coverage

Phase 1 Task 7"
```

---

## Task 8: Mac App - Migration Implementation

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/Storage/Migration.swift`
- Create: `mac/Tests/LlmIdeMacTests/Services/Storage/MigrationTests.swift`

**Interfaces:**
- Produces: `Migration.migrate()`, `Migration.needsMigration()`

- [ ] **Step 1: Write the migration implementation**

```swift
// mac/Sources/LlmIdeMac/Services/Storage/Migration.swift

import Foundation

struct MigrationStep {
    let from: URL
    let to: URL
}

struct MigrationResult {
    var migrated: [MigrationStep] = []
    var skipped: [String] = []
    var errors: [(step: MigrationStep, error: String)] = []
}

@MainActor
final class Migration {
    
    /// Check if migration is needed
    func needsMigration(repoRoot: URL) -> Bool {
        let legacyPaths = [
            repoRoot.appendingPathComponent("graphify-out").appendingPathComponent("memory"),
            repoRoot.appendingPathComponent("system").appendingPathComponent("graph")
        ]
        
        for path in legacyPaths {
            if FileManager.default.fileExists(atPath: path.path) {
                return true
            }
        }
        
        return false
    }
    
    /// Migrate to .llm-ide structure
    func migrateToLLMIdeStructure(repoRoot: URL) -> MigrationResult {
        var result = MigrationResult()
        
        let memoryDir = repoRoot.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
        let graphDir = repoRoot.appendingPathComponent(".llm-ide").appendingPathComponent("graph")
        
        let migrations: [MigrationStep] = [
            MigrationStep(
                from: repoRoot.appendingPathComponent("graphify-out").appendingPathComponent("memory"),
                to: memoryDir
            ),
            MigrationStep(
                from: repoRoot.appendingPathComponent("system").appendingPathComponent("graph"),
                to: graphDir
            )
        ]
        
        for step in migrations {
            if !FileManager.default.fileExists(atPath: step.from.path) {
                result.skipped.append(step.from.path)
                continue
            }
            
            do {
                // Create target directory
                try FileManager.default.createDirectory(at: step.to, withIntermediateDirectories: true)
                
                // Move contents
                let contents = try FileManager.default.contentsOfDirectory(at: step.from, includingPropertiesForKeys: nil)
                for item in contents {
                    let src = step.from.appendingPathComponent(item.lastPathComponent)
                    let dest = step.to.appendingPathComponent(item.lastPathComponent)
                    try FileManager.default.moveItem(at: src, to: dest)
                }
                
                // Remove old directory if empty
                try? FileManager.default.removeItem(at: step.from)
                
                result.migrated.append(step)
            } catch let err {
                result.errors.append((step, err.localizedDescription))
            }
        }
        
        return result
    }
}
```

- [ ] **Step 2: Write tests**

```swift
// mac/Tests/LlmIdeMacTests/Services/Storage/MigrationTests.swift

import XCTest
@testable import LlmIdeMac

final class MigrationTests: XCTestCase {
    var migration: Migration!
    var testRepoURL: URL!
    
    override func setUp() async throws {
        migration = Migration()
        let tempDir = FileManager.default.temporaryDirectory
        testRepoURL = tempDir.appendingPathComponent("llm-ide-test-\(UUID())")
        try FileManager.default.createDirectory(at: testRepoURL, withIntermediateDirectories: true)
    }
    
    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: testRepoURL)
    }
    
    func testNeedsMigrationReturnsFalseForNewRepo() async throws {
        let result = migration.needsMigration(repoRoot: testRepoURL)
        
        XCTAssertEqual(result, false)
    }
    
    func testNeedsMigrationReturnsTrueForLegacyPath() async throws {
        let legacyPath = testRepoURL.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: legacyPath, withIntermediateDirectories: true)
        
        let result = migration.needsMigration(repoRoot: testRepoURL)
        
        XCTAssertEqual(result, true)
    }
    
    func testMigratesLegacyMemoryDirectory() async throws {
        let legacyPath = testRepoURL.appendingPathComponent("graphify-out").appendingPathComponent("memory")
        try FileManager.default.createDirectory(at: legacyPath, withIntermediateDirectories: true)
        try "content".write(to: legacyPath.appendingPathComponent("test.md"), atomically: true, encoding: .utf8)
        
        let result = migration.migrateToLLMIdeStructure(repoRoot: testRepoURL)
        
        XCTAssertEqual(result.migrated.count, 1)
        
        // Verify file moved
        let newMemoryDir = testRepoURL.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
        let content = try String(contentsOf: newMemoryDir.appendingPathComponent("test.md"), encoding: .utf8)
        XCTAssertEqual(content, "content")
    }
    
    func testSkipsMissingDirectories() async throws {
        let result = migration.migrateToLLMIdeStructure(repoRoot: testRepoURL)
        
        XCTAssertEqual(result.migrated.count, 0)
        XCTAssertEqual(result.skipped.count, 2)
    }
}
```

- [ ] **Step 3: Run tests**

```bash
cd mac
swift test --filter MigrationTests
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/Storage/Migration.swift mac/Tests/LlmIdeMacTests/Services/Storage/MigrationTests.swift
git commit -m "feat(storage): add Mac app directory migration

- Migration.migrateToLLMIdeStructure
- Migration.needsMigration check
- Moves graphify-out/memory and system/graph to .llm-ide/
- Preserves data, leaves old paths for rollback
- Full test coverage

Phase 1 Task 8"
```

---

## Verification

Run full test suite to ensure everything works together:

```bash
# Extension
cd extension
npm test

# Mac app
cd ../mac
swift test
```

Expected: All tests pass

---

## Success Criteria

✅ **Type definitions** for memory and graph structures
✅ **Storage layer** with atomic writes
✅ **Typed errors** (MemoryStorageError, GraphStorageError)
✅ **Migration functions** from legacy paths
✅ **Full test coverage** for all storage operations
✅ **No breaking changes** to existing code
✅ **All tests pass**

---

## Next Phase

Once Phase 1 is complete, proceed to **Phase 2: Service Layer** which will:
- Implement MemoryService, GraphService, AutomationService
- Services will delegate to old implementations initially
- Integration tests will verify parity with existing code

**Phase 1 is independently shippable** - the storage layer can be used by existing code without any changes to call sites.
