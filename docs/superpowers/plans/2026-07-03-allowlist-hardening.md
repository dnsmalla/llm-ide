# Allow-List Hardening (Write-Layer Chokepoint) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-provider repo-operation allow-list's "hard lock" actually hold everywhere by gating writes at the data layer, not just at individual buttons.

**Architecture:** An `AllowlistedRepoBackend` decorator wraps every concrete `RepoBackend` and throws `RepoBackendError.operationNotAllowed` before any disallowed write; a factory routes all backend construction through it so automation and every manual path are covered. `SourceControlService` (local git, not a `RepoBackend`) is gated separately. `.merge` is renamed to `.closeIssue` and a new `.editIssue` op covers metadata edits + kanban drag-relabel.

**Tech Stack:** Swift / SwiftUI (macOS), swift-testing (`import Testing`, `@Suite`, `@Test`, `#expect`). Tests: `cd mac && swift test --filter <Name>`; full: `cd mac && swift build && swift test` (use dangerouslyDisableSandbox for swift build/test — the default sandbox fails on the manifest compile step).

## Global Constraints

- Provider type is the existing `RepoBackendKind` (`.gitlab`/`.github`); no new provider enum.
- Blocked writes THROW `RepoBackendError.operationNotAllowed(RepoOperation, provider: RepoBackendKind)` (do not silently no-op) — except `try?` fire-and-forget call sites, which will naturally skip (documented, acceptable).
- Keep all existing `.disabled` UI gates; this plan ADDS the data-layer chokepoint and fills the missed discrete buttons.
- `.merge` is renamed to `.closeIssue`; add `.editIssue`. Legacy stored rawValue `"merge"` must decode to `.closeIssue`.
- Allow-list stays Mac-local (no backend/route changes).
- The chokepoint is the guarantee; UI `.disabled` is UX polish.

---

