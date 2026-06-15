# Activity Bar + Workspace Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A 3-button activity bar (Explorer / Search / Source Control) + ⋯ More overflow, and a real workspace search over file names and contents.

**Architecture:** A pure `SearchService` walking the workspace root; a `SearchView` (query + grouped results → tabbed editor); a `.search` section; and a `SidebarView` rewritten into an activity bar driving `shell.section`.

**Tech Stack:** Swift / SwiftUI, FileManager, swift-testing.

**Environment note:** `swift test` doesn't run here. "Run test" = `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests` (dangerouslyDisableSandbox: true). App build = `GIT_CONFIG_GLOBAL=/dev/null swift build`. Verify UI by build + launch smoke; verify search against a real dir.

**Build order:** Wave 1 = Task 1 (SearchService) + Task 2 (SearchView + section). Wave 2 = Task 3 (activity-bar SidebarView).

---

## Task 1: SearchService (pure matcher)

**Files:** Create `Services/SearchService.swift`; Test `Tests/.../SearchServiceTests.swift`.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor @Suite struct SearchServiceTests {
    private func tmp() throws -> URL {
        let r = FileManager.default.temporaryDirectory.appendingPathComponent("se-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: r, withIntermediateDirectories: true)
        return r
    }
    @Test func matchesFilenameAndContent() throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try "let alpha = 1\nlet beta = 2\n".write(to: root.appendingPathComponent("alpha.swift"), atomically: true, encoding: .utf8)
        try "nothing here\n".write(to: root.appendingPathComponent("other.txt"), atomically: true, encoding: .utf8)

        let svc = SearchService()
        let results = await svc.search(query: "alpha", root: root)

        // alpha.swift matches by NAME and by CONTENT (line 1)
        let m = results.first { $0.url.lastPathComponent == "alpha.swift" }
        #expect(m != nil)
        #expect(m?.nameMatched == true)
        #expect(m?.lines.contains { $0.line == 1 && $0.text.contains("alpha") } == true)
        // other.txt does not match
        #expect(!results.contains { $0.url.lastPathComponent == "other.txt" })
    }

    @Test func skipsBinaryAndNoiseAndEmptyQuery() throws {
        let root = try tmp(); defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".git"), withIntermediateDirectories: true)
        try "query\n".write(to: root.appendingPathComponent(".git/config"), atomically: true, encoding: .utf8)
        var bin = Data([0x00, 0x01, 0x02]); bin.append("query".data(using: .utf8)!)
        try bin.write(to: root.appendingPathComponent("blob.bin"))

        let svc = SearchService()
        #expect(await svc.search(query: "", root: root).isEmpty)          // empty query
        let r = await svc.search(query: "query", root: root)
        #expect(!r.contains { $0.url.path.contains("/.git/") })           // noise dir skipped
        #expect(!r.contains { $0.url.lastPathComponent == "blob.bin" })   // binary skipped
    }
}
```

- [ ] **Step 2: Build test target — expect compile failure** (`SearchService` missing).

- [ ] **Step 3: Implement**

```swift
import Foundation
import Observation

@MainActor
@Observable
final class SearchService {
    struct LineMatch: Hashable { let line: Int; let text: String }
    struct FileMatch: Identifiable, Hashable {
        let url: URL
        let displayPath: String
        let nameMatched: Bool
        let lines: [LineMatch]
        var id: String { url.path }
    }

    private static let maxFileBytes = 1_000_000
    private static let maxLineMatches = 1000
    private static let noiseNames = FileSystemTree.noiseNames

