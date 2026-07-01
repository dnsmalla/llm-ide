# Source Control Panel (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cursor-style Source Control panel on the active cloned repo — changed-files list, per-file stage/unstage/discard, colored unified diff, and commit.

**Architecture:** Pure parsers (`status`/`diff`) + a `SourceControlService` over `RepoManager`'s hardened git runner, rendered in a new `.sourceControl` sidebar section as a two-pane view (file list + diff), reusing the colored diff-row style from `UpdateFileSheet`.

**Tech Stack:** Swift / SwiftUI, `/usr/bin/git` via `RepoManager`, swift-testing.

**Environment note:** `swift test` does not execute in this environment (no XCTest runner). Each "run test" step = `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests` to confirm the test compiles + encodes the contract (set `dangerouslyDisableSandbox: true` on the Bash call — sandbox blocks swift build). App build = `GIT_CONFIG_GLOBAL=/dev/null swift build`. The pure parsers (Tasks 2–3) are also verifiable by a tiny standalone runtime check; the service (Task 4) is verifiable against a real temp git repo.

---

## File structure

- Create: `mac/Sources/LlmIdeMac/Services/SCMModels.swift` — `FileChange`, `DiffRow`, `DiffHunk` (Task 2/3).
- Create: `mac/Sources/LlmIdeMac/Services/SCMParsers.swift` — `StatusParser`, `UnifiedDiffParser` (Task 2/3).
- Modify: `mac/Sources/LlmIdeMac/Services/RepoManager.swift` — public `runGit` (Task 1).
- Create: `mac/Sources/LlmIdeMac/Services/SourceControlService.swift` (Task 4).
- Create: `mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift` (Task 5).
- Create: `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` (Task 6).
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift`, `Views/Shell/SidebarView.swift`, `Views/AppShell.swift` (Task 7).
- Test: `mac/Tests/LlmIdeMacTests/SCMParsersTests.swift` (Task 2/3).

---

## Task 1: Public git runner on RepoManager

**Files:** Modify `mac/Sources/LlmIdeMac/Services/RepoManager.swift` (near the private `gitOutput` at line 188).

- [ ] **Step 1: Add a public wrapper** that exposes the hardened runner for read/local commands (no token needed — SCM ops are local):

```swift
/// Public entry point for local, non-authenticated git commands (status,
/// diff, add, restore, commit). Reuses the same hardened Process runner
/// (timeouts, deadlock-safe pipe drain). Returns stdout; throws on non-zero.
func runGit(_ args: [String], at cwd: URL) async throws -> String {
    try await gitOutput(args, cwd: cwd)
}
```

- [ ] **Step 2: Build**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/RepoManager.swift
git commit -m "feat(scm): expose public runGit on RepoManager"
```

---

## Task 2: Models + StatusParser (pure)

**Files:** Create `SCMModels.swift`, `SCMParsers.swift`; Test `SCMParsersTests.swift`.

- [ ] **Step 1: Write the failing test** (`SCMParsersTests.swift`)

```swift
import Testing
@testable import LlmIdeMac

@Suite struct StatusParserTests {
    @Test func parsesStagedUnstagedUntrackedRenamed() {
        let porcelain = """
        M  staged.swift
         M unstaged.swift
        MM both.swift
        ?? new.txt
        A  added.swift
         D deleted.swift
        R  old.swift -> renamed.swift
        """
        let files = StatusParser.parse(porcelain: porcelain)

        // staged.swift → one staged modified
        #expect(files.contains { $0.path == "staged.swift" && $0.staged && $0.status == .modified })
        // unstaged.swift → one unstaged modified
        #expect(files.contains { $0.path == "unstaged.swift" && !$0.staged && $0.status == .modified })
        // both.swift → two entries (staged + unstaged)
        #expect(files.filter { $0.path == "both.swift" }.count == 2)
        // new.txt → untracked, unstaged
        #expect(files.contains { $0.path == "new.txt" && !$0.staged && $0.status == .untracked })
        // added.swift → staged added
        #expect(files.contains { $0.path == "added.swift" && $0.staged && $0.status == .added })
        // deleted.swift → unstaged deleted
        #expect(files.contains { $0.path == "deleted.swift" && !$0.staged && $0.status == .deleted })
        // rename → staged renamed, path is the new name
        #expect(files.contains { $0.path == "renamed.swift" && $0.staged && $0.status == .renamed })
    }

    @Test func emptyStatusYieldsNoFiles() {
        #expect(StatusParser.parse(porcelain: "").isEmpty)
        #expect(StatusParser.parse(porcelain: "\n").isEmpty)
    }
}
```

