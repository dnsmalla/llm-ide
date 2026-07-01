# Issues List + Unified Gantt (GitLab-professional) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Issues kanban with a GitLab-classic row list, and re-type the rich Gantt view onto the provider-neutral `RepoBackend` so one code path serves both GitHub and GitLab; then delete the now-dead `RepoKanbanPanel` and `RepoGanttView`.

**Architecture:** View-layer only — no `RepoBackend` protocol or model changes. `RepoIssue`/`RepoMilestone`/`RepoLabel`/`RepoUser` already carry every field. Gantt date sourcing branches on the existing `usesScheduleOverlay` flag: GitLab reads native `dueDate`/milestone dates; GitHub reads the `/kb/issue-schedule` overlay (exactly as the deleted `RepoGanttView` did).

**Tech Stack:** Swift 6, SwiftUI, Swift Package Manager (`swift build` / `swift test` from `mac/`), Swift Testing (`import Testing`, `@Test`, `#expect`).

## Global Constraints

- Build + test from `mac/`: `swift build`, `swift test`. Both must stay green.
- If `swift build`/`swift test` fails with a `sandbox_apply` error, that is a nested-sandbox artifact of the tooling, NOT a real failure — rerun with the sandbox disabled.
- Colors: use `theme.current.<token>` only — never literal hex or system colors (`.green`/`.red`). Tokens: `body, surface, surface2, border, text, textMuted, accent, accent2, accent3, accent4, danger, rowAlt, gridLine`; aliases `success, warning, info`.
- Spacing/Radius/Typography: use the `Spacing` / `Radius` / `Typography` tokens (e.g. `Spacing.sm`, `Typography.body`), not magic numbers, where an existing token fits.
- `RepoUser.id` is a `String`; `UserAvatar`'s primary init wants an `Int` seed — pass `abs(u.id.hashValue)` (the pattern `RepoKanbanPanel` uses at `RepoKanbanPanel.swift:193`).
- `RepoIssue.state` is `"opened"`/`"closed"` (not `"open"`). `isOpen` == `state == "opened"`.
- Commit after each task with a `feat(mac):` / `refactor(mac):` / `test(mac):` message. Do not push (the operator pushes).

---

## File Structure

- **Reuse** `mac/Sources/LlmIdeMac/Views/Components/LabelChip.swift` — already a standalone component (`LabelChip(name:color:small:)`); survives `RepoKanbanPanel`'s deletion, no extraction needed.
- **Create** `mac/Sources/LlmIdeMac/Views/Issues/RepoIssueListView.swift` — the GitLab-classic issue row list (replaces `RepoKanbanPanel`).
- **Create** `mac/Tests/LlmIdeMacTests/RepoIssueListViewTests.swift` — row-composition unit tests.
- **Create** `mac/Tests/LlmIdeMacTests/GanttViewModelTests.swift` — date-sourcing (native vs overlay) unit tests.
- **Modify** `mac/Sources/LlmIdeMac/Views/Issues/RepoIssuesView.swift` — swap `RepoKanbanPanel` call site for `RepoIssueListView`.
- **Delete** `mac/Sources/LlmIdeMac/Views/Issues/RepoKanbanPanel.swift` — no call sites after Task 2.
- **Modify** `mac/Sources/LlmIdeMac/ViewModels/GanttViewModel.swift` — retype `GitLab*` → `Repo*` + `RepoBackend`; add overlay date sourcing.
- **Modify** `mac/Sources/LlmIdeMac/Views/Gantt/GanttView.swift` — retype params; then visual polish (Task 4).
- **Modify** `mac/Sources/LlmIdeMac/Views/Gantt/GanttContainerView.swift` — `RepoProject`-based project load; accept `api`.
- **Modify** `mac/Sources/LlmIdeMac/Views/AppShell.swift` — route both providers to `GanttContainerView`.
- **Delete** `mac/Sources/LlmIdeMac/Views/Gantt/RepoGanttView.swift` — no call sites after Task 3.
- **Keep** `mac/Sources/LlmIdeMac/Views/Gantt/IssueScheduleEditorSheet.swift` and `LlmIdeAPIClient+IssueSchedule.swift` — still used for GitHub overlay date editing.
- **Modify** `mac/Tests/LlmIdeMacTests/RepoBackendCapabilityTests.swift` — add flag-consumption assertions.

