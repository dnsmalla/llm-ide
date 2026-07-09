# Token-Efficient Workflow

Use this workflow when working on the llm-ide codebase to minimize token usage while maintaining quality.

## Core Principles

1. **Subagents for Exploration** - Send agents to find information, return conclusions only
2. **Batch Operations** - Collect changes, implement once, verify once
3. **Reference Documentation** - Reuse existing docs instead of re-reading code
4. **Efficient Access** - Read only what you need, when you need it
5. **Single Verification** - Build and test once at the end

## When to Use This Skill

- Making multiple file changes across the codebase
- Investigating bugs or issues in unfamiliar code
- Implementing features that touch multiple subsystems
- Refactoring across several files
- Any work that would normally require reading 5+ files

## Process

### Phase 1: Quick Assessment (2-3 minutes)

**Goal:** Understand what needs to be done without reading files

1. Check `docs/session-summary-*.md` for recent context
2. Check `memory/` for project-specific guidance
3. Identify the subsystem from the user's request
4. Estimate: files involved, complexity, risks

**Output:** Brief assessment of what's needed

### Phase 2: Targeted Exploration (5-10 minutes)

**Goal:** Find exact information needed, nothing more

**Option A - Use Explore Agent (for broad searches):**
```
Explore agent: Find all uses of "pattern X" in subsystem Y
→ Returns: File list with line numbers and brief context
→ You get: 2k tokens instead of 20k tokens from reading files
```

**Option B - Direct Grep (for specific patterns):**
```
grep -r "specificFunction" --include="*.swift" subsystem/
→ Returns: Exact matches with line numbers
→ You get: 500 tokens instead of 10k tokens from reading files
```

**Option C - Targeted Read (for single files):**
```
Read file:offset:limit
→ Returns: Only the section you need
→ You get: 1k tokens instead of 20k tokens for full file
```

**Decision Guide:**
- Need to scan 10+ files? → Explore agent
- Need specific function/class? → grep
- Need exact file section? → targeted read
- Already documented? → reference docs

### Phase 3: Batch Implementation (10-15 minutes)

**Goal:** Make all changes efficiently

1. **Collect Changes:** List all files and exact changes needed
2. **Group by Type:** Put similar changes together (e.g., all warning fixes)
3. **Implement Sequentially:** Edit each file once
4. **Track Progress:** Simple checklist (✅ done, ⏳ pending)

**Batch Example:**
```
Changes to make:
- [ ] NoteService.swift:384 - fix enumeration
- [ ] InboxGenerationPipeline.swift:41 - fix enumeration
- [ ] AppShell.swift:799 - remove unused var
- [ ] AppShell.swift:911 - remove unused var
- [ ] UAGraphView.swift:1324 - capture actor value
- [ ] UAGraphView.swift:1382 - capture actor value

→ Implement all 6 changes, then build once
→ NOT: change → build → change → build (wastes tokens)
```

### Phase 4: Single Verification (5 minutes)

**Goal:** Verify everything works once

```bash
# Single build
swift build

# Single test run
swift test

# Check for issues once
grep -E "(error:|warning:)" build_output
```

**Output:** Pass/fail for entire batch

## Examples

### Example 1: Fixing Warnings (Inefficient → Efficient)

**Inefficient (high tokens):**
```
Read NoteService.swift (20k tokens)
→ Find warning at line 384
→ Read more to understand context (10k tokens)
→ Edit file
→ Build (2k tokens)
→ Read InboxGenerationPipeline.swift (15k tokens)
→ Find warning at line 41
→ Edit file
→ Build again (2k tokens)
... repeat 6 times
Total: ~100k tokens
```

**Efficient (low tokens):**
```
grep -rn "for case.*enumerator" --include="*.swift" .
→ Returns: NoteService.swift:384, InboxGenerationPipeline.swift:41
→ Read only those lines with context (2k tokens)
→ Edit both files
→ Build once (2k tokens)
Total: ~10k tokens (90% reduction)
```

### Example 2: Bug Investigation (Inefficient → Efficient)

**Inefficient:**
```
Read 10 files to find where error occurs (200k tokens)
→ Each file is 5k-20k tokens
→ Most content irrelevant
```

**Efficient:**
```
Explore agent: "Find where 'system/graph' nesting occurs"
→ Returns: Migration.swift:110-112 with analysis
→ You get: 5k tokens instead of 200k tokens
```

### Example 3: Feature Implementation (Inefficient → Efficient)

**Inefficient:**
```
Read entire project to understand structure (500k tokens)
→ Read each file to see how it relates
→ Ask user questions about architecture
→ Eventually implement
```

**Efficient:**
```
1. Check docs/session-summary-*.md (2k tokens)
→ Already documented: architecture, recent changes

2. Explore agent: "Find validation patterns in storage layer" (5k tokens)
→ Returns: MemoryStorage.swift, GraphStorage.swift patterns

3. Implement following existing patterns (5k tokens)
→ No need to re-read files

4. Reference docs for testing approach (1k tokens)
Total: ~13k tokens instead of 500k tokens
```

## Decision Tree

```
Need to work on codebase
│
├─ Already done before?
│  ├─ Yes → Check docs/session-summary-*.md and memory/
│  └─ No → Continue
│
├─ Need to find where something is?
│  ├─ Specific pattern? → grep -rn "pattern" subsystem/
│  ├─ Multiple files? → Explore agent
│  └─ Single known file? → Read file:offset:limit
│
├─ Need to understand how something works?
│  ├─ Already documented? → Reference docs
│  ├─ Complex subsystem? → Explore agent for architecture
│  └─ Simple function? → Read function only
│
└─ Making changes?
   ├─ Multiple files? → Batch changes, verify once
   ├─ Similar changes? → Group by type, implement together
   └─ Single change? → Make it, move on
```

## Token Savings Tracking

**Before this workflow:**
- Typical session: 80k-150k tokens
- Bug fix: 40k-80k tokens
- Feature: 100k-200k tokens

**After this workflow:**
- Typical session: 20k-40k tokens (75% reduction)
- Bug fix: 10k-20k tokens (75% reduction)
- Feature: 30k-60k tokens (70% reduction)

**Key savings:**
- Explore agents vs reading: 90% reduction
- Batching vs incremental: 80% reduction
- Docs vs re-reading: 95% reduction
- Targeted reads vs full files: 85% reduction

## Quick Reference

**Useful Commands:**
```bash
# Find pattern across files
grep -rn "pattern" --include="*.swift" subsystem/

# Find file locations
find subsystem/ -name "*.swift" -type f

# Check recent changes
git log --oneline -10

# Find function definitions
grep -rn "func functionName" --include="*.swift" .
```

**Useful Reads:**
```bash
# Read only specific section
Read file_path offset:300 limit:50

# Read test for function understanding
Read tests/path/to/test_file.swift

# Read documentation first
Read docs/relevant-topic.md
```

**Useful Memory:**
```bash
# Check project architecture
Read memory/llm-ide-architecture.md

# Check recent work
Read docs/session-summary-*.md

# Check project-specific guidance
Read memory/*.md
```

## When NOT to Use This Workflow

- **Single trivial change** (fix one typo, change one line) → Just do it
- **Emergency hotfix** → Speed over efficiency
- **User provides exact file/lines** → Implement directly
- **Well-documented task** → Follow existing docs

## Implementation

Start any complex task with:
> "Using token-efficient workflow to [task description]"

Then follow the process phases above.
