# Cursor Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Terminal toggle + repo-aware cwd, git pull/push/sync/branch in Source Control, editor gutter change markers, and syntax-highlighted diffs.

**Architecture:** Extend `SourceControlService`/`RepoManager` for remote+branch ops; add a visible terminal toggle and repo-aware cwd; add a pure `GitGutter` helper feeding `CodeWebView`; re-render `UnifiedDiffView` via `WKWebView` + highlight.js.

**Tech Stack:** Swift / SwiftUI, WKWebView + vendored highlight.js, `/usr/bin/git` via RepoManager, swift-testing.

**Environment note:** `swift test` does not execute here (no XCTest runner). "Run test" = `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests` (dangerouslyDisableSandbox: true). App build = `GIT_CONFIG_GLOBAL=/dev/null swift build`. Verify UI by build + launch smoke; verify git command sequences against a temp repo on disk.

**Build order (two waves):** Wave 1 = Tasks 1 (terminal) + 2 (diff highlight) — small, low-risk. Wave 2 = Tasks 3 (git header) + 4 (gutter).

---

## Task 1: Terminal — visible toggle + repo-aware cwd

**Files:** Modify `Views/Shell/StatusBar.swift`, `Views/AppShell.swift`.

- [ ] **Step 1: Repo-aware cwd.** In `AppShell.swift` `projectDirectory` (~line 110), prefer the active SCM repo:

```swift
private var projectDirectory: URL {
    // Prefer the active Source Control repo so the terminal's git matches
    // the SCM panel; fall back to the active project folder, then home.
    if let repo = config.activeRepoLocalURL,
       FileManager.default.fileExists(atPath: repo.path) {
        return repo
    }
    if let path = projectStore.activeProject?.localPath,
       !path.isEmpty, FileManager.default.fileExists(atPath: path) {
        return URL(fileURLWithPath: path)
    }
    return FileManager.default.homeDirectoryForCurrentUser
}
```

(Confirm `config` is reachable in AppShell — it is via `@EnvironmentObject`. Confirm `activeRepoLocalURL` type is `URL?`.)

- [ ] **Step 2: Visible toggle in StatusBar.** Read `Views/Shell/StatusBar.swift` to match its layout/theme. Add a terminal toggle button that reads `@Environment(TerminalPanelState.self)` and calls `terminalPanelState.toggle(projectDirectory:)`. It needs the same `projectDirectory`; expose a small computed there mirroring AppShell's, OR read `config.activeRepoLocalURL`/project. Show `terminal` SF Symbol, filled/tinted when `state.isOpen`. Tooltip "Toggle terminal (⌃`)".

```swift
// inside StatusBar body, in the trailing controls cluster:
Button { terminalPanelState.toggle(projectDirectory: terminalCwd) } label: {
    Image(systemName: "terminal")
        .foregroundStyle(terminalPanelState.isOpen ? theme.current.accent : theme.current.textMuted)
}
.buttonStyle(.plain)
.help("Toggle terminal (⌃`)")
```

(Add `@Environment(TerminalPanelState.self) private var terminalPanelState` and `@EnvironmentObject var config: AppConfig` to StatusBar if not present; both are injected at the AppShell root. Define `terminalCwd` mirroring the AppShell logic.)

- [ ] **Step 3: Build + launch smoke.** `GIT_CONFIG_GLOBAL=/dev/null swift build` → Build complete!. Launch `.build/debug/LlmIdeMac`, confirm alive.

- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(scm): visible terminal toggle + repo-aware terminal cwd"`

---

## Task 2: Diff syntax highlighting (web-based UnifiedDiffView)

**Files:** Modify `Views/SourceControl/UnifiedDiffView.swift`. Reference `CodeWebView` in `Views/Library/FileDetailView.swift` for the vendored highlight.js loading (Resources/highlight.min.js + atom-one-dark/light CSS) and the extension→language map.

- [ ] **Step 1: Read `CodeWebView`** to copy the highlight.js HTML/CSS scaffold (how it inlines the JS/CSS into a WKWebView, the line-number gutter grid, dark/light theme switch, and `languageClass(for ext:)`).

