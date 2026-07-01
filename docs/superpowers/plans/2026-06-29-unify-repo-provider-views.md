# Unify GitLab + GitHub repo views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route both GitLab and GitHub through one shared set of `RepoBackend`-backed views (`RepoIssuesView`, `RepoGanttView`), preserving GitLab's native affordances via capability flags, then delete the legacy GitLab-only views.

**Architecture:** The backend (`RepoBackend`) is already provider-neutral and shared. This is a view-layer unification: add two capability flags + one model field, fold the legacy GitLab affordances into the unified views gated by those flags, flip `AppShell` routing to always-unified, then delete the legacy views.

**Tech Stack:** Swift 6 / SwiftUI, macOS app under `mac/`. Tests via `swift-testing` (`import Testing`, `@Test`) in `mac/Tests/LlmIdeMacTests/`. Build/test: `swift build` / `swift test` run from `mac/`.

## Global Constraints

- All work happens under `mac/` on branch `feat/unify-repo-provider-views` (already created).
- Run `swift build` and `swift test` from the `mac/` directory. Every task ends green.
- `RepoBackend` is `@MainActor`-isolated; both `GitLabClient` and `GitHubClient` are `@MainActor`. Tests that touch them must be `@MainActor`.
- Do NOT change the network/auth layer of either client. Only the two new flags, the `weight` field mapping, and view wiring change.
- No GitLab regression: weight, native due-date editing, milestone filter, and MR-creation UI must all survive in the unified views.
- Commit after every task. Do not push until the whole plan is green (the git pre-push hook runs `swift build`+`swift test`; pre-warm then push once).

---

### Task 1: Capability flags + `weight` model + milestone filter field

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/Repo/RepoBackend.swift` (protocol flags, `RepoIssue.weight`, `RepoIssueFilter.milestoneId`)
- Modify: `mac/Sources/LlmIdeMac/Services/Repo/GitLabClient+RepoBackend.swift` (flag values)
- Modify: `mac/Sources/LlmIdeMac/Services/Repo/GitLabModels+Repo.swift` (map `weight` in GitLab `asRepoIssue`)
- Modify: `mac/Sources/LlmIdeMac/Services/Repo/GitHubClient+RepoBackend.swift` (flag values)
- Test: `mac/Tests/LlmIdeMacTests/RepoBackendCapabilityTests.swift` (create)

**Interfaces:**
- Produces: `RepoBackend.supportsWeight: Bool`, `RepoBackend.usesScheduleOverlay: Bool`, `RepoIssue.weight: Int?`, `RepoIssueFilter.milestoneId: String?`. Tasks 2–4 read these.
- Consumes: existing `RepoBackend`, `RepoIssue`, `RepoIssueFilter`, `GitLabClient(config:)`, `GitHubClient(config:)`.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/RepoBackendCapabilityTests.swift`:

```swift
import Testing
@testable import LlmIdeMac

@MainActor
struct RepoBackendCapabilityTests {
    @Test func gitlabCapabilities() {
        let c = GitLabClient(config: AppConfig.makeForTesting())
        #expect(c.supportsWeight == true)
        #expect(c.usesScheduleOverlay == false)
    }

    @Test func githubCapabilities() {
        let c = GitHubClient(config: AppConfig.makeForTesting())
        #expect(c.supportsWeight == false)
        #expect(c.usesScheduleOverlay == true)
    }

    @Test func repoIssueCarriesWeightAndFilterCarriesMilestone() {
        var f = RepoIssueFilter()
        f.milestoneId = "42"
        #expect(f.milestoneId == "42")
        let issue = RepoIssue(
            id: "1", number: 1, title: "t", body: nil, state: "opened",
            labels: [], milestone: nil, assignees: [], author: .init(id: "u", username: "u", name: "u", avatarUrl: nil),
            createdAt: "", updatedAt: "", closedAt: nil, webUrl: "", commentCount: 0,
            dueDate: nil, weight: 3)
        #expect(issue.weight == 3)
        #expect(issue.bumping(commentCount: 1).weight == 3)
    }
}
```

> If `AppConfig.makeForTesting()` does not exist, replace with the existing test-config constructor used elsewhere in `LlmIdeMacTests` (grep `AppConfig(` in `mac/Tests/`); if there is none, use `AppConfig.shared`. Match `RepoUser`'s real initializer signature (grep `struct RepoUser` in `RepoBackend.swift`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter RepoBackendCapabilityTests`
Expected: FAIL — `supportsWeight`/`usesScheduleOverlay` unknown members, `RepoIssue` has no `weight`, `RepoIssueFilter` has no `milestoneId`.

