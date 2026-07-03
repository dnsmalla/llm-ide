# Per-Provider Repo Operation Allow-List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-provider checklist (GitLab & GitHub) of allowed repo operations; an unchecked operation is skipped by automation AND its matching manual button is disabled.

**Architecture:** All Mac-side. A `RepoOperation` enum + two `Set<RepoOperation>` on `AppConfig` (per provider, default all-enabled, persisted to UserDefaults) with one predicate `isAllowed(_:provider:)`. A new `OperationsAllowlistView` renders the checkboxes in each settings section. The predicate is consulted by the automation engine (`AutoCodeUpdateService`) and by `.disabled(...)` on manual buttons.

**Tech Stack:** Swift / SwiftUI (macOS), swift-testing (`import Testing`, `@Suite`, `@Test`, `#expect`). Provider type is the existing `RepoBackendKind` (`.gitlab` / `.github`).

## Global Constraints

- Provider type is `RepoBackendKind` (`Services/Repo/RepoBackend.swift:16`), cases `.gitlab` / `.github`. Do NOT introduce a new provider enum.
- Storage is Mac-local only (UserDefaults for the sets, mirroring `gitHubSavedRepos`). No backend/route changes.
- Default state is **all operations enabled** — applied only when the UserDefaults key is ABSENT. An explicitly-stored empty array means "none allowed" and must be preserved (do not fall back to all-enabled on empty).
- Tolerant decode: unknown operation raw-strings in stored data are dropped, never fatal.
- Tests run with: `cd mac && swift test --filter <TestName>`. Full gate: `cd mac && swift build && swift test`.
- Follow existing settings-view style helpers: `SettingsSectionCard`, `SectionLabel`, `Spacing`, `Typography`, `theme.current.*`.

---

### Task 1: `RepoOperation` model + `AppConfig` storage, predicate, and mutator

**Files:**
- Create: `mac/Sources/LlmIdeMac/Models/RepoOperation.swift`
- Modify: `mac/Sources/LlmIdeMac/Models/Config.swift` (add two `@Published` sets near the GitHub block ~line 229; add predicate/mutator methods; add init decode after line 522)
- Test: `mac/Tests/LlmIdeMacTests/RepoOperationAllowlistTests.swift`

**Interfaces:**
- Produces:
  - `enum RepoOperation: String, Codable, CaseIterable { case sync, push, createBranch, autoCommit, createIssue, commentIssue, createPR, merge }` with `var label: String` and `static var groups: [(String, [RepoOperation])]`.
  - `AppConfig.gitHubAllowedOps: Set<RepoOperation>` and `AppConfig.gitLabAllowedOps: Set<RepoOperation>` (default `Set(RepoOperation.allCases)`).
  - `AppConfig.isAllowed(_ op: RepoOperation, provider: RepoBackendKind) -> Bool`
  - `AppConfig.setAllowed(_ op: RepoOperation, provider: RepoBackendKind, _ on: Bool)`

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/RepoOperationAllowlistTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("Repo operation allow-list")
struct RepoOperationAllowlistTests {

    private func freshDefaults() -> UserDefaults {
        let name = "allowlist-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func defaultsToAllEnabledWhenKeyAbsent() {
        let cfg = AppConfig(userDefaults: freshDefaults())
        for op in RepoOperation.allCases {
            #expect(cfg.isAllowed(op, provider: .github))
            #expect(cfg.isAllowed(op, provider: .gitlab))
        }
    }

    @Test func setAllowedTogglesAndPersistsPerProvider() {
        let defaults = freshDefaults()
        let cfg = AppConfig(userDefaults: defaults)
        cfg.setAllowed(.createIssue, provider: .github, false)
        #expect(cfg.isAllowed(.createIssue, provider: .github) == false)
        // Other provider is untouched.
        #expect(cfg.isAllowed(.createIssue, provider: .gitlab) == true)

        // A new AppConfig on the same defaults reflects the persisted change.
        let reloaded = AppConfig(userDefaults: defaults)
        #expect(reloaded.isAllowed(.createIssue, provider: .github) == false)
        #expect(reloaded.isAllowed(.push, provider: .github) == true)
    }