- [ ] **Step 2: Build the test target — expect compile failure (no types yet)**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: FAIL — "cannot find 'StatusParser'/'FileChange'".

- [ ] **Step 3: Implement models** (`SCMModels.swift`)

```swift
import Foundation

struct FileChange: Identifiable, Hashable {
    enum Status: String { case added, modified, deleted, renamed, untracked, conflicted }
    var path: String          // repo-relative; for renames, the new path
    var status: Status
    var staged: Bool
    var displayPath: String { path }
    var id: String { (staged ? "S:" : "U:") + path }
}

struct DiffRow: Hashable {
    enum Kind { case context, insert, delete }
    var kind: Kind
    var oldLine: Int?
    var newLine: Int?
    var text: String
}

struct DiffHunk: Hashable {
    var header: String        // the @@ line
    var rows: [DiffRow]
}
```

- [ ] **Step 4: Implement StatusParser** (`SCMParsers.swift`)

```swift
import Foundation

enum StatusParser {
    /// Parse `git status --porcelain=v1 --untracked-files=all` output.
    /// Each line is "XY <path>" (rename: "XY <old> -> <new>").
    /// X = index/staged state, Y = worktree/unstaged state.
    static func parse(porcelain: String) -> [FileChange] {
        var out: [FileChange] = []
        for raw in porcelain.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = String(raw)
            guard line.count >= 3 else { continue }
            let chars = Array(line)
            let x = chars[0], y = chars[1]
            var pathPart = String(chars[3...]).trimmingCharacters(in: .whitespaces)
            // Rename: "old -> new" — keep the new path.
            if let r = pathPart.range(of: " -> ") {
                pathPart = String(pathPart[r.upperBound...])
            }
            pathPart = unquote(pathPart)

            if x == "?" && y == "?" {
                out.append(FileChange(path: pathPart, status: .untracked, staged: false))
                continue
            }
            if x == "U" || y == "U" {
                out.append(FileChange(path: pathPart, status: .conflicted, staged: false))
                continue
            }
            if x != " " { out.append(FileChange(path: pathPart, status: status(for: x), staged: true)) }
            if y != " " { out.append(FileChange(path: pathPart, status: status(for: y), staged: false)) }
        }
        return out
    }

    private static func status(for code: Character) -> FileChange.Status {
        switch code {
        case "A": return .added
        case "D": return .deleted
        case "R": return .renamed
        case "M", "T": return .modified
        default:  return .modified
        }
    }

    /// git quotes paths containing special chars in double quotes; strip them.
    private static func unquote(_ s: String) -> String {
        guard s.hasPrefix("\""), s.hasSuffix("\""), s.count >= 2 else { return s }
        return String(s.dropFirst().dropLast())
    }
}
```

