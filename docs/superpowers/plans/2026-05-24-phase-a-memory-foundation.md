# Phase A — Memory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Memory tab to the Graphify view that surfaces `<repo>/graphify-out/memory/` files for browsing/editing, plus a one-time "Install agent skill" action that runs `graphify install --platform <cli>` so the user's CLI agent reads memory automatically.

**Architecture:** Reuses Graphify's existing memory directory convention (`graphify-out/memory/`) — no parallel store. A small `MemoryStore` reads + seeds; `GraphifyInstaller` shells `graphify install` via the existing `ProcessLauncher` seam (tested without spawning); a new `MemoryTabView` adds a third tab next to Graphify / InfiniteBrain. Markdown files are rendered via the app's existing `FileDetailView` so no new editor work is needed.

**Tech Stack:** Swift 5.9 / SwiftUI / Swift Testing (`@Test`). External CLI: `graphify` (already required by the Code-mode Graphify path).

**Spec:** [docs/superpowers/specs/2026-05-24-agent-memory-and-feedback-design.md](../specs/2026-05-24-agent-memory-and-feedback-design.md) — sub-project A only.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift` | Read/seed `<repo>/graphify-out/memory/`. Phase A surface: `seedIfMissing(in:)`, `loadRepoNotes(at:)`, `saveRepoNotes(at:contents:)`, `listBugs(at:)`, `listQA(at:)`. |
| `mac/Sources/MeetNotesMac/CodeGraph/GraphifyInstaller.swift` | Wraps `graphify install --platform <cli>` against the existing `ProcessLauncher`. Maps `AICliTool` rawValue → `--platform` argument. |
| `mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift` | The new tab content. Left list of memory files, right `FileDetailView` for the selected one, install-skill button, node-count badge. |
| `mac/Tests/MeetNotesMacTests/MemoryStoreTests.swift` | Round-trip seed / load / save coverage on a tmp directory. |
| `mac/Tests/MeetNotesMacTests/GraphifyInstallerTests.swift` | Mock-launcher assertions for argv + platform mapping. |

**Modify:**

| Path | Why |
|---|---|
| `mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyView.swift:29-78` | Add `.memory` to `Mode` enum; metadata (`displayName: "Memory"`, `icon: "books.vertical"`, `tint: theme.accent3`). |
| `mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyView.swift` (itemsPanel switch) | Add a `case .memory:` arm rendering `MemoryTabView(repoRoot: …)`. |

---

## Task 1: Seed + load `MemoryStore` (read-only surface)

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift`
- Create: `mac/Tests/MeetNotesMacTests/MemoryStoreTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/MeetNotesMacTests/MemoryStoreTests.swift`:

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct MemoryStoreTests {
    /// Helper — create a unique tmp dir scoped to this test method.
    private func tmpRepoDir() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("memory-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func seedIfMissingCreatesDirAndRepoTemplate() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }

        let store = MemoryStore()
        try store.seedIfMissing(in: repo)

        let memoryDir = repo.appendingPathComponent("graphify-out/memory")
        let repoMd = memoryDir.appendingPathComponent("repo.md")
        #expect(FileManager.default.fileExists(atPath: memoryDir.path))
        #expect(FileManager.default.fileExists(atPath: repoMd.path))

        let contents = try String(contentsOf: repoMd, encoding: .utf8)
        #expect(contents.contains("# Project facts"))
    }

    @Test func seedIsIdempotent() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()

        try store.seedIfMissing(in: repo)
        let repoMd = repo.appendingPathComponent("graphify-out/memory/repo.md")
        try "user-edited content".write(to: repoMd, atomically: true, encoding: .utf8)

        // Second seed must not clobber existing content.
        try store.seedIfMissing(in: repo)
        let after = try String(contentsOf: repoMd, encoding: .utf8)
        #expect(after == "user-edited content")
    }

    @Test func loadRepoNotesReturnsNilWhenAbsent() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        #expect(store.loadRepoNotes(at: repo) == nil)
    }

    @Test func saveAndLoadRoundTrip() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        try store.saveRepoNotes(at: repo, contents: "# Stack\nSwift 5.9")
        #expect(store.loadRepoNotes(at: repo) == "# Stack\nSwift 5.9")
    }

    @Test func listBugsAndQAReturnEmptyWhenAbsent() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        #expect(store.listBugs(at: repo).isEmpty)
        #expect(store.listQA(at: repo).isEmpty)
    }

    @Test func listBugsAndQAReturnMarkdownFilesSorted() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let bugs = repo.appendingPathComponent("graphify-out/memory/bugs", isDirectory: true)
        let qa   = repo.appendingPathComponent("graphify-out/memory/q&a", isDirectory: true)
        try FileManager.default.createDirectory(at: bugs, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: qa,   withIntermediateDirectories: true)
        try "b".write(to: bugs.appendingPathComponent("2026-05-23-flow.md"), atomically: true, encoding: .utf8)
        try "b".write(to: bugs.appendingPathComponent("2026-05-22-auth.md"), atomically: true, encoding: .utf8)
        try "q".write(to: qa.appendingPathComponent("deploy.md"), atomically: true, encoding: .utf8)
        try "ignored".write(to: bugs.appendingPathComponent("not-markdown.txt"), atomically: true, encoding: .utf8)

        let store = MemoryStore()
        let listedBugs = store.listBugs(at: repo).map { $0.lastPathComponent }
        let listedQA = store.listQA(at: repo).map { $0.lastPathComponent }
        #expect(listedBugs == ["2026-05-22-auth.md", "2026-05-23-flow.md"])   // sorted ascending by file name
        #expect(listedQA == ["deploy.md"])
    }
}
```

- [ ] **Step 2: Run tests — expect failures because MemoryStore doesn't exist**

```
cd /Users/dinsmallade/Desktop/meet-notes/mac
swift test --filter MemoryStoreTests
```

Expected: FAIL with `cannot find 'MemoryStore' in scope`.

- [ ] **Step 3: Implement MemoryStore**

Create `mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift`:

```swift
// Read/write Graphify's memory dir under <repo>/graphify-out/memory/.
//
// Phase A surface — seed + read only:
//   • seedIfMissing(in:) creates the dir layout and a templated
//     repo.md if it doesn't exist. Idempotent — user edits to
//     repo.md are preserved on subsequent seeds.
//   • loadRepoNotes / saveRepoNotes for the curated repo.md.
//   • listBugs / listQA enumerate markdown files in the
//     bugs/ and q&a/ subdirs for the UI to display.
//
// Write methods for bugs (phase B) and Q&A (phase C) live in this
// same type but are added in their respective plans.

