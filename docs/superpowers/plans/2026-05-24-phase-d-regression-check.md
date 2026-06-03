# Phase D — Regression Check on Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Re-run every `status: fixed` bug prompt against the agent and flag any whose current answer has drifted from the fix that was originally recorded. Triggered automatically when `appVersion` changes between launches, or manually from a new "Regression" sidebar entry.

**Architecture:** `RegressionRunner` is a `@MainActor ObservableObject` service that iterates `<repo>/graphify-out/memory/bugs/*.md`, filters to `status == .fixed`, sends each `prompt` through `api.codeAssist`, and computes a per-bug verdict via normalised-whitespace exact match against the answer the bug captured. Verdicts publish to the new `RegressionView`. Auto-trigger lives in `AppShell` on launch (compares `Bundle.main` short version to `config.lastSeenAppVersion`). A new sidebar section `regression` sits under **Explore** alongside Graphify.

**Tech Stack:** Swift 5.9 / SwiftUI / existing `MeetNotesAPIClient`.

**Spec:** [docs/superpowers/specs/2026-05-24-agent-memory-and-feedback-design.md §D](../specs/2026-05-24-agent-memory-and-feedback-design.md).

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `mac/Sources/MeetNotesMac/Services/RegressionRunner.swift` | Driver — iterates fixed bugs, invokes the agent, computes verdicts. Pure logic + state; no SwiftUI. |
| `mac/Sources/MeetNotesMac/Views/Regression/RegressionView.swift` | The list view + diff sheet. |
| `mac/Tests/MeetNotesMacTests/RegressionRunnerTests.swift` | Verdict-comparison logic + iteration over a fake prompter. |

**Modify:**

| Path | Why |
|---|---|
| `mac/Sources/MeetNotesMac/Services/ShellState.swift` | Add `.regression` case + label + icon + tint + userHideable entry. |
| `mac/Sources/MeetNotesMac/Views/Shell/SidebarView.swift` | Add `.regression` row under the **Explore** group (next to Graphify). |
| `mac/Sources/MeetNotesMac/Views/AppShell.swift` | Route `.regression` → `RegressionView`. Wire auto-trigger on launch. |
| `mac/Sources/MeetNotesMac/Models/Config.swift` | Add `lastSeenAppVersion: String` persisted to UserDefaults. |

---

## Task 1: `RegressionRunner` + verdict logic

**Files:**
- Create: `mac/Sources/MeetNotesMac/Services/RegressionRunner.swift`
- Create: `mac/Tests/MeetNotesMacTests/RegressionRunnerTests.swift`

- [ ] **Step 1: Write the tests**