- [ ] **Step 2: Re-implement `UnifiedDiffView`** to take `hunks: [DiffHunk]` plus a `fileExtension: String` (for language) and render via `WKWebView`:
  - Build an HTML table; each `DiffRow` → a `<tr>` with: old-line gutter cell, new-line gutter cell, sign cell (`+`/`−`/` `), and a `<td class="code language-<lang>">` with HTML-escaped text.
  - Row class `add`/`del`/`ctx` → CSS green/red/none background.
  - After load, run `hljs.highlightElement` on each code cell (or `hljs.highlightAll`), preserving the row backgrounds (highlight only the code cell).
  - Hunk header rows rendered as a muted full-width row.
  - No-wrap + horizontal scroll; theme via the app's dark/light (pass `isDark`).
  - The view's public init must accept what `SourceControlView` can provide — update the call site to pass the selected file's extension (e.g. `(sel.path as NSString).pathExtension`).

- [ ] **Step 3: Update the call site** in `SourceControlView.swift` to pass `fileExtension` from the selected `FileChange`.

- [ ] **Step 4: Build + launch smoke.** Build complete!; launch; alive. (Highlighting itself is visual — confirm no crash + the diff still renders; full visual check is manual.)

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(scm): syntax-highlighted diff via highlight.js"`

---

## Task 3: Git header — pull / push / sync + branch switcher

**Files:** Modify `Services/RepoManager.swift`, `Services/SourceControlService.swift`, `Views/SourceControl/SourceControlView.swift`.

- [ ] **Step 1: Authenticated `fetch` on RepoManager.** Add (mirroring `pull`):

```swift
func fetch(at repoURL: URL, token: String, backend: Backend = .gitlab, remote: String = "origin") async throws {
    try await stripRemoteCredentials(at: repoURL, remote: remote)
    _ = try await git(["fetch", remote], cwd: repoURL, token: token, backend: backend)
    log.info("repo_fetched path=\(repoURL.path, privacy: .public)")
}
```

- [ ] **Step 2: Backend/token resolution + remote/branch ops in `SourceControlService`.** Add a way for the service to resolve the active repo's backend + token. Since the service shouldn't depend on AppConfig directly if avoidable, accept a resolver: add an optional closure `var credentials: ((URL) -> (token: String, backend: RepoManager.Backend)?)?` set by the view, OR pass `AppConfig` in. Recommended: the view passes a small struct/closure. Implement:

```swift
// Resolved by the caller (SourceControlView) from config.gitLabSavedProjects/
// gitHubSavedRepos by matching localPath == root.path.
var resolveCredentials: ((URL) -> (token: String, backend: RepoManager.Backend)?)?

var canRemote: Bool { state.branch != nil }   // refined by token presence in the view

func pull(root: URL) async {
    guard let c = resolveCredentials?(root), !c.token.isEmpty else {
        state.error = "No credentials configured for this repo."; return
    }
    do { try await repo.pull(at: root, token: c.token, backend: c.backend) }
    catch { state.error = error.localizedDescription }
    await refresh(root: root)
}
// push(root:) → needs current branch (state.branch); repo.push(at:branch:token:backend:)
// sync(root:)  → repo.fetch(...) then refresh(root:)
func listBranches(root: URL) async -> [String] {
    guard let out = try? await repo.runGit(["branch", "--format=%(refname:short)"], at: root) else { return [] }
    return out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}
func checkout(root: URL, branch: String) async {
    do { _ = try await repo.runGit(["checkout", branch], at: root) }
    catch { state.error = error.localizedDescription }
    await refresh(root: root)
}
```

(`push` uses `state.branch`; if nil, set error. Adjust signatures to your final shape; keep them consistent with the view calls.)

- [ ] **Step 3: Header UI in `SourceControlView`.** In the branch header, add: Pull (`arrow.down`), Push (`arrow.up`), Sync (`arrow.triangle.2.circlepath`) buttons, and a branch `Menu` (label = current branch with a `chevron`, items = `listBranches` results → `checkout`). Wire credential resolution:

```swift
.task(id: root?.path) {
    scm.resolveCredentials = { repo in
        if let p = config.gitLabSavedProjects.first(where: { $0.localPath == repo.path }), !config.gitLabToken.isEmpty {
            return (config.gitLabToken, .gitlab)
        }
        if let r = config.gitHubSavedRepos.first(where: { $0.localPath == repo.path }), !config.gitHubToken.isEmpty {
            return (config.gitHubToken, .github)
        }
        return nil
    }
    await scm.refresh(root: root)
}
```

Disable Pull/Push when `scm.resolveCredentials?(root) == nil` (tooltip "Configure a token in Settings"). Show a spinner / disable all during an in-flight op (add an `isBusy` flag or reuse `state.isLoading`). Errors already surface via the banner.

(Confirm `SavedGitLabProject.localPath` / `SavedGitHubRepo.localPath` field names; confirm `RepoManager.Backend` is the right type name and `.gitlab`/`.github` cases.)