    /// Walk `root`, matching the query against file names and text-file
    /// contents (case-insensitive). Runs the blocking walk off the main
    /// actor. Empty/whitespace query → no results.
    func search(query rawQuery: String, root: URL) async -> [FileMatch] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        let needle = query.lowercased()
        let rootPath = root.standardizedFileURL.path
        return await Task.detached(priority: .userInitiated) {
            Self.walk(root: root, rootPath: rootPath, needle: needle)
        }.value
    }

    nonisolated private static func walk(root: URL, rootPath: String, needle: String) -> [FileMatch] {
        let fm = FileManager.default
        guard let en = fm.enumerator(at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles]) else { return [] }
        var out: [FileMatch] = []
        var lineBudget = maxLineMatches
        for case let url as URL in en {
            if noiseNames.contains(url.lastPathComponent) { en.skipDescendants(); continue }
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            if lineBudget <= 0 { break }
            let name = url.lastPathComponent
            let display = url.path.hasPrefix(rootPath + "/") ? String(url.path.dropFirst(rootPath.count + 1)) : url.path
            let nameMatched = display.lowercased().contains(needle)

            var lines: [LineMatch] = []
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if size <= maxFileBytes, let data = try? Data(contentsOf: url),
               !isBinary(data), let text = String(data: data, encoding: .utf8) {
                var n = 0
                for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                    n += 1
                    if line.lowercased().contains(needle) {
                        lines.append(LineMatch(line: n, text: String(line.prefix(400))))
                        lineBudget -= 1
                        if lineBudget <= 0 { break }
                    }
                }
            }
            if nameMatched || !lines.isEmpty {
                out.append(FileMatch(url: url, displayPath: display, nameMatched: nameMatched, lines: lines))
            }
        }
        return out.sorted { $0.displayPath.localizedCaseInsensitiveCompare($1.displayPath) == .orderedAscending }
    }

    nonisolated private static func isBinary(_ data: Data) -> Bool {
        data.prefix(4096).contains(0)
    }
}
```

(Confirm `FileSystemTree.noiseNames` is reachable nonisolated — `FileSystemTree` is a plain enum, so `noiseNames` is fine from `nonisolated` context. If not, inline the set.)

- [ ] **Step 4: Build test target — confirm compiles.**

- [ ] **Step 5: Runtime-verify** against a real dir: search the project for a known token, confirm filename + content matches with line numbers (paste output via a quick check).

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(search): workspace search service (names + contents)"`

---

## Task 2: SearchView + `.search` section

**Files:** Create `Views/Search/SearchView.swift`; Modify `Services/ShellState.swift`, `Views/AppShell.swift`.

- [ ] **Step 1: Add the `.search` section** in `ShellState.swift`: enum case `search` + all switch arms — `label` "Search", `systemImage` "magnifyingglass", a tint, `category` "Code". GREP every `switch` over `Section` and add `.search` (avoid non-exhaustive build break). Route in `AppShell.sectionView`: `case .search: SearchView(api: api)`.

- [ ] **Step 2: Implement `SearchView`**

```swift
import SwiftUI

struct SearchView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var projectStore: ProjectStore
    @State private var scm = SearchService()
    @State private var query = ""
    @State private var results: [SearchService.FileMatch] = []
    @State private var searching = false
    @State private var tabs: [URL] = []
    @State private var activeTab: URL?
    @State private var debounce: Task<Void, Never>?

    private var root: URL? {
        if let r = config.activeRepoLocalURL, FileManager.default.fileExists(atPath: r.path) { return r }
        if let p = projectStore.activeProject?.localPath { return URL(fileURLWithPath: p) }
        return nil
    }

    var body: some View {
        if root == nil {
            emptyState("Open a project or activate a repo to search")
        } else {
            HSplitView {
                resultsPane.frame(minWidth: 280, idealWidth: 340, maxWidth: 520)
                editorPane.frame(minWidth: 360)
            }
        }
    }

    private var resultsPane: some View {
        VStack(spacing: 0) {
            TextField("Search files by name or content", text: $query)
                .textFieldStyle(.plain).padding(8)
                .background(theme.current.surface2).clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                .padding(8)
                .onChange(of: query) { _, q in scheduleSearch(q) }
            Divider()
            if searching { ProgressView().padding() }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(results) { fm in
                        fileGroup(fm)
                    }
                }
            }
            if !query.isEmpty && results.isEmpty && !searching {
                Text("No matches").font(Typography.caption).foregroundStyle(theme.current.textMuted).padding()
            }
        }
    }

    @ViewBuilder private func fileGroup(_ fm: SearchService.FileMatch) -> some View {
        Text(fm.displayPath).font(Typography.captionStrong).foregroundStyle(theme.current.text)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onTapGesture { open(fm.url) }
        ForEach(fm.lines, id: \.self) { lm in
            HStack(spacing: 6) {
                Text("\(lm.line)").font(.system(size: 10, design: .monospaced)).foregroundStyle(theme.current.textMuted).frame(width: 36, alignment: .trailing)
                Text(lm.text).font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.current.text).lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 10).padding(.vertical, 1)
            .contentShape(Rectangle()).onTapGesture { open(fm.url) }
        }
    }

    @ViewBuilder private var editorPane: some View {
        VStack(spacing: 0) {
            if !tabs.isEmpty { EditorTabBar(tabs: $tabs, activeTab: $activeTab); Divider() }
            if let activeTab { FileDetailView(url: activeTab).id(activeTab) }
            else { emptyState("Select a result to open") }
        }
    }

    private func emptyState(_ msg: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 26)).foregroundStyle(theme.current.textMuted)
            Text(msg).font(Typography.caption).foregroundStyle(theme.current.textMuted)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func open(_ url: URL) {
        if !tabs.contains(url) { tabs.append(url) }
        activeTab = url
    }

    private func scheduleSearch(_ q: String) {
        debounce?.cancel()
        guard let root else { results = []; return }
        debounce = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            searching = true
            let r = await scm.search(query: q, root: root)
            if Task.isCancelled { return }
            results = r; searching = false
        }
    }
}
```