import Foundation

public struct MemoryStore {
    public init() {}

    // MARK: - Paths

    private func memoryDir(in repo: URL) -> URL {
        repo.appendingPathComponent("graphify-out", isDirectory: true)
            .appendingPathComponent("memory", isDirectory: true)
    }

    private func bugsDir(in repo: URL) -> URL  { memoryDir(in: repo).appendingPathComponent("bugs",  isDirectory: true) }
    private func qaDir(in repo: URL)   -> URL  { memoryDir(in: repo).appendingPathComponent("q&a",   isDirectory: true) }
    private func repoNotesURL(in repo: URL) -> URL { memoryDir(in: repo).appendingPathComponent("repo.md") }

    // MARK: - Seed

    /// Idempotent. Creates memory/, memory/bugs/, memory/q&a/ if absent,
    /// and writes repo.md from the template if (and only if) it doesn't
    /// already exist. User edits to repo.md are never overwritten.
    public func seedIfMissing(in repo: URL) throws {
        let fm = FileManager.default
        for dir in [memoryDir(in: repo), bugsDir(in: repo), qaDir(in: repo)] {
            if !fm.fileExists(atPath: dir.path) {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            }
        }
        let repoMd = repoNotesURL(in: repo)
        if !fm.fileExists(atPath: repoMd.path) {
            try Self.repoTemplate.write(to: repoMd, atomically: true, encoding: .utf8)
        }
    }

    // MARK: - Repo notes

    public func loadRepoNotes(at repo: URL) -> String? {
        try? String(contentsOf: repoNotesURL(in: repo), encoding: .utf8)
    }

    public func saveRepoNotes(at repo: URL, contents: String) throws {
        try FileManager.default.createDirectory(at: memoryDir(in: repo), withIntermediateDirectories: true)
        try contents.write(to: repoNotesURL(in: repo), atomically: true, encoding: .utf8)
    }

    // MARK: - List

    /// Sorted ascending by file name (date-prefixed slugs naturally
    /// order chronologically). Only `.md` files are returned; non-markdown
    /// files in the dir are ignored.
    public func listBugs(at repo: URL) -> [URL] { listMarkdown(in: bugsDir(in: repo)) }
    public func listQA(at repo: URL)   -> [URL] { listMarkdown(in: qaDir(in: repo)) }

