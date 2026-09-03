# VS Code Parity P2: Source Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `UnifiedDiffView`'s WKWebView+highlight.js diff renderer with Monaco's real diff editor (`MonacoHost.showDiff`, built in P0), add real hunk-level git staging (currently only whole-file staging exists), and collapse three of the app's other independent diff re-implementations onto the same shared model. Changes-list UX gets multi-select, keyboard nav, a context menu, and rename `old → new` display.

**Architecture:** Per design §5, Monaco *renders* diffs Swift supplies (`showDiff(original:modified:language:)`); Swift stays the source of truth for what's staged and how a patch is built. This plan splits "view a diff" from "act on a diff": a new `MonacoDiffView` (mirroring P1's `MonacoEditorView`) gives every consumer the same rich, read-only visual (word-level highlighting, no custom JS needed); a new native SwiftUI hunk list — chosen over custom Monaco gutter widgets specifically because this session cannot visually verify live WebView JS, and a native list is simpler, testable, and needs no JS at all — sits alongside it in Source Control's Changes mode and drives the new stage/unstage-one-hunk capability. `DiffHunk`/`DiffRow` (already the shared parse-target for real git diffs) become the one model every consumer renders from, including the two consumers that don't have a `git diff` to parse (`UpdateFileSheet`, `DiffStats`) — a new pure `DiffHunk.fromLineDiff(old:new:)` helper produces the same model from a raw string comparison, replacing two independent `CollectionDifference` re-implementations with one.

**Tech Stack:** Swift 5 (macOS 14+ target), SwiftUI, Foundation `Process`/`Pipe` (extended for stdin — new to this codebase), XCTest.

**Spec:** [docs/superpowers/specs/2026-09-03-vscode-parity-explorer-scm-search-design.md](../specs/2026-09-03-vscode-parity-explorer-scm-search-design.md) — read §3 finding #2 (the five duplicate diff implementations), §5, §6.4 (`GutterAction`/`HunkAction`, already built in P0 but unconsumed until this plan), §7 (hunk staging's exact git-apply data flow), §11 P2 bullet.

**Prior phases:** P0 (foundation, merged `main@63f23cca`) and P1 (Editor, merged `main@d4a3446e`). This plan builds directly on both — `MonacoHost`, `GitTruthStore`, `MonacoLanguageMap`, and the `MonacoEditorView`/`MonacoEditorMessageHandler` pattern this plan's `MonacoDiffView` mirrors are all real, reviewed code already on `main`.

## Global Constraints

- Swift 6 language mode is NOT enabled (`swiftLanguageModes: [.v5]` in `Package.swift`) — do not add strict-concurrency-only syntax.
- No raw `Color.green`/`.red`/`.orange` in new or touched view code — always a `Theme` token (existing project rule, `Theme.swift:88-91`; this plan's native hunk rendering uses the `diffAddedBg`/`diffAddedFg`/`diffDeletedBg`/`diffDeletedFg` tokens P0 already added).
- `MonacoHost`'s bridge methods stay `private` on its `Coordinator` — every interaction goes through its declarative properties, exactly as P1's `MonacoEditorView` already does. This plan's `MonacoDiffView` follows the identical pattern.
- `MonacoRevealRequest`-style "hold in `@State`, never construct inline in `body`" applies equally to `MonacoDiffRequest` where used — construct it in a method (`onChange`/`.task`), never inline.
- This toolchain (Xcode Command Line Tools only, no full Xcode) cannot run `swift test` (no XCTest/Testing runtime — see memory `mac-build-environment`). Every task's "run the test" step still means literally running the command; if it fails with `no such module 'XCTest'`, treat that as an environment limitation, not a task failure, and confirm via `swift build`/`swift build --build-tests` (compiles, which this toolchain CAN do) instead. State this explicitly when it happens — do not claim the test passed.
- Per design §9: view-glue code (SwiftUI + `WKWebView`) has no live-WebView test harness in this codebase — confirmed manually per the checklist, not by XCTest. Pure logic (parsers, patch synthesis, the `DiffHunk.fromLineDiff` helper) gets real tests.
- **`git apply --cached` is destructive to the git index if given a malformed patch** (it can fail cleanly, which is fine, but a subtly-wrong patch that "succeeds" corrupts the index). Every task touching patch synthesis or `RepoManager`'s new stdin path must run its test against a REAL temp git repo (not a mock), verified via `git diff --cached`/`git status --porcelain` after the operation — mocking `git apply`'s own semantics would defeat the point of testing it.
- Scope calls already made (do not re-litigate mid-plan; each is explained where it applies): `DiffStats` (the small chat-card diff-count chip) keeps its own lightweight rendering — converting a 3-line chat bubble preview into a Monaco/WKWebView instance would be pure overhead, not a real duplicate-view problem. History mode's multi-file commit diff is redesigned to a per-file browse (commit → file list → single-file `MonacoDiffView`), never multiple simultaneous Monaco instances. `CodeWorkflowSheet`'s per-file previews get real `UnifiedDiffParser`-based native rendering (Theme-colored, no WKWebView) rather than Monaco, since its `DisclosureGroup` list can have several files' previews mounted at once.

---

## File Structure

**New files:**
- `mac/Sources/LlmIdeMac/Views/Shared/MonacoDiffView.swift` — the new owning view wrapping `MonacoHost`'s `diffRequest` (mirrors `MonacoEditorView.swift`'s pattern)
- `mac/Sources/LlmIdeMac/Views/SourceControl/HunkStagingList.swift` — native SwiftUI hunk list with per-hunk Stage/Unstage buttons
- `mac/Tests/LlmIdeMacTests/RepoManagerStdinTests.swift`
- `mac/Tests/LlmIdeMacTests/GitTruthStorePatchTests.swift`
- `mac/Tests/LlmIdeMacTests/DiffHunkLineDiffTests.swift`

**Modified files:**
- `mac/Sources/LlmIdeMac/Services/RepoManager.swift` — `git(_:cwd:token:backend:timeout:)` gains an optional `stdin: Data?` parameter; `runGit` gains a stdin-accepting overload
- `mac/Sources/LlmIdeMac/Services/GitTruthStore.swift` — gains `stagePatch(root:hunk:path:)`/`unstagePatch(root:hunk:path:)`
- `mac/Sources/LlmIdeMac/Services/SCMModels.swift` — `FileChange` gains `renamedFrom: String?`; `DiffHunk` gains `static func fromLineDiff(old:new:) -> [DiffHunk]`
- `mac/Sources/LlmIdeMac/Services/SCMParsers.swift` — `StatusParser.parse` retains the old path for renames instead of discarding it
- `mac/Sources/LlmIdeMac/Services/SourceControlService.swift` — gains `diffContent(root:file:)`, `commitFiles(root:sha:)`, `commitFileContent(root:sha:path:)`
- `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` — Changes-mode right pane becomes `MonacoDiffView` + `HunkStagingList`; History mode becomes commit → file list → `MonacoDiffView`; `fileRow`/changes list gain multi-select, keyboard nav, context menu, rename display
- `mac/Sources/LlmIdeMac/Agent/Views/UpdateFileSheet.swift` — diff preview becomes `MonacoDiffView`; private `DiffRow`/`diffRows`/`diffRowView` deleted; change-count chip reuses `DiffStats.compute`
- `mac/Sources/LlmIdeMac/Services/CodeWorkflowService.swift` — `parseDiffFiles` uses `UnifiedDiffParser.parse` instead of its `+`-line-grep reconstruction
- `mac/Sources/LlmIdeMac/Views/CodeWorkflowSheet.swift` — per-file preview renders parsed hunks (Theme-colored) instead of `Text(file.rawDiff)`

**Deleted:**
- `mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift` (both `UnifiedDiffView` and `DiffWebView`) — fully superseded by `MonacoDiffView` + `HunkStagingList`

---