```swift
// mac/Tests/MeetNotesMacTests/RegressionRunnerTests.swift
import Testing
import Foundation
@testable import MeetNotesMac

@MainActor
struct RegressionRunnerTests {
    /// Tiny stand-in for MeetNotesAPIClient so the runner can be
    /// tested without hitting the network. Keyed by prompt → reply.
    final class FakePrompter: RegressionPrompter {
        var replies: [String: String] = [:]
        var calls: [String] = []
        func ask(prompt: String) async throws -> String {
            calls.append(prompt)
            return replies[prompt] ?? ""
        }
    }

    private func tmpRepo() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("regression-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func writeBug(_ store: MemoryStore, at repo: URL,
                         prompt: String, response: String, status: BugStatus) throws -> URL {
        let bug = BugReport(
            prompt: prompt, response: response, notes: "",
            severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: nil, appVersion: "0.1", agent: "claude_code",
            status: status, tags: []
        )
        return try store.writeBug(at: repo, bug)
    }

    @Test func unchangedWhenAnswerMatchesAfterWhitespaceNormalisation() {
        let v = RegressionRunner.verdict(
            originalAnswer: "Auth uses JWT.\nRefresh with the /refresh endpoint.",
            currentAnswer: "Auth   uses JWT.  Refresh with the /refresh endpoint.  "
        )
        #expect(v == .unchanged)
    }

    @Test func regressedWhenAnswerDiffers() {
        let v = RegressionRunner.verdict(
            originalAnswer: "JWT with refresh",
            currentAnswer: "Cookies with sessions"
        )
        #expect(v == .regressed)
    }

    @Test func runIteratesOnlyFixedBugsAndPopulatesResults() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()

        _ = try writeBug(store, at: repo, prompt: "fixed-q",
                         response: "fixed-answer", status: .fixed)
        _ = try writeBug(store, at: repo, prompt: "open-q",
                         response: "open-answer", status: .open)
        _ = try writeBug(store, at: repo, prompt: "wontfix-q",
                         response: "wf-answer", status: .wontFix)

        let prompter = FakePrompter()
        prompter.replies["fixed-q"] = "fixed-answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo)

        #expect(prompter.calls == ["fixed-q"])
        #expect(runner.results.count == 1)
        #expect(runner.results.first?.verdict == .unchanged)
    }

    @Test func runMarksRegressedWhenAgentDriftsAndFailedOnError() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try writeBug(store, at: repo, prompt: "drifted-q",
                         response: "old-answer", status: .fixed)

        final class ThrowingPrompter: RegressionPrompter {
            func ask(prompt: String) async throws -> String {
                throw NSError(domain: "test", code: 1, userInfo: nil)
            }
        }
        let runner = RegressionRunner(prompter: ThrowingPrompter(), store: store)
        await runner.run(at: repo)

        #expect(runner.results.count == 1)
        if case .failed = runner.results.first?.verdict {
            // ok
        } else {
            Issue.record("expected .failed verdict, got \(String(describing: runner.results.first?.verdict))")
        }
    }
}
```

- [ ] **Step 2: Implement `RegressionRunner`**

```swift
// mac/Sources/MeetNotesMac/Services/RegressionRunner.swift
//
// Phase D driver. Iterates all `status: fixed` BugReports under
// <repo>/graphify-out/memory/bugs/, re-asks the agent each
// question, and compares the new answer to the one saved on the
// bug. Verdicts publish via @Published so the view can stream them
// as work progresses.
//
// The agent invocation is abstracted via the RegressionPrompter
// protocol so tests can swap in a deterministic fake (and so we
// can later replace MeetNotesAPIClient without touching this file).

import Foundation

/// Minimal interface the runner needs. Production binds this to
/// `MeetNotesAPIClient.codeAssist`; tests bind a fake.
protocol RegressionPrompter: AnyObject {
    func ask(prompt: String) async throws -> String
}

@MainActor
final class RegressionRunner: ObservableObject {
    enum Verdict: Equatable {
        case pending
        case unchanged
        case regressed
        /// CLI / network error — surfaces in the UI as "couldn't run".
        case failed(String)
    }

    struct Result: Identifiable, Equatable {
        let id = UUID()
        let bugURL: URL
        let prompt: String
        let originalAnswer: String
        var currentAnswer: String?
        var verdict: Verdict
    }

    @Published private(set) var results: [Result] = []
    @Published private(set) var running: Bool = false
    @Published private(set) var lastRunAt: Date?

    private let prompter: RegressionPrompter
    private let store: MemoryStore

    init(prompter: RegressionPrompter, store: MemoryStore = MemoryStore()) {
        self.prompter = prompter
        self.store = store
    }

    /// Execute the full run. Safe to call repeatedly — resets state
    /// each call. Bails out cleanly if there are no fixed bugs.
    func run(at repoRoot: URL) async {
        running = true
        defer {
            running = false
            lastRunAt = Date()
        }
        // Load + filter to fixed in one pass; skip files that fail to
        // decode (corrupt frontmatter / future schema).
        let urls = store.listBugs(at: repoRoot)
        let fixed: [(URL, BugReport)] = urls.compactMap { url in
            guard let bug = try? store.loadBug(at: url) else { return nil }
            return bug.status == .fixed ? (url, bug) : nil
        }
        // Seed results in pending state so the UI can render the full
        // list immediately, then flip verdicts as work completes.
        results = fixed.map {
            Result(bugURL: $0.0,
                   prompt: $0.1.prompt,
                   originalAnswer: $0.1.response,
                   currentAnswer: nil,
                   verdict: .pending)
        }
        for (idx, pair) in fixed.enumerated() {
            do {
                let reply = try await prompter.ask(prompt: pair.1.prompt)
                let v = Self.verdict(originalAnswer: pair.1.response, currentAnswer: reply)
                results[idx].currentAnswer = reply
                results[idx].verdict = v
            } catch {
                results[idx].verdict = .failed(error.localizedDescription)
            }
        }
    }

    /// Exact-match comparison after normalising runs of whitespace
    /// (incl. newlines/tabs) to single spaces and trimming the ends.
    /// Cosmetic re-flow doesn't count as regression; semantic edits
    /// do.
    static func verdict(originalAnswer: String, currentAnswer: String) -> Verdict {
        if normalise(originalAnswer) == normalise(currentAnswer) {
            return .unchanged
        }
        return .regressed
    }

    private static func normalise(_ s: String) -> String {
        let parts = s.split(whereSeparator: { $0.isWhitespace })
        return parts.joined(separator: " ")
    }
}

/// Production adapter — binds the protocol to MeetNotesAPIClient.
/// Lives next to the runner so callers don't reach into the API
/// surface directly.
final class CodeAssistPrompter: RegressionPrompter {
    let api: MeetNotesAPIClient
    let language: String
    let model: String?
    let agent: String

    init(api: MeetNotesAPIClient, language: String = "en",
         model: String? = nil, agent: String = "claude_code") {
        self.api = api
        self.language = language
        self.model = model
        self.agent = agent
    }

    func ask(prompt: String) async throws -> String {
        let resp = try await api.codeAssist(
            message: prompt,
            language: language,
            model: model,
            history: [],
            attachments: [],
            agentContext: nil
        )
        return resp.reply
    }
}
```