    private func listMarkdown(in dir: URL) -> [URL] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            return []
        }
        return entries
            .filter { $0.pathExtension.lowercased() == "md" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    // MARK: - Template

    static let repoTemplate = """
    # Project facts

    Edit this file with anything the agent should know about this repo —
    architecture, conventions, gotchas, where things live. The agent reads
    it on every prompt via the Graphify skill.

    > ⚠️ Don't paste secrets here. This file is checked in alongside the
    > rest of the graphify-out/ dir.

    ## Stack

    (e.g. Swift 5.9, macOS 14+, SPM)

    ## Conventions

    (e.g. tests live in Tests/<Target>Tests/, services in Sources/<Target>/Services/)

    ## Gotchas

    (things that surprised you the first time)
    """
}
```

- [ ] **Step 4: Run tests — expect all 6 pass**

```
swift test --filter MemoryStoreTests
```

Expected: 6 / 6 PASS.

- [ ] **Step 5: Commit**

```
git add mac/Sources/MeetNotesMac/CodeGraph/MemoryStore.swift mac/Tests/MeetNotesMacTests/MemoryStoreTests.swift
git commit -m "feat(memory): MemoryStore seeds + reads graphify-out/memory/

Phase A.1 of the agent memory + feedback work. Read-only surface
(seed / load / save repo.md, list bugs and q&a markdown files) that
the Memory tab will consume. Write methods for bugs (phase B) and Q&A
(phase C) land in their own commits."
```

---

## Task 2: `GraphifyInstaller`

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeGraph/GraphifyInstaller.swift`
- Create: `mac/Tests/MeetNotesMacTests/GraphifyInstallerTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/MeetNotesMacTests/GraphifyInstallerTests.swift`:

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct GraphifyInstallerTests {
    final class MockLauncher: ProcessLauncher, @unchecked Sendable {
        var capturedExecutable: URL?
        var capturedArgs: [String] = []
        var exitCode: Int32 = 0
        var stdout: Data = Data()
        var stderr: Data = Data()

        func run(executable: URL, arguments: [String], environment: [String: String]?) async throws -> (Int32, Data, Data) {
            capturedExecutable = executable
            capturedArgs = arguments
            return (exitCode, stdout, stderr)
        }
    }

    @Test func mapsClaudeCodeToPlatformClaude() async throws {
        let launcher = MockLauncher()
        let installer = GraphifyInstaller(launcher: launcher, binaryURL: URL(fileURLWithPath: "/fake/graphify"))
        _ = try await installer.install(cli: .claudeCode).get()
        #expect(launcher.capturedArgs == ["install", "--platform", "claude"])
    }

    @Test func mapsCursorToPlatformCursor() async throws {
        let launcher = MockLauncher()
        let installer = GraphifyInstaller(launcher: launcher, binaryURL: URL(fileURLWithPath: "/fake/graphify"))
        _ = try await installer.install(cli: .cursor).get()
        #expect(launcher.capturedArgs == ["install", "--platform", "cursor"])
    }

    @Test func mapsGeminiToPlatformGemini() async throws {
        let launcher = MockLauncher()
        let installer = GraphifyInstaller(launcher: launcher, binaryURL: URL(fileURLWithPath: "/fake/graphify"))
        _ = try await installer.install(cli: .gemini).get()
        #expect(launcher.capturedArgs == ["install", "--platform", "gemini"])
    }

    @Test func mapsCopilotToPlatformCodex() async throws {
        // graphify's --platform whitelist doesn't include "copilot" — the
        // closest documented target for VS Code / Copilot users is "codex"
        // (OpenAI's CLI which Copilot users typically also have). Confirm
        // the mapping is explicit in the installer so it can't silently
        // drift.
        let launcher = MockLauncher()
        let installer = GraphifyInstaller(launcher: launcher, binaryURL: URL(fileURLWithPath: "/fake/graphify"))
        _ = try await installer.install(cli: .copilot).get()
        #expect(launcher.capturedArgs == ["install", "--platform", "codex"])
    }

    @Test func returnsBinaryMissingWhenUnresolvable() async {
        let installer = GraphifyInstaller(launcher: MockLauncher(), binaryURL: nil)
        let result = await installer.install(cli: .claudeCode)
        #expect(result == .failure(.binaryMissing))
    }

    @Test func returnsRunFailedOnNonZeroExit() async {
        let launcher = MockLauncher()
        launcher.exitCode = 2
        launcher.stderr = Data("nope\n".utf8)
        let installer = GraphifyInstaller(launcher: launcher, binaryURL: URL(fileURLWithPath: "/fake/graphify"))
        let result = await installer.install(cli: .claudeCode)
        guard case .failure(.runFailed(let code, let tail)) = result else {
            Issue.record("expected runFailed, got \(result)"); return
        }
        #expect(code == 2)
        #expect(tail.contains("nope"))
    }
}
```

- [ ] **Step 2: Run tests — expect failures**

```
swift test --filter GraphifyInstallerTests
```

Expected: FAIL — `GraphifyInstaller` doesn't exist.

- [ ] **Step 3: Implement GraphifyInstaller**

Create `mac/Sources/MeetNotesMac/CodeGraph/GraphifyInstaller.swift`:

```swift
// One-time install of the Graphify "skill" file into the user's CLI
// agent config dir. Wraps:
//
//     graphify install --platform <name>
//
// The `--platform` whitelist accepted by graphify is documented in
// `graphify --help`: claude | windows | codex | opencode | aider |
// claw | droid | trae | trae-cn | gemini | cursor | antigravity |
// hermes | kiro | pi. We only ship mappings for the AICliTool values
// the app exposes today; unmapped tools throw at the caller boundary
// so we never silently install for the wrong agent.