### Task 1: Rename `.merge`→`.closeIssue`, add `.editIssue`, decode alias

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/RepoOperation.swift`
- Modify: `mac/Sources/LlmIdeMac/Models/Config.swift` (init decode of the two allow-op sets)
- Modify: every current `.merge` reference (grep — at least `mac/Sources/LlmIdeMac/Views/Issues/RepoIssueDetailSheet.swift`)
- Test: `mac/Tests/LlmIdeMacTests/RepoOperationAllowlistTests.swift` (extend)

**Interfaces:**
- Produces: `RepoOperation` cases now `sync, push, createBranch, autoCommit, createIssue, editIssue, commentIssue, closeIssue, createPR`. `RepoOperation.groups` updated. Legacy `"merge"` rawValue decodes to `.closeIssue`.

- [ ] **Step 1: Write the failing tests** (append to `RepoOperationAllowlistTests.swift`)

```swift
    @Test func legacyMergeRawValueDecodesToCloseIssue() {
        let defaults = UserDefaults(suiteName: "allowlist-migrate-\(UUID().uuidString)")!
        // A pre-rename custom set that allowed only "merge" (the old close/reopen op).
        defaults.set(["merge"], forKey: "gitHubAllowedOps")
        let cfg = AppConfig(userDefaults: defaults)
        #expect(cfg.isAllowed(.closeIssue, provider: .github))
    }

    @Test func editIssueIsInDefaultAllEnabledSet() {
        let name = "allowlist-edit-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        let cfg = AppConfig(userDefaults: d)
        #expect(cfg.isAllowed(.editIssue, provider: .github))
        #expect(cfg.isAllowed(.closeIssue, provider: .gitlab))
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mac && swift test --filter RepoOperationAllowlistTests`
Expected: FAIL to compile — `.closeIssue` / `.editIssue` don't exist.

- [ ] **Step 3: Update the enum** (`RepoOperation.swift`)

Replace `case merge` with `case closeIssue`, add `case editIssue`, and update `label` + `groups`:

```swift
enum RepoOperation: String, Codable, CaseIterable {
    case sync, push, createBranch, autoCommit,
         createIssue, editIssue, commentIssue, closeIssue, createPR

    var label: String {
        switch self {
        case .sync:         return "Pull / Re-sync"
        case .push:         return "Push"
        case .createBranch: return "Create branch"
        case .autoCommit:   return "Auto-commit AI changes"
        case .createIssue:  return "Create issue"
        case .editIssue:    return "Edit issue (labels, assignee, milestone…)"
        case .commentIssue: return "Comment on issue"
        case .closeIssue:   return "Close / reopen issue"
        case .createPR:     return "Create PR / MR"
        }
    }

    static var groups: [(String, [RepoOperation])] {
        [
            ("Sync",        [.sync]),
            ("Code writes", [.push, .createBranch, .autoCommit]),
            ("Issues",      [.createIssue, .editIssue, .commentIssue, .closeIssue]),
            ("PR / MR",     [.createPR]),
        ]
    }
}
```

- [ ] **Step 4: Add the decode alias** (`Config.swift`)

The init currently decodes each set with `raw.compactMap(RepoOperation.init(rawValue:))`. Replace the mapping (in BOTH the gitHub and gitLab decode blocks) with a helper that aliases the legacy value. Add this private free function near the top of `Config.swift` (file scope, before `AppConfig`):

```swift
/// Decode a stored allow-op rawValue, mapping the pre-rename "merge" to
/// its replacement `.closeIssue`. Unknown values still return nil (dropped).
private func decodeRepoOp(_ raw: String) -> RepoOperation? {
    if raw == "merge" { return .closeIssue }
    return RepoOperation(rawValue: raw)
}
```

Then in `init`, change both `Set(raw.compactMap(RepoOperation.init(rawValue:)))` occurrences to `Set(raw.compactMap(decodeRepoOp))`.

- [ ] **Step 5: Fix all `.merge` references**

Run: `cd mac && grep -rn "\.merge\b" Sources/LlmIdeMac --include='*.swift'`
For every hit that is `RepoOperation.merge` (e.g. `RepoIssueDetailSheet.swift` close/reopen gating — `isAllowed(.merge, ...)` and its `.help`), replace `.merge` with `.closeIssue`. Do NOT touch `SourceControlService.merge(...)` (a local git method, unrelated). Re-run the grep to confirm no `RepoOperation.merge` remains.

- [ ] **Step 6: Run tests + build**

Run: `cd mac && swift test --filter RepoOperationAllowlistTests` → all pass (incl. the 2 new).
Run: `cd mac && swift build` → clean.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/RepoOperation.swift mac/Sources/LlmIdeMac/Models/Config.swift mac/Sources/LlmIdeMac/Views/ mac/Tests/LlmIdeMacTests/RepoOperationAllowlistTests.swift
git commit -m "feat(mac): rename allow-list .merge→.closeIssue, add .editIssue op"
```

---

### Task 2: `RepoBackendError` + `AllowlistedRepoBackend` decorator

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/Repo/RepoBackend.swift` (add error enum)
- Create: `mac/Sources/LlmIdeMac/Services/Repo/AllowlistedRepoBackend.swift`
- Test: `mac/Tests/LlmIdeMacTests/AllowlistedRepoBackendTests.swift`

**Interfaces:**
- Consumes: `RepoBackend` protocol, `AppConfig.isAllowed(_:provider:)`, `RepoIssuePayload.stateChange`.
- Produces: `enum RepoBackendError.operationNotAllowed(RepoOperation, provider: RepoBackendKind)`; `final class AllowlistedRepoBackend: RepoBackend` with `init(wrapping: RepoBackend, config: AppConfig)`.

- [ ] **Step 1: Write the failing test** (`AllowlistedRepoBackendTests.swift`)

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
@Suite("AllowlistedRepoBackend")
struct AllowlistedRepoBackendTests {

    // Minimal mock: records the last write called; reads return empties.
    final class Spy: RepoBackend {
        nonisolated var kind: RepoBackendKind { .github }
        var canWriteIssues = true; var canCreateMergeRequests = true
        var supportsWeight = false; var usesScheduleOverlay = true
        var lastWrite: String?
        func listProjects() async throws -> [RepoProject] { [] }
        func getProject(id: String) async throws -> RepoProject { throw CancellationError() }
        func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue] { [] }
        func getIssue(projectId: String, number: Int) async throws -> RepoIssue { throw CancellationError() }
        func listLabels(projectId: String) async throws -> [RepoLabel] { [] }
        func listMilestones(projectId: String) async throws -> [RepoMilestone] { [] }
        func listMembers(projectId: String) async throws -> [RepoUser] { [] }
        func listNotes(projectId: String, number: Int) async throws -> [RepoNote] { [] }
        func listOpenMergeRequests(projectId: String) async throws -> [RepoMergeRequest] { [] }
        func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue { lastWrite = "createIssue"; throw CancellationError() }
        func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue { lastWrite = "updateIssue"; throw CancellationError() }
        func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote { lastWrite = "createNote"; throw CancellationError() }
        func createBranch(projectId: String, name: String, ref: String) async throws -> Bool { lastWrite = "createBranch"; return true }
        func createMergeRequest(projectId: String, payload: RepoMergeRequestPayload) async throws -> RepoMergeRequest { lastWrite = "createMR"; throw CancellationError() }
    }

    private func config(disallow ops: [RepoOperation]) -> AppConfig {
        let name = "allowlisted-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        let c = AppConfig(userDefaults: d)
        for op in ops { c.setAllowed(op, provider: .github, false) }
        return c
    }

    @Test func createIssueThrowsWhenDisallowed() async {
        let spy = Spy()
        let g = AllowlistedRepoBackend(wrapping: spy, config: config(disallow: [.createIssue]))
        await #expect(throws: RepoBackendError.self) {
            _ = try await g.createIssue(projectId: "1", payload: RepoIssuePayload(title: "x"))
        }
        #expect(spy.lastWrite == nil, "must not reach the wrapped backend")
    }

    @Test func createBranchDelegatesWhenAllowed() async throws {
        let spy = Spy()
        let g = AllowlistedRepoBackend(wrapping: spy, config: config(disallow: []))
        _ = try await g.createBranch(projectId: "1", name: "b", ref: "main")
        #expect(spy.lastWrite == "createBranch")
    }

    @Test func updateIssueRoutesToCloseVsEdit() async {
        let spy = Spy()
        // .closeIssue disallowed, .editIssue allowed.
        let g = AllowlistedRepoBackend(wrapping: spy, config: config(disallow: [.closeIssue]))
        // stateChange present → gated as .closeIssue → throws.
        await #expect(throws: RepoBackendError.self) {
            _ = try await g.updateIssue(projectId: "1", number: 1, payload: RepoIssuePayload(title: "x", stateChange: .close))
        }
        #expect(spy.lastWrite == nil)
        // metadata-only → gated as .editIssue → allowed → reaches backend.
        _ = try? await g.updateIssue(projectId: "1", number: 1, payload: RepoIssuePayload(title: "x", labels: ["bug"]))
        #expect(spy.lastWrite == "updateIssue")
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mac && swift test --filter AllowlistedRepoBackendTests`
Expected: FAIL to compile — `RepoBackendError` and `AllowlistedRepoBackend` don't exist.

- [ ] **Step 3: Add the error enum** (`RepoBackend.swift`, after the `RepoBackend` protocol)

```swift
enum RepoBackendError: Error, LocalizedError {
    case operationNotAllowed(RepoOperation, provider: RepoBackendKind)
    var errorDescription: String? {
        switch self {
        case let .operationNotAllowed(op, provider):
            return "\(op.label) is disabled for \(provider.displayName). Enable it in Settings → \(provider.displayName) → Automation & Actions."
        }
    }
}
```

- [ ] **Step 4: Create the decorator** (`AllowlistedRepoBackend.swift`)

```swift
import Foundation

/// Decorator that enforces the per-provider operation allow-list at the data
/// layer. Reads pass through; each write throws
/// `RepoBackendError.operationNotAllowed` when the op is disabled for this
/// provider, so no UI path can perform a disallowed write. Wrap every backend
/// via `RepoBackendFactory.guarded(_:config:)`.
@MainActor
final class AllowlistedRepoBackend: RepoBackend {
    private let wrapped: RepoBackend
    private let config: AppConfig
    nonisolated var kind: RepoBackendKind { wrapped.kind }

    init(wrapping wrapped: RepoBackend, config: AppConfig) {
        self.wrapped = wrapped
        self.config = config
    }

    private func require(_ op: RepoOperation) throws {
        guard config.isAllowed(op, provider: wrapped.kind) else {
            throw RepoBackendError.operationNotAllowed(op, provider: wrapped.kind)
        }
    }

    // Capability flags + reads — delegate verbatim.
    var canWriteIssues: Bool { wrapped.canWriteIssues }
    var canCreateMergeRequests: Bool { wrapped.canCreateMergeRequests }
    var supportsWeight: Bool { wrapped.supportsWeight }
    var usesScheduleOverlay: Bool { wrapped.usesScheduleOverlay }
    func listProjects() async throws -> [RepoProject] { try await wrapped.listProjects() }
    func getProject(id: String) async throws -> RepoProject { try await wrapped.getProject(id: id) }
    func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue] { try await wrapped.listIssues(projectId: projectId, filter: filter, page: page) }
    func getIssue(projectId: String, number: Int) async throws -> RepoIssue { try await wrapped.getIssue(projectId: projectId, number: number) }
    func listLabels(projectId: String) async throws -> [RepoLabel] { try await wrapped.listLabels(projectId: projectId) }
    func listMilestones(projectId: String) async throws -> [RepoMilestone] { try await wrapped.listMilestones(projectId: projectId) }
    func listMembers(projectId: String) async throws -> [RepoUser] { try await wrapped.listMembers(projectId: projectId) }
    func listNotes(projectId: String, number: Int) async throws -> [RepoNote] { try await wrapped.listNotes(projectId: projectId, number: number) }
    func listOpenMergeRequests(projectId: String) async throws -> [RepoMergeRequest] { try await wrapped.listOpenMergeRequests(projectId: projectId) }

    // Writes — gated.
    func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue {
        try require(.createIssue)
        return try await wrapped.createIssue(projectId: projectId, payload: payload)
    }
    func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue {
        try require(payload.stateChange != nil ? .closeIssue : .editIssue)
        return try await wrapped.updateIssue(projectId: projectId, number: number, payload: payload)
    }
    func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote {
        try require(.commentIssue)
        return try await wrapped.createNote(projectId: projectId, number: number, body: body)
    }
    @discardableResult
    func createBranch(projectId: String, name: String, ref: String) async throws -> Bool {
        try require(.createBranch)
        return try await wrapped.createBranch(projectId: projectId, name: name, ref: ref)
    }
    func createMergeRequest(projectId: String, payload: RepoMergeRequestPayload) async throws -> RepoMergeRequest {
        try require(.createPR)
        return try await wrapped.createMergeRequest(projectId: projectId, payload: payload)
    }
}
```

NOTE: if the real `RepoIssuePayload.init` signature differs from the test's (`title:`, `labels:`, `stateChange:`), adjust the test calls to match — the payload struct is defined in `RepoBackend.swift` (fields: `title, description, labels, milestoneId, assigneeIds, dueDate, weight, stateChange`). Do not change the struct.

- [ ] **Step 5: Run tests**

Run: `cd mac && swift test --filter AllowlistedRepoBackendTests` → all pass.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/Repo/RepoBackend.swift mac/Sources/LlmIdeMac/Services/Repo/AllowlistedRepoBackend.swift mac/Tests/LlmIdeMacTests/AllowlistedRepoBackendTests.swift
git commit -m "feat(mac): AllowlistedRepoBackend decorator gates writes on the allow-list"
```

---

### Task 3: `RepoBackendFactory` + route all backend construction through it

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/Repo/RepoBackendFactory.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeWorkflowTarget.swift`, `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`, `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift`, and the sites where a `RepoBackend`/client is handed to `RepoIssuesView` / `RepoIssueDetailSheet` / `RepoKanbanPanel` / `GanttContainerView` (grep to find them).

**Interfaces:**
- Consumes: `AllowlistedRepoBackend`, `AppConfig`.
- Produces: `enum RepoBackendFactory { static func guarded(_ client: RepoBackend, config: AppConfig) -> RepoBackend }`.

- [ ] **Step 1: Create the factory**

```swift
import Foundation

/// Single place that wraps a concrete backend in the allow-list guard.
/// Route ALL backend construction through this so every consumer — manual UI
/// and automation — gets enforcement for free.
enum RepoBackendFactory {
    @MainActor
    static func guarded(_ client: RepoBackend, config: AppConfig) -> RepoBackend {
        AllowlistedRepoBackend(wrapping: client, config: config)
    }
}
```

- [ ] **Step 2: Find every site that hands a raw backend to a consumer**

Run:
```
cd mac && grep -rn "GitLabClient()\|GitHubClient()\| as RepoBackend\|\.client\b" Sources/LlmIdeMac --include='*.swift' | grep -v Tests
```
Enumerate the sites where the resulting backend is passed to a view/service that performs writes: `CodeWorkflowTarget` (its backend/client accessor used by `CodeWorkflowService`), `AutoCodeUpdateService.resolveBackendAndProject()` (`resolved.client` at ~line 220), `CodeAssistantPanel.swift:~1846` (`let client = GitLabClient()`), and wherever `RepoIssuesView`/`RepoIssueDetailSheet`/`RepoKanbanPanel`/`GanttContainerView` obtain their backend. List them in the report.

- [ ] **Step 3: Wrap at each site**

At each enumerated site, wrap the concrete client before it is used for writes, e.g. change `let client = GitLabClient()` → `let client = RepoBackendFactory.guarded(GitLabClient(), config: config)` (using the `AppConfig` already in scope — every one of these sites already has a `config`/`appConfig`). For `CodeWorkflowTarget` and `AutoCodeUpdateService`, wrap the backend where it is resolved (so the returned `.client` is already guarded). Read each site to confirm a `config` is in scope; if one genuinely isn't, report it rather than force a wrap.

- [ ] **Step 4: Verify build + no unwrapped write consumers remain**

Run: `cd mac && swift build` → clean.
Run: `cd mac && grep -rn "GitLabClient()\|GitHubClient()" Sources/LlmIdeMac --include='*.swift' | grep -v Tests` — confirm each remaining raw construction is either read-only utility (e.g. token verify) or immediately wrapped. Note any intentional read-only exceptions in the report.

- [ ] **Step 5: Full suite (no regression)**

Run: `cd mac && swift test` → all pass (369+ prior + new).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/Repo/RepoBackendFactory.swift mac/Sources/LlmIdeMac/Views/ mac/Sources/LlmIdeMac/Services/
git commit -m "feat(mac): route all backend construction through the allow-list guard"
```

---

### Task 4: Gate `SourceControlService` (local git)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/SourceControlService.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` (construct the service with config; add button `.disabled`)
- Test: `mac/Tests/LlmIdeMacTests/SourceControlAllowlistTests.swift`

**Interfaces:**
- Consumes: `AppConfig.isAllowed(_:provider:)`, saved-project/repo lists (to map a root URL → `RepoBackendKind`).
- Produces: `SourceControlService` guards `push`/`pull`/`sync`/`publish`/`createBranch`; exposes a user-facing blocked message.

- [ ] **Step 1: Read the service's error-reporting mechanism**

Read `SourceControlService.swift` and identify the `@Published` property the view shows on failure (e.g. an `errorMessage`/`lastError`/`status`). The gate sets THAT property + returns early (these methods are `async` returning Void — they do NOT throw). Name it in the report as `<errProp>`.

- [ ] **Step 2: Write the failing test** (`SourceControlAllowlistTests.swift`)

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
@Suite("SourceControl allow-list")
struct SourceControlAllowlistTests {
    private func cfg(disallow ops: [RepoOperation], provider: RepoBackendKind) -> AppConfig {
        let name = "scm-allow-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        let c = AppConfig(userDefaults: d)
        // Register an active cloned repo at a temp root so providerKind resolves.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        if provider == .github {
            c.gitHubSavedRepos = [SavedGitHubRepo(url: "https://github.com/o/r", displayName: "r", isActive: true, localPath: root.path)]
        }
        for op in ops { c.setAllowed(op, provider: provider, false) }
        return c
    }

    @Test func pushBlockedWhenPushDisallowed() async {
        let config = cfg(disallow: [.push], provider: .github)
        let root = URL(fileURLWithPath: config.gitHubSavedRepos[0].localPath!)
        let scm = SourceControlService(config: config)
        await scm.push(root: root)
        #expect(scm.blockedMessage != nil)   // rename to the real <errProp> from Step 1
    }
}
```
(If the real active-repo model field names differ from `SavedGitHubRepo(url:displayName:isActive:localPath:)`, adjust to the real initializer read from `Models/GitHubModels.swift`.)

- [ ] **Step 3: Run to verify failure**

Run: `cd mac && swift test --filter SourceControlAllowlistTests`
Expected: FAIL — `SourceControlService(config:)` / provider resolution / gate don't exist.

- [ ] **Step 4: Add config + provider resolver + guards** (`SourceControlService.swift`)

Add a stored `private let config: AppConfig?` (optional so the existing `init(repo:)`/`init()` keep working for non-gated call sites — default nil = no gating), plus `init(config: AppConfig)`. Add a resolver:

```swift
/// Which provider owns the repo at `root` (matched by clone localPath), or
/// nil when the root isn't an allow-list-managed repo (then don't gate).
private func providerKind(for root: URL) -> RepoBackendKind? {
    guard let config else { return nil }
    let path = root.standardizedFileURL.path
    if config.gitHubSavedRepos.contains(where: { $0.localPath == path }) { return .github }
    if config.gitLabSavedProjects.contains(where: { $0.localPath == path }) { return .gitlab }
    return nil
}