- [ ] **Step 3: Run tests, expect 4/4 PASS**

```
swift test --filter RegressionRunnerTests
```

- [ ] **Step 4: Commit**

```
git add mac/Sources/MeetNotesMac/Services/RegressionRunner.swift mac/Tests/MeetNotesMacTests/RegressionRunnerTests.swift
git commit -m "feat(memory): RegressionRunner — re-ask fixed bugs and flag drift"
```

---

## Task 2: Sidebar entry + route

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Services/ShellState.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/Shell/SidebarView.swift`

- [ ] **Step 1: Add `.regression` to `ShellState.Section`**

In `ShellState.swift`:

```swift
enum Section: String, Hashable, CaseIterable {
    case library, live, review, plans, conflicts, issues, gantt, docGen, autoCode, graphify, regression, settings
```

Add the corresponding `label` / `systemImage` / `tint` / `userHideable` entries:

```swift
// label
case .regression: return "Regression"
// systemImage
case .regression: return "arrow.uturn.backward.circle"
// tint
case .regression: return .orange
// userHideable list — extend
static let userHideable: [Section] = [
    .review, .plans, .conflicts, .issues, .gantt, .docGen, .autoCode, .graphify, .regression
]
```

- [ ] **Step 2: Surface in the sidebar's Explore group**

In `SidebarView.swift`, replace the `if isVisible(.graphify)` block with one that renders both:

```swift
let exploreSections: [ShellState.Section] = [.graphify, .regression]
let visibleExplore = exploreSections.filter(isVisible)
if !visibleExplore.isEmpty {
    Section(isCompact ? "" : "Explore") {
        ForEach(visibleExplore, id: \.self) { sidebarRow(section: $0) }
    }
}
```

- [ ] **Step 3: Build**

```
swift build
```

Expected: `Build complete!`. There will be compile errors in `AppShell.swift` for the unhandled `.regression` case — that's expected and Task 3 wires it up.

If `swift build` does fail with "switch must be exhaustive" inside `AppShell`, proceed to Task 3 immediately rather than committing yet — the commit at the end of Task 3 covers both.

Skip committing here; defer to Task 3's combined commit.

---

## Task 3: Route + auto-trigger

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Models/Config.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/AppShell.swift`
- Create: `mac/Sources/MeetNotesMac/Views/Regression/RegressionView.swift`

- [ ] **Step 1: Add `lastSeenAppVersion` to AppConfig**

Find the cluster of `@Published` vars in `AppConfig`. Add (mirroring the existing pattern with `UserDefaults` write-through):

```swift
    @Published var lastSeenAppVersion: String {
        didSet { defaults.set(lastSeenAppVersion, forKey: "lastSeenAppVersion") }
    }
```

Initialise in the `init`:

```swift
        self.lastSeenAppVersion = defaults.string(forKey: "lastSeenAppVersion") ?? ""
```

(Match the style of the other initialisers — likely `let defaults = UserDefaults.standard` already in scope.)

- [ ] **Step 2: Create `RegressionView`**

Run:

```
mkdir -p mac/Sources/MeetNotesMac/Views/Regression
```

Create `mac/Sources/MeetNotesMac/Views/Regression/RegressionView.swift`:

```swift
// Phase D view — lists every fixed bug and the verdict of re-asking
// the agent. Surfaces a "Run now" button and (when present) the
// active repo's name. Driven entirely by RegressionRunner; nothing
// network-level lives in here.

import SwiftUI

struct RegressionView: View {
    let api: MeetNotesAPIClient

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    @StateObject private var runner: RegressionRunner

    @State private var inspectURL: URL?

    init(api: MeetNotesAPIClient) {
        self.api = api
        let prompter = CodeAssistPrompter(api: api, agent: "claude_code")
        _runner = StateObject(wrappedValue: RegressionRunner(prompter: prompter))
    }

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            header
            Divider().background(t.border)
            list
        }
        .background(t.body)
        .sheet(item: $inspectURL) { url in
            if let result = runner.results.first(where: { $0.bugURL == url }) {
                diffSheet(result)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        let t = theme.current
        let fixed = runner.results.count
        let regressed = runner.results.filter {
            if case .regressed = $0.verdict { return true }; return false
        }.count
        return HStack(spacing: Spacing.md) {
            SectionLabel("REGRESSION CHECK")
            if fixed > 0 {
                Text("\(fixed) fixed bug\(fixed == 1 ? "" : "s")")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
                if regressed > 0 {
                    Text("·").foregroundStyle(t.textMuted)
                    Label("\(regressed) regressed", systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.caption).foregroundStyle(t.danger)
                }
            }
            Spacer()
            Button {
                Task { await runIfPossible() }
            } label: {
                Label(runner.running ? "Running…" : "Run now",
                      systemImage: "arrow.uturn.backward.circle")
                    .font(Typography.captionStrong)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(runner.running || activeRepoRoot == nil)
        }
        .padding(.horizontal, Spacing.lg).padding(.vertical, Spacing.sm)
    }

    // MARK: - List

    @ViewBuilder
    private var list: some View {
        let t = theme.current
        if activeRepoRoot == nil {
            empty("Pick an active GitLab or GitHub repo in Settings to enable regression checks.")
        } else if runner.results.isEmpty && !runner.running {
            empty("No fixed bugs to re-check. Mark a bug as Fixed from the Graphify → Memory tab to populate this list.")
        } else {
            List {
                ForEach(runner.results) { r in
                    row(r)
                        .contentShape(Rectangle())
                        .onTapGesture { inspectURL = r.bugURL }
                }
            }
            .listStyle(.inset)
        }
        _ = t
    }

    @ViewBuilder
    private func row(_ r: RegressionRunner.Result) -> some View {
        let t = theme.current
        HStack(spacing: 10) {
            verdictIcon(r.verdict)
            VStack(alignment: .leading, spacing: 2) {
                Text(r.prompt.prefix(120))
                    .font(Typography.body).lineLimit(2).truncationMode(.tail)
                    .foregroundStyle(t.text)
                Text(verdictLabel(r.verdict))
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            }
            Spacer()
            if case .regressed = r.verdict {
                Text("View diff").font(Typography.caption).foregroundStyle(t.accent2)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func verdictIcon(_ v: RegressionRunner.Verdict) -> some View {
        let t = theme.current
        switch v {
        case .pending:   Image(systemName: "ellipsis.circle").foregroundStyle(t.textMuted)
        case .unchanged: Image(systemName: "checkmark.circle.fill").foregroundStyle(t.accent3)
        case .regressed: Image(systemName: "xmark.octagon.fill").foregroundStyle(t.danger)
        case .failed:    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(t.accent4)
        }
    }

    private func verdictLabel(_ v: RegressionRunner.Verdict) -> String {
        switch v {
        case .pending: return "pending"
        case .unchanged: return "unchanged"
        case .regressed: return "REGRESSED"
        case .failed(let why): return "couldn't run — \(why)"
        }
    }

    @ViewBuilder
    private func empty(_ msg: String) -> some View {
        let t = theme.current
        VStack {
            Spacer()
            Text(msg)
                .font(Typography.body).foregroundStyle(t.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Spacing.lg)
    }

    // MARK: - Diff sheet

    @ViewBuilder
    private func diffSheet(_ r: RegressionRunner.Result) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                Text("Diff").font(Typography.title).foregroundStyle(t.text)
                Spacer()
                Button("Close") { inspectURL = nil }.buttonStyle(.bordered)
            }
            Text("Prompt").font(Typography.caption).foregroundStyle(t.textMuted)
            ScrollView { Text(r.prompt).font(Typography.body).textSelection(.enabled) }
                .frame(maxHeight: 80)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(t.surface))

            HStack(alignment: .top, spacing: Spacing.md) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Original (when fixed)").font(Typography.caption).foregroundStyle(t.textMuted)
                    ScrollView {
                        Text(r.originalAnswer)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 6).fill(t.accent3.opacity(0.08)))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Current").font(Typography.caption).foregroundStyle(t.textMuted)
                    ScrollView {
                        Text(r.currentAnswer ?? "(no response)")
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 6).fill(t.danger.opacity(0.08)))
                }
            }
        }
        .padding(Spacing.lg)
        .frame(minWidth: 720, minHeight: 520)
    }

    // MARK: - Helpers

    private var activeRepoRoot: URL? {
        if let p = config.gitLabSavedProjects.first(where: { $0.isActive && $0.isCloned }),
           let url = p.localURL { return url }
        if let r = config.gitHubSavedRepos.first(where: { $0.isActive && $0.isCloned }),
           let url = r.localURL { return url }
        return nil
    }

    private func runIfPossible() async {
        guard let repo = activeRepoRoot else { return }
        await runner.run(at: repo)
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}
```

NOTE on the `URL: Identifiable` retroactive conformance — if `URL: Identifiable` is already declared elsewhere in the codebase, drop this extension. Search:

```
grep -rn "extension URL.*Identifiable" mac/Sources
```

If a match exists, omit the extension block from this file.

- [ ] **Step 3: Route in `AppShell`**

In `AppShell.swift`, alongside `case .graphify: GraphifyView()`, add:

```swift
        case .regression: RegressionView(api: api)
```

- [ ] **Step 4: Auto-trigger on launch**

Find the `body` (or initial-task) of `AppShell`. Pick the existing `.task` / `.onAppear` on `AppShell` that fires on launch (search for `.task {` near the top of the file). Add a sibling effect:

```swift
        .task {
            let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
            if current != config.lastSeenAppVersion {
                config.lastSeenAppVersion = current
                // Defer the actual regression run until the user opens
                // the Regression tab — auto-running on launch would fire
                // N CLI calls in the background with no signal of
                // intent. The version bump is the trigger that arms
                // the manual button; the spec calls this out as a
                // tradeoff.
            }
        }
```

NOTE: The spec's "automatic … runs in the background, surfaces a banner" path is intentionally deferred here. The plan keeps Phase D's auto-trigger to **arming** (record the new version) rather than firing the agent, because the agent invocation is not yet metered and surprise N-call runs are user-hostile. The "Run now" button is the user's explicit go-ahead. If you want the fully-automatic flow, swap this `// Defer …` comment for an `await runner.run(at: repo)` call wrapped in `if let repo = activeRepoRoot()`.

If no obvious `.task` on the root `AppShell` view exists, attach the modifier to the outermost container in `AppShell.body`.

- [ ] **Step 5: Build**

```
swift build
```

Expected: `Build complete!`.

- [ ] **Step 6: Commit (combined with Task 2)**

```
git add mac/Sources/MeetNotesMac/Services/ShellState.swift \
        mac/Sources/MeetNotesMac/Views/Shell/SidebarView.swift \
        mac/Sources/MeetNotesMac/Views/AppShell.swift \
        mac/Sources/MeetNotesMac/Views/Regression/RegressionView.swift \
        mac/Sources/MeetNotesMac/Models/Config.swift
git commit -m "feat(memory): Regression sidebar + view, lastSeenAppVersion gate

Phase D.2 + D.3. New 'Regression' section under Explore. The view
binds to a RegressionRunner that re-asks every fixed bug and flags
drift via exact-match (whitespace-normalised) verdict. Auto-trigger
records the new app version on launch; user starts the run from
the 'Run now' button."
```

---

## Task 4: Verification + smoke test

- [ ] **Step 1: Targeted tests**

```
swift test --filter "RegressionRunnerTests|QAEntryTests|CodeAssistantSessionTests|MemoryStoreTests|MemoryStoreWritesTests|BugReportTests|GraphifyInstallerTests"
```

Expected: all suites pass.

- [ ] **Step 2: Full suite**

```
swift test 2>&1 | grep -cE "✘ Test "
```

Expected: `2` (same two pre-existing unrelated failures).

- [ ] **Step 3: Manual smoke**

```
./build_app.sh && pkill -f MeetNotesMac.app; sleep 1; open -n MeetNotesMac.app
```

1. With an active repo selected, file a bug from Code Assistant; in Memory tab flip it to **Fixed**.
2. Open sidebar → **Explore → Regression**.
3. Empty list shows the "no fixed bugs / Run now" state; the row from step 1 should appear once you click **Run now**.
4. Click **Run now**. Watch the row flip from `pending` → `unchanged` (if the agent gives the same answer) or `REGRESSED` (if drift).
5. Click a regressed row → diff sheet opens with original-vs-current side by side.
6. Verify the sidebar visibility toggle in Settings can hide/show the Regression entry.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Re-run fixed-bug prompts through the agent | Task 1 (`RegressionRunner.run`) |
| Exact-match (whitespace-normalised) verdict | Task 1 (`verdict`, `normalise`) |
| Pending / unchanged / regressed / failed states | Task 1 (`Verdict` enum) |
| Sidebar entry under Explore, hideable | Task 2 |
| "Run now" button | Task 3 (Step 2 header) |
| Diff sheet | Task 3 (Step 2 `diffSheet`) |
| Auto-trigger on `appVersion != lastSeenAppVersion` | Task 3 (Step 4) — arming only; full background run explicitly deferred (commented in the plan + commit message) |
| `lastSeenAppVersion` on AppConfig | Task 3 (Step 1) |

**Placeholder scan:** No TBDs. The one deferred behaviour (auto-firing the runner) is called out explicitly with rationale.

**Type consistency:**
- `RegressionPrompter` protocol → `CodeAssistPrompter` adapter + `FakePrompter` test double.
- `RegressionRunner.Verdict` cases consistent across the runner, the view's `verdictIcon`/`verdictLabel`, and the tests.
- `RegressionRunner.Result.bugURL` → drives `inspectURL` sheet binding.

No spec gap (modulo the deferred auto-run, which is documented).
