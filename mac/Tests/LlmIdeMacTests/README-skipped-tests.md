# Skipped tests — wiring gap

The following test suites were planned but deferred because the production
types as currently written are difficult to mock cleanly. Adding them is
worthwhile but needs a small refactor first.

## CodeWorkflowServiceTests (deferred)
- `CodeWorkflowService` is `final class` with an `init(project:api:)` that
  takes a concrete `LlmIdeAPIClient`. To test
  `bootstrapFromExistingIssue` / `retryMROnly` / `closeIssueIfNeeded`
  (idempotent via `doneCloseFired`), we need to inject mockable seams for
  `GitLabClient` and `RepoManager`.
- Suggested refactor: introduce protocols `GitLabClientProtocol` +
  `RepoManagerProtocol`, default to the concrete types in the production
  init, and add a test-only init that takes the protocols. Then assert on
  recorded calls.

## ChatSessionStoreTests (deferred)
- `ChatSessionStore` uses `FileManager.default.url(for:
  .applicationSupportDirectory ...)`, which is process-global. Overriding
  it cleanly requires either a `baseDirProvider` static hook or factoring
  the file IO behind a `ChatSessionStorage` protocol with a temp-dir
  implementation for tests.
- Round-trip / sort / delete / clear / migrateLegacy are all good
  candidates once that hook lands.

Server-side path-traversal regression coverage was the priority for this
commit and ships in `extension/tests/kb-router-path-traversal.test.mjs`.