- [ ] **Step 5: Build the test target — confirm it compiles**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: `Build complete!`

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SCMModels.swift mac/Sources/LlmIdeMac/Services/SCMParsers.swift mac/Tests/LlmIdeMacTests/SCMParsersTests.swift
git commit -m "feat(scm): SCM models + git status porcelain parser"
```

---

## Task 3: UnifiedDiffParser (pure)

**Files:** Modify `SCMParsers.swift`; extend `SCMParsersTests.swift`.

- [ ] **Step 1: Write the failing test**

```swift
@Suite struct UnifiedDiffParserTests {
    @Test func parsesHunkWithInsertDeleteContext() {
        let diff = """
        diff --git a/f.swift b/f.swift
        index 111..222 100644
        --- a/f.swift
        +++ b/f.swift
        @@ -1,3 +1,3 @@
         let a = 1
        -let b = 2
        +let b = 20
         let c = 3
        """
        let hunks = UnifiedDiffParser.parse(diff)
        #expect(hunks.count == 1)
        let rows = hunks[0].rows
        // first row: context, old 1 / new 1
        #expect(rows[0].kind == .context && rows[0].oldLine == 1 && rows[0].newLine == 1)
        // delete row: old 2, no new
        #expect(rows.contains { $0.kind == .delete && $0.oldLine == 2 && $0.newLine == nil && $0.text == "let b = 2" })
        // insert row: new 2, no old
        #expect(rows.contains { $0.kind == .insert && $0.newLine == 2 && $0.oldLine == nil && $0.text == "let b = 20" })
    }

    @Test func emptyDiffYieldsNoHunks() {
        #expect(UnifiedDiffParser.parse("").isEmpty)
    }
}
```

- [ ] **Step 2: Build the test target — expect compile failure**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: FAIL — "cannot find 'UnifiedDiffParser'".

- [ ] **Step 3: Implement UnifiedDiffParser** (append to `SCMParsers.swift`)

```swift
enum UnifiedDiffParser {
    /// Parse a git unified diff into hunks of typed rows with line numbers.
    static func parse(_ diff: String) -> [DiffHunk] {
        var hunks: [DiffHunk] = []
        var current: DiffHunk?
        var oldLine = 0, newLine = 0

        for raw in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("@@") {
                if let c = current { hunks.append(c) }
                (oldLine, newLine) = Self.hunkStarts(line)
                current = DiffHunk(header: line, rows: [])
                continue
            }
            // Skip file headers / metadata.
            if current == nil { continue }
            if line.hasPrefix("diff --git") || line.hasPrefix("index ")
                || line.hasPrefix("--- ") || line.hasPrefix("+++ ")
                || line.hasPrefix("\\") { continue }

            guard let first = line.first else {
                // blank line within a hunk = an empty context line
                current?.rows.append(DiffRow(kind: .context, oldLine: oldLine, newLine: newLine, text: ""))
                oldLine += 1; newLine += 1
                continue
            }
            let body = String(line.dropFirst())
            switch first {
            case "+":
                current?.rows.append(DiffRow(kind: .insert, oldLine: nil, newLine: newLine, text: body))
                newLine += 1
            case "-":
                current?.rows.append(DiffRow(kind: .delete, oldLine: oldLine, newLine: nil, text: body))
                oldLine += 1
            default: // context (leading space)
                current?.rows.append(DiffRow(kind: .context, oldLine: oldLine, newLine: newLine, text: body))
                oldLine += 1; newLine += 1
            }
        }
        if let c = current { hunks.append(c) }
        return hunks
    }

    /// Parse "@@ -a,b +c,d @@" → (a, c).
    private static func hunkStarts(_ header: String) -> (Int, Int) {
        // Grab the "-a,b +c,d" segment between the @@ markers.
        let parts = header.split(separator: " ")
        var oldStart = 0, newStart = 0
        for p in parts {
            if p.hasPrefix("-") { oldStart = Int(p.dropFirst().split(separator: ",").first ?? "0") ?? 0 }
            if p.hasPrefix("+") { newStart = Int(p.dropFirst().split(separator: ",").first ?? "0") ?? 0 }
        }
        return (oldStart, newStart)
    }
}
```

- [ ] **Step 4: Build the test target — confirm it compiles**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: `Build complete!`

- [ ] **Step 5: Verify the pure parsers at runtime** (optional but cheap proof, since `swift test` won't run)

Write a throwaway check confirming the logic, then delete it. Skip if not convenient.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SCMParsers.swift mac/Tests/LlmIdeMacTests/SCMParsersTests.swift
git commit -m "feat(scm): unified diff parser"
```

