# Issue/PR Operations Pattern

## Problem

Issue and PR operations were scattered across services:
- `CodeWorkflowService` — create, close, update issues
- `AutoCodeUpdateService` — list issues (paginated), create issues
- Each reimplemented: pagination, error handling, close logic, retry

**Result:** Same bugs in multiple places, hard to maintain.

## Solution

Use `IssueUtilities` — single source of truth for all issue/PR operations.

### Basic Usage

```swift
let utils = IssueUtilities(
    client: resolvedBackend.client,
    projectId: resolvedBackend.projectId,
    logger: taskLogStore // optional
)

// List all open issues
let openIssues = try await utils.fetchOpenIssues()

// Create an issue
let issue = try await utils.createIssue(
    title: "Build failed",
    description: "Pipeline error in CI",
    labels: ["bug", "auto-generated"],
    assignee: nil
)

// Close after merge
try await utils.closeAfterMerge(issue, commitSha: "abc123")

// Reopen if test fails
try await utils.reopenIfStale(issue, reason: "Test regression detected")
```

### Pagination (Automatic)

```swift
// Fetches all pages automatically until < 10 items (end of results)
let allClosed = try await utils.fetchByState(.closed, maxPages: 20)
```

### Common Workflows

#### Close after code update
```swift
try await utils.closeAfterMerge(issue, commitSha: commitHash)
// Idempotent: if already closed, does nothing
```

#### Reopen on new error
```swift
let wasReopened = try await utils.reopenIfStale(issue, reason: "New error detected")
if wasReopened {
    logStore.append("Issue reopened")
}
```

#### Retry transient failures
```swift
let issues = try await utils.retry(maxAttempts: 3, backoff: 2.0) {
    try await utils.fetchOpenIssues()
}
```

### Where to Use

**Migrate these:**
- `CodeWorkflowService.createIssue()` → `utils.createIssue(...)`
- `CodeWorkflowService.closeIssueIfNeeded()` → `utils.closeAfterMerge(...)`
- `AutoCodeUpdateService.fetchAllIssues()` → `utils.fetchAllIssues(...)`

**New code:** Always use `IssueUtilities` instead of calling `client.createIssue()` directly.

## When It Gets Updated

Changes to pagination, retry logic, or error handling automatically apply everywhere.

**Example:** If we discover a pagination bug in May, one fix updates all services instead of 5+ patches.

## Future Extensions

Add to `IssueUtilities` as needed:
- `assignToUser()` — common workflow
- `addLabel()` — batch label operations
- `bulkClose()` — close multiple issues
- `linkPRtoIssue()` — associate PR with issue

**Pattern:** Extract after you find it's used 3+ times.
