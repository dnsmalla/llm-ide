# Comprehensive Git Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** VS Code/Cursor-parity git: branch mgmt + auto-refresh, commit history, stash/amend/commit&push/discard-all, merge/blame/tags.

**Architecture:** Extend `SourceControlService` with new ops + pure parsers (log/blame/stash); extend `SourceControlView` (branch menu, History toggle, stash/amend/discard menus); optional blame gutter in `FileDetailView`. All via `RepoManager.runGit` / authenticated push.

**Tech Stack:** Swift / SwiftUI, `/usr/bin/git` via RepoManager, swift-testing.

**Environment note:** `swift test` doesn't run here. "Run test" = `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests` (dangerouslyDisableSandbox: true). App build = `GIT_CONFIG_GLOBAL=/dev/null swift build`. Verify git command sequences against a temp repo (with a bare remote where needed); build + launch smoke for UI.

**Build order (waves):** W1 = Task 1 (branch mgmt + auto-refresh). W2 = Task 2 (history). W3 = Task 3 (stash/amend/commit&push/discard-all). W4 = Task 4 (merge/blame/tags). Each wave: implement → review → fix → next.

Deferred (NOT in this plan): interactive rebase, cherry-pick, 3-way conflict editor, remote management.

---

## Task 1: Branch management + auto-refresh

**Files:** `Services/SourceControlService.swift`, `Views/SourceControl/SourceControlView.swift`.

- [ ] **Step 1: Service ops.** Add to `SourceControlService`:
  - `func createBranch(root: URL, name: String) async` → `run(["checkout","-b",name], root)` (refreshes via `run`).
  - `func deleteBranch(root: URL, name: String, force: Bool = false) async` → `run(["branch", force ? "-D" : "-d", name], root)`.
  - `func publish(root: URL) async` → resolve creds (like `push`); if no upstream, `repo.push(at:branch:token:backend:)` with current `state.branch` (push already uses `--set-upstream`); refresh. Errors → `state.error`.
  - `var hasUpstream: Bool` — derive from `state.ahead`/`behind` reliability is weak; instead compute in refresh: run `git rev-parse --abbrev-ref --symbolic-full-name @{u}` and set `state.hasUpstream = (exit 0)`. Add `hasUpstream` to `State` (default false).
- [ ] **Step 2: Auto-refresh fix.** In `SourceControlView`:
  - Add an `.onAppear { Task { await scm.refresh(root: root) } }` (fires every entry, not just root change).
  - Add a visible-only poll: `@State private var poll: Task<Void,Never>?`; on appear start a loop `while !Task.isCancelled { try? await Task.sleep(3s); if !scm.isBusy { await scm.refresh(root: root) } }`; cancel on `.onDisappear`. (Guard against overlap with `isBusy`.)
- [ ] **Step 3: Branch menu UI.** Extend the branch `Menu`: a **Create Branch…** item (presents a small sheet/alert with a `TextField` → `createBranch`), a **Publish Branch** item shown when `!scm.state.hasUpstream`, a **Delete** submenu/per-branch action (confirm), plus existing switch. Current-branch label binds to `scm.state.branch` and updates via refresh.
- [ ] **Step 4: Build + runtime-verify** (`checkout -b`, `branch -d`, `rev-parse @{u}`, `push -u`) against a temp repo + bare remote. Build complete!; launch smoke.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(scm): branch create/delete/publish + auto-refresh poll"`

---

## Task 2: Commit history

**Files:** Create `Services/GitLog.swift` (pure parsers) + `Tests/.../GitLogTests.swift`; modify `SourceControlService.swift`, `SourceControlView.swift`.

- [ ] **Step 1: Write the failing test** (log parser):

```swift
import Testing
@testable import LlmIdeMac
@Suite struct GitLogTests {
    @Test func parsesLogLines() {
        // fields delimited by US (0x1f), records by newline
        let us = "\u{1f}"
        let out = "abc123\(us)abc\(us)Jane\(us)2 days ago\(us)Fix bug\ndef456\(us)def\(us)Bob\(us)1 week ago\(us)Add feature"
        let commits = GitLog.parse(out)
        #expect(commits.count == 2)
        #expect(commits[0].shortSha == "abc")
        #expect(commits[0].author == "Jane")
        #expect(commits[0].subject == "Fix bug")
        #expect(commits[1].subject == "Add feature")
    }
}
```

- [ ] **Step 2: Build test target — expect compile failure.**

- [ ] **Step 3: Implement `GitLog`:**

```swift
import Foundation
struct Commit: Identifiable, Hashable {
    let sha: String; let shortSha: String; let author: String
    let relativeDate: String; let subject: String
    var id: String { sha }
}
enum GitLog {
    /// Parse `git log --pretty=%H%x1f%h%x1f%an%x1f%ar%x1f%s` (US-delimited
    /// fields, newline-delimited records).
    static func parse(_ out: String) -> [Commit] {
        out.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line in
            let f = line.components(separatedBy: "\u{1f}")
            guard f.count == 5 else { return nil }
            return Commit(sha: f[0], shortSha: f[1], author: f[2], relativeDate: f[3], subject: f[4])
        }
    }
}
```

