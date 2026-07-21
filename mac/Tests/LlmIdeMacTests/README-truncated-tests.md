# Truncated tests — package layout + XCTest

`ChatSessionStoreTests.swift` is checked in as the authoritative spec for scoped
multi-session persistence (list/filter, save/load/delete, legacy migration,
scoped clear). It is **not** wired into `Package.swift` yet, so `swift test`
does not compile or run these cases in the current tree.

## Why tests are deferred

1. **Executable-only target** — `LlmIdeMac` is an `.executableTarget`. Swift
   Package Manager test targets need a library module to `@testable import`.
   Fixing this requires splitting sources into a `.target` (library) plus a thin
   executable entry point. That restructure is out of scope for the chat-history
   feature; do not add a test target that cannot link.

2. **XCTest in this environment** — Even with a test target declared, `swift test`
   fails here with `no such module 'XCTest'` when only Command Line Tools are
   installed (full Xcode provides the XCTest SDK). CI/macOS runners with Xcode
   will hit blocker (1) first.

## When tests will run

After the package split (library + app executable):

```swift
.testTarget(
    name: "LlmIdeMacTests",
    dependencies: ["LlmIdeMacLib"],  // name TBD at split time
    path: "Tests/LlmIdeMacTests"
)
```

Then:

```bash
cd mac && swift test --filter ChatSessionStoreTests
```

Expected: all four tests pass against a temp dir via
`ChatSessionStore.baseDirectoryOverride`.

## Related

- `README-skipped-tests.md` — other suites deferred on mockability, not package layout.
- Plan: `docs/superpowers/plans/2026-07-21-cursor-style-chat-history.md` (Task 3).
