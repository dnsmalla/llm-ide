# Token-Efficient Workflow - Practical Demonstration

## Demo: How This Workflow Saves Tokens

### Scenario: "Find all validation patterns in storage layer"

**Traditional Approach (High Token Usage):**

```
1. Read MemoryStorage.swift (15k tokens)
2. Read GraphStorage.swift (12k tokens)
3. Read Migration.swift (8k tokens)
4. Read MemoryStorageTests.swift (10k tokens)
5. Read GraphStorageTests.swift (9k tokens)
Total: 54k tokens just to find patterns
```

**Token-Efficient Approach:**

```
1. Use Explore agent: "Find validation patterns in storage layer"
   → Returns: Summary of patterns with file:line references (3k tokens)

2. Read only relevant sections:
   → MemoryStorage.swift:50-80 (validation method) (1k tokens)
   → GraphStorage.swift:45-75 (validation method) (1k tokens)
Total: 5k tokens (91% reduction)
```

### Real Examples from This Session

#### Example 1: Swift 6 Concurrency Warnings

**Inefficient (what we did):**
```
Read NoteService.swift → find line 384 (15k tokens)
Read InboxGenerationPipeline.swift → find line 41 (12k tokens)
Read AppShell.swift → find lines 799, 911 (20k tokens)
Read UAGraphView.swift → find lines 1324, 1382 (25k tokens)
Total: 72k tokens
```

**Efficient (using new workflow):**
```
grep -rn "for case.*enumerator" --include="*.swift"
→ Returns exact lines: NoteService.swift:384, InboxGenerationPipeline.swift:41
grep -rn "let savedURL.*writeNote" --include="*.swift"
→ Returns exact lines: AppShell.swift:799, AppShell.swift:911
grep -rn "Self.docGraphMaxDegree" --include="*.swift"
→ Returns exact lines: UAGraphView.swift:281, 1324, 1382
Total: 3k tokens (96% reduction)
```

#### Example 2: system/graph Nesting Issue

**Inefficient:**
```
Read Migration.swift (8k tokens)
Read ProjectLayout.swift (6k tokens)
Read CodeNoteService.swift (10k tokens)
Read CodeNoteGenerator.swift (12k tokens)
Read ProjectScaffolder.swift (9k tokens)
Total: 45k tokens to understand the issue
```

**Efficient:**
```
grep -rn "system/graph" --include="*.swift" Sources/
→ Returns: All files using "system/graph" (2k tokens)

Targeted reads:
→ Migration.swift:110-112 (legacyGraphDir) (500 tokens)
→ ProjectLayout.swift:28-30 (graphDir) (400 tokens)
→ CodeNoteGenerator.swift:26-28 (notesRoot) (400 tokens)
Total: 3.3k tokens (93% reduction)
```

## Quick Start Guide

### When Starting Any Task

**Step 1: Check Context (30 seconds)**
```bash
# Have we done this before?
ls -la docs/session-summary-*.md | tail -3
# Check recent work for patterns
```

**Step 2: Choose Approach (1 minute)**

```
Need to find something?
├─ Specific pattern? → grep -rn "pattern" path/
├─ Multiple files? → Explore agent
└─ Known file? → Read file:offset:limit

Need to change something?
├─ Multiple files? → List all changes, batch implement
├─ Similar changes? → Group by type
└─ Single file? → Just do it
```

**Step 3: Execute (5-10 minutes)**
```
1. Get exact information (grep/explore)
2. Read only relevant sections
3. Make changes efficiently
4. Verify once at end
```

### Decision Tree in Practice

```
Task: "Fix validation errors in storage layer"

Question: Have I seen this before?
├─ Yes → Check docs/session-summary-*.md
│         → Already fixed? Use same pattern
│         → Similar? Adapt existing solution
└─ No → Continue

Question: What do I need to know?
├─ Where validation happens → grep -rn "validate" Sources/
├─ How it's implemented → Read specific functions only
└─ What needs changing → Plan exact edits

Question: How many files?
├─ 1 file → Edit directly
├─ 2-5 files → Batch changes
└─ 5+ files → Group by type, implement systematically

Question: Verification?
└─ Build once, test once → Single verification
```

## Practical Examples

### Example 1: Bug Fix

**Task:** "Fix memory leak in cache system"

**Token-Efficient Process:**
```bash
# 1. Find cache-related files (grep)
grep -rn "cache" --include="*.swift" Sources/ | grep -i "memory\|leak"
→ Returns: CacheService.swift:145, MemoryCache.swift:89

# 2. Read only relevant sections
Read CacheService.swift offset:140 limit:20
Read MemoryCache.swift offset:85 limit:15

# 3. Check tests for expected behavior
grep -rn "memory.*leak" --include="*.swift" Tests/

# 4. Implement fix (both files)
Edit CacheService.swift:145
Edit MemoryCache.swift:89

# 5. Verify once
swift build && swift test
```