    @Test func storedEmptyMeansNoneNotDefaultAll() {
        let defaults = freshDefaults()
        let cfg = AppConfig(userDefaults: defaults)
        for op in RepoOperation.allCases { cfg.setAllowed(op, provider: .gitlab, false) }
        let reloaded = AppConfig(userDefaults: defaults)
        for op in RepoOperation.allCases {
            #expect(reloaded.isAllowed(op, provider: .gitlab) == false)
        }
    }

    @Test func decodeIgnoresUnknownOperationStrings() {
        let defaults = freshDefaults()
        defaults.set(["push", "bogus-op", "merge"], forKey: "gitHubAllowedOps")
        let cfg = AppConfig(userDefaults: defaults)
        #expect(cfg.isAllowed(.push, provider: .github))
        #expect(cfg.isAllowed(.merge, provider: .github))
        #expect(cfg.isAllowed(.createIssue, provider: .github) == false)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mac && swift test --filter RepoOperationAllowlistTests`
Expected: FAIL to compile — `RepoOperation` and the `AppConfig` members don't exist yet.

- [ ] **Step 3: Create the `RepoOperation` model**

Create `mac/Sources/LlmIdeMac/Models/RepoOperation.swift`:

```swift
import Foundation

/// A repo operation the app can perform on behalf of the user. Membership in a
/// provider's allow-list (`AppConfig.gitHubAllowedOps` / `gitLabAllowedOps`)
/// gates BOTH automated execution and the matching manual button.
enum RepoOperation: String, Codable, CaseIterable {
    case sync          // pull / re-sync / clone
    case push
    case createBranch
    case autoCommit
    case createIssue   // create issue/ticket, incl. tracker dispatch
    case commentIssue
    case createPR      // create PR / MR
    case merge         // merge / close PR / MR

    var label: String {
        switch self {
        case .sync:         return "Pull / Re-sync"
        case .push:         return "Push"
        case .createBranch: return "Create branch"
        case .autoCommit:   return "Auto-commit AI changes"
        case .createIssue:  return "Create issue"
        case .commentIssue: return "Comment on issue"
        case .createPR:     return "Create PR / MR"
        case .merge:        return "Merge / close"
        }
    }

    /// UI grouping — display only; the stored model stays a flat set.
    static var groups: [(String, [RepoOperation])] {
        [
            ("Sync",        [.sync]),
            ("Code writes", [.push, .createBranch, .autoCommit]),
            ("Issues",      [.createIssue, .commentIssue]),
            ("PR / MR",     [.createPR, .merge]),
        ]
    }
}
```

- [ ] **Step 4: Add storage, predicate, and mutator to `AppConfig`**

In `mac/Sources/LlmIdeMac/Models/Config.swift`, after the `gitHubActiveRepoId` computed var (ends line 232), add:

```swift
    // ── Per-provider operation allow-list ─────────────────────────────
    /// Operations automation may perform / manual buttons may trigger for
    /// GitHub. Absent key ⇒ all-enabled (see init); explicit empty ⇒ none.
    @Published var gitHubAllowedOps: Set<RepoOperation> = Set(RepoOperation.allCases) {
        didSet { defaults.set(gitHubAllowedOps.map(\.rawValue), forKey: "gitHubAllowedOps") }
    }
    @Published var gitLabAllowedOps: Set<RepoOperation> = Set(RepoOperation.allCases) {
        didSet { defaults.set(gitLabAllowedOps.map(\.rawValue), forKey: "gitLabAllowedOps") }
    }

    /// The one predicate every enforcement site consults.
    func isAllowed(_ op: RepoOperation, provider: RepoBackendKind) -> Bool {
        (provider == .github ? gitHubAllowedOps : gitLabAllowedOps).contains(op)
    }

    /// Toggle one op for one provider (used by the settings checklist).
    func setAllowed(_ op: RepoOperation, provider: RepoBackendKind, _ on: Bool) {
        if provider == .github {
            if on { gitHubAllowedOps.insert(op) } else { gitHubAllowedOps.remove(op) }
        } else {
            if on { gitLabAllowedOps.insert(op) } else { gitLabAllowedOps.remove(op) }
        }
    }
```

- [ ] **Step 5: Add init decode (tolerant, absent ⇒ all-enabled)**

In `Config.swift`, in `init(userDefaults defaults: UserDefaults = .standard)`, right after the `gitHubSavedRepos` decode block (ends line 522, the `}` after `self.gitHubSavedRepos = []`), add:

```swift
        // Allow-lists: absent key ⇒ default all-enabled; stored array (even
        // empty) is honored verbatim; unknown raw-strings are dropped.
        if let raw = defaults.array(forKey: "gitHubAllowedOps") as? [String] {
            self.gitHubAllowedOps = Set(raw.compactMap(RepoOperation.init(rawValue:)))
        } else {
            self.gitHubAllowedOps = Set(RepoOperation.allCases)
        }
        if let raw = defaults.array(forKey: "gitLabAllowedOps") as? [String] {
            self.gitLabAllowedOps = Set(raw.compactMap(RepoOperation.init(rawValue:)))
        } else {
            self.gitLabAllowedOps = Set(RepoOperation.allCases)
        }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd mac && swift test --filter RepoOperationAllowlistTests`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/RepoOperation.swift \
        mac/Sources/LlmIdeMac/Models/Config.swift \
        mac/Tests/LlmIdeMacTests/RepoOperationAllowlistTests.swift
git commit -m "feat(mac): per-provider repo operation allow-list model + AppConfig storage"
```

---

### Task 2: `OperationsAllowlistView` + wire into both settings sections

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Settings/OperationsAllowlistView.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/GitHubSettingsSection.swift:93` (after the `Divider()`)
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/GitLabSettingsSection.swift` (after its `Divider()`, ~line 105)

**Interfaces:**
- Consumes: `AppConfig.isAllowed(_:provider:)`, `AppConfig.setAllowed(_:provider:_:)`, `RepoOperation.groups`, `RepoBackendKind`.
- Produces: `struct OperationsAllowlistView: View { init(provider: RepoBackendKind) }`.

- [ ] **Step 1: Create the view**

Create `mac/Sources/LlmIdeMac/Views/Settings/OperationsAllowlistView.swift`:

```swift
import SwiftUI

/// Per-provider checklist of allowed repo operations. An unchecked op is
/// skipped by automation and its manual button is disabled. Rendered at the
/// bottom of GitHubSettingsSection / GitLabSettingsSection.
struct OperationsAllowlistView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    let provider: RepoBackendKind

    private func binding(for op: RepoOperation) -> Binding<Bool> {
        Binding(
            get: { config.isAllowed(op, provider: provider) },
            set: { config.setAllowed(op, provider: provider, $0) }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionLabel("AUTOMATION & ACTIONS", size: 10, tracking: 1.2)
            Text("Unchecked operations are skipped automatically and disabled in the UI.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)

            ForEach(RepoOperation.groups, id: \.0) { group in
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.0.uppercased())
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(theme.current.textMuted)
                    ForEach(group.1, id: \.self) { op in
                        Toggle(op.label, isOn: binding(for: op))
                            .toggleStyle(.checkbox)
                            .font(Typography.caption)
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 2: Verify it builds (no dedicated unit test — logic is Task 1)**

Run: `cd mac && swift build`
Expected: builds (the view compiles; toggle logic is covered by Task 1's `setAllowed`/`isAllowed` tests).

- [ ] **Step 3: Wire into the GitHub section**

In `GitHubSettingsSection.swift`, immediately AFTER line 93 (`Divider().padding(.vertical, 4)`) and before the `HStack { SectionLabel("REPOSITORIES" ...`, insert:

```swift
                OperationsAllowlistView(provider: .github)

                Divider().padding(.vertical, 4)
```

- [ ] **Step 4: Wire into the GitLab section**

In `GitLabSettingsSection.swift`, find the `Divider().padding(.vertical, 4)` that precedes the `SectionLabel("PROJECTS" ...` header (~line 105) and insert immediately after it:

```swift
                OperationsAllowlistView(provider: .gitlab)

                Divider().padding(.vertical, 4)
```

- [ ] **Step 5: Verify it builds**

Run: `cd mac && swift build`
Expected: builds.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Settings/OperationsAllowlistView.swift \
        mac/Sources/LlmIdeMac/Views/Settings/GitHubSettingsSection.swift \
        mac/Sources/LlmIdeMac/Views/Settings/GitLabSettingsSection.swift
git commit -m "feat(mac): render per-provider operation checklist in GitHub/GitLab settings"
```

---

### Task 3: Enforce the allow-list in automation (`AutoCodeUpdateService`)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift` (issue-create loop ~line 305; CLI implement loop ~line 338)
- Test: `mac/Tests/LlmIdeMacTests/RepoOperationAllowlistTests.swift` (add an enforcement-decision test)

**Interfaces:**
- Consumes: `config.isAllowed(_:provider:)`, `client.kind` (the resolved backend's `RepoBackendKind`), the existing `config` property (`AutoCodeUpdateService.swift:28`) and `log`.

- [ ] **Step 1: Write the failing test (decision helper)**

The `run()` method is integration-heavy (needs backend + meetings + registry), so we test the gating DECISION via a small pure helper we add to the service. Append to `RepoOperationAllowlistTests.swift`:

```swift
    @Test func automationStepsRespectAllowList() {
        let defaults = UserDefaults(suiteName: "allowlist-auto-\(UUID().uuidString)")!
        let cfg = AppConfig(userDefaults: defaults)
        cfg.setAllowed(.createIssue, provider: .github, false)
        cfg.setAllowed(.autoCommit, provider: .github, false)

        let steps = AutoCodeUpdateService.allowedAutoSteps(config: cfg, provider: .github)
        #expect(steps.createIssue == false)
        #expect(steps.createBranch == true)   // still enabled
        #expect(steps.autoCommit == false)

        // GitLab side untouched.
        let gl = AutoCodeUpdateService.allowedAutoSteps(config: cfg, provider: .gitlab)
        #expect(gl.createIssue == true)
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mac && swift test --filter RepoOperationAllowlistTests`
Expected: FAIL — `AutoCodeUpdateService.allowedAutoSteps` doesn't exist.

- [ ] **Step 3: Add the pure decision helper**

In `AutoCodeUpdateService.swift`, add a static helper (near the top of the type, after the stored properties):

```swift
    /// Which automated steps are permitted for a provider. Pure + static so the
    /// gating decision is unit-testable without running the full pipeline.
    static func allowedAutoSteps(config: AppConfig, provider: RepoBackendKind)
        -> (createIssue: Bool, createBranch: Bool, autoCommit: Bool) {
        (
            createIssue:  config.isAllowed(.createIssue,  provider: provider),
            createBranch: config.isAllowed(.createBranch, provider: provider),
            autoCommit:   config.isAllowed(.autoCommit,   provider: provider)
        )
    }
```

- [ ] **Step 4: Apply the guards in `run()`**

In `run()`, after `let client = resolved.client` (line 209), add:

```swift
        let autoSteps = Self.allowedAutoSteps(config: config, provider: client.kind)
```

Guard the issue-creation loop. Replace the loop header at line 304-305:

```swift
        // 3. Create issues for genuinely new actions
        for action in newActions {
```
with:

```swift
        // 3. Create issues for genuinely new actions (allow-list gated)
        for action in newActions where autoSteps.createIssue {
```

And immediately before line 333 (`// 4. Implement pending entries via CLI subprocess`), add a guard so branch-cut + auto-commit are skipped when either is disallowed:

```swift
        // 4. Implement pending entries via CLI subprocess (branch + commit).
        // Skip entirely if either the branch or the commit step is disallowed —
        // implementing without committing would leave dirty state.
        guard autoSteps.createBranch, autoSteps.autoCommit else {
            log.info("auto_code_skip_implement reason=allowlist provider=\(client.kind.rawValue, privacy: .public) branch=\(autoSteps.createBranch) commit=\(autoSteps.autoCommit)")
            return AutoCodeRunSummary(createdIssues: createdCount, implemented: 0, failed: failedCount, error: lastError)
        }
```

NOTE: match the exact return shape used elsewhere in `run()`. Before editing, read the existing `return` at the end of `run()` and mirror its constructor/values (the summary type and its fields). If `run()` returns `Void`, replace the `return AutoCodeRunSummary(...)` line with a bare `return` and keep the `log.info` line.

- [ ] **Step 5: Run tests**

Run: `cd mac && swift test --filter RepoOperationAllowlistTests`
Expected: PASS (5 tests now).

- [ ] **Step 6: Verify no regression in the service's own tests**

Run: `cd mac && swift test --filter AutoCode`
Expected: PASS (AutoCodeUpdateServiceTests, AutoCodeStashTests, AutoCodeLookbackTests, AutoCodeLogRotationTests all green).

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift \
        mac/Tests/LlmIdeMacTests/RepoOperationAllowlistTests.swift
git commit -m "feat(mac): gate AutoCodeUpdateService issue/branch/commit on the allow-list"
```

---

### Task 4: Enforce the allow-list on manual buttons

Each manual button gets `.disabled(!config.isAllowed(.<op>, provider: <kind>))` plus a `.help(...)` tooltip. In the settings sections the provider is a literal (`.github` / `.gitlab`); in the in-app views use the active backend's `.kind`.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/GitHubSettingsSection.swift` (Re-sync/Clone button)
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/GitLabSettingsSection.swift` (Re-sync/Clone button)
- Modify: `mac/Sources/LlmIdeMac/Views/Issues/RepoIssuesView.swift` (New Issue button → `.createIssue`)
- Modify: the comment-issue action site (Comment button → `.commentIssue`)
- Modify: the Push & MR/PR entry site in the code-workflow sheet (→ `.push` && `.createPR`)
- Modify: the merge/close action site (→ `.merge`)

- [ ] **Step 1: Gate the GitHub Re-sync/Clone button**

In `GitHubSettingsSection.swift`, locate the clone/re-sync `Button` inside `repoRow` (its action calls `cloneOrSync(...)`; label is "Clone" / "Re-sync"). Add to that button, after its existing modifiers:

```swift
                    .disabled(!config.isAllowed(.sync, provider: .github))
                    .help(config.isAllowed(.sync, provider: .github) ? "" : "Enable Pull / Re-sync in Automation & Actions above")
```

- [ ] **Step 2: Gate the GitLab Re-sync/Clone button**

Same change in `GitLabSettingsSection.swift`'s clone/re-sync button, with `provider: .gitlab`:

```swift
                    .disabled(!config.isAllowed(.sync, provider: .gitlab))
                    .help(config.isAllowed(.sync, provider: .gitlab) ? "" : "Enable Pull / Re-sync in Automation & Actions above")
```

- [ ] **Step 3: Gate the "New Issue" button**

Locate the site: `cd mac && grep -rn "New Issue" Sources/LlmIdeMac/Views/Issues/`. On that `Button`, using the view's active backend value (the `RepoBackend` it already holds — call its `.kind`; bind it to a local `let providerKind = backend.kind`), add:

```swift
                    .disabled(!config.isAllowed(.createIssue, provider: backend.kind))
                    .help(config.isAllowed(.createIssue, provider: backend.kind) ? "" : "Enable Create issue in Settings → \(backend.kind.displayName) → Automation & Actions")
```

If the view does not already read `@EnvironmentObject var config: AppConfig`, add that property.

- [ ] **Step 4: Gate the Comment button**

Locate: `cd mac && grep -rn "Comment" Sources/LlmIdeMac/Views/Issues/`. On the button that opens/sends a comment, add (using the active backend `.kind`):

```swift
                    .disabled(!config.isAllowed(.commentIssue, provider: backend.kind))
                    .help(config.isAllowed(.commentIssue, provider: backend.kind) ? "" : "Enable Comment on issue in Settings → \(backend.kind.displayName) → Automation & Actions")
```

- [ ] **Step 5: Gate the "Push & MR/PR" button**

Locate: `cd mac && grep -rn "Push" Sources/LlmIdeMac/Views/CodeWorkflowSheet.swift Sources/LlmIdeMac/Views/QuickFixSheet.swift`. The push-and-create-MR action requires both push and PR creation, so gate on both. On that button (using the workflow's provider kind — the `CodeWorkflowService`/`RepoBackend` kind it targets; bind `let k = <service>.backend.kind` or the resolved target kind), add:

```swift
                    .disabled(!(config.isAllowed(.push, provider: k) && config.isAllowed(.createPR, provider: k)))
                    .help((config.isAllowed(.push, provider: k) && config.isAllowed(.createPR, provider: k)) ? "" : "Enable Push and Create PR / MR in Settings → \(k.displayName) → Automation & Actions")
```

- [ ] **Step 6: Gate the Merge/Close button**

Locate: `cd mac && grep -rn "Merge\|Close" Sources/LlmIdeMac/Views/ | grep -i button`. On the merge/close action button, add (with the active provider kind):

```swift
                    .disabled(!config.isAllowed(.merge, provider: k))
                    .help(config.isAllowed(.merge, provider: k) ? "" : "Enable Merge / close in Settings → \(k.displayName) → Automation & Actions")
```

- [ ] **Step 7: Verify the whole app builds**

Run: `cd mac && swift build`
Expected: builds with no errors.

- [ ] **Step 8: Full mac test gate**

Run: `cd mac && swift test`
Expected: all tests pass (including the new `RepoOperationAllowlistTests`).

- [ ] **Step 9: Manual verification (running app)**

Build+launch via `bash mac/Scripts/build.sh && open mac/LlmIdeMac.app`. In Settings → GitHub, uncheck "Create issue"; confirm the "New Issue" button greys out with the tooltip. Re-check it; confirm the button re-enables.

- [ ] **Step 10: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/
git commit -m "feat(mac): disable manual repo-action buttons when the operation is not allowed"
```

---

## Self-Review

**Spec coverage:**
- Per-provider scope → Task 1 (two sets), Task 2 (one view per section). ✓
- Hard lock (automation + manual) → Task 3 (automation guards), Task 4 (button `.disabled`). ✓
- Operation set (Sync / Code writes / Issues / PR-MR) → `RepoOperation` + `groups` (Task 1). ✓
- Default all-enabled, absent-key semantics, empty-means-none → Task 1 Step 5 + tests. ✓
- Mac-local storage, no backend change → Task 1 (UserDefaults). ✓
- Tolerant decode → Task 1 Step 5 + `decodeIgnoresUnknownOperationStrings` test. ✓
- Skipped-step logging → Task 3 Step 4 (`log.info` lines). ✓
- Retry-sweep edge deferred → not implemented by design (spec Decision 6). ✓

**Placeholder scan:** Task 4 uses `grep` to locate a few button sites rather than fixed line numbers (those files weren't line-verified during planning); each still specifies the exact op, provider source, and the exact modifier lines to add — actionable, not vague. Task 3 Step 4 flags a read-and-mirror on the `run()` return shape. No "TBD/handle appropriately" placeholders remain.

**Type consistency:** `RepoBackendKind` (`.github`/`.gitlab`) used throughout; `isAllowed(_:provider:)`, `setAllowed(_:provider:_:)`, `allowedAutoSteps(config:provider:)`, and `RepoOperation` cases match across tasks and tests.