---

## Task 4: SourceControlService

**Files:** Create `mac/Sources/LlmIdeMac/Services/SourceControlService.swift`.

- [ ] **Step 1: Implement the service**

```swift
import Foundation
import Observation

@MainActor
@Observable
final class SourceControlService {
    struct State {
        var branch: String?
        var ahead: Int = 0
        var behind: Int = 0
        var files: [FileChange] = []
        var isLoading = false
        var error: String?
    }

    private(set) var state = State()
    private let repo: RepoManager

    init(repo: RepoManager = RepoManager()) { self.repo = repo }

    var stagedFiles: [FileChange]   { state.files.filter { $0.staged } }
    var unstagedFiles: [FileChange] { state.files.filter { !$0.staged } }

    /// Refresh status + branch info for `root`. nil root → cleared state.
    func refresh(root: URL?) async {
        guard let root, isGitRepo(root) else { state = State(); return }
        state.isLoading = true; state.error = nil
        defer { state.isLoading = false }
        do {
            let porcelain = try await repo.runGit(
                ["status", "--porcelain=v1", "--untracked-files=all"], at: root)
            state.files = StatusParser.parse(porcelain: porcelain)
            state.branch = try? await repo.runGit(
                ["rev-parse", "--abbrev-ref", "HEAD"], at: root)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            // ahead/behind vs upstream (best-effort; no upstream → 0/0)
            if let counts = try? await repo.runGit(
                ["rev-list", "--count", "--left-right", "@{u}...HEAD"], at: root) {
                let nums = counts.split(whereSeparator: { $0 == "\t" || $0 == " " })
                    .compactMap { Int($0) }
                if nums.count == 2 { state.behind = nums[0]; state.ahead = nums[1] }
            } else { state.ahead = 0; state.behind = 0 }
        } catch {
            state.error = error.localizedDescription
        }
    }

    func diff(root: URL, path: String, staged: Bool) async -> [DiffHunk] {
        let args = staged ? ["diff", "--cached", "--", path] : ["diff", "--", path]
        guard let raw = try? await repo.runGit(args, at: root) else { return [] }
        return UnifiedDiffParser.parse(raw)
    }

    func stage(root: URL, path: String) async { await run(["add", "--", path], root) }
    func unstage(root: URL, path: String) async { await run(["restore", "--staged", "--", path], root) }

    /// Discard working-tree changes. Untracked files are deleted; tracked files
    /// are restored. Caller must confirm — this is destructive.
    func discard(root: URL, file: FileChange) async {
        if file.status == .untracked {
            try? FileManager.default.removeItem(at: root.appendingPathComponent(file.path))
        } else {
            await run(["restore", "--", file.path], root)
        }
        await refresh(root: root)
    }

    func commit(root: URL, message: String) async {
        do { try await repo.commit(at: root, message: message) }
        catch { state.error = error.localizedDescription }
        await refresh(root: root)
    }

    private func run(_ args: [String], _ root: URL) async {
        do { _ = try await repo.runGit(args, at: root); await refresh(root: root) }
        catch { state.error = error.localizedDescription }
    }

    private func isGitRepo(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathComponent(".git").path)
    }
}
```

(Confirm `RepoManager.commit(at:message:)` signature matches — adjust the call if the labels differ.)

- [ ] **Step 2: Build**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 3: Runtime-verify against a real temp repo** (this is the key proof)

In a scratch dir: `git init`, create a file, `git add`+`commit`, modify it, then exercise the service mentally against `git status --porcelain` output for that repo — or, after the panel exists (Task 6), point it at a real repo. Document the manual check in the task report.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SourceControlService.swift
git commit -m "feat(scm): SourceControlService over RepoManager"
```

---

## Task 5: UnifiedDiffView

**Files:** Create `mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift`. Reference the colored-row style in `mac/Sources/LlmIdeMac/Agent/Views/UpdateFileSheet.swift` (`diffRowView`, ~lines 190-242).

- [ ] **Step 1: Read `UpdateFileSheet.swift`** to match the existing row visuals (sign column, green/red row backgrounds, monospaced font, theme colors).

- [ ] **Step 2: Implement the view** (feed parsed git hunks; keep the visual style consistent with UpdateFileSheet)

```swift
import SwiftUI