- [ ] **Step 4: Service ops.** Add to `SourceControlService`:
  - `func log(root: URL, limit: Int = 100) async -> [Commit]` → `runGit(["log","--pretty=%H%x1f%h%x1f%an%x1f%ar%x1f%s","-n","\(limit)"], at: root)` → `GitLog.parse`.
  - `func commitDiff(root: URL, sha: String) async -> [DiffHunk]` → `runGit(["show","--format=","--", ] ...)` actually `["show","--format=", sha]` → `UnifiedDiffParser.parse`.
- [ ] **Step 5: UI.** In `SourceControlView` add a **Changes / History** segmented toggle at the top of the left pane. History mode lists `[Commit]` rows (shortSha · subject · author · relativeDate); selecting a commit loads `commitDiff` into the right `UnifiedDiffView`. Load the log on entering History (and on refresh).
- [ ] **Step 6: Build (app + tests) + runtime-verify** `git log --pretty=...` and `git show` against a temp repo with ≥2 commits. Build complete!; smoke.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(scm): commit history + per-commit diff"`

---

## Task 3: Stash / amend / commit & push / discard-all

**Files:** `Services/SourceControlService.swift`, `Views/SourceControl/SourceControlView.swift`.

- [ ] **Step 1: Service ops.**
  - `stashPush(root:message:)` → `git stash push -u` (+ `-m msg` when non-empty) → refresh.
  - `stashList(root:) -> [Stash]` → `git stash list` parsed to `Stash { index: Int, message: String }` (line `stash@{0}: WIP on …` → index 0, message tail). Add a pure parser + a test.
  - `stashPop(root:index:)` → `git stash pop "stash@{\(index)}"` → refresh.
  - `amend(root:message:)` → `git commit --amend` + (`-m msg` if non-empty else `--no-edit`) → refresh.
  - `commitAndPush(root:message:)` → `commit(...)` (commit-all-aware) then `push(...)` → refresh.
  - `discardAll(root:)` → `runGit(["checkout","--","."], root)` then `runGit(["clean","-fd"], root)` → refresh. (Destructive — caller confirms.)
- [ ] **Step 2: UI.**
  - A **stash** control (menu): "Stash changes" (optional message), "Pop latest"/list of stashes → pop.
  - An **Amend** checkbox/toggle next to Commit; when on, the Commit button calls `amend`.
  - A **Commit & Push** button (secondary action near Commit) → `commitAndPush`.
  - A **Discard All Changes** item in a `…` menu on the Changes header → destructive `confirmationDialog` ("This deletes all uncommitted changes and untracked files") → `discardAll`.
- [ ] **Step 3: Build + runtime-verify** (`stash push -u`, `stash list`, `stash pop`, `commit --amend`, `checkout -- .` + `clean -fd`) against a temp repo. Build (app+tests) complete!; smoke.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(scm): stash, amend, commit&push, discard-all"`

---

## Task 4: Merge / blame / tags

**Files:** `Services/SourceControlService.swift`, `Services/GitLog.swift` (blame parser) + test, `Views/SourceControl/SourceControlView.swift`, `Views/Library/FileDetailView.swift` (blame gutter).

- [ ] **Step 1: Service ops.**
  - `merge(root:branch:)` → `runGit(["merge", branch], root)` → refresh (conflicts → `state.error` + status shows `U` files).
  - `tags(root:) -> [String]` → `git tag --sort=-creatordate`; `createTag(root:name:)` → `git tag <name>` → refresh.
  - `blame(root:path:) -> [BlameLine]` → `git blame --line-porcelain -- <path>` parsed to `BlameLine { line: Int, shortSha: String, author: String }`. Add a pure blame parser + test (porcelain: a header line `<sha> <orig> <final> <n>`, then `author X`, … then `\t<code>` per line).
- [ ] **Step 2: UI.**
  - Branch menu → **Merge "<branch>" into current** (per other branch).
  - A **tags** entry in a `…` menu (list + Create Tag…).
  - **Blame gutter** in `FileDetailView`: a toggle that, when on, computes `blame` for the file and shows `shortSha · author` in a left margin per line (lazy, capped). Off by default.
- [ ] **Step 3: Build (app+tests) + runtime-verify** (`merge`, `tag`, `blame --line-porcelain`) against a temp repo with 2 branches. Build complete!; smoke.
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(scm): merge, blame gutter, tags"`

---

## Self-review (completed)

- **Spec coverage:** branch mgmt+refresh (T1), history (T2), stash/amend/commit&push/discard (T3), merge/blame/tags (T4). Deferred items explicitly out. All in-scope spec features mapped.
- **Placeholder scan:** pure parsers (GitLog, stash, blame) have complete code + tests; service ops have exact git commands; UI steps enumerate concrete controls.
- **Type consistency:** `Commit`/`Stash`/`BlameLine` defined where first used; `commitDiff`/`log` feed `UnifiedDiffParser`/`UnifiedDiffView` (existing); service method names consistent with UI calls; `state.hasUpstream` added in T1 used by Publish.
- **Confirm-against-codebase flags:** `RepoManager.runGit`/`push` signatures; `SourceControlService.run` helper (refreshes); `state` struct extension; `UnifiedDiffView`/`FileDetailView` reuse; `isBusy` guard for the poll; credential resolver reuse for publish/commit&push.
