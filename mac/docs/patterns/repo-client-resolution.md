# Repo Client Resolution Pattern

## Problem

Every service that needs to work with GitHub or GitLab was reimplementing:
- Token validation
- Client initialization  
- Error diagnostics
- LinkedRepo vs fallback resolution

This led to:
- 47+ instances of duplicate code
- Same bugs reintroduced on every update
- Inconsistent error messages
- Hard to maintain

## Solution

Use `RepoClientFactory` — single source of truth for repo backend resolution.

### Basic Usage

```swift
let factory = RepoClientFactory(config: config, projectStore: projectStore)
var diagnosis: String?
guard let resolved = factory.resolveLinkedRepo(outDiagnosis: &diagnosis) else {
    logStore.append("⚠ \(diagnosis ?? "No repo configured")", level: .error)
    return
}
// Use resolved.client, resolved.projectId, resolved.gitRoot, resolved.projectRoot
```

### Check Token Without Resolving

```swift
let hasGitHub = factory.hasToken(for: .github)
let hasGitLab = factory.hasToken(for: .gitlab)
```

### Create Client Directly

```swift
guard let client = factory.makeClient(for: .github) else {
    // Token not set
    return
}
```

### Get Full Diagnostic

```swift
let fullDiagnosis = factory.diagnoseSetup()
// Output: "GitLab token=empty; GitHub token=set; Active project='MyProject' (linkedRepo=github remoteId=owner/repo); ..."
```

## Where to Use

- `AutoCodeUpdateService` — instead of `resolveBackendAndProject()`
- `CodeAssistantService` — for any GitHub/GitLab API calls
- `IssuesService` — instead of duplicating token checks
- Any new code that needs repo backends

## Migration Path

1. **New code:** Always use `RepoClientFactory`
2. **Existing services:** Replace local token checks + client init with factory calls
3. **No rush:** Can coexist with old code during gradual migration

## When It Gets Updated

Changes to `RepoClientFactory` automatically apply everywhere it's used — no more scattered updates across 10+ files.

## Adding New Patterns

If you find yourself duplicating code in multiple services:
1. Extract to a helper in the appropriate `*Factory` or `*Utilities` file
2. Add a comment with the pattern name
3. Document in this guide

**Rule:** Anything repeated 3+ times across services → centralize it.