### Task 1: `RepoManager` gains stdin support

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/RepoManager.swift:382-516` (`gitOutput`, `runGit`, the private `git` function)
- Test: Create `mac/Tests/LlmIdeMacTests/RepoManagerStdinTests.swift`

**Interfaces:**
- Produces: `func runGit(_ args: [String], at cwd: URL, stdin: Data) async throws -> String` (new overload; the existing no-stdin `runGit` is untouched, callers keep compiling)
- No change to `runGitOp` or any other existing `RepoManager` public method.

This is genuinely new capability — a repo-wide grep (done before writing this plan) confirms every existing `Process` in this codebase hardcodes `proc.standardInput = FileHandle.nullDevice`; there is no prior stdin-piping code to follow. The design mirrors the EXISTING concurrent-drain pattern this same function already uses for stdout/stderr (`RepoManager.swift:446-458`): dispatch the stdin write on its own background queue, entered into the same `DispatchGroup`, all set up BEFORE `proc.run()` — the write's data sits in the kernel pipe buffer if the child hasn't started reading yet, exactly like a `Pipe`'s read end does.

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/RepoManagerStdinTests.swift
import XCTest
@testable import LlmIdeMacLib

final class RepoManagerStdinTests: XCTestCase {
    var repo: URL!

    override func setUp() async throws {
        try await super.setUp()
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("repomanager-stdin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
        super.tearDown()
    }

    /// `git hash-object --stdin` computes the SHA1 of whatever it reads from
    /// stdin — a real git subcommand (not a mock) that only succeeds if stdin
    /// actually reaches the child process, and whose output is independently
    /// verifiable (a known string has a known SHA1).
    func testStdinDataReachesTheGitSubprocess() async throws {
        let manager = RepoManager()
        let content = "llm-ide stdin test\n"
        let out = try await manager.runGit(["hash-object", "--stdin"], at: repo, stdin: Data(content.utf8))
        // `echo -n "llm-ide stdin test\n" | git hash-object --stdin` — pinned
        // independently via `printf '%s' "llm-ide stdin test\n" | git hash-object --stdin`
        // outside this test, not recomputed by the test itself.
        XCTAssertEqual(out.trimmingCharacters(in: .whitespacesAndNewlines), "9f3d288799fa0ad91f4dc63019c40aa476d67ca2")
    }

    /// A larger payload (bigger than one pipe buffer, ~64KB) must not
    /// deadlock — the same pipe-buffer hazard `RepoManager.git`'s own doc
    /// comment already documents for stdout/stderr, now checked for stdin.
    func testLargeStdinDoesNotDeadlock() async throws {
        let manager = RepoManager()
        let big = String(repeating: "a", count: 200_000) + "\n"
        let exp = expectation(description: "runGit returns")
        var result: String?
        Task {
            result = try? await manager.runGit(["hash-object", "--stdin"], at: repo, stdin: Data(big.utf8))
            exp.fulfill()
        }
        await fulfillment(of: [exp], timeout: 10)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.trimmingCharacters(in: .whitespacesAndNewlines).count, 40) // a SHA1 hex string
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `runGit(_:at:stdin:)` doesn't exist yet.

- [ ] **Step 3: Add stdin support**

In `RepoManager.swift`, add a new public overload right after the existing `runGit` (line 392):

```swift
    /// Same as `runGit(_:at:)`, but pipes `stdin` to the child process before
    /// reading its output — needed for `git apply --cached -` (hunk staging,
    /// see `GitTruthStore.stagePatch`). No existing call in this codebase
    /// piped data into a subprocess before this; every other `Process` here
    /// hardcodes `FileHandle.nullDevice`.
    func runGit(_ args: [String], at cwd: URL, stdin: Data) async throws -> String {
        let (out, _) = try await git(args, cwd: cwd, stdin: stdin)
        return out
    }