- [ ] **Step 3: Add the protocol flags**

In `RepoBackend.swift`, after the existing flag declarations (`var canCreateMergeRequests: Bool { get }`):

```swift
    /// True when issues carry a native numeric weight (GitLab). The unified
    /// views show a weight badge/editor only when this is true.
    var supportsWeight: Bool { get }

    /// True when issue start/due dates come from our `/kb/issue-schedule`
    /// overlay instead of native fields (GitHub). When false, the views read
    /// and write native `dueDate`/milestone dates (GitLab).
    var usesScheduleOverlay: Bool { get }
```

- [ ] **Step 4: Add `weight` to `RepoIssue` and `milestoneId` to `RepoIssueFilter`**

In `RepoBackend.swift`, add to `RepoIssue` after `let dueDate: String?`:

```swift
    /// GitLab native issue weight; nil on GitHub (which has no weight).
    let weight: Int?
```

Update `bumping(commentCount:)` to thread `weight` through the re-init (add `weight: weight` as the final argument).

In `RepoIssueFilter`, add:

```swift
    /// Provider-neutral milestone id to filter by; nil = any milestone.
    var milestoneId: String?
```

- [ ] **Step 5: Set the flag values on both clients**

In `GitLabClient+RepoBackend.swift`, alongside the existing flags:

```swift
    var supportsWeight: Bool { true }
    var usesScheduleOverlay: Bool { false }
```

In `GitHubClient+RepoBackend.swift`, alongside the existing flags:

```swift
    var supportsWeight: Bool { false }
    var usesScheduleOverlay: Bool { true }
```

- [ ] **Step 6: Map `weight` in the adapters**

