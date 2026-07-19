# Memory Operations Pattern

## Problem

Memory operations (fault tracking, Q&A, repo notes) were scattered:
- `RegressionView` — loading faults, marking fixed, reopening
- `RegressionRunner` — batch loading with try?
- `FaultPack` — error handling on load

**Result:** Inconsistent error handling, repeated try-catch blocks, no unified state access.

## Solution

Use `MemoryUtilities` — single source of truth for all memory operations.

### Basic Usage

```swift
let utils = MemoryUtilities(
    store: config.memoryStore,
    repoURL: repoURL,
    logHandler: { print($0) } // optional
)

// Initialize memory structure
try utils.initializeIfNeeded()

// Load open faults
let openFaults = utils.loadOpenFaults()

// Mark a fault as fixed
try utils.markFaultFixed(at: faultURL, verify: "Verified in testing")

// Get memory summary
utils.printSummary()
// Output:
// Memory Summary:
// - Faults: 5 total (2 open, 3 closed)
// - Q&A: 12 entries
```

### Load Operations

#### Load with error handling
```swift
// Returns nil if loading fails (logged automatically)
if let fault = utils.loadFault(at: url) {
    print("Loaded: \(fault.title)")
}
```

#### Load all faults (skips failures)
```swift
let allFaults = utils.loadAllFaults()
// Faults that failed to load are logged but don't crash
```

#### Filter by status
```swift
let openFaults = utils.loadOpenFaults()
let closedFaults = utils.loadClosedFaults()
let highPriority = utils.loadFaultsByStatus(.open)
```

### Update Operations

#### Mark fault as fixed
```swift
try utils.markFaultFixed(at: faultURL, verify: "Tested in staging")
```

#### Reopen fault (regression detected)
```swift
try utils.reopenFault(at: faultURL)
```

#### Batch operations
```swift
let (succeeded, failed) = utils.markMultipleFaultsFixed(at: faultURLs)
print("Fixed \(succeeded), failed to update \(failed)")
```

#### Reopen by condition
```swift
let reopened = utils.reopenFaultsMatching { fault in
    fault.component == "auth" && fault.severity == .high
}
```

### Common Workflows

#### Check for regressions
```swift
let openFaults = utils.loadOpenFaults()
for fault in openFaults {
    if testRegression(fault) {
        // Reopen if test still fails
        try utils.reopenFault(at: fault.sourceURL ?? repoURL)
    }
}
```

#### Prepare for code review
```swift
let summary = utils.getSummary()
if summary.openFaults > 0 {
    print("⚠️  \(summary.openFaults) open faults to address")
}
```

#### Git integration
```swift
// See what changed in memory
if let diff = utils.gitDiff() {
    print("Memory changes: \(diff.unified)")
}

// Discard memory changes before switching branches
try utils.discardAllChanges()
```

### Where to Use

**Migrate these:**
- `RegressionView`: Direct `loadFault` calls → `utils.loadFault(...)`
- `RegressionRunner`: Batch `try?` loads → `utils.loadAllFaults()`
- Multiple `try store.loadFault()` → `utils.loadOpenFaults()`

**New code:** Always use `MemoryUtilities` instead of accessing `MemoryStore` directly for high-level operations.

## Error Handling

All operations handle errors gracefully:
- **Load operations**: Return nil, log error (non-fatal)
- **Update operations**: Throw (caller decides whether to fail or continue)
- **Batch operations**: Continue even if individual items fail, return counts

## Built-In Safety

- **Idempotent init:** Safe to call multiple times
- **Graceful degradation:** Missing files don't crash
- **Logging:** All operations logged for debugging
- **Batch continuation:** One failure doesn't stop batch processing

## Future Extensions

Add to `MemoryUtilities` as needed:
- `archiveFault()` — move to archive directory
- `exportSummary()` — generate report
- `deduplicateFaults()` — merge similar issues
- `suggestRelated()` — find related faults

**Pattern:** Extract after you find it's used 3+ times.