```

Replace the private `git` function's signature (line 397):

```swift
    private func git(_ args: [String], cwd: URL, token: String? = nil, backend: Backend = .gitlab, timeout: TimeInterval? = nil) async throws -> (String, String) {
```

with:

```swift
    private func git(_ args: [String], cwd: URL, token: String? = nil, backend: Backend = .gitlab, timeout: TimeInterval? = nil, stdin: Data? = nil) async throws -> (String, String) {
```

Replace the stdin setup (line 422, currently `proc.standardInput = FileHandle.nullDevice`) with:

```swift
                let stdinPipe = Pipe()
                if let stdin {
                    proc.standardInput = stdinPipe
                } else {
                    proc.standardInput = FileHandle.nullDevice
                }
```

Immediately after the existing stdout/stderr `readGroup.enter()` blocks (after line 458, still BEFORE `try proc.run()` at line 461), add a third concurrent operation — writing stdin, symmetric with how the two reads are already dispatched before the process starts:

```swift
                // Write stdin concurrently with the stdout/stderr drains,
                // all set up before proc.run() — exactly the same
                // deadlock-avoidance shape this function already uses for
                // reading (see the doc comment on the reads above): a
                // large patch could otherwise fill the stdin pipe buffer
                // while this thread is blocked writing it, with nothing
                // yet reading stdout to unblock the child.
                if let stdin {
                    readGroup.enter()
                    DispatchQueue.global(qos: .userInitiated).async {
                        stdinPipe.fileHandleForWriting.write(stdin)
                        try? stdinPipe.fileHandleForWriting.close()
                        readGroup.leave()
                    }
                }
```

Do not change anything else in this function — `proc.run()`, the timeout watchdog, `waitUntilExit()`, and the exit-status handling are all untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. If a full Xcode toolchain is available, additionally run `swift test --filter RepoManagerStdinTests` and confirm both tests pass (the first pins a real SHA1 — if your environment's `git hash-object` disagrees, recompute it locally with `printf 'llm-ide stdin test\n' | git hash-object --stdin` and use that value instead of guessing).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/RepoManager.swift mac/Tests/LlmIdeMacTests/RepoManagerStdinTests.swift
git commit -m "feat(mac): RepoManager can pipe stdin to a git subprocess"
```

---

### Task 2: `DiffHunk.fromLineDiff` — shared line-diff → hunk model

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/SCMModels.swift` (append to the file)
- Test: Create `mac/Tests/LlmIdeMacTests/DiffHunkLineDiffTests.swift`

**Interfaces:**
- Consumes: nothing new (pure `String` comparison)
- Produces: `static func fromLineDiff(old: String, new: String) -> [DiffHunk]` (a static method on the existing `DiffHunk` struct)

This wraps the SAME `CollectionDifference`-based technique `UpdateFileSheet`'s current private `diffRows` computation already uses (`mac/Sources/LlmIdeMac/Agent/Views/UpdateFileSheet.swift:124-163`, read it for the exact algorithm this task ports) — producing the SHARED `DiffHunk`/`DiffRow` model instead of `UpdateFileSheet`'s own private `DiffRow` type. `DiffRow.oldLine`/`.newLine` already support `nil` (insert/delete-only rows), matching this algorithm's shape exactly. Later tasks (7) delete `UpdateFileSheet`'s private duplicate and switch it to this.

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/DiffHunkLineDiffTests.swift
import XCTest
@testable import LlmIdeMacLib

final class DiffHunkLineDiffTests: XCTestCase {
    func testIdenticalStringsProduceOneHunkAllContext() {
        let hunks = DiffHunk.fromLineDiff(old: "a\nb\n", new: "a\nb\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .context, oldLine: 2, newLine: 2, text: "b"),
        ])
    }

    func testPureInsertion() {
        let hunks = DiffHunk.fromLineDiff(old: "a\n", new: "a\nb\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 2, text: "b"),
        ])
    }

    func testPureDeletion() {
        let hunks = DiffHunk.fromLineDiff(old: "a\nb\n", new: "a\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .delete, oldLine: 2, newLine: nil, text: "b"),
        ])
    }

    func testModificationIsDeleteThenInsert() {
        let hunks = DiffHunk.fromLineDiff(old: "old\n", new: "new\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .delete, oldLine: 1, newLine: nil, text: "old"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 1, text: "new"),
        ])
    }

    func testEmptyOldIsAllInsertions() {
        let hunks = DiffHunk.fromLineDiff(old: "", new: "a\nb\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows.map(\.kind), [.insert, .insert])
    }

    func testTwoEmptyStringsProduceNoHunks() {
        XCTAssertEqual(DiffHunk.fromLineDiff(old: "", new: ""), [])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `DiffHunk.fromLineDiff` doesn't exist yet.

- [ ] **Step 3: Add `fromLineDiff` to `SCMModels.swift`**

Append to the file, inside (or as an extension of) the existing `DiffHunk` struct:

```swift
extension DiffHunk {
    /// Line-level diff between two full strings, packaged as the SAME
    /// `[DiffHunk]` model `UnifiedDiffParser.parse` produces from a real
    /// `git diff` — used where there's no git diff to run at all (an
    /// agent's proposed edit that may not be on disk yet). Ports
    /// `UpdateFileSheet`'s pre-existing `CollectionDifference`-based
    /// algorithm (see `UpdateFileSheet.swift`'s prior `diffRows`) onto the
    /// shared model instead of a private one, so every diff consumer in
    /// this app renders from one type. Always produces at most one hunk
    /// (whole-file context, matching the prior `UpdateFileSheet` behavior
    /// exactly — it never showed multiple hunks either); empty `rows`
    /// (both strings identical AND empty) returns `[]`, not a one-hunk
    /// empty-rows result.
    static func fromLineDiff(old: String, new: String) -> [DiffHunk] {
        let oldLines = old.isEmpty ? [] : old.components(separatedBy: "\n")
        let newLines = new.isEmpty ? [] : new.components(separatedBy: "\n")
        guard !oldLines.isEmpty || !newLines.isEmpty else { return [] }

        let diff = newLines.difference(from: oldLines)
        var removedFromOld = Set<Int>()
        var insertedInNew = Set<Int>()
        for change in diff {
            switch change {
            case .remove(let off, _, _): removedFromOld.insert(off)
            case .insert(let off, _, _): insertedInNew.insert(off)
            }
        }

        var rows: [DiffRow] = []
        var i = 0
        var j = 0
        while i < oldLines.count || j < newLines.count {
            let iRemoved = i < oldLines.count && removedFromOld.contains(i)
            let jInserted = j < newLines.count && insertedInNew.contains(j)
            if iRemoved {
                rows.append(DiffRow(kind: .delete, oldLine: i + 1, newLine: nil, text: oldLines[i]))
                i += 1
            } else if jInserted {
                rows.append(DiffRow(kind: .insert, oldLine: nil, newLine: j + 1, text: newLines[j]))
                j += 1
            } else if i < oldLines.count && j < newLines.count {
                rows.append(DiffRow(kind: .context, oldLine: i + 1, newLine: j + 1, text: newLines[j]))
                i += 1
                j += 1
            } else if j < newLines.count {
                rows.append(DiffRow(kind: .insert, oldLine: nil, newLine: j + 1, text: newLines[j]))
                j += 1
            } else if i < oldLines.count {
                rows.append(DiffRow(kind: .delete, oldLine: i + 1, newLine: nil, text: oldLines[i]))
                i += 1
            }
        }
        return [DiffHunk(header: "", rows: rows)]
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. If a full Xcode toolchain is available, additionally run `swift test --filter DiffHunkLineDiffTests` and expect all 6 tests to pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SCMModels.swift mac/Tests/LlmIdeMacTests/DiffHunkLineDiffTests.swift
git commit -m "feat(mac): DiffHunk.fromLineDiff shares the hunk model with non-git diff consumers"
```

---

### Task 3: `GitTruthStore.stagePatch`/`unstagePatch`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/GitTruthStore.swift` (append)
- Test: Create `mac/Tests/LlmIdeMacTests/GitTruthStorePatchTests.swift`

**Interfaces:**
- Consumes: `RepoManager.runGit(_:at:stdin:)` (Task 1), `DiffHunk`/`DiffRow` (existing)
- Produces:
  ```swift
  func stagePatch(root: URL, path: String, hunk: DiffHunk) async throws
  func unstagePatch(root: URL, path: String, hunk: DiffHunk) async throws
  ```

Synthesizes a minimal, valid unified-diff patch for exactly ONE hunk and pipes it to `git apply --cached -` (stage) / `git apply --cached --reverse -` (unstage). `git apply` needs a real patch header even for one hunk: `diff --git a/<path> b/<path>`, then `--- a/<path>` / `+++ b/<path>` (or `/dev/null` on the appropriate side for a pure add/delete — out of scope for a SINGLE hunk of an already-tracked file, which is this task's actual use case; whole-file add/delete still goes through `SourceControlService.stage`/`.discard`, unchanged), then the hunk's own `@@` header line verbatim, then each row reconstructed as `" " + text` (context), `"+" + text` (insert), `"-" + text` (delete).

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/GitTruthStorePatchTests.swift
import XCTest
@testable import LlmIdeMacLib

final class GitTruthStorePatchTests: XCTestCase {
    var repo: URL!

    override func setUp() async throws {
        try await super.setUp()
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("git-truth-patch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try run(["init", "-q"])
        try run(["config", "user.email", "test@example.com"])
        try run(["config", "user.name", "Test"])
        try "line1\nline2\nline3\n".write(to: repo.appendingPathComponent("f.txt"), atomically: true, encoding: .utf8)
        try run(["add", "-A"])
        try run(["commit", "-q", "-m", "init"])
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
        super.tearDown()
    }

    @discardableResult
    private func run(_ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = args
        p.currentDirectoryURL = repo
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    func testStagePatchStagesExactlyOneHunk() async throws {
        // Two independent hunks: change line1, change line3.
        try "CHANGED1\nline2\nCHANGED3\n".write(to: repo.appendingPathComponent("f.txt"), atomically: true, encoding: .utf8)
        let diff = try run(["diff", "--", "f.txt"])
        let hunks = UnifiedDiffParser.parse(diff)
        XCTAssertEqual(hunks.count, 2, "fixture must produce two independent hunks — adjust the fixture if git merged them into one")

        let store = GitTruthStore()
        try await store.stagePatch(root: repo, path: "f.txt", hunk: hunks[0])

        let staged = try run(["diff", "--cached", "--", "f.txt"])
        XCTAssertTrue(staged.contains("-line1"), "the first hunk's change must be staged")
        XCTAssertTrue(staged.contains("+CHANGED1"))
        XCTAssertFalse(staged.contains("CHANGED3"), "the second hunk must NOT be staged")

        let unstaged = try run(["diff", "--", "f.txt"])
        XCTAssertTrue(unstaged.contains("CHANGED3"), "the second hunk's change must still be in the working tree, unstaged")
    }

    func testUnstagePatchReversesExactlyOneStagedHunk() async throws {
        try "CHANGED1\nline2\nCHANGED3\n".write(to: repo.appendingPathComponent("f.txt"), atomically: true, encoding: .utf8)
        try run(["add", "-A"])   // stage both hunks first
        let staged = try run(["diff", "--cached", "--", "f.txt"])
        let stagedHunks = UnifiedDiffParser.parse(staged)
        XCTAssertEqual(stagedHunks.count, 2)

        let store = GitTruthStore()
        try await store.unstagePatch(root: repo, path: "f.txt", hunk: stagedHunks[0])

        let stagedAfter = try run(["diff", "--cached", "--", "f.txt"])
        XCTAssertFalse(stagedAfter.contains("CHANGED1"), "the unstaged hunk must be gone from the index")
        XCTAssertTrue(stagedAfter.contains("CHANGED3"), "the other hunk must remain staged")
    }

    func testStagePatchOnAMalformedHunkThrows() async {
        let store = GitTruthStore()
        let bogus = DiffHunk(header: "@@ -1,1 +1,1 @@", rows: [
            DiffRow(kind: .delete, oldLine: 1, newLine: nil, text: "this line does not exist in f.txt"),
        ])
        do {
            try await store.stagePatch(root: repo, path: "f.txt", hunk: bogus)
            XCTFail("expected git apply to reject a patch that doesn't match the file")
        } catch {
            // Expected — git apply --cached correctly refuses a non-matching patch.
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `stagePatch`/`unstagePatch` don't exist yet.

- [ ] **Step 3: Add `stagePatch`/`unstagePatch` to `GitTruthStore`**

Append inside the `GitTruthStore` class, after `lineMarks(root:path:)`:

```swift
    /// Stage exactly one hunk (not the whole file) via `git apply --cached`,
    /// piping a minimal synthesized patch to its stdin (`RepoManager`'s new
    /// stdin support, added alongside this method). `path` is the file's
    /// repo-relative path — the SAME string `DiffHunk`'s own rows don't
    /// carry (a `DiffHunk` has no path of its own; it's always scoped to
    /// one file by whoever parsed it).
    func stagePatch(root: URL, path: String, hunk: DiffHunk) async throws {
        let patch = Self.synthesizePatch(path: path, hunk: hunk)
        _ = try await repo.runGit(["apply", "--cached", "-"], at: root, stdin: Data(patch.utf8))
    }

    /// Reverse of `stagePatch` — unstages exactly one currently-staged hunk.
    /// `hunk` must be one parsed from the STAGED diff (`git diff --cached`),
    /// not the working-tree diff, or `--reverse` will apply against the
    /// wrong baseline and `git apply` will correctly reject it.
    func unstagePatch(root: URL, path: String, hunk: DiffHunk) async throws {
        let patch = Self.synthesizePatch(path: path, hunk: hunk)
        _ = try await repo.runGit(["apply", "--cached", "--reverse", "-"], at: root, stdin: Data(patch.utf8))
    }

    /// Builds the minimal patch text `git apply` needs for one hunk of an
    /// already-tracked file: a `diff --git`/`---`/`+++` header (both sides
    /// name the same path — this task's use case is always a modification,
    /// never a whole-file add/delete, which stay on `SourceControlService`'s
    /// existing whole-file `stage`/`discard`), then the hunk's own `@@`
    /// header line verbatim, then each row reconstructed with its unified-
    /// diff prefix character.
    private static func synthesizePatch(path: String, hunk: DiffHunk) -> String {
        var lines = [
            "diff --git a/\(path) b/\(path)",
            "--- a/\(path)",
            "+++ b/\(path)",
            hunk.header,
        ]
        for row in hunk.rows {
            switch row.kind {
            case .context: lines.append(" " + row.text)
            case .insert:  lines.append("+" + row.text)
            case .delete:  lines.append("-" + row.text)
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. If a full Xcode toolchain is available, additionally run `swift test --filter GitTruthStorePatchTests` and expect all 3 tests to pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/GitTruthStore.swift mac/Tests/LlmIdeMacTests/GitTruthStorePatchTests.swift
git commit -m "feat(mac): GitTruthStore.stagePatch/unstagePatch stage a single hunk via git apply --cached"
```

---

### Task 4: `MonacoDiffView`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shared/MonacoDiffView.swift`

**Interfaces:**
- Consumes: `MonacoHost`, `MonacoDiffRequest` (existing, `Views/Shared/MonacoHost.swift`)
- Produces:
  ```swift
  struct MonacoDiffView: View {
      var original: String
      var modified: String
      var language: String = "plaintext"
  }
  ```

Mirrors P1's `MonacoEditorView` pattern exactly, but simpler: `MonacoHost.diffRequest` is `Equatable` on its full value (not an id, unlike `revealRequest`), so re-requesting the identical diff is already a correct no-op at the `MonacoHost.Coordinator` level — this view can construct a fresh `MonacoDiffRequest` on every render without the "hold in `@State`" concern `MonacoRevealRequest` has (that concern is specific to `revealRequest`'s per-construction fresh `UUID()`; `MonacoDiffRequest` has no such id). No load-failure fallback in this task — a diff view failing to load Monaco has no equivalent "plain diff" fallback worth building (every consumer already has its own way to show SOMETHING — the underlying data — independent of this view); if this proves to matter in practice, add one later rather than guessing now. No automated test — same rationale as `MonacoEditorView` (SwiftUI + `WKWebView` glue, no live-WebView harness in this codebase).

- [ ] **Step 1: No test to write** — proceed to Step 2.

- [ ] **Step 2: Create `MonacoDiffView.swift`**

```swift
// mac/Sources/LlmIdeMac/Views/Shared/MonacoDiffView.swift
import SwiftUI

/// Read-only diff visual — the "view" half of Source Control's diff
/// experience, paired with a native SwiftUI hunk list (`HunkStagingList`,
/// where staging applies) for the "act" half. Declarative, exactly like
/// `MonacoEditorView`: set `original`/`modified`/`language` and SwiftUI's
/// normal re-render cycle applies the change through `MonacoHost`.
///
/// Unlike `MonacoRevealRequest`, `MonacoDiffRequest` needs no per-render
/// identity trick — it's `Equatable` on its full value, so `MonacoHost`'s
/// own diffing already treats "show the same diff again" as a correct
/// no-op. A fresh `MonacoDiffRequest` can be constructed inline here every
/// render.
struct MonacoDiffView: View {
    var original: String
    var modified: String
    var language: String = "plaintext"

    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        MonacoHost(
            theme: theme.current,
            diffRequest: MonacoDiffRequest(original: original, modified: modified, language: language),
            readOnly: true
        )
    }
}
```

- [ ] **Step 3: Run full build to verify it compiles**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!` — this view isn't wired into any call site yet (later tasks do that).

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shared/MonacoDiffView.swift
git commit -m "feat(mac): add MonacoDiffView, the declarative read-only diff visual"
```

---

### Task 5: `SourceControlService` gains full-content + per-commit-file diff sources

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/SourceControlService.swift` (append near the existing `diff(root:file:)`/`commitDiff(root:sha:)`, lines ~98-113 and ~265-269)

**Interfaces:**
- Consumes: `RepoManager.runGit(_:at:)` (existing, via `self.repo`)
- Produces:
  ```swift
  func diffContent(root: URL, file: FileChange) async -> (original: String, modified: String)
  func commitFiles(root: URL, sha: String) async -> [String]
  func commitFileContent(root: URL, sha: String, path: String) async -> (original: String, modified: String)
  ```

`diffContent` feeds `MonacoDiffView` for Changes mode (the existing `diff(root:file:) -> [DiffHunk]` stays untouched, still feeding `HunkStagingList`'s staging actions — both are needed, for different halves of the split UI). `commitFiles`/`commitFileContent` replace `commitDiff(root:sha:)`'s all-files-at-once model with per-file browsing (History mode redesign, Task 9) — `commitDiff` itself is left in place (Task 9 stops calling it, but deleting it is out of scope for this task; a later cleanup can remove it once confirmed unused).

- [ ] **Step 1: No test to write** — this is a thin wrapper over `RepoManager.runGit`, the same pattern the existing (untested-in-isolation) `diff`/`commitDiff` methods already use; the git-command construction itself is the only logic, and it's exercised end-to-end by Task 9's manual verification. Proceed to Step 2.

- [ ] **Step 2: Add the three methods to `SourceControlService`**

Append near the existing `diff(root:file:)` (after line ~113):

```swift
    /// Full old/new file content for `MonacoDiffView`'s visual (distinct
    /// from `diff(root:file:)`'s parsed `[DiffHunk]`, which `HunkStagingList`
    /// uses for staging — Monaco's diff editor computes its OWN word-level
    /// diff from full text, it never consumes `DiffHunk`). `original` is
    /// always the last-committed blob; `modified` is the STAGED blob when
    /// `file.staged`, else the current working-tree content — matching
    /// which diff `diff(root:file:)` itself would show for the same file.
    func diffContent(root: URL, file: FileChange) async -> (original: String, modified: String) {
        let original = (try? await repo.runGit(["show", "HEAD:\(file.path)"], at: root)) ?? ""
        if file.status == .untracked {
            let modified = (try? String(contentsOf: root.appendingPathComponent(file.path), encoding: .utf8)) ?? ""
            return (original: "", modified: modified)
        }
        if file.staged {
            let staged = (try? await repo.runGit(["show", ":\(file.path)"], at: root)) ?? ""
            return (original: original, modified: staged)
        }
        let workingTree = (try? String(contentsOf: root.appendingPathComponent(file.path), encoding: .utf8)) ?? ""
        return (original: original, modified: workingTree)
    }
```

Append near the existing `commitDiff(root:sha:)` (after line ~269):

```swift
    /// Repo-relative paths touched by `sha`, for History mode's per-file
    /// browse (Task 9) — replaces trying to render an entire multi-file
    /// commit through a single-file diff view.
    func commitFiles(root: URL, sha: String) async -> [String] {
        guard let raw = try? await repo.runGit(["show", "--format=", "--name-only", sha], at: root) else { return [] }
        return raw.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    /// One file's old/new content AT a specific commit — `sha^` (the parent)
    /// for `original`, `sha` itself for `modified`. A commit with no parent
    /// (the repo's first commit) has no `sha^`; `git show` on a missing ref
    /// fails, and the `try?` below degrades to an empty original, correctly
    /// rendering the whole file as added.
    func commitFileContent(root: URL, sha: String, path: String) async -> (original: String, modified: String) {
        let original = (try? await repo.runGit(["show", "\(sha)^:\(path)"], at: root)) ?? ""
        let modified = (try? await repo.runGit(["show", "\(sha):\(path)"], at: root)) ?? ""
        return (original: original, modified: modified)
    }
```

- [ ] **Step 3: Run full build to verify no regressions**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SourceControlService.swift
git commit -m "feat(mac): SourceControlService gains full-content and per-commit-file diff sources"
```

---

### Task 6: `HunkStagingList`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/SourceControl/HunkStagingList.swift`

**Interfaces:**
- Consumes: `DiffHunk`/`DiffRow` (existing), `Theme.diffAddedBg`/`.diffAddedFg`/`.diffDeletedBg`/`.diffDeletedFg` (existing, P0)
- Produces:
  ```swift
  struct HunkStagingList: View {
      let hunks: [DiffHunk]
      /// nil = read-only (History mode); non-nil = Stage/Unstage buttons shown.
      var onStage: ((DiffHunk) -> Void)? = nil
      var onUnstage: ((DiffHunk) -> Void)? = nil
  }
  ```

Native SwiftUI — no WKWebView, no JS. Row rendering (gutter columns, add/remove backgrounds) is adapted from `UpdateFileSheet`'s existing, already-accessible `diffRowView` (`UpdateFileSheet.swift:195-247` — read it for the exact layout this ports), generalized to `DiffHunk`/`DiffRow` and Theme-colored instead of raw `Color.green`/`.red`. When `onStage`/`onUnstage` are both nil, no button row renders (History mode's read-only browse, Task 9).

- [ ] **Step 1: No test to write** — this is pure SwiftUI rendering with no non-trivial logic to isolate (unlike `DiffHunk.fromLineDiff`, there's no pure function here worth extracting; the row-coloring `switch` is the same one-line-per-case shape `CodeGutter`/`FileDetailView` already have precedent for leaving untested, per this plan's Global Constraints on view-glue code). Proceed to Step 2.

- [ ] **Step 2: Create `HunkStagingList.swift`**

```swift
// mac/Sources/LlmIdeMac/Views/SourceControl/HunkStagingList.swift
import SwiftUI

/// Native SwiftUI hunk list — the "act" half of Source Control's diff
/// experience, paired with `MonacoDiffView` (the "view" half). Chosen over
/// custom Monaco gutter widgets specifically because building interactive
/// decorations inside Monaco's rendered diff editor is real JS/DOM work
/// this environment cannot visually verify before shipping; a native list
/// needs none of that and is directly testable.
struct HunkStagingList: View {
    let hunks: [DiffHunk]
    var onStage: ((DiffHunk) -> Void)? = nil
    var onUnstage: ((DiffHunk) -> Void)? = nil

    @EnvironmentObject private var theme: ThemeStore

    private var isInteractive: Bool { onStage != nil || onUnstage != nil }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                    hunkBlock(hunk)
                }
            }
            .padding(8)
        }
    }

    @ViewBuilder
    private func hunkBlock(_ hunk: DiffHunk) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(hunk.header.isEmpty ? " " : hunk.header)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                if isInteractive {
                    if let onUnstage {
                        Button("Unstage") { onUnstage(hunk) }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    if let onStage {
                        Button("Stage") { onStage(hunk) }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                }
            }
            ForEach(Array(hunk.rows.enumerated()), id: \.offset) { _, row in
                rowView(row)
            }
        }
        .padding(6)
        .background(Color(nsColor: .textBackgroundColor))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.2)))
    }

    private let lineNumWidth: CGFloat = 38

    @ViewBuilder
    private func rowView(_ row: DiffRow) -> some View {
        let (sign, bg, fg): (String, Color, Color) = {
            switch row.kind {
            case .insert:  return ("+", theme.current.diffAddedBg, theme.current.diffAddedFg)
            case .delete:  return ("−", theme.current.diffDeletedBg, theme.current.diffDeletedFg)
            case .context: return (" ", .clear, .secondary)
            }
        }()
        HStack(spacing: 0) {
            Text(row.oldLine.map(String.init) ?? "")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.secondary.opacity(0.7))
                .frame(width: lineNumWidth, alignment: .trailing)
                .padding(.trailing, 6)
            Text(row.newLine.map(String.init) ?? "")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.secondary.opacity(0.7))
                .frame(width: lineNumWidth, alignment: .trailing)
                .padding(.trailing, 8)
            Text(sign)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(fg.opacity(0.7))
                .frame(width: 14, alignment: .center)
            Text(row.text.isEmpty ? " " : row.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(fg)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.leading, 2)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1)
        .background(bg)
    }
}
```

- [ ] **Step 3: Run full build to verify it compiles**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!` — not wired into any call site yet.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/SourceControl/HunkStagingList.swift
git commit -m "feat(mac): add HunkStagingList, the native per-hunk stage/unstage view"
```

---

### Task 7: `SourceControlView`'s Changes mode — retire `UnifiedDiffView`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift:107-120` (`content`'s right pane), `:14-15` (add `@State` for the selected file's original/modified content)
- Delete: `mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift`

**Interfaces:**
- Consumes: `MonacoDiffView` (Task 4), `HunkStagingList` (Task 6), `SourceControlService.diffContent(root:file:)` (Task 5), `GitTruthStore.stagePatch`/`unstagePatch` (Task 3)

Before deleting `UnifiedDiffView.swift`: confirm (as this plan's author already did) its only consumer is `SourceControlView.swift:114` — `grep -rln "UnifiedDiffView\b" mac/Sources/ mac/Tests/` should show only `SourceControlView.swift` and `UnifiedDiffView.swift` itself. If a second consumer or a test file turns up, STOP and report — the delete step assumes this is the complete picture.

- [ ] **Step 1: No test to write** — SwiftUI wiring over already-tested pieces. Proceed to Step 2.

- [ ] **Step 2: Add state and a `GitTruthStore` instance for staging**

In `SourceControlView`'s property list (near the existing `@State private var hunks: [DiffHunk] = []`, line 15), add:

```swift
    @State private var diffOriginal: String = ""
    @State private var diffModified: String = ""
    @State private var gitTruthStore = GitTruthStore()
```

- [ ] **Step 3: Replace the right pane**

Currently (`content`, around line 114):

```swift
                UnifiedDiffView(hunks: hunks, fileExtension: diffLanguage)
```

becomes:

```swift
                if mode == .changes, let selected {
                    VSplitView {
                        MonacoDiffView(original: diffOriginal, modified: diffModified,
                                       language: MonacoLanguageMap.id(for: diffLanguage))
                        HunkStagingList(
                            hunks: hunks,
                            onStage: selected.staged ? nil : { hunk in
                                Task {
                                    guard let root else { return }
                                    try? await gitTruthStore.stagePatch(root: root, path: selected.path, hunk: hunk)
                                    await scm.refresh(root: root)
                                }
                            },
                            onUnstage: selected.staged ? { hunk in
                                Task {
                                    guard let root else { return }
                                    try? await gitTruthStore.unstagePatch(root: root, path: selected.path, hunk: hunk)
                                    await scm.refresh(root: root)
                                }
                            } : nil
                        )
                    }
                } else {
                    MonacoDiffView(original: diffOriginal, modified: diffModified,
                                    language: MonacoLanguageMap.id(for: diffLanguage))
                }
```

(History mode's right pane is fully redesigned in Task 9 — this task only makes Changes mode correct; the `else` branch here is a placeholder that Task 9 replaces outright, not something to polish now.)

- [ ] **Step 4: Load `diffOriginal`/`diffModified` alongside `hunks`**

`loadHunks(_:)` (line 43-50) only ever sets `hunks`. Add a parallel loader for the Monaco visual, called from the same two `.onChange` sites `loadHunks` already is (`.onChange(of: selected)` at line 184, and the `scm.state.files` re-resolution at line 174-178) — add this method near `loadHunks`:

```swift
    /// Loads the full old/new content for the Monaco visual, mirroring
    /// `loadHunks`'s cancel-before-reload shape but keyed on the SAME
    /// `diffTask` (both loads race the same selection change, so cancelling
    /// one must cancel the other).
    private func loadDiffContent(_ file: FileChange) {
        guard let root else { diffOriginal = ""; diffModified = ""; return }
        Task {
            let (original, modified) = await scm.diffContent(root: root, file: file)
            guard !Task.isCancelled else { return }
            diffOriginal = original
            diffModified = modified
        }
    }
```

At the two call sites, call it alongside `loadHunks`. `.onChange(of: selected)` (line 184-187):

```swift
        .onChange(of: selected) { _, sel in
            guard let sel, let root else { hunks = []; return }
            loadHunks { await scm.diff(root: root, file: sel) }
        }
```

becomes:

```swift
        .onChange(of: selected) { _, sel in
            guard let sel, let root else { hunks = []; diffOriginal = ""; diffModified = ""; return }
            loadHunks { await scm.diff(root: root, file: sel) }
            loadDiffContent(sel)
        }
```

And the `scm.state.files` re-resolution (line 174-178):

```swift
            if let resolved {
                selected = resolved
                loadHunks { await scm.diff(root: root, file: resolved) }
            } else {
```

becomes:

```swift
            if let resolved {
                selected = resolved
                loadHunks { await scm.diff(root: root, file: resolved) }
                loadDiffContent(resolved)
            } else {
```

- [ ] **Step 5: Delete `UnifiedDiffView.swift`**

```bash
git rm mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift
```

- [ ] **Step 6: Run full build to verify no regressions**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!` — no references to `UnifiedDiffView`/`DiffWebView` remain (History mode's `selectedCommit` path still compiles against the placeholder `else` branch from Step 3; Task 9 replaces it).

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift
git commit -m "refactor(mac): SourceControlView Changes mode uses MonacoDiffView + HunkStagingList"
```

---

### Task 8: `UpdateFileSheet` collapses onto `MonacoDiffView` + `DiffStats`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Agent/Views/UpdateFileSheet.swift`

**Interfaces:**
- Consumes: `MonacoDiffView` (Task 4), `MonacoLanguageMap` (existing, P1), `DiffStats.compute` (existing, `Agent/Models/DiffStats.swift`)
- No change to `UpdateFileSheet`'s own public `init`/`ConfirmResult` — callers (`CodeAssistant+Sheets.swift:77`) are unaffected.

Deletes the private `DiffRow`/`diffRows`/`diffRowView` (lines 112-247 as of this plan's writing — locate by the `// MARK: - Diff` section comment through `changeSummary`'s closing brace, since earlier edits in this task shift line numbers) and replaces `diffPane` with `MonacoDiffView`. The separate editable `TextEditor` (lines 58-67, labeled "Proposed content (editable)") is UNCHANGED — it's how the user edits `proposedContent`; the diff view above it is purely a read-only visual that re-renders live as `proposedContent` changes (SwiftUI's normal re-render cycle already does this, no new wiring needed).

- [ ] **Step 1: No test to write** — SwiftUI wiring over already-tested pieces (`MonacoDiffView`, `DiffStats`). Proceed to Step 2.

- [ ] **Step 2: Replace `diffPane`, delete the private diff type/computation/renderer**

Currently, `diffPane` (lines 165-188) and everything from the `private struct DiffRow` (line 112) through `diffRowView` (ending line 247) exist as described in "Task Description" above. Replace ALL of it — the `private struct DiffRow` declaration, the `diffRows` computed property, `diffPane`, `lineNumWidth`, and `diffRowView` — with a single computed property:

```swift
    // MARK: - Diff

    private var diffLanguage: String {
        MonacoLanguageMap.id(for: (displayPath as NSString).pathExtension)
    }

    @ViewBuilder
    private var diffPane: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Diff vs current file")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            MonacoDiffView(original: originalContent, modified: proposedContent, language: diffLanguage)
                .frame(minHeight: 240, maxHeight: 380)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
        }
    }
```

- [ ] **Step 3: Replace `changeSummary` to reuse `DiffStats`**

Currently (lines 249-256):

```swift
    /// "+12 −3" summary chip. Drives nothing functional but gives the
    /// user a quick at-a-glance read of the size of the change.
    private var changeSummary: String {
        let rows = diffRows
        let added = rows.filter { $0.kind == .insert }.count
        let removed = rows.filter { $0.kind == .remove }.count
        return "+\(added) −\(removed) lines"
    }
```

becomes:

```swift
    /// "+12 −3" summary chip. Drives nothing functional but gives the
    /// user a quick at-a-glance read of the size of the change. Reuses
    /// `DiffStats.compute` (the SAME `CollectionDifference` technique this
    /// file's own diff used to compute independently) rather than keeping
    /// a second copy of the same line-diffing logic.
    private var changeSummary: String {
        let stats = DiffStats.compute(old: originalContent, new: proposedContent)
        return "+\(stats.added) −\(stats.removed) lines"
    }
```

- [ ] **Step 4: Run full build to verify no regressions**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Agent/Views/UpdateFileSheet.swift
git commit -m "refactor(mac): UpdateFileSheet's diff preview becomes MonacoDiffView, reuses DiffStats for the summary"
```

---

### Task 9: History mode — per-commit file browsing with `MonacoDiffView`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` (History-mode state, `historyList`/`commitRow`, `.onChange(of: selectedCommit)`, the right-pane `else` branch Task 7 left as a placeholder)

**Interfaces:**
- Consumes: `SourceControlService.commitFiles(root:sha:)`/`commitFileContent(root:sha:path:)` (Task 5), `MonacoDiffView` (Task 4), `HunkStagingList` (Task 6, read-only mode — `onStage`/`onUnstage` both `nil`)

Replaces the "one commit's ENTIRE multi-file diff at once" model with the same "list, then pick one, then view its diff" shape Changes mode already has — a commit's file LIST is native SwiftUI (like the changes-list `fileGroup`), and picking a file reuses `MonacoDiffView` + read-only `HunkStagingList`, never rendering more than one file's diff — and never more than one Monaco instance — at a time.

- [ ] **Step 1: No test to write** — SwiftUI wiring over already-tested pieces. Proceed to Step 2.

- [ ] **Step 2: Add per-commit file-list state**

Near the existing `@State private var selectedCommit: Commit?` (line 25), add:

```swift
    @State private var commitFiles: [String] = []
    @State private var selectedCommitFile: String?
```

- [ ] **Step 3: Replace the `selectedCommit` diff-loading logic**

Currently (`.onChange(of: selectedCommit)`, lines 210-213):

```swift
        // Load the selected commit's diff into the shared right pane.
        .onChange(of: selectedCommit) { _, c in
            guard let c, let root else { hunks = []; return }
            loadHunks { await scm.commitDiff(root: root, sha: c.sha) }
        }
```

becomes:

```swift
        // List the selected commit's touched files (not their diffs yet —
        // picking one is a separate step, mirroring Changes mode's
        // select-a-file-then-see-its-diff shape).
        .onChange(of: selectedCommit) { _, c in
            selectedCommitFile = nil
            diffOriginal = ""; diffModified = ""
            guard let c, let root else { commitFiles = []; return }
            Task {
                let files = await scm.commitFiles(root: root, sha: c.sha)
                guard !Task.isCancelled else { return }
                commitFiles = files
            }
        }
        .onChange(of: selectedCommitFile) { _, path in
            guard let path, let c = selectedCommit, let root else { diffOriginal = ""; diffModified = ""; return }
            Task {
                let (original, modified) = await scm.commitFileContent(root: root, sha: c.sha, path: path)
                guard !Task.isCancelled else { return }
                diffOriginal = original
                diffModified = modified
            }
        }
```

- [ ] **Step 4: Add the commit-file list to `historyList`/`commitRow`**

Read `historyList(_:)`/`commitRow(_:)` (lines 320-353) to find where the currently-selected commit is highlighted. Immediately below the existing commit list (still inside `historyList`'s body, after the `ForEach` over `commits`), add a file list that only renders when a commit is selected:

```swift
            if selectedCommit != nil, !commitFiles.isEmpty {
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(commitFiles, id: \.self) { path in
                            Text(path)
                                .font(Typography.caption)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .padding(.horizontal, Spacing.xs)
                                .padding(.vertical, 2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(selectedCommitFile == path ? theme.current.accent.opacity(0.12) : .clear)
                                .contentShape(Rectangle())
                                .onTapGesture { selectedCommitFile = path }
                        }
                    }
                }
            }
```

(Match this codebase's existing `Typography`/`Spacing` token usage, visible elsewhere in this same file — e.g. `fileRow`, line ~531 — rather than introducing new magic numbers; adjust the exact spacing/font tokens to whatever `historyList`'s surrounding code already uses if it differs from `fileRow`'s.)

- [ ] **Step 5: Replace the placeholder right-pane `else` branch**

Task 7's Step 3 left the non-Changes-mode right pane as a bare `MonacoDiffView(original: diffOriginal, modified: diffModified, ...)` placeholder. Replace it with the same view/staging-list pairing Changes mode uses, but with staging DISABLED (`onStage`/`onUnstage` both `nil` — committed history isn't stageable).

The hunks for this pane come from state, NOT from an inline fetch — a SwiftUI `ViewBuilder` cannot `await`, so the parsed hunks must already be in `@State` by the time `body` runs. Add one more state property alongside the ones from Step 2:

```swift
    @State private var commitFileHunks: [DiffHunk] = []
```

Then replace the placeholder `else` branch with:

```swift
                } else {
                    VSplitView {
                        MonacoDiffView(original: diffOriginal, modified: diffModified,
                                        language: MonacoLanguageMap.id(for: diffLanguage))
                        if selectedCommitFile != nil {
                            HunkStagingList(hunks: commitFileHunks)
                        }
                    }
                }
```

And extend Step 3's `.onChange(of: selectedCommitFile)` block to populate `commitFileHunks` — reusing the `original`/`modified` strings it already fetched, run through `DiffHunk.fromLineDiff` (Task 2), rather than making a second git call for the same information:

```swift
        .onChange(of: selectedCommitFile) { _, path in
            guard let path, let c = selectedCommit, let root else {
                diffOriginal = ""; diffModified = ""; commitFileHunks = []; return
            }
            Task {
                let (original, modified) = await scm.commitFileContent(root: root, sha: c.sha, path: path)
                guard !Task.isCancelled else { return }
                diffOriginal = original
                diffModified = modified
                commitFileHunks = DiffHunk.fromLineDiff(old: original, new: modified)
            }
        }
```

- [ ] **Step 6: Run full build to verify no regressions**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift
git commit -m "refactor(mac): History mode browses one commit file at a time via MonacoDiffView"
```

---

### Task 10: `CodeWorkflowService`/`CodeWorkflowSheet` use the real parser

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/CodeWorkflowService.swift:796-827` (`DiffFile`, `parseDiffFiles`)
- Modify: `mac/Sources/LlmIdeMac/Views/CodeWorkflowSheet.swift` (the `generatedFilesPreview` section)

**Interfaces:**
- Consumes: `UnifiedDiffParser.parse` (existing), `HunkStagingList` (Task 6, read-only mode)
- Produces: `DiffFile` gains `hunks: [DiffHunk]`; `newContent`/`rawDiff` stay (other call sites in `CodeWorkflowSheet.swift` — lines 305/308/267/286/328/450/533 per this plan's research — still read `path`/`isNew`, untouched by this task).

Replaces the `+`-line-grep reconstruction (which never parsed a real hunk, just filtered `+`-prefixed lines to rebuild whole-file content) with the SAME `UnifiedDiffParser.parse` every other diff consumer in the app now uses, and replaces the raw `Text(file.rawDiff)` dump with `HunkStagingList` (read-only — this workflow already stages everything unconditionally via `stageAll` at commit time, per this plan's research; no per-hunk staging UI is added here).

- [ ] **Step 1: No test to write** — `parseDiffFiles` becomes a thin wrapper delegating to the already-tested `UnifiedDiffParser.parse`; no new logic of its own to isolate. Proceed to Step 2.

- [ ] **Step 2: Extend `DiffFile`, update `parseDiffFiles`**

Currently (lines 796-827, exact text may have shifted — locate by the `struct DiffFile` declaration):

```swift
struct DiffFile: Identifiable {
    let id = UUID()
    let path: String
    let isNew: Bool
    let newContent: String
    let rawDiff: String
}
```

becomes:

```swift
struct DiffFile: Identifiable {
    let id = UUID()
    let path: String
    let isNew: Bool
    let newContent: String
    let rawDiff: String
    /// Parsed via `UnifiedDiffParser.parse(rawDiff)` — the real parser
    /// every other diff consumer in the app uses, replacing this type's
    /// former `+`-line-grep reconstruction of `newContent` as the ONLY
    /// way this file's change was represented.
    let hunks: [DiffHunk]
}
```

In `parseDiffFiles`, find where each `DiffFile(...)` is constructed (still inside the per-chunk loop) and add `hunks: UnifiedDiffParser.parse(chunk)` (using whatever the loop's existing local variable holding this file's raw diff chunk is named — read the surrounding code to match it exactly) as an additional argument. Do not change how `path`/`isNew`/`newContent`/`rawDiff` themselves are computed — only add the new field.

- [ ] **Step 3: Update `CodeWorkflowSheet`'s per-file preview**

In `CodeWorkflowSheet.swift`'s `generatedFilesPreview` (or wherever the report's cited lines ~284-310 land — locate by the `Text(file.rawDiff)` call), replace:

```swift
                Text(file.rawDiff)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
```

with:

```swift
                HunkStagingList(hunks: file.hunks)
```

Leave everything else in that `DisclosureGroup` (the label showing `file.path`/`file.isNew`, the surrounding `ScrollView`, etc.) untouched — only the content being scrolled changes.

- [ ] **Step 4: Run full build to verify no regressions**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/CodeWorkflowService.swift mac/Sources/LlmIdeMac/Views/CodeWorkflowSheet.swift
git commit -m "refactor(mac): CodeWorkflowSheet renders real parsed hunks instead of a raw diff-text dump"
```

---

### Task 11: Rename `old → new` — `StatusParser` retains the old path

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/SCMModels.swift` (`FileChange`)
- Modify: `mac/Sources/LlmIdeMac/Services/SCMParsers.swift:14-18` (`StatusParser.parse`)
- Modify: `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` (`fileRow`)
- Test: Modify `mac/Tests/LlmIdeMacTests/SCMParsersTests.swift` (append)

**Interfaces:**
- Consumes: nothing new
- Produces: `FileChange` gains `var renamedFrom: String? = nil` (default value — existing 3-argument `FileChange(path:status:staged:)` call sites across the codebase keep compiling unchanged, since Swift's synthesized memberwise init respects a trailing property's default)

- [ ] **Step 1: Write the failing test**

Append to `mac/Tests/LlmIdeMacTests/SCMParsersTests.swift` (inside the existing `SCMParsersTests` class, in the `// MARK: - StatusParser` section):

```swift
    func testRenameRetainsTheOldPath() {
        let changes = StatusParser.parse(porcelain: "R  old.txt -> new.txt")
        XCTAssertEqual(changes, [FileChange(path: "new.txt", status: .renamed, staged: true, renamedFrom: "old.txt")])
    }

    func testNonRenameHasNilRenamedFrom() {
        let changes = StatusParser.parse(porcelain: " M path.txt")
        XCTAssertEqual(changes.first?.renamedFrom, nil)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `FileChange` has no `renamedFrom` argument/member yet, so the `init` call in the new test doesn't compile.

- [ ] **Step 3: Add `renamedFrom` to `FileChange`**

In `SCMModels.swift`, `FileChange`'s property list gains one line (exact surrounding properties per this plan's research: `path`, `status`, `staged`, then a computed `displayPath`/`id`):

```swift
    var path: String          // repo-relative; for renames, the new path
    var status: Status
    var staged: Bool
    /// The pre-rename path, when `status == .renamed`. `nil` for every
    /// other status. `StatusParser.parse` populates this from the porcelain
    /// line's "old -> new" segment instead of discarding the old side.
    var renamedFrom: String? = nil
```

- [ ] **Step 4: `StatusParser.parse` retains the old path**

Currently (`SCMParsers.swift:14-18`):

```swift
            var pathPart = String(chars[3...]).trimmingCharacters(in: .whitespaces)
            // Rename: "old -> new" — keep the new path.
            if let r = pathPart.range(of: " -> ") {
                pathPart = String(pathPart[r.upperBound...])
            }
            pathPart = unquote(pathPart)
```

becomes:

```swift
            var pathPart = String(chars[3...]).trimmingCharacters(in: .whitespaces)
            // Rename: "old -> new" — keep the new path as `pathPart`, but
            // no longer discard the old one; `oldPathPart` feeds
            // `FileChange.renamedFrom` below.
            var oldPathPart: String?
            if let r = pathPart.range(of: " -> ") {
                oldPathPart = unquote(String(pathPart[..<r.lowerBound]))
                pathPart = String(pathPart[r.upperBound...])
            }
            pathPart = unquote(pathPart)
```

Then update both `FileChange(...)` constructions later in the same function (lines 29-30) to pass it through:

```swift
            if x != " " { out.append(FileChange(path: pathPart, status: status(for: x), staged: true, renamedFrom: oldPathPart)) }
            if y != " " { out.append(FileChange(path: pathPart, status: status(for: y), staged: false, renamedFrom: oldPathPart)) }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. If a full Xcode toolchain is available, additionally run `swift test --filter SCMParsersTests` and confirm all tests (existing + the 2 new ones) pass.

- [ ] **Step 6: Render `old → new` in the changes list**

In `SourceControlView.swift`'s `fileRow(_:_:)` (per this plan's research, the row showing `Text(file.displayPath)`), change:

```swift
            Text(file.displayPath).font(Typography.caption).lineLimit(1).truncationMode(.middle)
```

to:

```swift
            if let renamedFrom = file.renamedFrom {
                Text("\(renamedFrom) → \(file.displayPath)")
                    .font(Typography.caption).lineLimit(1).truncationMode(.middle)
            } else {
                Text(file.displayPath).font(Typography.caption).lineLimit(1).truncationMode(.middle)
            }
```

- [ ] **Step 7: Run full build to verify no regressions**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SCMModels.swift mac/Sources/LlmIdeMac/Services/SCMParsers.swift mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift mac/Tests/LlmIdeMacTests/SCMParsersTests.swift
git commit -m "feat(mac): StatusParser retains the old path for renames; changes list shows old -> new"
```

---

### Task 12: Changes list — multi-select, keyboard navigation, context menu

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` (`fileRow`, `fileGroup`, the `@State` property list)

**Interfaces:**
- No new types — extends existing `SourceControlView` state and view code.

Replaces `@State private var selected: FileChange?` (single-selection) with a `Set<FileChange>` while preserving single-click-selects/opens-diff behavior as the common case (`⌘`-click toggles membership, `⇧`-click extends a range within the SAME `fileGroup` list the click landed in — staged and unstaged are separate lists, a range never spans both). The diff pane (`hunks`/`diffOriginal`/`diffModified`) continues to reflect exactly ONE file — whichever was most recently clicked — even when multiple are selected for a BULK stage/unstage/discard action; multi-select is for BULK actions on the list, not for showing multiple diffs at once (`MonacoDiffView` already established the "one file's diff at a time" pattern in Task 7).

- [ ] **Step 1: No test to write** — SwiftUI selection-state wiring, the same category as every other task in this plan touching `SourceControlView` directly. Proceed to Step 2.

- [ ] **Step 2: Replace `selected` with a set, keep single-file diff tracking**

Currently (line 14): `@State private var selected: FileChange?`

becomes:

```swift
    @State private var selectedFiles: Set<FileChange> = []
    /// The single file the diff pane shows — the most recently clicked
    /// file, independent of how many are in `selectedFiles` (multi-select
    /// drives bulk actions on the list; the diff pane still only ever
    /// shows one file, per Task 7's MonacoDiffView design).
    @State private var selected: FileChange?
```

Every existing reference to `selected` elsewhere in the file (the `.onChange(of: selected)` diff-loading hook from Task 7, `fileRow`'s highlight background, `dialogs`) is UNCHANGED by this — it keeps meaning "the file whose diff is shown." Only `fileRow`'s tap handling changes.

- [ ] **Step 3: Update `fileRow`'s tap gesture for multi-select**

Currently (`fileRow(_:_:)`, per this plan's research):

```swift
      .onTapGesture { selected = file }
```

becomes (using `NSEvent.modifierFlags` — the existing pattern for reading live modifier state in this codebase's AppKit-backed views; if a different existing helper for this is already in use elsewhere in `SourceControlView.swift` or a sibling Explorer/Source Control file, prefer that one instead of introducing a second way to read modifier keys):

```swift
      .onTapGesture {
          let flags = NSEvent.modifierFlags
          if flags.contains(.command) {
              if selectedFiles.contains(file) { selectedFiles.remove(file) } else { selectedFiles.insert(file) }
          } else if flags.contains(.shift), let anchor = selected,
                    let files = fileGroupFiles(containing: file, and: anchor) {
              selectedFiles.formUnion(files)
          } else {
              selectedFiles = [file]
          }
          selected = file
      }
      .contextMenu {
          contextMenuItems(for: file)
      }
```

Add a small helper near `fileRow` to resolve a `⇧`-click range within whichever of the two lists (staged/unstaged) both `file` and `anchor` belong to — if they're in DIFFERENT lists (one staged, one not), return `nil` (no cross-list range, per this task's own scoping above):

```swift
    /// Resolves a `⇧`-click range between `file` and `anchor`, scoped to
    /// whichever single list (staged or unstaged) both belong to — `nil`
    /// if they're in different lists, since a "range" spanning both has no
    /// sensible meaning here (they're rendered as two separate groups).
    private func fileGroupFiles(containing file: FileChange, and anchor: FileChange) -> [FileChange]? {
        let candidates = [scm.state.files.filter { $0.staged }, scm.state.files.filter { !$0.staged }]
        for list in candidates {
            guard let iFile = list.firstIndex(of: file), let iAnchor = list.firstIndex(of: anchor) else { continue }
            let range = iFile < iAnchor ? iFile...iAnchor : iAnchor...iFile
            return Array(list[range])
        }
        return nil
    }
```

- [ ] **Step 4: Add the context menu**

Near `fileRow`, add a `@ViewBuilder` method reusing the exact same actions `fileRow`'s existing inline buttons already call (`scm.stage`/`scm.unstage`, `confirmDiscard`) — the context menu is an additional entry point to the SAME actions, not new capability:

```swift
    @ViewBuilder
    private func contextMenuItems(for file: FileChange) -> some View {
        let targets = selectedFiles.contains(file) ? Array(selectedFiles) : [file]
        if file.staged {
            Button("Unstage\(targets.count > 1 ? " \(targets.count) Files" : "")") {
                guard let root else { return }
                Task { for f in targets { await scm.unstage(root: root, path: f.path) } }
            }
        } else {
            Button("Stage\(targets.count > 1 ? " \(targets.count) Files" : "")") {
                guard let root else { return }
                Task { for f in targets { await scm.stage(root: root, path: f.path) } }
            }
            Button("Discard Changes\(targets.count > 1 ? " (\(targets.count) Files)" : "")", role: .destructive) {
                confirmDiscard = file
            }
        }
        Divider()
        Button("Copy Path") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(file.path, forType: .string)
        }
        Button("Reveal in Finder") {
            guard let root else { return }
            NSWorkspace.shared.activateFileViewerSelecting([root.appendingPathComponent(file.path)])
        }
    }
```

(`confirmDiscard`'s existing dialog only ever discards the ONE file it was set to — this task does not extend bulk discard beyond what the confirmation dialog already supports; a "discard N files" bulk confirmation is a real UX decision for a follow-up, not silently added here.)

- [ ] **Step 5: Add keyboard navigation**

The changes list is a hand-built `ScrollView` + `ForEach` of `HStack`s (NOT a SwiftUI `List`), so arrow-key handling has to be added explicitly — converting the whole panel to `List(selection:)` would restructure its layout and styling wholesale, a visual-regression risk this environment cannot verify, and is not what this task is for.

Add a helper near `fileGroupFiles(containing:and:)` that resolves the next/previous file across BOTH groups in display order (unlike `⇧`-click ranges, plain arrow navigation SHOULD cross the staged/unstaged boundary — it's a single visual list to the user):

```swift
    /// All files in the order the two `fileGroup`s render them — staged
    /// first, then unstaged — so arrow-key navigation walks the list the
    /// way it looks on screen, crossing the group boundary.
    private var filesInDisplayOrder: [FileChange] {
        scm.state.files.filter { $0.staged } + scm.state.files.filter { !$0.staged }
    }

    /// Move the diff-pane selection one row up (-1) or down (+1). Clamps at
    /// both ends rather than wrapping (matching Finder/Xcode list behavior).
    private func moveSelection(_ delta: Int) {
        let files = filesInDisplayOrder
        guard !files.isEmpty else { return }
        guard let current = selected, let idx = files.firstIndex(of: current) else {
            // Nothing selected yet: arrow down selects the first row.
            let first = files[0]
            selected = first
            selectedFiles = [first]
            return
        }
        let next = min(max(idx + delta, 0), files.count - 1)
        let file = files[next]
        selected = file
        selectedFiles = [file]
    }
```

Then make the changes-mode file list focusable and wire the arrow keys. In `leftPane(_:)`, on the `ScrollView` that wraps the two `fileGroup` calls (per this plan's research, `leftPane` at `SourceControlView.swift:295-318` contains `ScrollView { errorBanner(); fileGroup(...); fileGroup(...) }` in Changes mode), add:

```swift
            .focusable()
            .onMoveCommand { direction in
                switch direction {
                case .up:   moveSelection(-1)
                case .down: moveSelection(1)
                default:    break
                }
            }
```

`onMoveCommand` is the AppKit-backed arrow-key hook for a focusable SwiftUI view — it fires for ↑/↓ (and ←/→, ignored here) only while the view has focus, so it can't swallow arrow keys meant for the commit-message field or the diff pane.

- [ ] **Step 6: Run full build to verify no regressions**

Run: `cd mac && swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift
git commit -m "feat(mac): changes list gains multi-select, keyboard navigation, and a context menu"
```

---

## End-of-phase verification

- [ ] Run the full test suite: `cd mac && swift build --build-tests 2>&1 | tail -40`. If a full Xcode toolchain is available, also run `swift test 2>&1 | tail -60` and confirm every test from Tasks 1, 2, 3, 11 passes (Tasks 4-10, 12 have no automated test — see each task's note).
- [ ] Run `cd mac && swift build 2>&1 | tail -5` and confirm `Build complete!` with no new warnings in the files this plan touched.
- [ ] `grep -rn "UnifiedDiffView\b\|DiffWebView\b" mac/Sources/ mac/Tests/` returns nothing.
- [ ] `git log --oneline -12` shows one commit per task, in order.
- [ ] **Manual verification** (per design §9 — this repo has no runnable XCTest, so this is the real acceptance gate): launch the Mac app against a real git repo with staged AND unstaged changes across multiple files, including at least one rename (`git mv`) and one multi-hunk file.
  - [ ] Changes mode: select a file, confirm the Monaco diff view renders word-level highlighting and the hunk list below it shows the SAME hunks with working Stage/Unstage buttons; stage one hunk and confirm `git diff --cached` on disk reflects exactly that hunk, not the whole file.
  - [ ] Unstage a previously-staged hunk the same way; confirm it returns to the unstaged diff, not lost.
  - [ ] Rename a file (`git mv`) — confirm the changes list shows "old → new", not just the new path.
  - [ ] Multi-select 2+ files (`⌘`-click, `⇧`-click) and stage/unstage them together via the context menu; confirm the single-file diff pane still shows a sensible single file throughout (doesn't error/blank on multi-select).
  - [ ] Click a file in the changes list, then press ↑/↓ — confirm the selection (and the diff pane) moves one row at a time, crosses the staged/unstaged group boundary, and clamps at both ends without wrapping. Then click into the commit-message field and press ↑/↓ there — confirm the file list does NOT move (focus correctly gates the arrow keys).
  - [ ] History mode: select a commit touching 2+ files, confirm the file list appears, and confirm picking a file shows THAT file's diff only (not every file's diff at once, not a hang from multiple Monaco instances).
  - [ ] Trigger the agent's `update-file` tool (or however this repo's chat currently exercises it) and confirm `UpdateFileSheet`'s diff view renders via Monaco, the separate "editable" text box still lets you hand-edit before Apply, and the "+N −M" summary chip still updates live as you type.
  - [ ] Trigger a Code Workflow run that touches multiple files and confirm `CodeWorkflowSheet`'s per-file previews show colored hunks (not a raw diff-text dump) when expanded.

## What P3 inherits

- `MonacoDiffView`/`HunkStagingList` — ready for `ExplorerTreeStore`'s own diff-adjacent needs if any arise, though P3's own scope (per design §11) is Explorer tree state, not diffs.
- `GitTruthStore.stagePatch`/`unstagePatch` — the hunk-staging primitive is now proven in Source Control; nothing about it is Source-Control-specific.
- `FileChange.renamedFrom` — available for Explorer's own file-tree rename display, if P3 wants it (not required — Explorer's current rename UI, if any, is untouched by this plan).