/// Returns true (and sets the user-facing error) when `op` is blocked for
/// the repo at `root`. Call sites early-return on true.
private func blocked(_ op: RepoOperation, at root: URL) -> Bool {
    guard let config, let kind = providerKind(for: root) else { return false }
    if config.isAllowed(op, provider: kind) { return false }
    <errProp> = "\(op.label) is disabled for \(kind.displayName). Enable it in Settings → \(kind.displayName) → Automation & Actions."
    return true
}
```

Guard each remote-affecting method at its top:
- `push(root:)` → `if blocked(.push, at: root) { return }`
- `pull(root:)` → `if blocked(.sync, at: root) { return }`
- `sync(root:)` → `if blocked(.sync, at: root) || blocked(.push, at: root) { return }`
- `publish(root:)` → `if blocked(.push, at: root) { return }`
- `createBranch(root:name:)` → `if blocked(.createBranch, at: root) { return }`
- Do NOT gate `merge(root:branch:)` (local git branch merge, not a remote op).

Use the real `<errProp>` from Step 1 in `blocked(...)` and the test.

- [ ] **Step 5: Construct the service with config in the view**

In `SourceControlView.swift`, change `@State private var scm = SourceControlService()` to build with config. Since `@State` can't read `@EnvironmentObject` at init, use the established pattern in the codebase for injecting config into a `@State`/`@StateObject` service (grep for a sibling view that does this, e.g. how `AutoCodeUpdateService` or another service receives `config`); typically an `.onAppear { scm.config = ... }` or a `@StateObject` initialized from environment. If `SourceControlService` uses `@State` (value type/`@Observable`), add a settable `config` and assign it in `.onAppear`/`.task`. Confirm the view already has `@EnvironmentObject var config: AppConfig` (add if missing).

- [ ] **Step 6: Add button `.disabled` (UX layer)** in `SourceControlView.swift`

For the Push (`:367`), Sync (`:372`), Create Branch (`:400`), Publish (`:405`) buttons, add `.disabled(!config.isAllowed(.<op>, provider: <kind>))` where `<kind>` is the active repo's provider (derive once via a computed property mirroring `providerKind`, or reuse `CodeWorkflowTarget`/config precedence). If the active provider can't be cheaply determined in the view, rely on the service-level block from Step 4 (the button click sets the error) and skip the `.disabled` for that button — note which in the report.

- [ ] **Step 7: Run tests + build**

Run: `cd mac && swift test --filter SourceControlAllowlistTests` → pass.
Run: `cd mac && swift build` → clean.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SourceControlService.swift mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift mac/Tests/LlmIdeMacTests/SourceControlAllowlistTests.swift
git commit -m "feat(mac): gate Source Control push/branch/sync on the allow-list"
```