---

## Task 1: RepoIssueListView (GitLab-classic row list)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Issues/RepoIssueListView.swift`
- Test: `mac/Tests/LlmIdeMacTests/RepoIssueListViewTests.swift`

**Interfaces:**
- Consumes: `RepoIssue`, `RepoLabel`, `RepoBackend`, `RepoBackendKind` (existing); `UserAvatar(name:id:avatarUrl:size:)`, `LabelChip(name:color:small:)` (existing standalone component in `Views/Components/LabelChip.swift`), `ThemeStore`, `Typography`, `Spacing`, `Radius`.
- Produces: `struct RepoIssueListView: View` with stored props identical to `RepoKanbanPanel`'s so it is a drop-in replacement:
  ```swift
  let issues: [RepoIssue]
  let labels: [RepoLabel]
  let backend: RepoBackendKind
  let client: RepoBackend
  let projectId: String
  let onSelect: (RepoIssue) -> Void
  let onIssueUpdate: (RepoIssue) -> Void
  ```
  Plus a pure static helper used by tests:
  ```swift
  static func metaLine(for issue: RepoIssue, now: Date) -> String
  static func assigneeOverflow(_ assignees: [RepoUser]) -> (shown: RepoUser?, extra: Int)
  ```

- [ ] **Step 1: Write the failing test for the row helpers**

```swift
// mac/Tests/LlmIdeMacTests/RepoIssueListViewTests.swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
struct RepoIssueListViewTests {
    static func issue(
        number: Int = 1, title: String = "T", state: String = "opened",
        labels: [String] = [], milestone: RepoMilestone? = nil,
        assignees: [RepoUser] = [], commentCount: Int = 0,
        createdAt: String = "2026-07-01T00:00:00Z", weight: Int? = nil
    ) -> RepoIssue {
        RepoIssue(id: "i\(number)", number: number, title: title, body: nil,
                  state: state, labels: labels, milestone: milestone,
                  assignees: assignees, author: .ghost, createdAt: createdAt,
                  updatedAt: createdAt, closedAt: nil, webUrl: "", commentCount: commentCount,
                  dueDate: nil, weight: weight)
    }
    static let u1 = RepoUser(id: "1", username: "a", displayName: "Alice", avatarUrl: nil)
    static let u2 = RepoUser(id: "2", username: "b", displayName: "Bob", avatarUrl: nil)

    @Test func metaLineShowsNumberAndRelativeAgeAndMilestone() {
        let ms = RepoMilestone(id: "m1", title: "v1.2", state: "active", dueDate: nil, startDate: nil, description: nil)
        let now = ISO8601DateFormatter().date(from: "2026-07-04T00:00:00Z")!
        let line = RepoIssueListView.metaLine(for: issue(number: 7, milestone: ms), now: now)
        #expect(line.contains("#7"))
        #expect(line.contains("3d"))          // opened 3 days before `now`
        #expect(line.contains("v1.2"))        // milestone name included
    }

    @Test func metaLineOmitsMilestoneWhenAbsent() {
        let now = ISO8601DateFormatter().date(from: "2026-07-02T00:00:00Z")!
        let line = RepoIssueListView.metaLine(for: issue(number: 9, milestone: nil), now: now)
        #expect(line.contains("#9"))
        #expect(!line.contains("·  ·"))       // no empty milestone segment
    }

    @Test func assigneeOverflowShowsFirstAndCountsExtra() {
        let none = RepoIssueListView.assigneeOverflow([])
        #expect(none.shown == nil && none.extra == 0)
        let one = RepoIssueListView.assigneeOverflow([u1])
        #expect(one.shown?.id == "1" && one.extra == 0)
        let many = RepoIssueListView.assigneeOverflow([u1, u2])
        #expect(many.shown?.id == "1" && many.extra == 1)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mac && swift test --filter RepoIssueListViewTests`