(Confirm `FileDetailView(url:)`, `EditorTabBar(tabs:activeTab:)`, `Typography`/`Radius`/`theme` names — they match Explorer's usage. Adjust if needed.)

- [ ] **Step 3: Build + launch smoke.** `Build complete!`; launch; alive.

- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(search): Search section view with grouped results"`

---

## Task 3: Activity-bar SidebarView

**Files:** Modify `Views/Shell/SidebarView.swift`.

- [ ] **Step 1: Read `SidebarView.swift`** fully (current `List(selection: $shell.section)` with Notes/Code/Data groups, `sidebarRow`, the `.safeAreaInset(.top)` header, the footer, `isVisible`, the Live recording dot).

- [ ] **Step 2: Rework into an activity bar.** Replace the grouped List with:
  - A **primary cluster** at the top: three prominent buttons — Explorer (`folder`), Search (`magnifyingglass`), Source Control (`arrow.triangle.branch`) — each sets `shell.section` and highlights when active. (A vertical stack of icon+label rows, or a horizontal segmented row at the very top — pick the layout that reads like an activity bar and fits the sidebar column width; keep `isCompact` icon-only behavior.)
  - A **⋯ More** control below: a `Menu` (or DisclosureGroup) listing every other section that passes `isVisible` — Library, Live (with the recording dot), Doc Gen, Review Code, Review Doc, Review Conflicts, Auto Tasks, Code Graph, Regression, Issues, Gantt, Visual. Selecting one sets `shell.section`. The More control shows an active highlight when `shell.section` is one of these.
  - Preserve the existing footer (profile/help/permissions; Settings reached there) and the top header inset.
  - Keep `shell.section` as the single selection source (so AppShell routing is unchanged).
  - Reuse `sidebarRow`'s label/icon/tint from `ShellState.Section` where convenient.

- [ ] **Step 3: Build.** Iterate to `Build complete!`. Ensure every section is still reachable (3 primary + all others in ⋯ More). Then `swift build --build-tests`.

- [ ] **Step 4: Launch smoke.** Launch; confirm alive; (manual: the 3 buttons switch panels, ⋯ More reaches others).

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(nav): activity bar — 3 primary buttons + More overflow"`

---

## Self-review (completed)

- **Spec coverage:** SearchService names+contents (T1), SearchView + `.search` section + routing (T2), activity bar 3-primary + ⋯ More (T3). All mapped.
- **Placeholder scan:** SearchService + tests have complete code; SearchView has complete code; the SidebarView rework gives concrete structure + a "confirm against codebase" note (layout latitude is intentional, not vague — the required behavior is enumerated).
- **Type consistency:** `SearchService.FileMatch`/`LineMatch`/`search(query:root:)` (T1) used by SearchView (T2); `.search` section (T2) referenced by SidebarView primary cluster (T3); `EditorTabBar`/`FileDetailView` reused per Explorer.
- **Confirm-against-codebase flags:** `FileSystemTree.noiseNames` nonisolated reach; every `ShellState.Section` switch gets `.search`; `FileDetailView`/`EditorTabBar`/theme/Typography/Radius names; `shell.section` selection wiring preserved through the SidebarView rewrite.