import Foundation

public final class GraphifyInstaller {
    private let launcher: ProcessLauncher
    private let binaryURL: URL?

    public init(launcher: ProcessLauncher = SystemProcessLauncher(),
                binaryURL: URL? = GraphifyRunner.resolveBinary()) {
        self.launcher = launcher
        self.binaryURL = binaryURL
    }

    /// Run `graphify install --platform <name>`. Returns the platform
    /// string on success so the UI can surface a confirmation like
    /// "Skill installed for claude".
    public func install(cli: AICliTool) async -> Result<String, GraphifyError> {
        guard let bin = binaryURL else { return .failure(.binaryMissing) }
        let platform = Self.platformArgument(for: cli)
        let args = ["install", "--platform", platform]
        do {
            let (exit, _, stderr) = try await launcher.run(executable: bin, arguments: args, environment: nil)
            if exit != 0 {
                return .failure(.runFailed(exitCode: exit, stderrTail: GraphifyRunner.safeTail(stderr, maxBytes: 800)))
            }
            return .success(platform)
        } catch is CancellationError {
            return .failure(.cancelled)
        } catch {
            return .failure(.runFailed(exitCode: -1, stderrTail: String(describing: error)))
        }
    }

    /// Map the app's AICliTool to graphify's `--platform` whitelist.
    /// Copilot has no direct entry in graphify's list — `codex` is the
    /// closest (OpenAI's CLI, which Copilot CLI users typically run too).
    /// The mapping is explicit here so it can be reviewed in one place.
    static func platformArgument(for cli: AICliTool) -> String {
        switch cli {
        case .claudeCode: return "claude"
        case .cursor:     return "cursor"
        case .gemini:     return "gemini"
        case .copilot:    return "codex"
        }
    }
}
```

- [ ] **Step 4: Run tests — expect all 6 pass**

```
swift test --filter GraphifyInstallerTests
```

Expected: 6 / 6 PASS.

- [ ] **Step 5: Commit**

```
git add mac/Sources/MeetNotesMac/CodeGraph/GraphifyInstaller.swift mac/Tests/MeetNotesMacTests/GraphifyInstallerTests.swift
git commit -m "feat(memory): GraphifyInstaller wraps \`graphify install --platform <cli>\`

Maps AICliTool → graphify's --platform whitelist with one explicit
switch so the mapping can't silently drift. Reuses the existing
ProcessLauncher seam for tests."
```

---

## Task 3: Add `.memory` to `Mode` enum

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyView.swift:29-78` (the `Mode` enum)

- [ ] **Step 1: Build to confirm clean baseline**

```
swift build
```

Expected: `Build complete!`.

- [ ] **Step 2: Extend Mode**

In `mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyView.swift`, find the `Mode` enum (around line 29) and replace it with:

```swift
    enum Mode: String, Identifiable, CaseIterable {
        case code            // → Graphify CLI on a code folder
        case data            // → MemoryGenerator on docs
        case memory          // → Curated memory + bug + Q&A files in graphify-out/memory/

        var id: String { rawValue }

        var displayName: String {
            switch self {
            case .code:   return "Graphify"
            case .data:   return "InfiniteBrain"
            case .memory: return "Memory"
            }
        }

        var icon: String {
            switch self {
            case .code:   return "chevron.left.forwardslash.chevron.right"
            case .data:   return "brain.head.profile"
            case .memory: return "books.vertical"
            }
        }

        /// Theme-driven accent — picks a role from the active palette so
        /// the tint stays consistent across light / dark / midnight modes
        /// instead of fighting them with literal colour values.
        func tint(_ theme: Theme) -> Color {
            switch self {
            case .code:   return theme.accent      // brand teal
            case .data:   return theme.accent2     // info blue
            case .memory: return theme.accent3     // success green — distinct from the other two
            }
        }

        /// Best-fit mode for a library item; defaults to .code so the
        /// run button still enables when there's nothing selected.
        /// Memory has no library-item correspondence (it's repo-wide),
        /// so it's never suggested from a selection.
        static func suggested(for category: LibraryItem.Category?) -> Mode? {
            switch category {
            case .code:           return .code
            case .data, .notes:   return .data
            case nil:             return nil
            }
        }

        var runLabel: String {
            switch self {
            case .code:   return "Run Graphify"
            case .data:   return "Generate Memory"
            case .memory: return "Open Memory"
            }
        }
        var description: String {
            switch self {
            case .code:   return "Run Graphify on the selected code folder."
            case .data:   return "Build memory from the selected docs."
            case .memory: return "Browse and edit the repo's curated memory files."
            }
        }
    }
```

- [ ] **Step 3: Address the new compile errors**

The exhaustive switches that fan out from `Mode` now miss `.memory`. Find each `switch mode { … }` that has no `default:` arm and add `case .memory:` returning a no-op / sensible default. Specifically:

Line ~199 (`canRun`):
```swift
    private var canRun: Bool {
        switch mode {
        case .code:   return codeTargetFolder != nil
        case .data:   return selectedItem?.category == .data || selectedItem?.category == .notes
        case .memory: return codeTargetFolder != nil   // memory lives under the same repo root
        }
    }
```

Line ~385 (status block running message):
```swift
                Text({
                    switch mode {
                    case .code:   return "Running graphify…"
                    case .data:   return "Generating memory…"
                    case .memory: return "Opening memory…"
                    }
                }())
```

Line ~399 (footer install hint):
```swift
            switch mode {
            case .code:
                Text("Requires graphify CLI:\n\(GraphifyRunner.installHint)")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            case .data:
                Text("Scans .md / .txt files,\nchunks by headings.")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            case .memory:
                Text("Surfaces curated facts the agent reads via\nthe Graphify skill.")
                    .font(Typography.caption).foregroundStyle(t.textMuted)
            }
```

Line ~431 (`currentRunButtonLabel`):
```swift
    private var currentRunButtonLabel: String {
        switch mode {
        case .code:
            if let folder = codeTargetFolder {
                return "Run Graphify on \(folder.lastPathComponent)"
            }
            return "Run Graphify — pick a Code item"
        case .data:
            if let item = selectedItem {
                if let origin = item.folderOrigin { return "Generate Memory from \(origin)" }
                return "Generate Memory from \(item.name)"
            }
            return "Generate Memory — pick a Data item"
        case .memory:
            if let folder = codeTargetFolder {
                return "Open Memory for \(folder.lastPathComponent)"
            }
            return "Pick a Code item to open its Memory"
        }
    }
```

Line ~452 (`modeHelpText`):
```swift
        case .memory:
            if codeTargetFolder == nil {
                return "Pick a code repo above; memory lives under its graphify-out/memory/."
            }
            return mode.description
```

Line ~620 (`run` switch):
```swift
    private func run() {
        switch mode {
        case .code: if let folder = codeTargetFolder { runGraphify(target: folder) }
        case .data: generateMemory()
        case .memory: break    // Memory tab has its own affordances; the Run footer button is a no-op here.
        }
    }
```

- [ ] **Step 4: Build**

```
swift build
```

Expected: `Build complete!`. Exhaustive-switch errors gone.

- [ ] **Step 5: Commit**

```
git add mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyView.swift
git commit -m "feat(memory): add .memory case to Graphify Mode enum

Wires through every exhaustive switch (canRun, runLabel, statusBlock,
description, currentRunButtonLabel, modeHelpText, run). No UI change
yet — the tab itself lands in the next commit."
```

---

## Task 4: `MemoryTabView`

**Files:**
- Create: `mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift`
- Modify: `mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyView.swift` (itemsPanel + canvasPanel switches)