/// Read-only unified diff renderer: colored +/− rows with old/new line
/// gutters. Fed by parsed git hunks (UnifiedDiffParser). Horizontal scroll,
/// no wrap (VSCode/Cursor pattern). Visual style mirrors UpdateFileSheet.
struct UnifiedDiffView: View {
    let hunks: [DiffHunk]
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        if hunks.isEmpty {
            VStack { Text("No changes to show").font(Typography.caption)
                .foregroundStyle(theme.current.textMuted) }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                        Text(hunk.header)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(theme.current.accent2)
                            .padding(.vertical, 2).padding(.horizontal, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(theme.current.surface2.opacity(0.5))
                        ForEach(Array(hunk.rows.enumerated()), id: \.offset) { _, row in
                            rowView(row)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func rowView(_ row: DiffRow) -> some View {
        let t = theme.current
        let bg: Color = row.kind == .insert ? Color.green.opacity(0.14)
                      : row.kind == .delete ? Color.red.opacity(0.14) : .clear
        let sign = row.kind == .insert ? "+" : row.kind == .delete ? "−" : " "
        HStack(spacing: 0) {
            gutter(row.oldLine); gutter(row.newLine)
            Text(sign).font(.system(size: 11, design: .monospaced))
                .foregroundStyle(t.textMuted).frame(width: 14)
            Text(row.text.isEmpty ? " " : row.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(t.text).fixedSize(horizontal: true, vertical: false)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1).background(bg)
    }

    private func gutter(_ n: Int?) -> some View {
        Text(n.map(String.init) ?? "")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(theme.current.textMuted.opacity(0.6))
            .frame(width: 40, alignment: .trailing).padding(.trailing, 4)
    }
}
```

- [ ] **Step 3: Build**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!` (confirm `Typography`/`ThemeStore` names match the codebase; fix if different.)

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift
git commit -m "feat(scm): unified diff view"
```

---

## Task 6: SourceControlView

**Files:** Create `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift`. Reference `ReviewView.swift` for the `HSplitView` shell + theme/env patterns, and how a view reaches `config.activeRepoLocalURL` (`@EnvironmentObject var config: AppConfig`).

- [ ] **Step 1: Implement the panel**

```swift
import SwiftUI

struct SourceControlView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @State private var scm = SourceControlService()
    @State private var selected: FileChange?
    @State private var hunks: [DiffHunk] = []
    @State private var message: String = ""
    @State private var confirmDiscard: FileChange?

    private var root: URL? { config.activeRepoLocalURL }

    var body: some View {
        Group {
            if let root {
                HSplitView {
                    leftPane(root).frame(minWidth: 280, idealWidth: 340, maxWidth: 520)
                    UnifiedDiffView(hunks: hunks).frame(minWidth: 360)
                }
            } else {
                emptyState
            }
        }
        .background(theme.current.body)
        .task(id: root?.path) { await scm.refresh(root: root) }
        .onChange(of: selected) { _, sel in
            guard let sel, let root else { hunks = []; return }
            Task { hunks = await scm.diff(root: root, path: sel.path, staged: sel.staged) }
        }
        .confirmationDialog("Discard changes?", isPresented: Binding(
            get: { confirmDiscard != nil }, set: { if !$0 { confirmDiscard = nil } }
        ), presenting: confirmDiscard) { file in
            Button("Discard \(file.displayPath)", role: .destructive) {
                if let root { Task { await scm.discard(root: root, file: file); confirmDiscard = nil } }
            }
        } message: { file in
            Text(file.status == .untracked
                 ? "“\(file.displayPath)” will be deleted."
                 : "Changes to “\(file.displayPath)” will be lost.")
        }
    }

    @ViewBuilder private func leftPane(_ root: URL) -> some View {
        VStack(spacing: 0) {
            branchHeader(root)
            Divider().background(theme.current.border)
            ScrollView {
                if let err = scm.state.error { errorBanner(err) }
                fileGroup("Staged Changes", scm.stagedFiles, root)
                fileGroup("Changes", scm.unstagedFiles, root)
            }
            Divider().background(theme.current.border)
            commitBox(root)
        }
    }

    private func branchHeader(_ root: URL) -> some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 12))
            Text(scm.state.branch ?? "—").font(Typography.bodyStrong)
            if scm.state.ahead > 0 { Text("↑\(scm.state.ahead)").font(Typography.caption) }
            if scm.state.behind > 0 { Text("↓\(scm.state.behind)").font(Typography.caption) }
            Spacer()
            Button { Task { await scm.refresh(root: root) } } label: {
                Image(systemName: "arrow.clockwise")
            }.buttonStyle(.plain).help("Refresh")
        }
        .foregroundStyle(theme.current.text)
        .padding(.horizontal, Spacing.md).padding(.vertical, Spacing.sm)
    }

    @ViewBuilder private func fileGroup(_ title: String, _ files: [FileChange], _ root: URL) -> some View {
        if !files.isEmpty {
            Text("\(title) (\(files.count))")
                .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Spacing.md).padding(.top, Spacing.sm)
            ForEach(files) { file in
                fileRow(file, root)
            }
        }
    }

    private func fileRow(_ file: FileChange, _ root: URL) -> some View {
        HStack(spacing: Spacing.xs) {
            Text(badge(file.status)).font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(color(file.status)).frame(width: 14)
            Text(file.displayPath).font(Typography.caption).lineLimit(1).truncationMode(.middle)
            Spacer()
            if file.staged {
                Button { Task { await scm.unstage(root: root, path: file.path) } } label: {
                    Image(systemName: "minus") }.buttonStyle(.plain).help("Unstage")
            } else {
                Button { Task { await scm.stage(root: root, path: file.path) } } label: {
                    Image(systemName: "plus") }.buttonStyle(.plain).help("Stage")
                Button { confirmDiscard = file } label: {
                    Image(systemName: "arrow.uturn.backward") }.buttonStyle(.plain).help("Discard")
            }
        }
        .padding(.horizontal, Spacing.md).padding(.vertical, 3)
        .background(selected == file ? theme.current.accent.opacity(0.12) : .clear)
        .contentShape(Rectangle())
        .onTapGesture { selected = file }
    }

    private func commitBox(_ root: URL) -> some View {
        VStack(spacing: Spacing.xs) {
            TextField("Commit message", text: $message, axis: .vertical)
                .textFieldStyle(.plain).lineLimit(1...4)
                .padding(Spacing.sm)
                .background(theme.current.surface2).clipShape(RoundedRectangle(cornerRadius: Radius.sm))
            Button {
                let msg = message
                Task { await scm.commit(root: root, message: msg); message = "" }
            } label: { Text("Commit").frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent)
            .disabled(scm.stagedFiles.isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(Spacing.md)
    }

    private func errorBanner(_ msg: String) -> some View {
        Text(msg).font(Typography.caption).foregroundStyle(theme.current.danger)
            .padding(Spacing.sm).frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.sm) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 28))
                .foregroundStyle(theme.current.textMuted)
            Text("No active repository").font(Typography.bodyStrong)
            Text("Activate a cloned repo in Settings → GitLab / GitHub.")
                .font(Typography.caption).foregroundStyle(theme.current.textMuted)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func badge(_ s: FileChange.Status) -> String {
        switch s { case .added: return "A"; case .modified: return "M"; case .deleted: return "D"
        case .renamed: return "R"; case .untracked: return "U"; case .conflicted: return "C" }
    }
    private func color(_ s: FileChange.Status) -> Color {
        switch s { case .added, .untracked: return .green; case .deleted: return .red
        case .conflicted: return .orange; default: return theme.current.accent2 }
    }
}
```

- [ ] **Step 2: Build** — `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build`. Fix any `Spacing`/`Radius`/`Typography`/`AppConfig.activeRepoLocalURL` name mismatches against the real codebase. Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift
git commit -m "feat(scm): source control panel view"
```

