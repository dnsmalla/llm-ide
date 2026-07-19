# Git Operations Pattern

## Problem

Git operations were scattered across multiple services:
- `SourceControlService` — runGit calls for various operations
- `CodeWorkflowService` — branch creation, commit logic
- Each service reimplemented: error handling, retry logic, status checking

**Result:** Inconsistent error handling, same bugs in multiple places.

## Solution

Use `GitUtilities` — single source of truth for all git operations.

### Basic Usage

```swift
let utils = GitUtilities(
    repoManager: repoManager,
    repoURL: repoURL,
    logHandler: { print($0) } // optional
)

// Check current branch
let branch = try await utils.currentBranch()

// Create and checkout branch
try await utils.createAndCheckout(branch: "feature/my-change", from: "main")

// Commit with validation
let sha = try await utils.commit(message: "Add new feature")

// Push with automatic retry
try await utils.push(maxRetries: 3)

// Safe checkout (stash if needed)
try await utils.safeCheckout("main")
```

### Common Workflows

#### Feature branch with PR
```swift
let sha = try await utils.featureBranchWorkflow(
    branchName: "feature/my-feature",
    commitMessage: "Implement new feature",
    baseRef: "main"
)
// Creates branch, commits, and pushes all in one call
```

#### Status Checking
```swift
let currentBranch = try await utils.currentBranch()
let hasDirtyTree = try await utils.hasUncommittedChanges()
let changedFiles = try await utils.changedFiles()
let currentSha = try await utils.currentCommitSha()
```

#### Cleanup Operations
```swift
// Stash before switching branches
try await utils.stash(message: "WIP: feature work")

// Discard all changes (dangerous!)
try await utils.discardChanges()
```

#### Retry-Safe Operations
```swift
// Push automatically retries on transient failures
try await utils.push(branch: "feature/x", maxRetries: 3)

// Pull with retry
try await utils.pull(maxRetries: 3)
```

### Where to Use

**Migrate these:**
- `SourceControlService.runGit(["commit", ...])` → `utils.commit(...)`
- `SourceControlService.createBranch(...)` → `utils.createAndCheckout(...)`
- Scattered push/pull retry logic → `utils.push(maxRetries: 3)`

**New code:** Always use `GitUtilities` instead of `repoManager.runGit()` directly for high-level operations.

## When It Gets Updated

Changes to:
- Retry logic for network operations
- Error handling & recovery
- Commit/branch workflows

...automatically apply everywhere instead of requiring fixes in 5+ places.

## Error Handling

All operations throw `GitError` with descriptive messages:
```swift
do {
    try await utils.commit(message: "")
} catch GitError.emptyCommitMessage {
    // Handle empty message
}
```

## Built-In Safety

- **Safe checkout:** `safeCheckout()` stashes changes automatically
- **Commit validation:** Rejects empty messages
- **Retry logic:** Network operations retry 3 times by default
- **Logging:** Optional handler for debugging

## Future Extensions

Add to `GitUtilities` as needed:
- `rebase()` — interactive rebase workflows
- `mergeConflictResolver()` — detect and report conflicts
- `tagRelease()` — versioning workflow
- `cherryPick()` — backport commits

**Pattern:** Extract after you find it's used 3+ times.