In `GitLabModels+Repo.swift`, in the GitLab issue wire's `asRepoIssue(...)`, pass the wire's `weight` (the GitLab issue JSON has a `weight` field; add `let weight: Int?` to the wire's `Decodable` struct + `CodingKeys` if absent) as `weight: weight`.

In `GitHubClient+RepoBackend.swift` (`GitHubIssueWire.asRepoIssue`, ~line 278), pass `weight: nil`.

> Both `asRepoIssue` constructors must now include `weight:` — the compiler will flag any call site you miss.

- [ ] **Step 7: Run tests + build to verify green**

Run: `cd mac && swift test --filter RepoBackendCapabilityTests && swift build`
Expected: PASS, build succeeds (fix any other `RepoIssue(...)` call sites the compiler flags by adding `weight: nil`).

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/Repo mac/Tests/LlmIdeMacTests/RepoBackendCapabilityTests.swift
git commit -m "feat(repo): add supportsWeight/usesScheduleOverlay flags + RepoIssue.weight + filter.milestoneId"
```

---

### Task 2: Fold GitLab affordances into the unified Issues views

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Issues/RepoIssuesView.swift` (milestone filter; default backend)
- Modify: `mac/Sources/LlmIdeMac/Views/Issues/RepoKanbanPanel.swift` (weight badge on cards)
- Modify: `mac/Sources/LlmIdeMac/Views/Issues/RepoIssueDetailSheet.swift` (weight editor, native due-date editor, MR-creation UI)
- Reference (port FROM, do not modify): `Issues/IssueBoardView.swift`, `Issues/IssueDetailPanel.swift`, `Issues/IssueKanbanPanel.swift`

**Interfaces:**
- Consumes: `currentClient.supportsWeight`, `currentClient.usesScheduleOverlay`, `currentClient.canCreateMergeRequests`, `RepoIssue.weight`, `RepoIssueFilter.milestoneId`, `currentClient.listMilestones(projectId:)`, `currentClient.updateIssue(projectId:number:payload:)`, `currentClient.createBranch(...)`, `currentClient.createMergeRequest(...)`.
- Produces: a single Issues view that renders identically-structured UI for both providers, with weight/MR/native-date affordances shown per capability flag.

- [ ] **Step 1: Add milestone state + load to `RepoIssuesView`**

Add `@State private var milestones: [RepoMilestone] = []`. In the issues load path (where `reloadIssues()` / project load runs), fetch `milestones = (try? await currentClient.listMilestones(projectId: project.id)) ?? []`. Add `.onChange(of: filter.milestoneId) { _, _ in Task { await reloadIssues() } }` next to the existing `filter.labelName` onChange (line ~72). In `reloadIssues()`, pass `filter` (which now carries `milestoneId`) to `listIssues` as today — confirm `RepoIssueFilter.milestoneId` is honored by each adapter's `listIssues` query (GitLab: `milestone` param; GitHub: `milestone` param). If an adapter ignores it, add the query param there.

- [ ] **Step 2: Add the milestone filter control to the filter bar**

In `RepoIssuesView`'s filter bar (near the existing label filter, ~line 198–250), add a milestone menu mirroring the label menu: an "Any milestone" entry plus one per `milestones`, toggling `filter.milestoneId`. Replicate the visual treatment of the label menu already present so the two read consistently. Both providers show it (both have milestones).

- [ ] **Step 3: Add the weight badge to `RepoKanbanPanel` cards, gated**

In the issue-card view of `RepoKanbanPanel.swift`, after the labels/title, add (replicating the badge styling from `IssueKanbanPanel.swift`'s weight chip):

```swift
if let w = issue.weight {   // only populated when supportsWeight (GitLab)
    HStack(spacing: 3) {
        Image(systemName: "scalemass").font(.system(size: 9, weight: .semibold))
        Text("\(w)").font(.system(size: 10, weight: .semibold))
    }
    .padding(.horizontal, 5).padding(.vertical, 1)
    .background(Capsule().fill(theme.current.surface2))
    .foregroundStyle(theme.current.textMuted)
}
```

(GitHub issues have `weight == nil`, so the badge is naturally absent — no flag check needed at the card level.)

- [ ] **Step 4: Add weight + native due-date editors to `RepoIssueDetailSheet`, gated**

In `RepoIssueDetailSheet.swift`, add an edit section (port the controls from `IssueDetailPanel.swift`):
- Weight stepper/field shown only `if currentClient.supportsWeight` (or `if let _ = issue.weight`), saved via `currentClient.updateIssue(projectId:number:payload:)` with `RepoIssuePayload(weight:)`. (Add `weight: Int?` to `RepoIssuePayload` if absent — grep `struct RepoIssuePayload`; if added, also map it in both adapters' update body builders: GitLab sends `weight`, GitHub omits it.)
- Due-date control: when `!currentClient.usesScheduleOverlay` (GitLab), a `DatePicker` that saves native `dueDate` via `updateIssue`; when `usesScheduleOverlay` (GitHub), reuse the existing schedule-overlay editor entry point (`IssueScheduleEditorSheet`) instead.

- [ ] **Step 5: Add MR-creation UI to the detail sheet, gated**

`if currentClient.canCreateMergeRequests`, surface the "Create branch / open MR" affordance (port from `IssueBoardView`/`IssueDetailPanel`'s MR action), calling `currentClient.createBranch(...)` then `currentClient.createMergeRequest(...)`. Dedup against `listOpenMergeRequests` exactly as the legacy view does.

- [ ] **Step 6: Build + behavioral verification**

Run: `cd mac && swift build`
Expected: build succeeds.
Then (manual, both providers configured) verify in the running app via `Scripts/build.sh` + open: GitLab Issues shows weight badges, milestone filter, weight editor, native due-date editor, and the MR action; GitHub Issues shows the milestone filter and (no weight badges), with the schedule-overlay editor for dates. (UI wiring is not unit-testable; `swift build` + this check is the gate.)

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Issues
git commit -m "feat(issues): fold GitLab weight/milestone/native-date/MR affordances into unified Repo issue views (flag-gated)"
```

---

### Task 3: Add the GitLab native-date branch to the unified Gantt

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Gantt/RepoGanttView.swift`
- Reference (port FROM): `Gantt/GanttView.swift`

**Interfaces:**
- Consumes: `currentClient.usesScheduleOverlay`, `RepoIssue.dueDate`, `RepoMilestone.startDate`/`dueDate`, `currentClient.updateIssue(...)`.
- Produces: a Gantt that draws bars from the overlay (GitHub) or native dates (GitLab) under one code path.

- [ ] **Step 1: Replace the hardcoded provider check with the capability flag**

In `RepoGanttView.swift` line ~46, change:

```swift
private var overlayEnabled: Bool { activeBackend == .github }
```
to:
```swift
private var overlayEnabled: Bool { currentClient.usesScheduleOverlay }
```

- [ ] **Step 2: Build the scheduled-rows set from native dates when overlay is off**

In `scheduledIssues` / `scheduledIds` construction (~lines 273, 327), branch on `overlayEnabled`:
- `overlayEnabled` (GitHub): keep today's behavior — rows come from `schedules` (issues whose overlay has a start or due).
- `!overlayEnabled` (GitLab): build rows from issues whose **native `dueDate` is non-nil**; bar start = `parseDate(issue.dueDate)` minus a default span (mirror the milestone fallback: `dueDate?.addingTimeInterval(-7*86_400)`), bar end = `parseDate(issue.dueDate)`. Reuse the existing `parseDate`/`prettyDate` helpers.

Concretely, factor the per-issue (start,due) resolution into one function:

```swift
private func issueDates(_ issue: RepoIssue) -> (start: Date, due: Date)? {
    if overlayEnabled {
        guard let s = schedules[issue.number], hasSchedule(s) else { return nil }
        let due = parseDate(s.dueDate ?? "")
        let start = parseDate(s.startDate ?? "") ?? due?.addingTimeInterval(-7 * 86_400)
        guard let start, let due else { return nil }
        return (start, due)
    } else {
        guard let due = parseDate(issue.dueDate ?? "") else { return nil }
        return (due.addingTimeInterval(-7 * 86_400), due)
    }
}
```

Use `issueDates(issue)` everywhere the row currently reads the overlay schedule.

- [ ] **Step 3: Guard the overlay-only load + tap behavior**

The schedules fetch (~line 490, `if overlayEnabled { schedules = … }`) already keys off `overlayEnabled` — confirm it now correctly skips for GitLab. For the bar-tap handler (line ~106: `if overlayEnabled { schedulingIssue = issue } else { detailIssue = issue }`), keep: GitHub opens the schedule editor; GitLab opens the detail sheet (where Task 2 added native due-date editing). No change needed beyond the flag now being capability-driven.

- [ ] **Step 4: Build + behavioral verification**

Run: `cd mac && swift build`
Expected: build succeeds.
Manual (both providers): GitLab Gantt draws bars from native due dates and milestone start→due, tapping a bar opens the detail sheet; GitHub Gantt still draws from the overlay and tapping opens the schedule editor.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Gantt/RepoGanttView.swift
git commit -m "feat(gantt): drive RepoGanttView dates from usesScheduleOverlay flag (native dates for GitLab)"
```

---

### Task 4: Flip `AppShell` routing to always-unified

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift` (`issuesRoute`, `ganttRoute`)
- Modify: `mac/Sources/LlmIdeMac/Views/Issues/RepoIssuesView.swift` + `mac/Sources/LlmIdeMac/Views/Gantt/RepoGanttView.swift` (provider-neutral default backend + empty state)

**Interfaces:**
- Consumes: `RepoIssuesView`, `RepoGanttView`, `availableBackends`.
- Produces: both providers reach the unified views; legacy views are now unreferenced (enabling Task 5).

- [ ] **Step 1: Default `activeBackend` to a configured provider**

In both `RepoIssuesView` and `RepoGanttView`, the initial `@State private var activeBackend` is hardcoded (`.gitlab` and `.github` respectively). Replace the hardcoded default by initializing from config in `.task`/`onAppear`: set `activeBackend` to the first of `availableBackends` (GitLab if a GitLab token exists, else GitHub) when the view first appears and the current value isn't available. This makes the view correct regardless of which single provider is configured.

- [ ] **Step 2: Provider-neutral empty state**

Where each unified view shows a "not connected" state, word it for either provider ("Add a GitLab or GitHub token in Settings") and show it only when `availableBackends.isEmpty`.

- [ ] **Step 3: Route both providers to the unified views**

In `AppShell.swift`, change `issuesRoute`:

```swift
private var issuesRoute: some View {
    VStack(spacing: 0) {
        repoProviderSwitch()
        RepoIssuesView()
    }
}
```

and `ganttRoute`:

```swift
private var ganttRoute: some View {
    VStack(spacing: 0) {
        repoProviderSwitch()
        RepoGanttView(api: api)
    }
}
```

(Remove the `switch effectiveRepoProvider { case .github …; default: <legacy> }` arms entirely.)

- [ ] **Step 4: Build + behavioral verification**

Run: `cd mac && swift build`
Expected: build succeeds (legacy views still compile, just unreferenced).
Manual: with only GitLab configured, the Issues and Gantt tabs render the unified views with full GitLab affordances; with only GitHub, the unified views with the overlay; with both, the provider switch toggles between them.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/AppShell.swift mac/Sources/LlmIdeMac/Views/Issues/RepoIssuesView.swift mac/Sources/LlmIdeMac/Views/Gantt/RepoGanttView.swift
git commit -m "feat(shell): route both providers through the unified Repo issue/gantt views"
```

---

### Task 5: Delete the legacy GitLab-only views

**Files:**
- Delete: `Issues/IssueBoardView.swift`, `Issues/IssueKanbanPanel.swift`, `Issues/IssueDetailPanel.swift`, `Issues/IssueCreateSheet.swift`, `Gantt/GanttContainerView.swift`, `Gantt/GanttView.swift`
- Conditionally delete: `Gantt/GanttFilterBar.swift` (only if unreferenced)

**Interfaces:**
- Consumes: nothing. Produces: a single shared view family.

- [ ] **Step 1: Audit each legacy view against its unified replacement**

For each file to delete, open it and confirm every user-facing affordance it provided now exists in the unified views (Tasks 2–3). Note any gap; if found, STOP and add it to the unified view before deleting.

- [ ] **Step 2: Grep for remaining references**

Run, for each symbol:
```bash
cd mac && grep -rn "IssueBoardView\|IssueKanbanPanel\|IssueDetailPanel\|IssueCreateSheet\|GanttContainerView\|GanttView\b\|GanttFilterBar" Sources Tests
```
Expected: only the files themselves (and `GanttView` may match `RepoGanttView`/`GanttZoom` — inspect each hit). Anything else must be rewired first. Check `GanttFilterBar` usage specifically: if `RepoGanttView` uses it, keep it.

- [ ] **Step 3: Delete the unreferenced files**

```bash
cd mac && git rm Sources/LlmIdeMac/Views/Issues/IssueBoardView.swift \
  Sources/LlmIdeMac/Views/Issues/IssueKanbanPanel.swift \
  Sources/LlmIdeMac/Views/Issues/IssueDetailPanel.swift \
  Sources/LlmIdeMac/Views/Issues/IssueCreateSheet.swift \
  Sources/LlmIdeMac/Views/Gantt/GanttContainerView.swift \
  Sources/LlmIdeMac/Views/Gantt/GanttView.swift
# Only if Step 2 showed GanttFilterBar is unreferenced:
# git rm Sources/LlmIdeMac/Views/Gantt/GanttFilterBar.swift
```

- [ ] **Step 4: Build + full test suite**

Run: `cd mac && swift build && swift test`
Expected: build succeeds, all tests pass. Fix any dangling reference the compiler surfaces.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(views): delete legacy GitLab-only issue/gantt views (unified path now serves both)"
```

---

## Self-Review

**Spec coverage:** §1 flags → Task 1. §2 model `weight` → Task 1. §3 unified Issues (milestone filter, weight, due-date branch, MR UI) → Task 2. §4 unified Gantt (native-date branch) → Task 3. §5 routing → Task 4. §6 deletions → Task 5. §7 testing → Task 1 unit tests + per-task build/behavioral gates. §8 migration order → task ordering 1→5. All covered.

**Placeholder scan:** No "TBD"/"handle edge cases". The two "if X doesn't exist, grep…" notes are explicit fallback instructions (test-config constructor, `RepoIssuePayload.weight`), not vague placeholders — they name the exact symbol and action.

**Type consistency:** `supportsWeight`/`usesScheduleOverlay` (Bool), `RepoIssue.weight: Int?`, `RepoIssueFilter.milestoneId: String?`, `issueDates(_:) -> (start: Date, due: Date)?`, `RepoIssuePayload.weight: Int?` used consistently across Tasks 1–4. `currentClient` is the `RepoBackend` accessor present in both unified views.

**Note on TDD:** Task 1 (model/flags/adapters) is the only fully unit-testable layer and is done test-first. Tasks 2–5 are SwiftUI view wiring and deletion, verified by `swift build` + explicit behavioral checks per the spec — this is honest for the surface and matches the codebase's existing test boundary (logic/adapters tested; SwiftUI views not).