---

### Task 5: Fill missed UI buttons + surface chokepoint throws

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Issues/RepoIssueDetailSheet.swift` (sidebar Status "Edit" menu), `mac/Sources/LlmIdeMac/Views/QuickFixSheet.swift` (widen "Run" gate), `mac/Sources/LlmIdeMac/Views/CodeWorkflowSheet.swift` ("Retry PR/MR only" button), `mac/Sources/LlmIdeMac/Views/Issues/RepoKanbanPanel.swift` (surface drag throw).

**Interfaces:** Consumes `AppConfig.isAllowed`, `RepoBackendError` (thrown by the guarded backend from Task 3).

- [ ] **Step 1: Gate the issue-detail sidebar Status "Edit" menu**

In `RepoIssueDetailSheet.swift`, the sidebar `Status` section's Edit menu (~line 291) calls `toggleState()`. Gate its `hasEdit`/menu on `.closeIssue`: change the `hasEdit:` condition to also require `config.isAllowed(.closeIssue, provider: client.kind)`. (The header Close/Reopen button already checks this — mirror it.)

- [ ] **Step 2: Widen QuickFix "Run" gate**

Read `CodeWorkflowService.runEndToEnd` (~`:477-511`) and list exactly which write ops it performs (createBranch, autoCommit, push, createPR, and — if it comments/closes — commentIssue, closeIssue). In `QuickFixSheet.swift` (~`:234`), extend the "Run" button `.disabled` to require ALL of those ops allowed for `kind` (AND them onto the existing condition), and update the `.help` to name the missing capability. Show the exact ops in the report.

- [ ] **Step 3: Gate "Retry PR/MR only"**

In `CodeWorkflowSheet.swift` (~`:557`), the "Retry PR/MR only" button is gated only on `svc.busy`. Add `.disabled(... || !(appConfig.isAllowed(.push, provider: kind) && appConfig.isAllowed(.createPR, provider: kind)))` + a `.help` fallback (mirrors the main Push & MR button).

- [ ] **Step 4: Surface the kanban drag throw**

In `RepoKanbanPanel.swift`, `move(idStr:to:)` (~:227) calls `client.updateIssue(...)` inside a `do/catch`. Confirm the `catch` surfaces the error to the user (an error banner/alert). If it currently swallows or only logs, change it to set the panel's user-facing error state to `error.localizedDescription` so a blocked drag (thrown by the guarded backend) shows the "disabled … enable in Settings" message. No `config` injection is needed — the guard lives in the backend; the panel just needs to display the thrown error.

- [ ] **Step 5: Build + full suite**

Run: `cd mac && swift build` → clean.
Run: `cd mac && swift test` → all pass.

- [ ] **Step 6: Manual verification (controller/human)**

GUI check (not automatable here): with a provider's "Close / reopen issue" unchecked, confirm the issue-detail sidebar Status Edit is disabled AND dragging a card to Closed shows the blocked-error banner. With "Push" unchecked, confirm Source Control Push is disabled and QuickFix "Run" is disabled.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/
git commit -m "feat(mac): fill remaining manual gates + surface allow-list blocks in the UI"
```