Expected: FAIL — `RepoIssueListView` type does not exist / no `metaLine` member.

- [ ] **Step 3: Implement `RepoIssueListView`**

```swift
// mac/Sources/LlmIdeMac/Views/Issues/RepoIssueListView.swift
import SwiftUI

/// GitLab-classic issue list: one two-line row per issue. Drop-in replacement
/// for RepoKanbanPanel (same stored props + callbacks); no drag-to-recolumn —
/// GitLab's Issues page is a list, and status changes happen in the detail sheet.
struct RepoIssueListView: View {
    @EnvironmentObject var theme: ThemeStore

    let issues: [RepoIssue]
    let labels: [RepoLabel]
    let backend: RepoBackendKind
    let client: RepoBackend
    let projectId: String
    let onSelect: (RepoIssue) -> Void
    let onIssueUpdate: (RepoIssue) -> Void

    // Label color lookup by name (issues carry label names; RepoLabel carries color).
    private func color(for labelName: String) -> String {
        labels.first(where: { $0.name == labelName })?.color ?? "#8b93a5"
    }

    var body: some View {
        let t = theme.current
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(Array(issues.enumerated()), id: \.element.id) { idx, issue in
                    row(issue, zebra: idx % 2 == 1, t: t)
                        .contentShape(Rectangle())
                        .onTapGesture { onSelect(issue) }
                    Divider().background(t.border.opacity(0.5))
                }
            }
        }
        .background(t.body)
    }

    @ViewBuilder
    private func row(_ issue: RepoIssue, zebra: Bool, t: Theme) -> some View {
        let overflow = Self.assigneeOverflow(issue.assignees)
        HStack(alignment: .top, spacing: Spacing.sm) {
            Circle()
                .fill(issue.isOpen ? t.success : t.textMuted)
                .frame(width: 9, height: 9)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(issue.title).font(Typography.bodyStrong).foregroundStyle(t.text)
                        .lineLimit(1)
                    ForEach(issue.labels.prefix(4), id: \.self) { name in
                        LabelChip(name: name, color: color(for: name), small: true)
                    }
                    if client.supportsWeight, let w = issue.weight {
                        Text("\(w)").font(Typography.mono)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 4).fill(t.surface2))
                            .foregroundStyle(t.textMuted)
                    }
                }
                Text(Self.metaLine(for: issue, now: Date()))
                    .font(Typography.caption).foregroundStyle(t.textMuted).lineLimit(1)
            }
            Spacer(minLength: Spacing.sm)
            if issue.commentCount > 0 {
                HStack(spacing: 3) {
                    Image(systemName: "bubble.right").font(.system(size: 10))
                    Text("\(issue.commentCount)").font(Typography.caption)
                }.foregroundStyle(t.textMuted)
            }
            if let shown = overflow.shown {
                UserAvatar(name: shown.displayName, id: abs(shown.id.hashValue),
                           avatarUrl: shown.avatarUrl, size: 22)
            }
            if overflow.extra > 0 {
                Text("+\(overflow.extra)").font(Typography.caption).foregroundStyle(t.textMuted)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
        .background(zebra ? t.rowAlt : Color.clear)
    }

    /// `#N · opened Nd ago[ · milestone]`. Milestone segment omitted when absent.
    static func metaLine(for issue: RepoIssue, now: Date) -> String {
        var parts = ["#\(issue.number)"]
        if let created = ISO8601DateFormatter().date(from: issue.createdAt) {
            let days = max(0, Int(now.timeIntervalSince(created) / 86_400))
            parts.append(days == 0 ? "opened today" : "opened \(days)d ago")
        }
        if let ms = issue.milestone { parts.append(ms.title) }
        return parts.joined(separator: " · ")
    }

    /// First assignee to show as an avatar, plus how many more are hidden.
    static func assigneeOverflow(_ assignees: [RepoUser]) -> (shown: RepoUser?, extra: Int) {
        (assignees.first, max(0, assignees.count - 1))
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mac && swift test --filter RepoIssueListViewTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Issues/RepoIssueListView.swift mac/Tests/LlmIdeMacTests/RepoIssueListViewTests.swift
git commit -m "feat(mac): GitLab-classic RepoIssueListView with row-composition tests"
```

---

## Task 2: Wire RepoIssueListView into RepoIssuesView; delete RepoKanbanPanel

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Issues/RepoIssuesView.swift:479-500`
- Delete: `mac/Sources/LlmIdeMac/Views/Issues/RepoKanbanPanel.swift`

**Interfaces:**
- Consumes: `RepoIssueListView` (Task 1).

- [ ] **Step 1: Swap the call site**

In `RepoIssuesView.swift`, the `issuesList` computed view instantiates `RepoKanbanPanel(...)` (around L479). Replace `RepoKanbanPanel(` with `RepoIssueListView(` — the parameter list is identical (`issues:`, `labels:`, `backend:`, `client:`, `projectId:`, `onSelect:`, `onIssueUpdate:`), so only the type name changes. Leave the `onIssueUpdate` closure body (the filter-fit drop test) unchanged.

- [ ] **Step 2: Delete RepoKanbanPanel**

```bash
git rm mac/Sources/LlmIdeMac/Views/Issues/RepoKanbanPanel.swift
```

- [ ] **Step 3: Build and run the full test suite**

Run: `cd mac && swift build && swift test`
Expected: builds with no reference to `RepoKanbanPanel`; all tests pass (RepoIssueListViewTests included). `LabelChip` is a standalone component (`Views/Components/LabelChip.swift`), so deleting `RepoKanbanPanel` leaves it intact.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(mac): Issues use RepoIssueListView; remove RepoKanbanPanel"
```

---

## Task 3: Retype the Gantt onto RepoBackend (both providers), delete RepoGanttView

This is one task because Swift compilation couples the ViewModel, View, Container, and AppShell — none compiles until all are retyped. Visual polish is deferred to Task 4 so this task's deliverable is "Gantt works for both providers" (structurally unchanged look).

**Files:**
- Modify: `mac/Sources/LlmIdeMac/ViewModels/GanttViewModel.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Gantt/GanttView.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Gantt/GanttContainerView.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift:507-516`
- Delete: `mac/Sources/LlmIdeMac/Views/Gantt/RepoGanttView.swift`
- Test: `mac/Tests/LlmIdeMacTests/GanttViewModelTests.swift`

**Interfaces:**
- Consumes: `RepoBackend`, `RepoProject`, `RepoIssue`, `RepoMilestone`, `RepoUser`, `LlmIdeAPIClient.listIssueSchedules(provider:repo:)`, `IssueSchedule` (fields: `issueNumber:Int, startDate:String?, dueDate:String?, estimateDays:Double?`).
- Produces: `GanttViewModel.load(backend: RepoBackend, project: RepoProject, api: LlmIdeAPIClient?)`; `GanttViewModel.issues: [RepoIssue]`; `GanttViewModel.startDate(for: RepoIssue) -> Date`; `GanttViewModel.endDate(for: RepoIssue) -> Date?`; `GanttViewModel.hasUsefulDates(_ issue: RepoIssue) -> Bool`. `GanttView(vm:backend:project:projects:onProjectChange:)`. `GanttContainerView(api: LlmIdeAPIClient?)`.

- [ ] **Step 1: Write the failing ViewModel date-sourcing tests**

```swift
// mac/Tests/LlmIdeMacTests/GanttViewModelTests.swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
struct GanttViewModelTests {
    static func issue(number: Int, dueDate: String? = nil,
                      milestoneDue: String? = nil, milestoneStart: String? = nil,
                      createdAt: String = "2026-06-01T00:00:00Z") -> RepoIssue {
        let ms: RepoMilestone? = (milestoneDue != nil || milestoneStart != nil)
            ? RepoMilestone(id: "m", title: "M", state: "active",
                            dueDate: milestoneDue, startDate: milestoneStart, description: nil)
            : nil
        return RepoIssue(id: "i\(number)", number: number, title: "T", body: nil,
                         state: "opened", labels: [], milestone: ms, assignees: [], author: .ghost,
                         createdAt: createdAt, updatedAt: createdAt, closedAt: nil, webUrl: "",
                         commentCount: 0, dueDate: dueDate, weight: nil)
    }

    // GitLab path: native dueDate drives the bar end; start backs off ~7 days.
    @Test func nativeDatesEndAtDueDate() {
        let vm = GanttViewModel()
        vm.applyIssues([Self.issue(number: 1, dueDate: "2026-07-10")], schedules: [:])
        let i = vm.issues[0]
        let end = vm.endDate(for: i)!
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"; fmt.timeZone = TimeZone(identifier: "UTC")
        #expect(fmt.string(from: end) == "2026-07-10")
        #expect(vm.hasUsefulDates(i))
    }

    // GitHub overlay path: no native dueDate, but an overlay schedule supplies it.
    @Test func overlayScheduleSuppliesDatesWhenNativeMissing() {
        let vm = GanttViewModel()
        let sched = IssueSchedule(provider: "github", repo: "o/r", issueNumber: 2,
                                  startDate: "2026-07-01", dueDate: "2026-07-08",
                                  estimateDays: nil, dependsOn: [], updatedAt: nil)
        vm.applyIssues([Self.issue(number: 2, dueDate: nil)], schedules: [2: sched])
        let i = vm.issues[0]
        #expect(vm.hasUsefulDates(i))
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"; fmt.timeZone = TimeZone(identifier: "UTC")
        #expect(fmt.string(from: vm.startDate(for: i)) == "2026-07-01")
        #expect(fmt.string(from: vm.endDate(for: i)!) == "2026-07-08")
    }

    // No native date and no overlay → not useful (hidden when hideBlankRows on).
    @Test func noDatesNoOverlayIsNotUseful() {
        let vm = GanttViewModel()
        vm.applyIssues([Self.issue(number: 3, dueDate: nil)], schedules: [:])
        #expect(!vm.hasUsefulDates(vm.issues[0]))
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mac && swift test --filter GanttViewModelTests`
Expected: FAIL — `applyIssues` / new `IssueSchedule`-based signatures don't exist; `issues` is still `[GitLabIssue]`.

- [ ] **Step 3: Retype `GanttViewModel` symbols GitLab → Repo**

Apply these exact substitutions in `GanttViewModel.swift` (per the grounding map):
- `@Published var issues: [GitLabIssue]` → `[RepoIssue]`; `milestones: [GitLabMilestone]` → `[RepoMilestone]`; `members: [GitLabUser]` → `[RepoUser]`.
- `selectedMilestoneIds: Set<Int>` → `Set<String>`; `selectedAssigneeIds: Set<Int>` → `Set<String>`.
- `startDate(for issue: GitLabIssue)` → `(for issue: RepoIssue)`; `endDate(for:)`, `hasUsefulDates(_:)`, `category(of:)`, `filteredIssues`, `preCategoryFiltered` → param/element type `RepoIssue`.
- Field renames inside those bodies: `issue.iid` → `issue.number`; `issue.milestone?.id` stays (now `String`); `issue.assignees.map { $0.id }` stays (now `String`); `GitLabUser.name` → `.displayName`. Milestone/assignee id comparisons now `String` vs `String`.
- `activeAssignees: [GitLabUser]` → `[RepoUser]`; `activeMilestones: [GitLabMilestone]` → `[RepoMilestone]`.

Add a stored overlay map and a pure apply seam the tests use:
```swift
/// Overlay schedules by issue number (GitHub). Empty for GitLab (native dates).
private(set) var schedules: [Int: IssueSchedule] = [:]

/// Test/`load` seam: set the issue set + overlay in one place so date logic
/// is unit-testable without a live backend.
func applyIssues(_ issues: [RepoIssue], schedules: [Int: IssueSchedule]) {
    self.schedules = schedules
    self.issues = issues
}
```

- [ ] **Step 4: Implement date sourcing that honors the overlay**

Replace the bodies of `startDate`/`endDate`/`hasUsefulDates` so they consult the overlay first (GitHub), then native fields (GitLab). Reuse the deleted `RepoGanttView`'s span math (`estimateDays ?? 7` days; `s = start ?? due-span`; `e = due ?? start+span`; GitLab native: `start = due - 7d`).

```swift
private static let sevenDays: TimeInterval = 7 * 86_400
private func ymd(_ s: String?) -> Date? {
    guard let s else { return nil }
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
    return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}

/// (start, end) for an issue, or nil when it has no usable dates.
private func span(for issue: RepoIssue) -> (Date, Date)? {
    if let sched = schedules[issue.number], sched.startDate != nil || sched.dueDate != nil {
        let width = (sched.estimateDays ?? 7) * 86_400
        let s0 = ymd(sched.startDate), d0 = ymd(sched.dueDate)
        let s = s0 ?? d0!.addingTimeInterval(-width)
        let e = d0 ?? s0!.addingTimeInterval(width)
        return (s, e)
    }
    // Native (GitLab): due from issue.dueDate or milestone.dueDate.
    if let due = ymd(issue.dueDate) ?? ymd(issue.milestone?.dueDate) {
        let s = ymd(issue.milestone?.startDate) ?? due.addingTimeInterval(-Self.sevenDays)
        return (s, due)
    }
    return nil
}

func hasUsefulDates(_ issue: RepoIssue) -> Bool { span(for: issue) != nil }
func startDate(for issue: RepoIssue) -> Date {
    span(for: issue)?.0 ?? ymd(issue.createdAt) ?? Date(timeIntervalSince1970: 0)
}
func endDate(for issue: RepoIssue) -> Date? { span(for: issue)?.1 }
```
(Replace the `Date()` fallback in the old `startDate` with `Date(timeIntervalSince1970: 0)` so an unparseable/undated issue is deterministic, not "today" — fixes the latent silent-today bug noted in a prior review.)

- [ ] **Step 5: Rewrite `load` to be backend-neutral + fetch the overlay**

```swift
func load(backend: RepoBackend, project: RepoProject, api: LlmIdeAPIClient?) async {
    isLoading = true; errorMessage = nil
    defer { isLoading = false }
    do {
        var all: [RepoIssue] = []; var seen = Set<String>()
        for page in 1...20 {
            // `.all` so the Gantt has both open + closed issues; the VM's own
            // stateFilter does the client-side narrowing (default "all").
            let batch = try await backend.listIssues(
                projectId: project.id, filter: RepoIssueFilter(state: .all), page: page)
            let fresh = batch.filter { seen.insert($0.id).inserted }
            if fresh.isEmpty { break }
            all.append(contentsOf: fresh)
        }
        let ms = (try? await backend.listMilestones(projectId: project.id)) ?? []
        let mem = (try? await backend.listMembers(projectId: project.id)) ?? []
        var sched: [Int: IssueSchedule] = [:]
        if backend.usesScheduleOverlay, let api {
            sched = (try? await api.listIssueSchedules(provider: "github", repo: project.fullName)) ?? [:]
        }
        self.milestones = ms; self.members = mem
        applyIssues(all, schedules: sched)
    } catch {
        errorMessage = error.localizedDescription
    }
}
```
(`isLoading` and `errorMessage` are the VM's existing `@Published` property names — confirmed. Keep the existing filter-state properties: `stateFilter: String`, `selectedMilestoneIds`, `selectedAssigneeIds`, `selectedLabels`, `rangeStart`.)

- [ ] **Step 6: Retype `GanttView` params**

In `GanttView.swift`: `let gitlab: GitLabClient` → `let backend: RepoBackend`; `let project: GitLabProject` → `let project: RepoProject`; `var projects: [GitLabProject]` → `[RepoProject]`; `var onProjectChange: (GitLabProject) -> Void` → `(RepoProject) -> Void`. Then:
- `body`: `vm.load(gitlab:projectId: project.id)` → `await vm.load(backend: backend, project: project, api: api)` — add `var api: LlmIdeAPIClient?` to `GanttView` and pass it from the container. `project.id` is now `String` (no `"\(...)"` Int cast).
- `leftColumn(issues: [GitLabIssue])` / `issueRow(issue: GitLabIssue)` / `drawChart(issues: [GitLabIssue])` / `isOverdue(_: GitLabIssue)` → `RepoIssue`. Inside `issueRow`: `issue.iid` → `issue.number`; `UserAvatar(user: issue.author)` → `UserAvatar(name: issue.author.displayName, id: abs(issue.author.id.hashValue), avatarUrl: issue.author.avatarUrl, size: 20)`.
- `milestoneMarkers` keyed on `ms.id` — now `String`; update any `Int` typing.

- [ ] **Step 7: Retype `GanttContainerView` to load projects via the backend**

Rewrite `GanttContainerView` to mirror `RepoIssuesView`'s provider/project handling:
```swift
struct GanttContainerView: View {
    var api: LlmIdeAPIClient? = nil
    @EnvironmentObject var config: AppConfig
    @StateObject private var vm = GanttViewModel()
    @State private var activeBackend: RepoBackendKind = .gitlab
    @State private var projects: [RepoProject] = []
    @State private var selectedProject: RepoProject?
    @State private var loading = false
    @State private var loadError: String?

    private var availableBackends: [RepoBackendKind] {
        var out: [RepoBackendKind] = []
        if !config.gitLabToken.isEmpty { out.append(.gitlab) }
        if !config.gitHubToken.isEmpty { out.append(.github) }
        return out
    }
    private var currentClient: RepoBackend {
        switch activeBackend {
        case .gitlab: return GitLabClient(config: config)
        case .github: return GitHubClient(config: config)
        }
    }
    // body: pick default backend (github if only github), loadProjects() via
    // currentClient.listProjects() sorted by fullName, selectedProject = first;
    // then GanttView(vm: vm, backend: currentClient, project: sel, projects: projects,
    //                 onProjectChange: { selectedProject = $0 }) with `api` passed in.
}
```
Model `loadProjects()` exactly on `RepoIssuesView.loadProjects` (`RepoIssuesView.swift:522-538`): `let fetched = try await currentClient.listProjects(); projects = fetched.sorted { $0.fullName.localizedCaseInsensitiveCompare($1.fullName) == .orderedAscending }; if selectedProject == nil { selectedProject = projects.first }`. Show `EmptyStateView` when `availableBackends.isEmpty`.

- [ ] **Step 8: Route both providers through GanttContainerView in AppShell**

In `AppShell.swift` `ganttRoute` (L507-516), replace the `switch effectiveRepoProvider { case .github where hasGitHub: RepoGanttView(api: api); default: GanttContainerView() }` with a single:
```swift
GanttContainerView(api: api)
```
Keep the `repoProviderSwitch()` above it (unchanged).

- [ ] **Step 9: Delete RepoGanttView**

```bash
git rm mac/Sources/LlmIdeMac/Views/Gantt/RepoGanttView.swift
```
(Keep `IssueScheduleEditorSheet.swift` and `LlmIdeAPIClient+IssueSchedule.swift`.)

- [ ] **Step 10: Build + run ViewModel tests + full suite**

Run: `cd mac && swift build && swift test`
Expected: builds with no `GitLab*` types in the Gantt files and no `RepoGanttView` references; `GanttViewModelTests` (3) pass; whole suite green.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(mac): unify Gantt onto RepoBackend (both providers); remove RepoGanttView"
```

---

## Task 4: Gantt visual polish (rounded bars, milestone diamonds, weekend + zebra)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Gantt/GanttView.swift` (`drawChart` and row background)

**Interfaces:**
- Consumes: `GanttViewModel` (Task 3); `Theme` tokens.

- [ ] **Step 1: Rounded pill bars with label-derived fill + shadow**

In `drawChart`, for each issue bar: replace the bar `Path`/`fill` with a rounded-capsule fill. Bar color = the first label's color if any (`labels.first(where: { $0.name == issue.labels.first })?.color`, parsed via the same hex parser `LabelChip` uses), else `t.accent`. Add a soft shadow: draw a 1px-offset darker capsule behind, or use `ctx.addFilter(.shadow(...))` before the bar fill. Corner radius = barHeight/2.

- [ ] **Step 2: Milestone diamond markers**

Where a bar's issue has `milestone?.dueDate` (or overlay dueDate), draw a small diamond (a 4-point `Path` rotated 45°, ~8pt) filled `t.warning` at the bar's end x-position, layered on top of the bar.

- [ ] **Step 3: Weekend column tint (day/week zoom only)**

In the timeline grid drawing, when `zoom == .day || zoom == .week`, fill Saturday/Sunday day-columns with `t.gridLine.opacity(0.35)`. Skip in `.month` zoom.

- [ ] **Step 4: Zebra row banding**

In the left column + chart row rendering, give alternate rows a `t.rowAlt` background (even rows clear, odd rows `t.rowAlt`), matching `RepoIssueListView`.

- [ ] **Step 5: Build + visually confirm compiles; run full suite**

Run: `cd mac && swift build && swift test`
Expected: green. (Visual correctness is confirmed in Task 6's manual run.)

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Gantt/GanttView.swift
git commit -m "feat(mac): Gantt visual polish — pill bars, milestone diamonds, weekend + zebra shading"
```

---

## Task 5: Capability-consumption tests + final verification

**Files:**
- Modify: `mac/Tests/LlmIdeMacTests/RepoBackendCapabilityTests.swift`

- [ ] **Step 1: Add flag-consumption assertions**

Append tests that pin the two behaviors the new views gate on, so a future flag flip is caught:
```swift
@Test func gitHubUsesScheduleOverlayGitLabDoesNot() {
    #expect(GitHubClient(config: cfg()).usesScheduleOverlay == true)
    #expect(GitLabClient(config: cfg()).usesScheduleOverlay == false)
}
@Test func gitLabSupportsWeightGitHubDoesNot() {
    #expect(GitLabClient(config: cfg()).supportsWeight == true)
    #expect(GitHubClient(config: cfg()).supportsWeight == false)
}
```
(Use the file's existing `cfg()` helper. If equivalent assertions already exist, extend rather than duplicate.)

- [ ] **Step 2: Run the full suite**

Run: `cd mac && swift test`
Expected: all green (RepoIssueListViewTests, GanttViewModelTests, RepoBackendCapabilityTests included).

- [ ] **Step 3: Build the release app and manually verify both providers**

Run: `cd mac && bash Scripts/build.sh && open mac/LlmIdeMac.app`
Then: open a GitLab project → Issues shows the row list; Gantt shows bars. Switch to a GitHub project → Issues shows the same row list; Gantt shows bars sourced from the schedule overlay. Confirm no "Gantt requires GitLab" empty-state remains for GitHub.

- [ ] **Step 4: Commit**

```bash
git add mac/Tests/LlmIdeMacTests/RepoBackendCapabilityTests.swift
git commit -m "test(mac): pin supportsWeight / usesScheduleOverlay consumption for Issues + Gantt"
```