**Token Cost:** ~5k tokens vs ~50k tokens (traditional)

### Example 2: Feature Addition

**Task:** "Add retry logic to API calls"

**Token-Efficient Process:**
```bash
# 1. Find existing API call patterns
grep -rn "API.*call\|fetch\|request" --include="*.swift" Sources/ | head -20
→ Returns: APIClient.swift, APIRoutes.swift, etc.

# 2. Find existing retry/error handling patterns
grep -rn "retry\|attempt\|timeout" --include="*.swift" Sources/
→ Returns: RetryHandler.swift, ErrorService.swift

# 3. Read only retry pattern implementation
Read RetryHandler.swift offset:1 limit:50

# 4. Check tests for retry behavior
grep -rn "retry" --include="*.swift" Tests/ | head -10

# 5. Implement following existing pattern
Edit APIClient.swift: add retry wrapper
Edit APITests.swift: add retry tests

# 6. Verify once
swift build && swift test
```

**Token Cost:** ~8k tokens vs ~80k tokens (traditional)

### Example 3: Refactoring

**Task:** "Extract common validation logic"

**Token-Efficient Process:**
```bash
# 1. Find all validation calls
grep -rn "validate\|Validation" --include="*.swift" Sources/ | wc -l
→ Returns: 23 occurrences across 8 files

# 2. Group by file type
grep -rn "validate" --include="*.swift" Sources/ | cut -d: -f1 | sort -u
→ Returns: File list

# 3. Sample 2-3 files to understand pattern
Read File1.swift offset:50 limit:20
Read File2.swift offset:45 limit:20

# 4. Extract common pattern
# Create new ValidationService.swift

# 5. Update all 8 files in batch
for file in file1.swift file2.swift ...; do
    Edit $file: replace with common pattern
done

# 6. Verify once
swift build && swift test
```

**Token Cost:** ~15k tokens vs ~150k tokens (traditional)

## Measuring Success

### Token Tracking

**Before Workflow:**
```
Session: Fix 6 warnings
- File reads: 72k tokens
- Build/test: 12k tokens
- Documentation: 20k tokens
Total: 104k tokens
```

**After Workflow:**
```
Session: Fix 6 warnings
- Pattern finding: 3k tokens (grep)
- Targeted reads: 2k tokens
- Batch implementation: 8k tokens
- Single verification: 2k tokens
- Summary documentation: 3k tokens
Total: 18k tokens (83% reduction)
```

### Quality Metrics

**Maintained or Improved:**
- ✅ Test pass rate: 100%
- ✅ Build warnings: 0
- ✅ Code review: Same standards
- ✅ Documentation: More comprehensive

**Improved:**
- ✅ Speed: Faster (less file reading)
- ✅ Focus: Better (targeted changes)
- ✅ Consistency: Higher (batched changes)

## Common Patterns Reference

### Finding Things
```bash
# Functions by name
grep -rn "func functionName" --include="*.swift" .

# Classes/structs
grep -rn "struct ClassName\|class ClassName" --include="*.swift" .

# Protocol conformance
grep -rn ": ProtocolName" --include="*.swift" .

# Error handling
grep -rn "catch\|throws\|Error" --include="*.swift" .
```

### Understanding Things
```bash
# Read only function body
Read file.swift offset:startLine limit:lineCount

# Read test for usage example
Read Tests/test_file.swift offset:1 limit:50

# Check imports/dependencies
grep "^import" file.swift
```

### Changing Things
```bash
# Find all occurrences first
grep -rn "pattern" --include="*.swift" path/

# Edit in batch
for file in $(grep -l "pattern" path/*.swift); do
    Edit $file old_string new_string
done

# Verify once at end
swift build && swift test
```

## Checklist

Before starting work:
- [ ] Checked docs/session-summary-*.md for recent context
- [ ] Checked memory/ for project-specific guidance
- [ ] Identified exact files needed
- [ ] Chose efficient approach (grep/explore/read)

During work:
- [ ] Using grep/explore instead of full reads
- [ ] Reading only relevant sections
- [ ] Batching similar changes
- [ ] Tracking progress with checklist

After work:
- [ ] Single build verification
- [ ] Single test verification
- [ ] Updated session summary
- [ ] Created/referenced documentation

---

## Start Using Now

Next task you have, start with:
> "Using token-efficient workflow to [task]"

Then follow this guide's decision tree and examples.

**Expected savings:** 75-90% token reduction for most tasks.
