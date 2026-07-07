# Unified Memory & Graph System — Design Spec

**Date:** 2026-07-07
**Status:** Approved (brainstorming)
**Owner:** dnsmalla

## Goal

Create a professional-grade, unified memory and graph system that:
1. Consolidates scattered memory/graph logic into clear service layers
2. Uses a single canonical directory structure (`.llm-ide/`)
3. Provides automatic memory capture, cleanup, and updates
4. Works seamlessly across both extension (Node) and Mac app platforms

## Non-Goals

- Cross-repo memory (memory is per-repo only)
- Global/user-level memory (that stays in Settings)
- Changing the core graph algorithms (we're consolidating, not redesigning)
- LLM-as-judge for regression testing (staying with exact-match for v1)

## Problems Solved

**Current chaos:**
- Memory logic scattered across 5 files (1,228 lines) with overlapping responsibilities
- Graph system split between extension and Mac with no shared interfaces
- Three different memory directory conventions (`graphify-out/memory/`, `system/`, `.understand-anything/memory/`)
- No automatic cleanup of stale facts
- No validation of fact accuracy
- No auto-update when code/docs change

**This design delivers:**
- Single source of truth: `.llm-ide/` directory structure
- Clear protocol-based service layers (Storage → Service → Application)
- Full automation: auto-capture, auto-cleanup, auto-update
- Professional error handling and testing
- Incremental migration path with zero downtime

## Architecture

### Overall Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Application Layer                          │
│  (Mac: UAGraphView, CodeAssistantPanel                      │
│   Extension: route.mjs, agent prompts)                      │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│              Service Layer (Protocol-based)                  │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ MemoryService  │  │ GraphService │  │ AutomationService│ │
│  │ - read/write   │  │ - generate   │  │ - auto-capture  │ │
│  │ - validate     │  │ - query      │  │ - auto-cleanup  │ │
│  └────────────────┘  └──────────────┘  └─────────────────┘ │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│              Storage Layer (Single Source of Truth)          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │        <repo>/.llm-ide/                               │ │
│  │          ├── memory/         (facts, bugs, Q&A)        │ │
│  │          ├── graph/          (graph.json, index.md)     │ │
│  │          └── cache/          (scan cache, fingerprints) │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Directory Structure

**The unified `<repo>/.llm-ide/` directory:**

```
<repo>/.llm-ide/
├── memory/                          # All memory-related data
│   ├── repo.md                      # User-curated project facts
│   ├── chat-memory.md               # LLM-captured facts (auto)
│   ├── graph-notes.md                # Code+doc graph rendering (auto)
│   ├── doc-notes.md                 # Doc→code cross-refs (auto)
│   ├── bugs/                        # Bug reports
│   │   └── 2026-07-07-auth-flow.md  # ISO-dated YAML frontmatter
│   └── q&a/                         # Saved Q&A
│       └── deploy-command.md       # Repeated-command saves
├── graph/                           # Graph data & cache
│   ├── graph.json                   # Merged code+doc graph (auto)
│   ├── index.md                     # Impact-ranked summary (auto)
│   ├── code-cache.json             # StructureScanner cache (auto)
│   └── doc-fingerprint.txt         # Doc change detection (auto)
└── logs/                            # Operation logs
    ├── memory-capture.log          # Auto-capture events
    ├── cleanup.log                 # Stale fact removals
    └── regeneration.log             # Graph regeneration events
```

**Storage layer responsibilities:**
- Single source of truth — no more multiple paths
- Auto-generated files marked read-only
- User-editable files clearly marked
- Atomic writes (temp-file + rename pattern)

## Service Layer Design

### Protocol Interfaces

**Extension (TypeScript):**

```typescript
interface MemoryService {
  // Read operations
  readMemory(repoRoot: URL): Promise<MemoryData>;
  readChatMemory(repoRoot: URL): Promise<ChatMemoryFact[]>;
  readBugs(repoRoot: URL): Promise<BugReport[]>;
  readQA(repoRoot: URL): Promise<QAEntry[]>;
  
  // Write operations
  writeChatMemory(repoRoot: URL, facts: ChatMemoryFact[]): Promise<void>;
  writeBug(repoRoot: URL, bug: BugReport): Promise<void>;
  writeQA(repoRoot: URL, qa: QAEntry): Promise<void>;
  updateRepoMD(repoRoot: URL, content: string): Promise<void>;
  
  // Validation
  validateFact(repoRoot: URL, fact: ChatMemoryFact): Promise<ValidationResult>;
  validateAllFacts(repoRoot: URL): Promise<ValidationReport>;
}

interface GraphService {
  generateGraph(repoRoot: URL, mode: GraphMode): Promise<GraphData>;
  queryGraph(repoRoot: URL, query: string, limit?: number): Promise<GraphNode[]>;
  findRelatedCode(repoRoot: URL, query: string, limit?: number): Promise<CodeRef[]>;
  regenerateGraph(repoRoot: URL): Promise<void>;
}

interface AutomationService {
  // Auto-capture from agent turns
  captureFromAgentTurn(context: AgentContext, reply: string): Promise<void>;
  
  // Auto-capture from UI actions (Mac app)
  captureFromUI(action: UIAction): Promise<void>;
  
  // Auto-cleanup
  cleanupStaleFacts(repoRoot: URL, olderThanDays?: number): Promise<CleanupReport>;
  detectContradictions(repoRoot: URL): Promise<ContradictionReport>;
  
  // Auto-update
  regenerateOnDocChange(repoRoot: URL): Promise<void>;
  regenerateOnCodeChange(repoRoot: URL): Promise<void>;
}
```

**Mac App (Swift):**

```swift
protocol MemoryService {
    func readMemory(repoRoot: URL) async throws -> MemoryData
    func readChatMemory(repoRoot: URL) async throws -> [ChatMemoryFact]
    func readBugs(repoRoot: URL) async throws -> [BugReport]
    func readQA(repoRoot: URL) async throws -> [QAEntry]
    
    func writeChatMemory(repoRoot: URL, facts: [ChatMemoryFact]) async throws
    func writeBug(repoRoot: URL, bug: BugReport) async throws
    func writeQA(repoRoot: URL, qa: QAEntry) async throws
    func updateRepoMD(repoRoot: URL, content: String) async throws
    
    func validateFact(repoRoot: URL, fact: ChatMemoryFact) async throws -> ValidationResult
    func validateAllFacts(repoRoot: URL) async throws -> ValidationReport
}

protocol GraphService {
    func generateGraph(repoRoot: URL, mode: GraphMode) async throws -> GraphData
    func queryGraph(repoRoot: URL, query: String, limit: Int) async throws -> [GraphNode]
    func findRelatedCode(repoRoot: URL, query: String, limit: Int) async throws -> [CodeRef]
    func regenerateGraph(repoRoot: URL) async throws
}

protocol AutomationService {
    func captureFromAgentTurn(context: AgentContext, reply: String) async throws
    func captureFromUI(action: UIAction) async throws
    func cleanupStaleFacts(repoRoot: URL, olderThanDays: Int) async throws -> CleanupReport
    func detectContradictions(repoRoot: URL) async throws -> ContradictionReport
    func regenerateOnDocChange(repoRoot: URL) async throws
    func regenerateOnCodeChange(repoRoot: URL) async throws
}
```

## File Consolidation

### Extension Restructuring

**Files to DELETE:**
```
extension/graphkit/memory.mjs
extension/graphkit/memory-writer.mjs
extension/llm_agent/runtime/memory-extract.mjs
extension/llm_agent/runtime/memory-persist.mjs
extension/graphkit/graph.mjs
```

**New structure:**
```
extension/graphkit/
├── services/
│   ├── memory-service.ts          # 400 lines (read/write/validate)
│   ├── graph-service.ts           # 300 lines (generate/query/cache)
│   └── automation-service.ts      # 250 lines (capture/cleanup/update)
├── storage/
│   ├── memory-storage.ts          # Low-level memory I/O
│   └── graph-storage.ts           # Low-level graph I/O
├── types/
│   ├── memory.ts                  # All memory types
│   └── graph.ts                   # All graph types
└── index.ts                        # Public API exports
```

**Metrics:**
- Before: 5 files, 1,228 lines
- After: 9 files, 1,200 lines
- Result: Clear separation of concerns

### Mac App Restructuring

**Files to DELETE:**
```
mac/Sources/LlmIdeMac/CodeGraph/MemoryStore.swift
mac/Sources/LlmIdeMac/CodeGraph/KnowledgeGraphService.swift
mac/Sources/LlmIdeMac/CodeGraph/GraphAutoUpdater.swift
```

**New structure:**
```
mac/Sources/LlmIdeMac/Services/
├── MemoryService.swift             # 350 lines
├── GraphService.swift              # 350 lines
├── AutomationService.swift        # 300 lines
└── ServiceFactory.swift            # Dependency injection
```

**Metrics:**
- Before: 3 files, 953 lines
- After: 4 files, 1,350 lines (includes new features)
- Result: Protocol-based design + new automation features

## Automation

### Auto-Capture Pipeline

**Extension (after each agent turn):**

```typescript
// In route.mjs, after reply is generated:
export async function handleCodeAssist(userId, message) {
  const reply = await runAgent(userId, message);
  
  // Fire-and-forget auto-capture (zero latency)
  automationService.captureFromAgentTurn({
    userId,
    repoRoot: activeRepoRoot(userId),
    userMessage: message,
    agentReply: reply,
    timestamp: Date.now()
  }).catch(err => {
    logger.error('memory-capture-failed', { error: err.message });
  });
  
  return reply;
}
```

**AutomationService.captureFromAgentTurn():**
1. Pre-filter: Skip if not worth extracting
2. LLM extraction (summarize model, capped at 5 facts/280 chars each)
3. Validate new facts (file existence, contradictions)
4. Write to `.llm-ide/memory/chat-memory.md`
5. Log capture event

**Mac App (UI action hooks):**

```swift
// Auto-capture from UI interactions:
extension CodeAssistantPanel {
    func onAgentReply(reply: String) {
        Task {
            try? await automationService.captureFromUI(.agentReply(reply: reply))
        }
    }
    
    func onFileOpened(file: URL) {
        Task {
            try? await automationService.captureFromUI(.fileViewed(file: file))
        }
    }
    
    func onCommandExecuted(command: String) {
        Task {
            try? await automationService.captureFromUI(.commandExecuted(command: command)))
        }
    }
}
```

### Auto-Cleanup Pipeline

**Background job (runs hourly):**

```typescript
async cleanupStaleFacts(repoRoot: URL, olderThanDays = 30): Promise<CleanupReport> {
  const facts = await memoryService.readChatMemory(repoRoot);
  const report: CleanupReport = { removed: [], kept: [], errors: [] };
  
  for (const fact of facts) {
    // 1. Check age
    if (this.isOlderThan(fact, olderThanDays)) {
      report.removed.push({ fact, reason: 'stale_age' });
      continue;
    }
    
    // 2. Validate file references
    const validation = await this.validateFact(repoRoot, fact);
    if (!validation.valid) {
      report.removed.push({ fact, reason: validation.reason });
      continue;
    }
    
    report.kept.push(fact);
  }
  
  // 3. Write cleaned facts
  await memoryService.writeChatMemory(repoRoot, report.kept);
  
  // 4. Log cleanup
  this.logCleanup(repoRoot, report);
  
  return report;
}
```

**Validation checks:**
- File existence: Verify files mentioned in facts still exist
- Contradiction detection: Detect opposite facts (e.g., "uses npm" vs "uses pnpm")
- Syntax validation: Verify command facts are valid

### Auto-Update Pipeline

**File watching + regeneration:**

```typescript
// File watcher (extension, runs on server start):
async watchRepoForChanges(repoRoot: URL): Promise<void> {
  const watcher = chokidar.watch(repoRoot, {
    ignored: /(^|[\/\\])\../,
    persistent: true
  });
  
  watcher.on('change', async (path) => {
    if (this.isDocFile(path)) {
      await this.regenerateOnDocChange(repoRoot);
    } else if (this.isCodeFile(path)) {
      await this.regenerateOnCodeChange(repoRoot);
    }
  });
}

async regenerateOnDocChange(repoRoot: URL): Promise<void> {
  // 1. Check doc fingerprint
  const newFingerprint = await this.computeDocFingerprint(repoRoot);
  const cached = await this.readCachedFingerprint(repoRoot);
  
  if (cached === newFingerprint) {
    return; // No actual change
  }
  
  // 2. Regenerate doc graph
  const graphData = await graphService.generateGraph(repoRoot, 'doc');
  
  // 3. Write to .llm-ide/graph/
  await this.writeGraph(repoRoot, graphData);
  
  // 4. Update fingerprint cache
  await this.writeCachedFingerprint(repoRoot, newFingerprint);
  
  // 5. Log regeneration
  this.logRegeneration(repoRoot, 'doc_change');
}
```

## Error Handling

### Storage Layer Errors

```typescript
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
```

### Service Layer Error Handling

**Graceful degradation:**
- Memory read failures return empty data (never crash the agent)
- Write failures log errors but don't block agent replies
- Validation failures skip invalid facts but write valid ones

**Example:**

```typescript
async readMemory(repoRoot: URL): Promise<MemoryData> {
  try {
    return await memoryStorage.readMemoryFile(repoRoot);
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      logger.error('memory-read-failed', { 
        code: err.code, 
        path: err.path 
      });
      return { facts: [], bugs: [], qa: [] }; // Graceful degradation
    }
    throw err;
  }
}
```

### Automation Error Handling

**Fire-and-forget pattern:**
```typescript
async captureFromAgentTurn(context: AgentContext): Promise<void> {
  try {
    const facts = await this.factExtractor.extract(context);
    await this.memoryService.writeChatMemory(context.repoRoot, facts);
    logger.info('memory-capture-success', { factsCount: facts.length });
  } catch (err) {
    // Never fail the agent reply
    logger.error('memory-capture-failed', { error: err.message });
  }
}
```

## Testing Strategy

### Unit Tests (Per Service)

**MemoryService tests:**
- Read returns empty on file not found
- Write skips invalid facts but writes valid ones
- Validate catches missing file references
- Validate detects contradictions

**GraphService tests:**
- Generate creates valid graph structure
- Query returns relevant results
- Cache invalidation works correctly

**AutomationService tests:**
- Capture extracts facts from agent turns
- Cleanup removes stale facts
- Update regenerates on file changes

### Integration Tests (End-to-End)

**Auto-capture integration:**
```typescript
it('should capture facts from agent turn', async () => {
  const service = new AutomationService(memoryService, factExtractor);
  
  await service.captureFromAgentTurn({
    repoRoot: testRepo,
    userMessage: 'How do I deploy?',
    agentReply: 'Deploys via fly.io using `fly deploy`'
  });
  
  const memory = await memoryService.readChatMemory(testRepo);
  expect(memory).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('fly.io') })
  );
});
```

**Cleanup integration:**
```typescript
it('should cleanup stale facts', async () => {
  // Seed with old facts
  await memoryService.writeChatMemory(testRepo, [
    { text: 'old fact', timestamp: Date.now() - (40 * 24 * 60 * 60 * 1000) }
  ]);
  
  const report = await automationService.cleanupStaleFacts(testRepo, 30);
  
  expect(report.removed).toHaveLength(1);
  expect(report.removed[0].reason).toBe('stale_age');
});
```

### Resilience Tests

**Error injection:**
- Disk full errors handled gracefully
- Concurrent writes don't corrupt data
- Permission errors don't crash services
- Corrupted files return empty data

## Migration Strategy

### Directory Migration

**One-time migration on startup:**

```typescript
export async function migrateToLLMIdeStructure(repoRoot: URL): Promise<MigrationResult> {
  const migrations: MigrationStep[] = [
    {
      from: repoRoot.appendingPathComponent('graphify-out/memory'),
      to: repoRoot.appendingPathComponent('.llm-ide/memory')
    },
    {
      from: repoRoot.appendingPathComponent('system/graph'),
      to: repoRoot.appendingPathComponent('.llm-ide/graph')
    }
  ];
  
  const results: MigrationResult = { migrated: [], skipped: [], errors: [] };
  
  for (const step of migrations) {
    try {
      if (await fs.exists(step.from)) {
        await fs.move(step.from, step.to);
        results.migrated.push(step);
      } else {
        results.skipped.push({ path: step.from, reason: 'not_found' });
      }
    } catch (err) {
      results.errors.push({ step, error: err.message });
    }
  }
  
  return results;
}
```

**Trigger points:**
1. Extension server startup
2. Mac app launch
3. Manual CLI command: `llm-ide migrate --repo <path>`

### Code Migration (Phased)

**Phase 1:** Create new structure with delegation to old code
**Phase 2:** Migrate call sites incrementally (3 separate PRs)
**Phase 3:** Delete old files once all migrated

## Implementation Phases

### Phase 1: Foundation (Week 1)
- Create storage layer with atomic writes
- Define type interfaces
- Implement migration functions
- **Success:** All existing tests pass, no breaking changes

### Phase 2: Service Layer (Week 2)
- Implement MemoryService, GraphService, AutomationService
- Services delegate to old implementations
- Integration tests verify parity
- **Success:** Behavior identical to old code

### Phase 3: Call Site Migration (Week 3)
- Update route.mjs → use AutomationService
- Update compose.mjs → use MemoryService
- Update Mac views → use new services
- **Success:** All tests pass, no regressions

### Phase 4: Feature Implementation (Week 4)
- Implement FactValidator (file checks, contradictions)
- Implement AutoCleanup (background stale removal)
- Add Mac app UI hooks
- **Success:** Validation catches issues, cleanup works

### Phase 5: Directory Migration (Week 5)
- Run migration script on startup
- Move data to `.llm-ide/`
- Leave old paths for rollback
- **Success:** Data migrated without loss

### Phase 6: Cleanup (Week 6)
- Delete old implementation files
- Verify no orphaned references
- Full test suite passes
- **Success:** Zero old code references

### Phase 7: Polish (Week 7)
- Complete documentation
- Performance tuning
- Final testing
- **Success:** Docs complete, benchmarks passing

**Total Timeline: 7 weeks**

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Migration data loss | Atomic writes, rollback support, leave old paths intact |
| Performance regression | Profile before/after, add caching where needed |
| Breaking existing workflows | Phased migration, each phase independently shippable |
| Test coverage gaps | Add tests before deleting old code, maintain coverage |
| Concurrent write issues | Use atomic writes (temp file + rename), test concurrent access |

## Success Criteria

1. **Single source of truth:** `.llm-ide/` is the only memory/graph directory
2. **Clear layer separation:** Storage → Service → Application
3. **Full automation:** Auto-capture, auto-cleanup, auto-update working
4. **No regressions:** All existing features work correctly
5. **Professional quality:** Complete error handling, tests, documentation
6. **Performance:** Matches or exceeds old implementation

## Out of Scope

- Cross-repo memory (stays per-repo)
- LLM-as-judge for validation (v1 uses exact file checks)
- Graph algorithm redesign (we're consolidating, not changing algorithms)
- Real-time collaboration (single-user only)
