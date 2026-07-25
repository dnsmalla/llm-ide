# Mac XCTest suite

`ChatSessionStoreTests.swift` covers scoped multi-session persistence (list/filter,
save/load/delete, legacy migration, scoped clear).

## Running tests

Requires **full Xcode** (Command Line Tools alone lack the XCTest module):

```bash
cd mac && swift test --filter ChatSessionStoreTests
```

Or via Make (pins Xcode toolchain):

```bash
make test-mac
```

## Package layout

Sources live in the `LlmIdeMacLib` library target; `@main` is in the thin
`LlmIdeMacMain` executable so tests can `@testable import LlmIdeMacLib`.

Expected: four tests pass against a temp dir via `ChatSessionStore.baseDirectoryOverride`.