- [ ] **Step 1: Implement MemoryTabView**

Create `mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift`:

```swift
// The Memory tab content shown when GraphifyView's Mode is .memory.
//
// Layout: same three-panel skeleton GraphifyView uses elsewhere, but
// panels 2 and 3 are repurposed for memory:
//   • Panel 2 (Items): list of memory files — repo.md, then bugs/*,
//     then q&a/*. Sections are headed; only `.md` files appear.
//   • Panel 3 (Canvas): FileDetailView for the currently-selected
//     file, OR the install-skill / seed call-to-action when nothing
//     is selected.
//
// MemoryTabView itself is rendered inside GraphifyView's itemsPanel
// + canvasPanel sub-views — see GraphifyView's `case .memory:` arms.

import SwiftUI

@MainActor
struct MemoryTabView: View {
    let repoRoot: URL
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    @State private var bugs: [URL] = []
    @State private var qa: [URL] = []
    @State private var hasRepoNotes = false
    @State private var seededOnce = false
    @State private var installing = false
    @State private var installStatus: String?
    @State private var installError: String?

    @Binding var selection: URL?

    private let store = MemoryStore()
    private let installer = GraphifyInstaller()

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            header
            Divider().background(t.border)
            itemList
        }
        .background(t.surface)
        .task(id: repoRoot.path) { await refresh() }
    }

    // MARK: - Header

    private var header: some View {
        let t = theme.current
        let cli = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
        return VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                SectionLabel("MEMORY")
                Spacer()
                Button {
                    Task { await runInstall() }
                } label: {
                    Label(installing ? "Installing…" : "Install skill for \(cli.displayName)",
                          systemImage: "square.and.arrow.down")
                        .font(Typography.captionStrong)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(installing)
                .help("Run `graphify install --platform \(GraphifyInstaller.platformArgument(for: cli))`")
            }
            if let status = installStatus {
                Label(status, systemImage: "checkmark.circle.fill")
                    .font(Typography.caption).foregroundStyle(t.accent3)
                    .lineLimit(2).truncationMode(.tail)
            }
            if let err = installError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption).foregroundStyle(t.danger)
                    .lineLimit(3).truncationMode(.tail)
            }
        }
        .padding(.horizontal, Spacing.lg).padding(.vertical, Spacing.sm)
    }

    // MARK: - List

    @ViewBuilder
    private var itemList: some View {
        let t = theme.current
        List(selection: $selection) {
            Section {
                if hasRepoNotes {
                    row(label: "repo.md", url: repoNotesURL, icon: "doc.text", tint: t.accent)
                } else {
                    placeholderRow(label: "Tap to seed repo.md") {
                        Task { await seed() }
                    }
                }
            } header: { Text("Overview") }
            Section {
                if bugs.isEmpty {
                    Text("No bug reports yet").font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(bugs, id: \.self) { url in
                        row(label: url.lastPathComponent, url: url, icon: "ant", tint: t.danger)
                    }
                }
            } header: { Text("Bugs (\(bugs.count))") }
            Section {
                if qa.isEmpty {
                    Text("No saved answers yet").font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(qa, id: \.self) { url in
                        row(label: url.lastPathComponent, url: url, icon: "bubble.left", tint: t.accent2)
                    }
                }
            } header: { Text("Q&A (\(qa.count))") }
        }
        .listStyle(.sidebar)
    }

    private var repoNotesURL: URL {
        repoRoot.appendingPathComponent("graphify-out/memory/repo.md")
    }

    @ViewBuilder
    private func row(label: String, url: URL, icon: String, tint: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).foregroundStyle(tint).font(.system(size: 11))
            Text(label).font(Typography.body).lineLimit(1).truncationMode(.middle)
        }
        .tag(url)
    }

    @ViewBuilder
    private func placeholderRow(label: String, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            HStack(spacing: 6) {
                Image(systemName: "plus.circle").foregroundStyle(theme.current.accent3).font(.system(size: 11))
                Text(label).font(Typography.body).foregroundStyle(theme.current.textMuted)
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Actions

    private func refresh() async {
        let exists = FileManager.default.fileExists(atPath: repoNotesURL.path)
        hasRepoNotes = exists
        bugs = store.listBugs(at: repoRoot)
        qa = store.listQA(at: repoRoot)
    }

    private func seed() async {
        do {
            try store.seedIfMissing(in: repoRoot)
            seededOnce = true
            await refresh()
            selection = repoNotesURL
        } catch {
            installError = "Couldn't create memory dir: \(error.localizedDescription)"
        }
    }

    private func runInstall() async {
        let cli = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
        installing = true
        installStatus = nil
        installError = nil
        defer { installing = false }
        let result = await installer.install(cli: cli)
        switch result {
        case .success(let platform):
            installStatus = "Skill installed for \(platform). The agent will read this memory on its next run."
        case .failure(.binaryMissing):
            installError = "Graphify CLI not found. Install with: \(GraphifyRunner.installHint)"
        case .failure(.runFailed(let code, let tail)):
            installError = "graphify install exited \(code): \(tail.suffix(160))"
        case .failure(.cancelled):
            installError = nil
        case .failure(.folderNotWritable),
             .failure(.noOutput),
             .failure(.parseFailed),
             .failure(.unsupportedSchema):
            installError = "graphify install failed."
        }
    }
}
```