- [ ] **Step 4: Build + runtime-verify git ops on a temp repo.** Build complete!. Then in a scratch repo with a local bare "remote": create `git init` + a bare remote + `git push`/`fetch`/`branch`/`checkout` to confirm the exact command sequences the service issues work (paste output). Launch smoke.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(scm): pull/push/sync + branch switcher in Source Control header"`

---

## Task 4: Editor gutter change decorations

**Files:** Create `Services/GitGutter.swift`; Modify `Views/Library/FileDetailView.swift`. Test `Tests/.../GitGutterTests.swift`.

- [ ] **Step 1: Write the failing test** (pure line-range extraction):

```swift
import Testing
@testable import LlmIdeMac

@Suite struct GitGutterTests {
    @Test func extractsAddedAndModifiedNewSideLines() {
        let diff = """
        @@ -1,2 +1,3 @@
         keep
        -old
        +new1
        +new2
        """
        let map = GitGutter.changedLines(fromDiff: diff)
        // new1 replaces old (modified region), new2 is an addition — both on new side
        #expect(map[2] != nil)   // new1 at new-line 2
        #expect(map[3] != nil)   // new2 at new-line 3
        #expect(map[1] == nil)   // context line unchanged
    }
}
```

- [ ] **Step 2: Build test target — expect compile failure.** `swift build --build-tests` → cannot find GitGutter.

- [ ] **Step 3: Implement `GitGutter`** (pure mapping over `UnifiedDiffParser`):

```swift
import Foundation

enum GitGutter {
    enum Mark { case added, modified }

    /// New-side line number → change mark, derived from a unified diff.
    /// A run of inserts adjacent to deletes is "modified"; pure inserts are "added".
    static func changedLines(fromDiff diff: String) -> [Int: Mark] {
        var marks: [Int: Mark] = [:]
        for hunk in UnifiedDiffParser.parse(diff) {
            var sawDeleteInRun = false
            for row in hunk.rows {
                switch row.kind {
                case .delete: sawDeleteInRun = true
                case .insert:
                    if let n = row.newLine { marks[n] = sawDeleteInRun ? .modified : .added }
                case .context: sawDeleteInRun = false
                }
            }
        }
        return marks
    }

    /// Compute marks for a file inside a repo (async; empty when not a repo / clean).
    static func changedLines(repo: URL, filePath: String, runGit: ([String], URL) async throws -> String) async -> [Int: Mark] {
        guard let raw = try? await runGit(["diff", "--", filePath], repo), !raw.isEmpty else { return [:] }
        return changedLines(fromDiff: raw)
    }
}
```

- [ ] **Step 4: Build test target — confirm it compiles.** `swift build --build-tests` → Build complete!

- [ ] **Step 5: Inject markers into `CodeWebView`.** Read `FileDetailView.swift` `CodeWebView`. Add an optional `changedLines: [Int: GitGutter.Mark] = [:]` input. In the HTML gutter rows, add a CSS class (`g-add`/`g-mod`) to the line whose number is in the map, with a left border bar (green/blue). Compute `changedLines` when the file view appears (and after save) using `GitGutter.changedLines(repo:filePath:runGit:)` where `repo` is the file's containing git repo (walk up to `.git`, or use `config.activeRepoLocalURL` if the file is inside it) and `runGit` is `RepoManager().runGit`. No-op (empty map) when the file isn't in a repo.

- [ ] **Step 6: Build + launch smoke.** Build complete!; launch; alive.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(scm): editor gutter change markers via git diff"`

---

## Self-review (completed)

- **Spec coverage:** terminal toggle+cwd (T1), diff highlight (T2), pull/push/sync/branch (T3), gutter markers (T4). All four spec features mapped.
- **Placeholder scan:** code blocks present for each code step; the integration steps (T2/T3/T4 UI) carry explicit "confirm against codebase" notes rather than vague directions, and pure logic (GitGutter, listBranches parse) has complete code.
- **Type consistency:** `RepoManager.fetch` (T3.1) used by `SourceControlService.sync` (T3.2); `GitGutter.Mark`/`changedLines` (T4.3) used by `CodeWebView` (T4.5); `resolveCredentials` closure shape consistent T3.2↔T3.3.
- **Confirm-against-codebase flags:** `activeRepoLocalURL` type, `TerminalPanelState` env access in StatusBar, `SavedGitLabProject.localPath`/`SavedGitHubRepo.localPath`, `RepoManager.Backend` case names, `CodeWebView` HTML structure + extension→language map.