---

## Self-Review

**Spec coverage:**
- Chokepoint decorator (spec §2/§3) → Task 2. ✓
- Universal injection (spec §4) → Task 3. ✓
- `.merge`→`.closeIssue` rename + `.editIssue` + decode alias (spec §1) → Task 1. ✓
- Throw `operationNotAllowed` (spec Decision 2) → Task 2 (`require`) + Task 5 (surfacing). ✓
- SourceControlService gating (spec §5) → Task 4. ✓
- UI: fill missed buttons + labels + surface throws (spec §6) → Task 1 (labels via enum) + Task 5. ✓
- `updateIssue` payload → closeIssue vs editIssue (spec §3) → Task 2 Step 4 + test. ✓
- Testing (spec §7) → Tasks 1,2,4 unit tests; Tasks 3,5 build+suite+manual. ✓
- Migration alias (spec) → Task 1 Step 4 + test. ✓
- Out-of-scope (PR-merge op, server enforcement, local-only SCM reads) → not implemented. ✓

**Placeholder scan:** Tasks 3–5 contain "grep to find the site / read to confirm the property" steps rather than fixed line numbers for a few UI internals (SCM error property, kanban catch, exact backend-hand-off sites) that weren't line-verified during planning. Each names the exact file, the exact modifier/pattern to apply, and a concrete verification — actionable, not vague. The `<errProp>` placeholder in Task 4 is explicitly resolved in Task 4 Step 1 before use. No "add error handling"-style placeholders remain.

**Type consistency:** `RepoOperation` cases (`.closeIssue`, `.editIssue`), `RepoBackendError.operationNotAllowed(_:provider:)`, `AllowlistedRepoBackend(wrapping:config:)`, `RepoBackendFactory.guarded(_:config:)`, and `isAllowed(_:provider:)` are used consistently across tasks and tests.