- [ ] **Step 2: Wire `.memory` arm into `itemsPanel`**

In `GraphifyView.swift`, find the `itemsPanel`'s `if mode == .code { codeItemsList } else { memoryItemsList }` block and turn it into a three-way switch:

```swift
            switch mode {
            case .code:
                codeItemsList
            case .data:
                memoryItemsList
            case .memory:
                MemoryTabView(repoRoot: codeTargetFolder ?? repoFallback,
                              selection: $memoryFileSelection)
            }
```

Add the supporting state to `GraphifyView`:

```swift
    @State private var memoryFileSelection: URL?

    /// Used when MemoryTabView is rendered without a resolved repo root
    /// (e.g. user lands on Memory before picking a code item). Falls
    /// back to the user's home directory so the view can still draw
    /// itself; seed actions are inert until a real repo is selected.
    private var repoFallback: URL {
        FileManager.default.homeDirectoryForCurrentUser
    }
```

- [ ] **Step 3: Wire `.memory` arm into `canvasPanel`**

In `canvasPanel`, find the `if data.nodes.isEmpty` empty-state and the `CodeGraphCanvas(...)` block. Wrap them in a switch so `.memory` renders `FileDetailView` instead:

```swift
            switch mode {
            case .memory:
                memoryDetailView
            default:
                ZStack {
                    t.body
                    if displayData.nodes.isEmpty {
                        EmptyStateView( /* unchanged */ )
                    } else {
                        CodeGraphCanvas(/* unchanged */)
                    }
                }
            }
```

And add the helper:

```swift
    @ViewBuilder
    private var memoryDetailView: some View {
        if let url = memoryFileSelection {
            FileDetailView(url: url)
        } else {
            EmptyStateView(
                icon: "books.vertical",
                title: "Pick a memory file",
                message: "Select repo.md to edit the curated facts the agent reads, or browse saved bugs and Q&A.")
        }
    }
```

- [ ] **Step 4: Build**

```
swift build
```

Expected: `Build complete!`.

- [ ] **Step 5: Manual smoke test**

```
./build_app.sh
pkill -f MeetNotesMac.app; sleep 1
open -n MeetNotesMac.app
```

Then in the app:
1. Open the Graphify sidebar entry.
2. Click the new **Memory** tab — third tab between Graphify and InfiniteBrain.
3. With a code repo set as Active (Settings → GitLab/GitHub → mark cloned repo active), the tab should show "Tap to seed repo.md" under Overview.
4. Click that row → repo.md appears in the canvas pane via FileDetailView; edits save inline (the existing FileDetailView writes on Cmd-S).
5. Click **Install skill for Claude Code** → status line reads "Skill installed for claude…" (assuming graphify CLI is on PATH).

- [ ] **Step 6: Commit**

```
git add mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift mac/Sources/MeetNotesMac/Views/CodeGraph/GraphifyView.swift
git commit -m "feat(memory): Memory tab in Graphify view

Surfaces graphify-out/memory/ as a third tab next to Graphify and
InfiniteBrain. Left list groups repo.md / bugs / q&a; right pane is
the existing FileDetailView so markdown edit / save / preview comes
for free. Header runs \`graphify install\` against the user's active
CLI so the agent reads memory automatically on its next prompt."
```

---

## Task 5: Build, run full test suite, manual end-to-end

- [ ] **Step 1: Full test run**

```
swift test 2>&1 | grep -E "(✘ Test|MemoryStoreTests|GraphifyInstallerTests)" | head -20
```

Expected: the MemoryStore + GraphifyInstaller test cases pass; the 2 pre-existing failures (`agentContextEncodesEmptyFieldsAsNullAndEmptyArray`, `ProcessedActionsRegistryTests` entries) are unchanged.