---

## Task 7: Sidebar wiring

**Files:** Modify `Services/ShellState.swift`, `Views/Shell/SidebarView.swift`, `Views/AppShell.swift`.

- [ ] **Step 1: Add the section case** in `ShellState.Section` (`ShellState.swift:9`): add `sourceControl` to the enum's case list. Then add its arms:
  - `label`: `case .sourceControl: return "Source Control"`
  - `systemImage`: `case .sourceControl: return "arrow.triangle.branch"`
  - `tint`: `case .sourceControl: return Color(red: 0.30, green: 0.70, blue: 0.45)` (green family)
  - `category`: add `.sourceControl` to the "Code" group return.
  - Add to `userHideable` if other code sections are hideable.

- [ ] **Step 2: Route it** in `AppShell.sectionView(for:)` (`AppShell.swift:337`): `case .sourceControl: SourceControlView(api: api)`.

- [ ] **Step 3: Add to the sidebar list** in `SidebarView.swift` `codeSections` array so it renders.

- [ ] **Step 4: Build + launch smoke test**

Run: `cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build` → `Build complete!`
Then launch `.build/debug/LlmIdeMac` and confirm the app starts without crashing (the Source Control item appears in the sidebar once signed in).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ShellState.swift mac/Sources/LlmIdeMac/Views/Shell/SidebarView.swift mac/Sources/LlmIdeMac/Views/AppShell.swift
git commit -m "feat(scm): add Source Control sidebar section"
```

---

## Task 8: Syntax highlighting in the diff (final, optional within Phase 1)

**Files:** Modify `Views/SourceControl/UnifiedDiffView.swift`. Reference `CodeWebView` in `Views/Library/FileDetailView.swift` for the vendored highlight.js approach.

- [ ] **Step 1:** Decide the lightest integration: render each diff row's text through highlight.js (per-language by file extension) while preserving the +/− gutters and row backgrounds, OR keep SwiftUI rows and apply a minimal Swift tokenizer. If highlight.js-in-diff proves heavy, STOP and ship Task 7's colored-rows version as Phase 1 — record it as a Phase-2 follow-up. Do not block the working panel on this.

- [ ] **Step 2: Build** — `Build complete!`

- [ ] **Step 3: Commit** (only if implemented)

```bash
git add mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift
git commit -m "feat(scm): syntax-highlight diff rows"
```

---

## Self-review (completed)

- **Spec coverage:** status model + parser (T2), diff parser (T3), service with refresh/diff/stage/unstage/discard/commit + branch/ahead-behind (T4), diff view (T5), panel with file groups/commit box/empty state/discard confirm (T6), sidebar section (T7), syntax highlighting (T8, deferrable). Target repo = `config.activeRepoLocalURL` (T6). All spec sections mapped.
- **Placeholder scan:** no TBD/"handle errors"/vague steps — code blocks present for every code step; T8 is explicitly optional-within-phase with a clear ship-without fallback.
- **Type consistency:** `FileChange`/`DiffRow`/`DiffHunk` defined in T2/T3 and used unchanged in T4/T5/T6; `SourceControlService` method signatures (`refresh(root:)`, `diff(root:path:staged:)`, `stage/unstage(root:path:)`, `discard(root:file:)`, `commit(root:message:)`) are consistent across T4 and T6; `runGit(_:at:)` defined T1, used T4.
- **Confirm-against-codebase flags for the implementer:** `RepoManager.commit` label shape (T4), `Typography`/`Spacing`/`Radius`/`ThemeStore`/`AppConfig.activeRepoLocalURL` names (T5/T6), and the exact `ShellState`/`SidebarView` arm locations (T7).