- [ ] **Step 2: End-to-end smoke test**

```
./build_app.sh && pkill -f MeetNotesMac.app; sleep 1; open -n MeetNotesMac.app
```

Walk:
1. Sidebar → Graphify → Memory tab → seed repo.md → edit a line → Cmd-S.
2. Settings → CLI → switch to Cursor.
3. Back to Memory tab → "Install skill" button label updates to "Install skill for Cursor".
4. Click it. Confirm status line shows success.
5. Switch active repo (Settings → GitLab → mark a different project active) → Memory tab refreshes its file list against the new repo's graphify-out/memory/.

---

## Self-Review

**Spec coverage:**

| Spec requirement (Phase A) | Implementing task |
|---|---|
| Memory tab in Graphify view, third position | Task 3 (Mode enum) + Task 4 (wiring) |
| Left list of memory files (repo.md / bugs / q&a) | Task 4 (`itemList`) |
| Right pane reuses FileDetailView | Task 4 (`memoryDetailView`) |
| Install skill button per `config.activeCLI` | Task 4 (header) backed by Task 2 |
| Status line for install success/failure | Task 4 (header `installStatus` / `installError`) |
| Seed repo.md template idempotently | Task 1 (`seedIfMissing`) |
| Memory dir layout `bugs/` + `q&a/` created on seed | Task 1 (`seedIfMissing`) |
| AICliTool → graphify `--platform` mapping explicit | Task 2 (`platformArgument(for:)`) + tests |
| Node-count badge ("N code · M doc") | **Gap — not in this plan.** Spec Section "Code + doc unification badge" calls for it. Add follow-up task. |

**Adding the missing badge task:**

### Task 6: Code + doc node-count badge

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift` (header)

- [ ] **Step 1: Extend MemoryTabView header**

Add a state property and load from the existing cached graph.json. In `MemoryTabView`:

```swift
    @State private var codeNodeCount: Int = 0
    @State private var docNodeCount: Int = 0
    private let graphStore = GraphifyStore()
```

In `refresh()`, after the existing list-rebuild logic:

```swift
        // Pick up the cached graph count if a prior `graphify update`
        // already ran. Non-fatal if missing — the badge just shows 0.
        if let raw = graphStore.loadGraphJSON(for: repoRoot),
           let parsed = try? GraphifyParser.parse(data: raw, repoRoot: repoRoot) {
            codeNodeCount = parsed.nodes.filter { $0.kind == .file || $0.kind == .symbol || $0.kind == .module }.count
            docNodeCount  = parsed.nodes.filter { $0.kind == .docPage || $0.kind == .memoryDoc || $0.kind == .memoryChunk }.count
        } else {
            codeNodeCount = 0
            docNodeCount = 0
        }
```

In the header VStack, add a small line under the install-status block:

```swift
            if codeNodeCount + docNodeCount > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "chart.dots.scatter")
                        .font(.system(size: 10)).foregroundStyle(t.textMuted)
                    Text("\(codeNodeCount) code · \(docNodeCount) doc nodes in graph.json")
                        .font(Typography.caption).foregroundStyle(t.textMuted)
                }
            }
```

- [ ] **Step 2: Build + manual check**

```
swift build && ./build_app.sh && pkill -f MeetNotesMac.app; sleep 1; open -n MeetNotesMac.app
```

In Memory tab, after a previous `graphify update` run against the repo, badge should read e.g. "1667 code · 228 doc nodes in graph.json".

- [ ] **Step 3: Commit**

```
git add mac/Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift
git commit -m "feat(memory): node-count badge in Memory tab header

Reads cached graph.json and shows 'N code · M doc nodes' so the user
can confirm Graphify is indexing both their source and their docs
into the same graph the agent will consult."
```

---

**Placeholder scan:** no TBD / TODO / "add appropriate error handling" / placeholder strings. Every step has explicit code or a concrete command.

**Type consistency:** `MemoryStore.seedIfMissing(in:)` matches between Task 1 implementation and Task 4 call site. `GraphifyInstaller.install(cli:)` returns `Result<String, GraphifyError>` consistently across Task 2 and Task 4. `Mode.memory` is referenced in every switch arm added in Task 3. `memoryFileSelection: URL?` declared in Task 4 step 2 and consumed in step 3. `repoFallback` referenced in Task 4 step 2.

**No spec gap remaining** after Task 6 was added.
