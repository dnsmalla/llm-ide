# VS Code Parity P4: Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Search panel into the VS Code equivalent: a genuinely cancellable streaming search that respects `.gitignore`, jumps the editor to the clicked result's line, warns when it hits the match cap, roots at the same folder the Explorer shows, previews replacements inline, and opens with ⌘⇧F from anywhere in the app.

**Architecture:** Search stays a Swift in-process filesystem walk — no `rg`, no `git grep` subprocess (see "Backend decision", below). The walk is split into three pure, separately testable layers that `SearchService` merely wraps: `GitIgnoreRules` decides what a path is allowed to be, `SearchEngine` decides where the matches are, and `SearchService.stream` turns the two into an `AsyncStream<SearchEvent>` whose consumer cancels simply by walking away. The UI layer changes are thin by design: `SearchView` appends pre-sorted `.file` events, and the line-jump reuses P1's existing `MonacoRevealRequest` rather than inventing a second reveal path.

**Tech Stack:** Swift 5 language mode (macOS 14+ target), SwiftUI, Foundation (`FileManager.enumerator`, `NSRegularExpression`), `AsyncStream`, XCTest.

**Spec:** [docs/superpowers/specs/2026-09-03-vscode-parity-explorer-scm-search-design.md](../specs/2026-09-03-vscode-parity-explorer-scm-search-design.md) — read §3 findings #7 (no line-jump plumbing anywhere), #8 (uncancellable `Task.detached` walks) and #10 (Search and Explorer use different root resolution), §6.5 (`SearchService.search` restructured to a stream), §8 (search-cancellation error handling), §9 (testing strategy: pure Swift logic gets tests, view glue is manual), and §11's P4 bullet.

**Prior phases:** P0 (foundation, merged) built the `Theme` diff/gutter tokens, `GitTruthStore`, the vendored Monaco bundle, and `MonacoHost`/`MonacoBridge`. **P1 (Editor, merged) built the `MonacoRevealRequest` line-jump API that Task 7 consumes** — its doc comment in `mac/Sources/LlmIdeMac/Views/Shared/MonacoHost.swift:4-21` is the contract this plan honours. P2 (Source Control) is in flight on this branch; P4 touches none of its files (`MonacoDiffView.swift`, `HunkStagingList.swift`, `SourceControlView.swift`, `RepoManager.swift`, `GitTruthStore.swift`).

### Backend decision — settled, do not re-litigate

Search stays an **in-process Swift filesystem walk**, and `.gitignore` is parsed in Swift rather than shelled out to `git check-ignore`. The evidence:

- Spec §6.5 prescribes it: "`SearchService.search` — restructured to an `AsyncStream<FileMatch>` … with `Task.isCancelled` checked inside the walk loop."
- **ripgrep is not installed** on this machine — `/opt/homebrew/bin/rg`, `/usr/local/bin/rg` and `/usr/bin/rg` are all absent. Shipping a feature that depends on it would ship a broken feature.
- `/usr/bin/git` *is* a hard dependency (`RepoManager` hardcodes it), but `git grep` uses a POSIX/PCRE engine while every replace path in `SearchService` uses `NSRegularExpression` (ICU). `SearchService.makeRegex`'s own doc comment (`SearchService.swift:20-33`) records that find and replace MUST observe the same match ordering — a second regex engine on the find side would make `replaceOne(fileIndex:)` silently rewrite the wrong occurrence.
- `RepoManager.git` buffers all output before resuming its continuation, so it could not stream results even if the engines matched.
- `git check-ignore` costs a subprocess per candidate path and **fails outright in a folder that is not a git repo** — which Search must still handle, since `WorkspaceRoot` can resolve to a plain project folder.

## Global Constraints

- Swift 6 language mode is NOT enabled (`swiftLanguageModes: [.v5]` in `Package.swift`) — do not add
  strict-concurrency-only syntax.
- No raw `Color.green`/`.red`/`.orange` in new or touched view code — always a `Theme` token (`Theme.swift`).
- This toolchain (Xcode Command Line Tools only, no full Xcode) CANNOT run `swift test` — it fails with
  `no such module 'XCTest'`. Every "run the test" step still means literally running the command; if it fails
  that way, that is an environment limitation, not a task failure. Confirm via `swift build` and
  `swift build --build-tests` instead, and state explicitly that the test did not execute. Never claim a test
  passed when it did not run.
- Do NOT set `GIT_CONFIG_GLOBAL` in any command — it is blocked in this isolated session and unnecessary.
  Build commands are plain `swift build`.
- View-glue code (SwiftUI + WKWebView) has no live-WebView test harness — confirmed manually per a checklist,
  not by XCTest. Pure logic (matchers, ignore-rule parsing, streaming/cancellation) gets real tests.
- Replace is DESTRUCTIVE to the user's working tree. Any task touching it must test against a REAL temp
  directory, never a mock, and verify resulting file contents.
- Split on `\.isNewline`, never the literal `"\n"` — Swift treats `"\r\n"` as ONE Character, a trap that has
  bitten this project three times.
- Chain every `cd` with its command in ONE Bash call; the working directory does not persist between calls.
- SourceKit diagnostics in this repo are frequently STALE false positives. Only real `swift build` output counts.

### Settled rulings (each is restated in the task where it applies)

- **The stream element is `SearchEvent`, not `FileMatch`.** §6.5 explicitly allows "an `AsyncStream<FileMatch>` (or a callback-per-file API)"; the truncation warning needs an out-of-band signal, so the element is an enum whose `.file` case carries the `FileMatch` — a superset of the spec's shape, not a departure. Cases: `.file(FileMatch)` / `.truncated(cap: Int)` / `.finished(totalMatches: Int, fileCount: Int)`.
- **`.gitignore` scope:** repo-root `.gitignore` + `.git/info/exclude` + nested `.gitignore` files discovered pre-order. Character classes (`[a-z]`) and backslash escapes are NOT supported — a pattern using them degrades to a *literal* match (every metacharacter regex-escaped) rather than misbehaving. `core.excludesFile` is not consulted.
- **Root unification means the Explorer's DISPLAY root**, including its single-child collapse (`code/` collapsed to its only child). Stated deliberately as an accepted consequence: with a project open, Search no longer covers `source/`, `notes/`, `data/`. That is what the requirement means.
- Cancellation is injected as a `() -> Bool` closure (not a direct `Task.isCancelled` read) so tests drive it deterministically without spawning a Task. The real caller passes `{ Task.isCancelled }`.
- A cancelled run emits **no** `.finished` — the consumer is gone and a partial total would be a lie.
- `stream` does not report an invalid regex. `makeRegex` is already `nonisolated static`, so the caller checks the pattern before starting a stream. This keeps an error case out of the element type that could only ever occur before the first event.

### P3 coordination point

Task 4 adds `WorkspaceRoot.browsingRoot`/`pickBrowsingRoot`, which replicate the logic currently inline in `ExplorerView.root` (`ExplorerView.swift:57-60`) and `ExplorerView.effectiveDisplayRoot` (`ExplorerView.swift:226-230`), and then delete those two inline copies. **P3 (Explorer) is being planned in parallel and rewrites the same file.** If P3 lands first and has introduced its own root helper (e.g. on `ExplorerTreeStore`), do NOT keep both: `WorkspaceRoot.pickBrowsingRoot` is the single definition, and P3's copy is deleted in favour of it. A merge conflict in `ExplorerView.swift` is expected here and is the *only* place these two phases touch the same file.

---

## File Structure

**New files:**

- `mac/Sources/LlmIdeMac/Services/GitIgnoreRules.swift` — parses and evaluates `.gitignore` patterns. Pure; no FileManager beyond reading a named file.
- `mac/Sources/LlmIdeMac/Services/SearchEngine.swift` — the match core: CRLF-safe line matching, the cancellable/truncating scan, and the `.gitignore`-aware candidate collector. No actor, no AsyncStream.
- `mac/Sources/LlmIdeMac/Services/SearchHeaderText.swift` — the results-header copy, including the truncation warning, as pure functions.
- `mac/Sources/LlmIdeMac/Services/ReplacePreview.swift` — the "before → after" segment model for a result row under an active Replace term.
- `mac/Sources/LlmIdeMac/Services/SearchFocusGate.swift` — decides whether a just-appeared Search panel should take keyboard focus.
- `mac/Sources/LlmIdeMac/Views/Shared/MonacoRevealGate.swift` — the "never reveal into an empty buffer" rule, shared by the two places that apply a reveal.
- `mac/Tests/LlmIdeMacTests/GitIgnoreRulesTests.swift`
- `mac/Tests/LlmIdeMacTests/SearchEngineTests.swift`
- `mac/Tests/LlmIdeMacTests/SearchStreamTests.swift`
- `mac/Tests/LlmIdeMacTests/WorkspaceRootBrowsingTests.swift`
- `mac/Tests/LlmIdeMacTests/SearchHeaderTextTests.swift`
- `mac/Tests/LlmIdeMacTests/MonacoRevealGateTests.swift`
- `mac/Tests/LlmIdeMacTests/ReplacePreviewTests.swift`
- `mac/Tests/LlmIdeMacTests/SearchFocusGateTests.swift`

**Modified files:**

- `mac/Sources/LlmIdeMac/Services/SearchService.swift` — gains `SearchEvent` + `nonisolated static func stream(...)`; `SearchResults` gains `truncated`; the private `walk`/`isBinary`/`maxFileBytes`/`maxMatches` and the batch `search(...)` are deleted once the stream replaces them.
- `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift` — consumes the stream, appends incrementally, renders the truncation warning and the replace preview, passes a `MonacoRevealRequest` on result click, roots at `WorkspaceRoot.browsingRoot`, takes focus on ⌘⇧F.
- `mac/Sources/LlmIdeMac/Services/WorkspaceRoot.swift` — gains `browsingRoot(config:projectStore:)` and the pure `pickBrowsingRoot(codeDir:fallback:exists:children:)`.
- `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` — `root` and `effectiveDisplayRoot` delegate to `WorkspaceRoot` (the P3 coordination point above).
- `mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift` — `initialLine: Int?` becomes `revealTarget: MonacoRevealRequest?` through `FileDetailView` → `MarkdownDetailView`/`CodeDetailView` → `EditableTextDetailView`; the preview closure becomes `(String, MonacoRevealRequest?) -> Preview`.
- `mac/Sources/LlmIdeMac/Services/ShellState.swift` — gains `var searchFocusToken: UUID?`.
- `mac/Sources/LlmIdeMac/Services/NotificationNames.swift` — gains `.focusSearchField`.
- `mac/Sources/LlmIdeMac/Views/AppShell.swift` — observes `.focusSearchField`.
- `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` — adds the ⌘⇧F "Find in Files…" command.

**Deleted files:** none. (Dead code is removed inside `SearchService.swift` in Task 5.)

---

### Task 1: `GitIgnoreRules` — parse and evaluate `.gitignore`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/GitIgnoreRules.swift`
- Test: Create `mac/Tests/LlmIdeMacTests/GitIgnoreRulesTests.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks. Foundation only.
- Produces:
  - `struct GitIgnoreRule { let base: String; let regex: NSRegularExpression; let isNegated: Bool; let dirOnly: Bool; func matches(path: String, isDirectory: Bool) -> Bool }`
  - `struct GitIgnoreRules { private(set) var rules: [GitIgnoreRule]; var isEmpty: Bool; static func repoRoot(_ root: URL) -> GitIgnoreRules; mutating func addFile(at url: URL, base: String); mutating func add(text: String, base: String); func isIgnored(relativePath: String, isDirectory: Bool) -> Bool; static func parse(_ text: String, base: String) -> [GitIgnoreRule]; static func translate(_ glob: String) -> String }`

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/GitIgnoreRulesTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// `.gitignore` is hand-translated to regex here (Foundation has no glob
/// engine and `git check-ignore` is one subprocess per path — and fails
/// outright outside a repo). A subtle anchoring or precedence bug silently
/// changes which files a search reads, with no compiler help to catch it.
final class GitIgnoreRulesTests: XCTestCase {

    private func rules(_ text: String, base: String = "") -> GitIgnoreRules {
        var out = GitIgnoreRules()
        out.add(text: text, base: base)
        return out
    }

    func testEmptyRulesIgnoreNothing() {
        let r = GitIgnoreRules()
        XCTAssertTrue(r.isEmpty)
        XCTAssertFalse(r.isIgnored(relativePath: "a/b.txt", isDirectory: false))
    }

    func testCommentsAndBlankLinesAreSkipped() {
        let r = rules("# a comment\n\n   \n*.log\n")
        XCTAssertEqual(r.rules.count, 1)
        XCTAssertTrue(r.isIgnored(relativePath: "x.log", isDirectory: false))
    }

    func testBareNameIgnoresAtAnyDepth() {
        let r = rules("node_modules\n")
        XCTAssertTrue(r.isIgnored(relativePath: "node_modules/x.js", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "a/b/node_modules/x.js", isDirectory: false))
    }

    func testLeadingSlashAnchorsToTheGitignoreDirectory() {
        let r = rules("/build\n")
        XCTAssertTrue(r.isIgnored(relativePath: "build/out.o", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "src/build/out.o", isDirectory: false))
    }

    func testEmbeddedSlashAlsoAnchors() {
        let r = rules("src/generated\n")
        XCTAssertTrue(r.isIgnored(relativePath: "src/generated/a.swift", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "app/src/generated/a.swift", isDirectory: false))
    }

    func testTrailingSlashMatchesDirectoriesOnly() {
        let r = rules("logs/\n")
        XCTAssertTrue(r.isIgnored(relativePath: "logs", isDirectory: true))
        XCTAssertFalse(r.isIgnored(relativePath: "logs", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "logs/today.txt", isDirectory: false))
    }

    func testNegationReIncludesAFile() {
        let r = rules("*.log\n!keep.log\n")
        XCTAssertTrue(r.isIgnored(relativePath: "drop.log", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "keep.log", isDirectory: false))
    }

    func testNegationCannotEscapeAnIgnoredParentDirectory() {
        // git: "It is not possible to re-include a file if a parent
        // directory of that file is excluded."
        let r = rules("build/\n!build/keep.txt\n")
        XCTAssertTrue(r.isIgnored(relativePath: "build/keep.txt", isDirectory: false))
    }

    func testSingleStarDoesNotCrossASlash() {
        let r = rules("src/*.swift\n")
        XCTAssertTrue(r.isIgnored(relativePath: "src/a.swift", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "src/deep/a.swift", isDirectory: false))
    }

    func testDoubleStarCrossesDirectories() {
        let r = rules("docs/**/*.md\n")
        XCTAssertTrue(r.isIgnored(relativePath: "docs/a.md", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "docs/x/y/a.md", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "notes/a.md", isDirectory: false))
    }

    func testQuestionMarkMatchesOneCharacter() {
        let r = rules("tmp?.txt\n")
        XCTAssertTrue(r.isIgnored(relativePath: "tmp1.txt", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "tmp12.txt", isDirectory: false))
    }

    func testCharacterClassDegradesToALiteralMatch() {
        // Ruling: `[...]` and `\` are out of scope. Degrade to literal rather
        // than emit a regex that means something else.
        let r = rules("file[1].txt\n")
        XCTAssertTrue(r.isIgnored(relativePath: "file[1].txt", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "file1.txt", isDirectory: false))
    }

    func testTrailingWhitespaceIsTrimmed() {
        let r = rules("*.tmp   \n")
        XCTAssertTrue(r.isIgnored(relativePath: "a.tmp", isDirectory: false))
    }

    func testNestedGitignoreOnlyAppliesToItsOwnSubtree() {
        var r = GitIgnoreRules()
        r.add(text: "*.tmp\n", base: "sub")
        XCTAssertTrue(r.isIgnored(relativePath: "sub/a.tmp", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "sub/deep/a.tmp", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "a.tmp", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "other/a.tmp", isDirectory: false))
    }

    func testLaterRuleWinsAtTheSameLevel() {
        var r = GitIgnoreRules()
        r.add(text: "*.txt\n", base: "")
        r.add(text: "!notes.txt\n", base: "sub")
        XCTAssertTrue(r.isIgnored(relativePath: "notes.txt", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "sub/notes.txt", isDirectory: false))
    }

    func testRepoRootReadsGitignoreAndInfoExclude() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gitignore-rules-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent(".git/info"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try "*.log\n".write(to: root.appendingPathComponent(".gitignore"),
                            atomically: true, encoding: .utf8)
        try "secret.txt\n".write(to: root.appendingPathComponent(".git/info/exclude"),
                                 atomically: true, encoding: .utf8)

        let r = GitIgnoreRules.repoRoot(root)
        XCTAssertTrue(r.isIgnored(relativePath: "a.log", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "secret.txt", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "a.swift", isDirectory: false))
    }

    func testRepoRootOnANonRepoFolderIsEmpty() {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gitignore-none-\(UUID().uuidString)")
        XCTAssertTrue(GitIgnoreRules.repoRoot(root).isEmpty)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter GitIgnoreRulesTests`

Expected in a full-Xcode environment: FAIL with "cannot find 'GitIgnoreRules' in scope".
Expected in THIS environment: the command fails with `no such module 'XCTest'` before running anything. That is the known toolchain limitation — record it, do not claim the test ran. Then confirm the intended failure by compiling instead:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | head -30`
Expected: a compile error naming `GitIgnoreRules`.

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Services/GitIgnoreRules.swift`:

```swift
import Foundation

/// One parsed `.gitignore` pattern.
///
/// `base` is the repo-relative directory whose `.gitignore` produced this rule
/// ("" for the repo root). A rule only ever applies to paths under its own
/// base — that is what scopes a nested `.gitignore` to its own subtree.
struct GitIgnoreRule {
    let base: String
    /// Anchored `^…$` over the path RELATIVE TO `base`.
    let regex: NSRegularExpression
    /// `!pattern` — a match UN-ignores instead of ignoring.
    let isNegated: Bool
    /// `pattern/` — only matches a directory.
    let dirOnly: Bool

    /// Does this rule match `path` (repo-relative, no leading slash)?
    /// `isDirectory` describes `path` itself.
    func matches(path: String, isDirectory: Bool) -> Bool {
        if dirOnly && !isDirectory { return false }
        let sub: String
        if base.isEmpty {
            sub = path
        } else if path.hasPrefix(base + "/") {
            sub = String(path.dropFirst(base.count + 1))
        } else {
            return false
        }
        let ns = sub as NSString
        return regex.firstMatch(in: sub, options: [],
                                range: NSRange(location: 0, length: ns.length)) != nil
    }
}

/// A `.gitignore` evaluator, parsed in Swift rather than shelled out to
/// `git check-ignore`.
///
/// Why in-process: `check-ignore` costs one subprocess per candidate path (or
/// a long-lived pipe to babysit), and it FAILS OUTRIGHT in a folder that is
/// not a git repo — which Search must still handle, since `WorkspaceRoot` can
/// resolve to a plain project folder. Parsing here is pure, testable, and runs
/// inside the same off-main walk that already reads the files.
///
/// SUPPORTED: `#` comments, blank lines, trailing-whitespace trimming, `!`
/// negation, trailing `/` (directory-only), leading `/` or an embedded `/`
/// (anchored to the rule's own directory), `*`, `?`, `**/`, `/**`, and nested
/// `.gitignore` files.
///
/// NOT SUPPORTED, deliberately: character classes (`[a-z]`) and backslash
/// escapes. A pattern containing `[`, `]` or `\` degrades to a LITERAL match
/// (every metacharacter regex-escaped) rather than silently meaning something
/// else. `core.excludesFile` (the user's global ignore) is not consulted.
struct GitIgnoreRules {
    private(set) var rules: [GitIgnoreRule] = []

    var isEmpty: Bool { rules.isEmpty }

    /// Root rules: `<root>/.gitignore` then `<root>/.git/info/exclude`.
    /// Missing files are skipped, so a non-repo folder yields an empty
    /// (always-false) evaluator instead of an error.
    static func repoRoot(_ root: URL) -> GitIgnoreRules {
        var out = GitIgnoreRules()
        out.addFile(at: root.appendingPathComponent(".gitignore"), base: "")
        out.addFile(at: root.appendingPathComponent(".git/info/exclude"), base: "")
        return out
    }

    /// Append the rules in `url`, scoped to `base`. No-op when unreadable.
    mutating func addFile(at url: URL, base: String) {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else { return }
        add(text: text, base: base)
    }

    /// Append parsed rules. ORDER MATTERS: later rules win, so a nested
    /// `.gitignore` must be added AFTER the rules it may override — which a
    /// pre-order directory walk gives for free.
    mutating func add(text: String, base: String) {
        rules.append(contentsOf: Self.parse(text, base: base))
    }

    /// Is `relativePath` (repo-relative, no leading slash) ignored?
    ///
    /// Every ancestor directory is tested first and short-circuits: git cannot
    /// re-include a file whose parent directory is excluded, so the first
    /// ancestor that comes out ignored is final.
    func isIgnored(relativePath: String, isDirectory: Bool) -> Bool {
        let comps = relativePath.split(separator: "/").map(String.init)
        guard !comps.isEmpty else { return false }
        for i in comps.indices {
            let prefix = comps[0...i].joined(separator: "/")
            let prefixIsDir = (i < comps.count - 1) || isDirectory
            if decide(path: prefix, isDirectory: prefixIsDir) { return true }
        }
        return false
    }

    /// Last matching rule wins — git's own precedence within one path level.
    private func decide(path: String, isDirectory: Bool) -> Bool {
        var ignored = false
        for rule in rules where rule.matches(path: path, isDirectory: isDirectory) {
            ignored = !rule.isNegated
        }
        return ignored
    }

    static func parse(_ text: String, base: String) -> [GitIgnoreRule] {
        var out: [GitIgnoreRule] = []
        for rawLine in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            var line = String(rawLine)
            // Trailing whitespace is insignificant. (Escaping it is a
            // backslash form, which this parser deliberately does not support.)
            while line.hasSuffix(" ") || line.hasSuffix("\t") { line.removeLast() }
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            var isNegated = false
            if line.hasPrefix("!") { isNegated = true; line.removeFirst() }
            var dirOnly = false
            if line.hasSuffix("/") { dirOnly = true; line.removeLast() }
            guard !line.isEmpty else { continue }
            // Computed BEFORE the leading slash is stripped: a slash anywhere
            // in the pattern anchors it to the .gitignore's own directory,
            // while a bare name matches at any depth below it.
            let anchored = line.contains("/")
            if line.hasPrefix("/") { line.removeFirst() }
            guard !line.isEmpty else { continue }
            let pattern = "^" + (anchored ? "" : "(?:.*/)?") + translate(line) + "$"
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            out.append(GitIgnoreRule(base: base, regex: regex,
                                     isNegated: isNegated, dirOnly: dirOnly))
        }
        return out
    }

    /// Glob body → regex body (no anchors — `parse` adds those).
    static func translate(_ glob: String) -> String {
        // Ruling: character classes and backslash escapes are out of scope.
        // Degrade to a literal match instead of producing a wrong regex.
        if glob.contains("[") || glob.contains("]") || glob.contains("\\") {
            return NSRegularExpression.escapedPattern(for: glob)
        }
        var out = ""
        var i = glob.startIndex
        while i < glob.endIndex {
            let c = glob[i]
            if c == "*" {
                let next = glob.index(after: i)
                if next < glob.endIndex, glob[next] == "*" {
                    let after = glob.index(after: next)
                    if after < glob.endIndex, glob[after] == "/" {
                        out += "(?:.*/)?"          // `**/` — zero or more dirs
                        i = glob.index(after: after)
                        continue
                    }
                    out += ".*"                     // `/**` or a bare `**`
                    i = after
                    continue
                }
                out += "[^/]*"
            } else if c == "?" {
                out += "[^/]"
            } else {
                out += NSRegularExpression.escapedPattern(for: String(c))
            }
            i = glob.index(after: i)
        }
        return out
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter GitIgnoreRulesTests`
Expected in a full-Xcode environment: PASS (18 tests).
Expected here: `no such module 'XCTest'`. State that the test did not execute, then confirm compilation:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build && swift build --build-tests`
Expected: both succeed with no errors.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/GitIgnoreRules.swift mac/Tests/LlmIdeMacTests/GitIgnoreRulesTests.swift
git commit -m "feat(mac): add GitIgnoreRules — in-process .gitignore parsing for Search"
```

---

### Task 2: `SearchEngine` — CRLF-safe, cancellable match core

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/SearchEngine.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/SearchService.swift:13-15` (the three private constants), `:52-111` (`walk` and `isBinary`)
- Test: Create `mac/Tests/LlmIdeMacTests/SearchEngineTests.swift`

**Interfaces:**
- Consumes: `struct Match { let nsRange: NSRange; let fileIndex: Int }`, `struct LineMatch { let line: Int; let lineText: String; let matches: [Match] }`, `struct FileMatch { let url: URL; let displayPath: String; let lineMatches: [LineMatch] }` — all already declared at file scope in `SearchService.swift:5-7`. `SearchService.makeRegex(query:options:) -> NSRegularExpression?` (`SearchService.swift:20`).
- Produces:
  - `enum SearchEngine` with `static let maxMatches = 1000`, `static let maxFileBytes = 1_000_000`
  - `struct SearchEngine.Candidate: Equatable { let url: URL; let displayPath: String }`
  - `enum SearchEngine.Outcome: Equatable { case completed(totalMatches: Int, fileCount: Int); case truncated(totalMatches: Int, fileCount: Int); case cancelled }`
  - `static func lineMatches(in text: String, regex: NSRegularExpression, budget: Int) -> (lines: [LineMatch], used: Int)`
  - `static func isBinary(_ data: Data) -> Bool`
  - `static func fileText(at url: URL) -> String?`
  - `static func scan(candidates: [Candidate], regex: NSRegularExpression, readText: (URL) -> String?, isCancelled: () -> Bool, emit: (FileMatch) -> Void) -> Outcome`

**Why this task also touches `SearchService.walk`:** the CRLF bug below is live in shipping code. Rewiring `walk`'s inner loop to the new `lineMatches` fixes it in this task, so the fix stands on its own even if the rest of P4 stops here. Task 5 deletes `walk` entirely once the stream replaces it.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/SearchEngineTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// The match core. Two classes of bug live here and neither shows up in a
/// compiler: line numbers that are wrong (which makes P4's line-jump land in
/// the wrong place) and a walk that ignores cancellation (design §3 #8).
final class SearchEngineTests: XCTestCase {

    private func regex(_ query: String, options: SearchOptions = SearchOptions()) -> NSRegularExpression {
        // Force-unwrap is fine in a test: an unbuildable pattern is a test bug.
        SearchService.makeRegex(query: query, options: options)!
    }

    // MARK: - lineMatches

    func testLFFileReportsRealLineNumbers() {
        let text = "alpha\nbeta\nneedle\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("needle"), budget: 100)
        XCTAssertEqual(out.lines.map(\.line), [3])
        XCTAssertEqual(out.used, 1)
    }

    /// REGRESSION: `SearchService.walk` split on the literal "\n". Swift
    /// treats "\r\n" as ONE Character, so a CRLF file came back as a single
    /// line and every match was reported on line 1.
    func testCRLFFileReportsRealLineNumbers() {
        let text = "alpha\r\nbeta\r\nneedle\r\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("needle"), budget: 100)
        XCTAssertEqual(out.lines.map(\.line), [3])
        XCTAssertEqual(out.lines.first?.lineText, "needle")
    }

    func testLoneCarriageReturnAlsoSplitsLines() {
        let text = "alpha\rbeta\rneedle"
        let out = SearchEngine.lineMatches(in: text, regex: regex("needle"), budget: 100)
        XCTAssertEqual(out.lines.map(\.line), [3])
    }

    func testMultipleMatchesOnOneLineGetSequentialFileIndexes() {
        let text = "foo bar foo\nfoo\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("foo"), budget: 100)
        XCTAssertEqual(out.used, 3)
        XCTAssertEqual(out.lines.count, 2)
        XCTAssertEqual(out.lines[0].matches.map(\.fileIndex), [0, 1])
        XCTAssertEqual(out.lines[1].matches.map(\.fileIndex), [2])
    }

    func testBudgetCapsMatchesAcrossLines() {
        let text = "foo\nfoo\nfoo\nfoo\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("foo"), budget: 2)
        XCTAssertEqual(out.used, 2)
        XCTAssertEqual(out.lines.map(\.line), [1, 2])
    }

    func testZeroBudgetProducesNothing() {
        let out = SearchEngine.lineMatches(in: "foo\n", regex: regex("foo"), budget: 0)
        XCTAssertTrue(out.lines.isEmpty)
        XCTAssertEqual(out.used, 0)
    }

    func testMultibyteRangesMapBackToTheSameLineText() {
        let text = "前\n出力調整禁止です\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("出力調整禁止"), budget: 100)
        XCTAssertEqual(out.lines.count, 1)
        let line = out.lines[0]
        let range = Range(line.matches[0].nsRange, in: line.lineText)
        XCTAssertNotNil(range)
        XCTAssertEqual(range.map { String(line.lineText[$0]) }, "出力調整禁止")
    }

    // MARK: - isBinary

    func testIsBinaryDetectsNulByte() {
        XCTAssertTrue(SearchEngine.isBinary(Data([0x41, 0x00, 0x42])))
        XCTAssertFalse(SearchEngine.isBinary(Data("plain text".utf8)))
    }

    // MARK: - scan

    private func candidate(_ name: String) -> SearchEngine.Candidate {
        SearchEngine.Candidate(url: URL(fileURLWithPath: "/tmp/\(name)"), displayPath: name)
    }

    func testScanEmitsOneFileMatchPerMatchingCandidateInOrder() {
        let texts = ["a.txt": "needle\n", "b.txt": "nothing\n", "c.txt": "x\nneedle\n"]
        var emitted: [String] = []
        let outcome = SearchEngine.scan(
            candidates: [candidate("a.txt"), candidate("b.txt"), candidate("c.txt")],
            regex: regex("needle"),
            readText: { texts[$0.lastPathComponent] },
            isCancelled: { false },
            emit: { emitted.append($0.displayPath) })
        XCTAssertEqual(emitted, ["a.txt", "c.txt"])
        XCTAssertEqual(outcome, .completed(totalMatches: 2, fileCount: 2))
    }

    func testScanSkipsUnreadableCandidate() {
        var emitted: [String] = []
        let outcome = SearchEngine.scan(
            candidates: [candidate("binary.bin"), candidate("a.txt")],
            regex: regex("needle"),
            readText: { $0.lastPathComponent == "a.txt" ? "needle\n" : nil },
            isCancelled: { false },
            emit: { emitted.append($0.displayPath) })
        XCTAssertEqual(emitted, ["a.txt"])
        XCTAssertEqual(outcome, .completed(totalMatches: 1, fileCount: 1))
    }

    func testScanStopsAtTheFirstCancelledCheckAndReportsCancelled() {
        var reads = 0
        var emitted = 0
        let outcome = SearchEngine.scan(
            candidates: (0..<50).map { candidate("f\($0).txt") },
            regex: regex("needle"),
            readText: { _ in reads += 1; return "needle\n" },
            isCancelled: { reads >= 3 },
            emit: { _ in emitted += 1 })
        XCTAssertEqual(outcome, .cancelled)
        XCTAssertEqual(reads, 3, "cancellation must be checked BEFORE each file, not after the walk")
        XCTAssertEqual(emitted, 3)
    }

    func testScanReportsTruncatedWhenTheCapIsHit() {
        // One match per file, one more file than the cap allows.
        let candidates = (0..<(SearchEngine.maxMatches + 5)).map { candidate("f\($0).txt") }
        var emitted = 0
        let outcome = SearchEngine.scan(
            candidates: candidates,
            regex: regex("needle"),
            readText: { _ in "needle\n" },
            isCancelled: { false },
            emit: { _ in emitted += 1 })
        XCTAssertEqual(outcome, .truncated(totalMatches: SearchEngine.maxMatches,
                                           fileCount: SearchEngine.maxMatches))
        XCTAssertEqual(emitted, SearchEngine.maxMatches)
    }

    func testFileTextSkipsAnOversizeFile() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("search-engine-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let big = dir.appendingPathComponent("big.txt")
        try String(repeating: "x", count: SearchEngine.maxFileBytes + 10)
            .write(to: big, atomically: true, encoding: .utf8)
        XCTAssertNil(SearchEngine.fileText(at: big))

        let small = dir.appendingPathComponent("small.txt")
        try "hello".write(to: small, atomically: true, encoding: .utf8)
        XCTAssertEqual(SearchEngine.fileText(at: small), "hello")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter SearchEngineTests`
Expected in a full-Xcode environment: FAIL with "cannot find 'SearchEngine' in scope".
Expected here: `no such module 'XCTest'` — record it, then confirm the real failure with
`cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | head -30`
Expected: a compile error naming `SearchEngine`.

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Services/SearchEngine.swift`:

```swift
import Foundation

/// The pure match core behind `SearchService`. No actor, no `AsyncStream`, no
/// filesystem walk — it takes text (or an already-decided list of candidate
/// files plus a reader closure) and produces matches, so every behaviour here
/// is unit-testable without a live repo or a Task.
enum SearchEngine {
    /// Global match cap for one run. Reached → the run stops and the UI shows
    /// a truncation warning rather than silently presenting a partial list as
    /// if it were complete.
    static let maxMatches = 1000
    /// Files larger than this are skipped: a 1 MB source file is already
    /// pathological, and reading a huge blob into memory to grep it is not
    /// acceptable in an interactive panel.
    static let maxFileBytes = 1_000_000

    /// One file the walk decided is worth reading.
    struct Candidate: Equatable {
        let url: URL
        /// Path relative to the search root, as shown in the results list.
        let displayPath: String
    }

    /// How a `scan` ended.
    enum Outcome: Equatable {
        case completed(totalMatches: Int, fileCount: Int)
        /// `maxMatches` was hit; results are a prefix of the truth.
        case truncated(totalMatches: Int, fileCount: Int)
        /// `isCancelled` returned true. Results are partial AND the consumer
        /// is gone, so callers must not report a total for this run.
        case cancelled
    }

    /// Split `text` into lines and match `regex` against each. Line numbers
    /// are 1-BASED, matching what an editor shows.
    ///
    /// Splits on `\.isNewline`, NEVER on the literal `"\n"`: Swift treats
    /// `"\r\n"` as ONE `Character`, so `split(separator: "\n")` returns a CRLF
    /// file as a single line and reports every match on line 1 — the bug that
    /// made search-result line numbers useless in CRLF files, and which would
    /// have silently broken this phase's line-jump.
    ///
    /// `budget` caps how many matches may be produced (the run-wide
    /// `maxMatches` remainder); `used` is how many actually were, so the
    /// caller can tell whether the cap was reached.
    static func lineMatches(in text: String,
                            regex: NSRegularExpression,
                            budget: Int) -> (lines: [LineMatch], used: Int) {
        guard budget > 0 else { return ([], 0) }
        var lines: [LineMatch] = []
        var fileIndex = 0        // monotonic per file, in document order
        var used = 0
        var lineNo = 0
        for sub in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            lineNo += 1
            if used >= budget { break }
            let lineText = String(sub)
            let nsLine = lineText as NSString
            let hits = regex.matches(in: lineText, options: [],
                                     range: NSRange(location: 0, length: nsLine.length))
            if hits.isEmpty { continue }
            var matches: [Match] = []
            for hit in hits {
                if used >= budget { break }
                matches.append(Match(nsRange: hit.range, fileIndex: fileIndex))
                fileIndex += 1
                used += 1
            }
            if !matches.isEmpty {
                lines.append(LineMatch(line: lineNo, lineText: lineText, matches: matches))
            }
        }
        return (lines, used)
    }

    /// A file whose first 4 KB contains a NUL byte is treated as binary.
    static func isBinary(_ data: Data) -> Bool { data.prefix(4096).contains(0) }

    /// Read a candidate as UTF-8 text, or nil when it is too big, unreadable,
    /// binary, or not valid UTF-8. This is `scan`'s default reader; tests pass
    /// their own closure instead of touching disk.
    static func fileText(at url: URL) -> String? {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= maxFileBytes,
              let data = try? Data(contentsOf: url),
              !isBinary(data) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Match every candidate in order, handing each non-empty `FileMatch` to
    /// `emit` the moment it is complete — this is what lets results appear
    /// incrementally instead of all at the end.
    ///
    /// Cancellation is an INJECTED `() -> Bool`, not a direct
    /// `Task.isCancelled` read, so a test can drive it deterministically
    /// without spawning a Task; the real caller passes `{ Task.isCancelled }`.
    /// It is consulted before every file, which is the granularity that
    /// matters: reading and matching one file is the unit of work.
    static func scan(candidates: [Candidate],
                     regex: NSRegularExpression,
                     readText: (URL) -> String? = { SearchEngine.fileText(at: $0) },
                     isCancelled: () -> Bool,
                     emit: (FileMatch) -> Void) -> Outcome {
        var total = 0
        var fileCount = 0
        for candidate in candidates {
            if isCancelled() { return .cancelled }
            if total >= maxMatches { return .truncated(totalMatches: total, fileCount: fileCount) }
            guard let text = readText(candidate.url) else { continue }
            let (lines, used) = lineMatches(in: text, regex: regex, budget: maxMatches - total)
            total += used
            guard !lines.isEmpty else { continue }
            fileCount += 1
            emit(FileMatch(url: candidate.url,
                           displayPath: candidate.displayPath,
                           lineMatches: lines))
        }
        if isCancelled() { return .cancelled }
        if total >= maxMatches { return .truncated(totalMatches: total, fileCount: fileCount) }
        return .completed(totalMatches: total, fileCount: fileCount)
    }
}
```

- [ ] **Step 4: Rewire the shipping `walk` onto the new core (this is the CRLF bug fix)**

In `mac/Sources/LlmIdeMac/Services/SearchService.swift`, delete the three private constants at lines 13-15:

```swift
    nonisolated private static let maxFileBytes = 1_000_000
    nonisolated private static let maxMatches = 1000
    nonisolated private static let noiseNames = IgnoreList.directories
```

and replace them with just the one still used by `walk`:

```swift
    nonisolated private static let noiseNames = IgnoreList.directories
```

Then, inside `walk`, replace the two `total >= maxMatches` guards and the whole read-and-split block (`SearchService.swift:63` and `:76-100`) so the body reads:

```swift
            if total >= SearchEngine.maxMatches { break }
```

for the guard at line 63, and:

```swift
            guard let text = SearchEngine.fileText(at: url) else { continue }
            // CRLF-safe line splitting lives in SearchEngine: Swift treats
            // "\r\n" as ONE Character, so the old `split(separator: "\n")`
            // here reported every match in a CRLF file on line 1.
            let (lineMatches, used) = SearchEngine.lineMatches(
                in: text, regex: regex, budget: SearchEngine.maxMatches - total)
            total += used
            if !lineMatches.isEmpty {
                files.append(FileMatch(url: url, displayPath: display, lineMatches: lineMatches))
            }
```

for lines 76-100. Finally delete `SearchService`'s now-unused private `isBinary` (lines 109-111):

```swift
    nonisolated private static func isBinary(_ data: Data) -> Bool {
        data.prefix(4096).contains(0)
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter SearchEngineTests`
Expected in a full-Xcode environment: PASS (13 tests).
Expected here: `no such module 'XCTest'` — state that the test did not execute, then:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build && swift build --build-tests`
Expected: both succeed. In particular there must be no "unused" or "cannot find" diagnostics from the deleted `isBinary`/`maxFileBytes`/`maxMatches`.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SearchEngine.swift mac/Sources/LlmIdeMac/Services/SearchService.swift mac/Tests/LlmIdeMacTests/SearchEngineTests.swift
git commit -m "fix(mac): search line numbers were wrong in every CRLF file

Swift treats \"\\r\\n\" as one Character, so SearchService.walk's
split(separator: \"\\n\") returned a CRLF file as a single line and
reported every match on line 1. Line matching moves to the new pure
SearchEngine, which splits on \\.isNewline and carries the cancellable,
budget-aware scan the streaming search will use next."
```

---

### Task 3: `SearchService.stream` — an `AsyncStream` over a `.gitignore`-aware walk

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/SearchEngine.swift` (append `collectCandidates`)
- Modify: `mac/Sources/LlmIdeMac/Services/SearchService.swift:8` (`SearchResults`) and `:50` (add `stream` after `search`)
- Test: Create `mac/Tests/LlmIdeMacTests/SearchStreamTests.swift`

**Interfaces:**
- Consumes: `GitIgnoreRules.repoRoot(_:)`, `GitIgnoreRules.addFile(at:base:)`, `GitIgnoreRules.isIgnored(relativePath:isDirectory:)` (Task 1); `SearchEngine.Candidate`, `SearchEngine.Outcome`, `SearchEngine.scan(candidates:regex:readText:isCancelled:emit:)`, `SearchEngine.maxMatches` (Task 2); `IgnoreList.directories` (`Services/IgnoreList.swift:7`); `GlobMatch.matchesAny(path:patterns:)` (`Services/GlobMatch.swift`).
- Produces:
  - `static func SearchEngine.collectCandidates(root: URL, include: String, exclude: String, isCancelled: () -> Bool) -> [Candidate]`
  - `enum SearchEvent { case file(FileMatch); case truncated(cap: Int); case finished(totalMatches: Int, fileCount: Int) }`
  - `SearchService.stream(regex: NSRegularExpression, root: URL, include: String, exclude: String) -> AsyncStream<SearchEvent>` (`nonisolated static`)
  - `SearchResults` gains `var truncated = false`

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/SearchStreamTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// The streaming search end-to-end, against a REAL temp tree — the candidate
/// walk's whole job is deciding what the filesystem contains, so mocking the
/// filesystem would test nothing.
final class SearchStreamTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("search-stream-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private func write(_ relativePath: String, _ contents: String) {
        let url = root.appendingPathComponent(relativePath)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? contents.write(to: url, atomically: true, encoding: .utf8)
    }

    private func paths(include: String = "", exclude: String = "") -> [String] {
        SearchEngine.collectCandidates(root: root, include: include, exclude: exclude,
                                       isCancelled: { false }).map(\.displayPath)
    }

    // MARK: - collectCandidates

    func testCollectsPlainFilesSortedByDisplayPath() {
        write("z.txt", "z")
        write("a.txt", "a")
        write("m/b.txt", "b")
        XCTAssertEqual(paths(), ["a.txt", "m/b.txt", "z.txt"])
    }

    func testRootGitignoreExcludesMatchingFiles() {
        write(".gitignore", "*.log\n")
        write("keep.txt", "x")
        write("drop.log", "x")
        XCTAssertEqual(paths(), ["keep.txt"])
    }

    func testGitignoredDirectoryIsSkippedWhole() {
        write(".gitignore", "generated/\n")
        write("generated/a.txt", "x")
        write("generated/deep/b.txt", "x")
        write("keep.txt", "x")
        XCTAssertEqual(paths(), ["keep.txt"])
    }

    func testNestedGitignoreAppliesOnlyToItsSubtree() {
        write("sub/.gitignore", "*.tmp\n")
        write("sub/a.tmp", "x")
        write("sub/a.txt", "x")
        write("a.tmp", "x")
        XCTAssertEqual(paths(), ["a.tmp", "sub/a.txt"])
    }

    func testNoiseDirectoriesAreSkippedWithoutAGitignore() {
        write("node_modules/dep/index.js", "x")
        write("app.js", "x")
        XCTAssertEqual(paths(), ["app.js"])
    }

    func testIncludeGlobFilters() {
        write("a.swift", "x")
        write("b.txt", "x")
        XCTAssertEqual(paths(include: "*.swift"), ["a.swift"])
    }

    func testExcludeGlobFilters() {
        write("a.swift", "x")
        write("b.txt", "x")
        XCTAssertEqual(paths(exclude: "*.txt"), ["a.swift"])
    }

    func testCollectStopsEarlyWhenCancelled() {
        for i in 0..<40 { write("f\(i).txt", "x") }
        let collected = SearchEngine.collectCandidates(
            root: root, include: "", exclude: "", isCancelled: { true })
        XCTAssertTrue(collected.isEmpty)
    }

    // MARK: - stream

    func testStreamYieldsFilesThenFinished() async {
        write("a.txt", "needle\n")
        write("b.txt", "nothing\n")
        write("c.txt", "x\nneedle\nneedle\n")
        let regex = SearchService.makeRegex(query: "needle", options: SearchOptions())!

        var files: [String] = []
        var finished: (Int, Int)?
        for await event in SearchService.stream(regex: regex, root: root, include: "", exclude: "") {
            switch event {
            case .file(let fm):       files.append(fm.displayPath)
            case .truncated:          XCTFail("three matches must not hit the cap")
            case .finished(let t, let f): finished = (t, f)
            }
        }
        XCTAssertEqual(files, ["a.txt", "c.txt"])
        XCTAssertEqual(finished?.0, 3)
        XCTAssertEqual(finished?.1, 2)
    }

    func testStreamRespectsGitignore() async {
        write(".gitignore", "ignored/\n")
        write("ignored/a.txt", "needle\n")
        write("kept.txt", "needle\n")
        let regex = SearchService.makeRegex(query: "needle", options: SearchOptions())!

        var files: [String] = []
        for await event in SearchService.stream(regex: regex, root: root, include: "", exclude: "") {
            if case .file(let fm) = event { files.append(fm.displayPath) }
        }
        XCTAssertEqual(files, ["kept.txt"])
    }

    func testStreamEmitsTruncatedBeforeFinishedAtTheCap() async {
        for i in 0..<(SearchEngine.maxMatches + 5) { write("f\(i).txt", "needle\n") }
        let regex = SearchService.makeRegex(query: "needle", options: SearchOptions())!

        var order: [String] = []
        for await event in SearchService.stream(regex: regex, root: root, include: "", exclude: "") {
            switch event {
            case .file:      break
            case .truncated: order.append("truncated")
            case .finished:  order.append("finished")
            }
        }
        XCTAssertEqual(order, ["truncated", "finished"])
    }

    /// A consumer that walks away must terminate the stream promptly instead
    /// of leaving a full-repo walk running — design §3 finding #8.
    func testAbandonedConsumerTerminatesTheStream() async {
        for i in 0..<200 { write("f\(i).txt", "needle\n") }
        let regex = SearchService.makeRegex(query: "needle", options: SearchOptions())!

        var seen = 0
        for await _ in SearchService.stream(regex: regex, root: root, include: "", exclude: "") {
            seen += 1
            break
        }
        XCTAssertEqual(seen, 1)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter SearchStreamTests`
Expected in a full-Xcode environment: FAIL with "type 'SearchEngine' has no member 'collectCandidates'".
Expected here: `no such module 'XCTest'` — record it, then confirm with
`cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | head -30`
Expected: compile errors naming `collectCandidates` and `SearchService.stream`.

- [ ] **Step 3: Add the candidate walk to `SearchEngine`**

Append inside `enum SearchEngine` in `mac/Sources/LlmIdeMac/Services/SearchEngine.swift`:

```swift
    /// Walk `root` pre-order and return, sorted by `displayPath`, the files a
    /// search should read.
    ///
    /// Filters in order: `IgnoreList.directories` noise dirs (skipped whole),
    /// `.gitignore` (repo root + `.git/info/exclude`, plus every nested
    /// `.gitignore` added as its directory is ENTERED — pre-order guarantees a
    /// nested rule lands after the rules it may override), then the
    /// include/exclude globs on the repo-relative path.
    ///
    /// Collecting up front rather than lazily is deliberate: enumeration only
    /// touches directory metadata (no file is read here), so it costs
    /// milliseconds even on a large repo, and it lets the ignore state be a
    /// plain local `var` instead of `inout` state threaded through a lazy
    /// sequence. Sorting here also means `scan` emits in display order, so the
    /// UI can append instead of insert — and the truncation cutoff becomes
    /// deterministic across runs.
    static func collectCandidates(root: URL,
                                  include: String,
                                  exclude: String,
                                  isCancelled: () -> Bool) -> [Candidate] {
        let rootPath = root.standardizedFileURL.path
        var ignore = GitIgnoreRules.repoRoot(root)
        let fm = FileManager.default
        guard let en = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]) else { return [] }

        var out: [Candidate] = []
        let excludeActive = exclude.split(separator: ",").contains {
            !$0.trimmingCharacters(in: .whitespaces).isEmpty
        }
        for case let url as URL in en {
            if isCancelled() { return [] }
            if IgnoreList.directories.contains(url.lastPathComponent) {
                en.skipDescendants()
                continue
            }
            // Standardize the enumerated path before stripping the root: on
            // macOS the enumerator yields `/private/var/…` while `rootPath`
            // (also standardized) is `/var/…`, so a raw-path prefix check
            // fails and the globs would match against the absolute path.
            let filePath = url.standardizedFileURL.path
            guard filePath.hasPrefix(rootPath + "/") else { continue }
            let display = String(filePath.dropFirst(rootPath.count + 1))

            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if ignore.isIgnored(relativePath: display, isDirectory: isDir) {
                if isDir { en.skipDescendants() }
                continue
            }
            if isDir {
                // Pre-order: this directory's own .gitignore must be in the
                // rule list before any of its children are tested.
                ignore.addFile(at: url.appendingPathComponent(".gitignore"), base: display)
                continue
            }
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            guard GlobMatch.matchesAny(path: display, patterns: include) else { continue }
            if excludeActive && GlobMatch.matchesAny(path: display, patterns: exclude) { continue }
            out.append(Candidate(url: url, displayPath: display))
        }
        return out.sorted {
            $0.displayPath.localizedCaseInsensitiveCompare($1.displayPath) == .orderedAscending
        }
    }
```

- [ ] **Step 4: Add `SearchEvent`, `SearchResults.truncated`, and `SearchService.stream`**

In `mac/Sources/LlmIdeMac/Services/SearchService.swift`, change the `SearchResults` declaration on line 8 from:

```swift
struct SearchResults: Equatable { var files: [FileMatch] = []; var totalMatches = 0; var fileCount = 0; var invalidPattern = false }
```

to:

```swift
struct SearchResults: Equatable {
    var files: [FileMatch] = []
    var totalMatches = 0
    var fileCount = 0
    var invalidPattern = false
    /// The run stopped at `SearchEngine.maxMatches`; `files` is a prefix of
    /// the truth and the UI must say so.
    var truncated = false
}

/// One event from a streaming search.
///
/// Design §6.5 asks for "an `AsyncStream<FileMatch>` (or a callback-per-file
/// API)". This is that, plus the two out-of-band signals the P4 UI needs: a
/// truncation warning and the final totals are facts about the RUN, not about
/// any one file, so they cannot ride inside a `FileMatch`.
///
/// There is deliberately no `.invalidPattern` case: that condition can only
/// ever be known BEFORE the first event, so the caller checks it with
/// `SearchService.makeRegex` and never starts a stream at all.
enum SearchEvent {
    case file(FileMatch)
    /// The run stopped at the match cap. Always yielded before `.finished`.
    case truncated(cap: Int)
    /// The run finished normally. NEVER yielded for a cancelled run — the
    /// consumer is gone and a partial total would be a lie.
    case finished(totalMatches: Int, fileCount: Int)
}
```

Then add this method to `SearchService`, immediately after `search(query:root:options:include:exclude:)` (currently ending at line 50):

```swift
    /// Streaming, cancellable search. Returns immediately; the walk runs on a
    /// detached task and yields `.file` as each matching file completes, in
    /// `displayPath` order.
    ///
    /// CANCELLATION (design §3 finding #8, §8): stop iterating — or cancel the
    /// task that iterates — and `AsyncStream`'s termination handler cancels
    /// the walk. `SearchEngine.scan` checks `Task.isCancelled` before every
    /// file, so a superseded search stops within one file instead of running
    /// the whole repo to completion in the background, which is exactly what
    /// the old `Task.detached`-with-no-checks `search(...)` did.
    ///
    /// The caller MUST validate the pattern first with `makeRegex` — passing a
    /// compiled regex in is what keeps an impossible error case out of
    /// `SearchEvent`.
    nonisolated static func stream(regex: NSRegularExpression,
                                   root: URL,
                                   include: String,
                                   exclude: String) -> AsyncStream<SearchEvent> {
        AsyncStream { continuation in
            let task = Task.detached(priority: .userInitiated) {
                let candidates = SearchEngine.collectCandidates(
                    root: root, include: include, exclude: exclude,
                    isCancelled: { Task.isCancelled })
                if Task.isCancelled { continuation.finish(); return }

                let outcome = SearchEngine.scan(
                    candidates: candidates,
                    regex: regex,
                    isCancelled: { Task.isCancelled },
                    emit: { continuation.yield(.file($0)) })

                switch outcome {
                case .completed(let total, let files):
                    continuation.yield(.finished(totalMatches: total, fileCount: files))
                case .truncated(let total, let files):
                    continuation.yield(.truncated(cap: SearchEngine.maxMatches))
                    continuation.yield(.finished(totalMatches: total, fileCount: files))
                case .cancelled:
                    break   // no `.finished`: the consumer is gone
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter SearchStreamTests`
Expected in a full-Xcode environment: PASS (12 tests).
Expected here: `no such module 'XCTest'` — state that the test did not execute, then:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build && swift build --build-tests`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SearchEngine.swift mac/Sources/LlmIdeMac/Services/SearchService.swift mac/Tests/LlmIdeMacTests/SearchStreamTests.swift
git commit -m "feat(mac): add cancellable streaming search with .gitignore support"
```

---

### Task 4: Root unification — `WorkspaceRoot.browsingRoot`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/WorkspaceRoot.swift` (append after `resolveOrHome`, line 40)
- Modify: `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift:36-38` (`root`)
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift:57-60` (`root`) and `:226-230` (`effectiveDisplayRoot`)
- Test: Create `mac/Tests/LlmIdeMacTests/WorkspaceRootBrowsingTests.swift`

**Interfaces:**
- Consumes: `WorkspaceRoot.resolve(config:projectStore:) -> URL?` (`WorkspaceRoot.swift:16`); `ProjectStore.activeProjectCodeDir: URL?` (`ProjectStore.swift:32`); `FileSystemTree.Node { let url: URL; let name: String; let isDirectory: Bool }` and `FileSystemTree.children(of: URL) -> [Node]` (`Services/FileSystemTree.swift`).
- Produces:
  - `@MainActor static func WorkspaceRoot.browsingRoot(config: AppConfig, projectStore: ProjectStore) -> URL?`
  - `static func WorkspaceRoot.pickBrowsingRoot(codeDir: URL?, fallback: URL?, exists: (URL) -> Bool, children: (URL) -> [FileSystemTree.Node]) -> URL?`

**P3 coordination:** this task deletes `ExplorerView`'s two inline copies of this logic. If P3 has already landed and introduced its own equivalent, keep `WorkspaceRoot.pickBrowsingRoot` and delete P3's — one definition, not two. Expect a merge conflict in `ExplorerView.swift`.

**Accepted consequence, stated deliberately:** with a project open, Search now roots at the Explorer's *display* root (`<project>/code`, collapsed to its single child when there is exactly one). Search therefore no longer covers `<project>/source`, `<project>/notes` or `<project>/data`. That is what "root unification with Explorer" means — the two panels showing different trees was the finding (§3 #10).

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/WorkspaceRootBrowsingTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// `pickBrowsingRoot` is the ONE definition of "the folder the code-browsing
/// panels show", shared by Explorer and Search. Its `exists` parameter is
/// load-bearing: a brand-new project has a `code/` path that does not exist
/// yet, and without the check Search would silently root at a missing folder
/// and report zero results forever.
final class WorkspaceRootBrowsingTests: XCTestCase {

    private func dir(_ path: String) -> URL { URL(fileURLWithPath: path) }

    private func node(_ path: String, isDirectory: Bool) -> FileSystemTree.Node {
        FileSystemTree.Node(url: dir(path),
                            name: dir(path).lastPathComponent,
                            isDirectory: isDirectory)
    }

    func testPrefersTheProjectCodeDirWhenItExists() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: dir("/repo"),
            exists: { _ in true },
            children: { _ in [self.node("/p/code/a.txt", isDirectory: false),
                              self.node("/p/code/b.txt", isDirectory: false)] })
        XCTAssertEqual(root, dir("/p/code"))
    }

    func testFallsBackWhenTheCodeDirDoesNotExistYet() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: dir("/repo"),
            exists: { $0.path == "/repo" },
            children: { _ in [] })
        XCTAssertEqual(root, dir("/repo"))
    }

    func testFallsBackWhenThereIsNoProject() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: nil,
            fallback: dir("/repo"),
            exists: { _ in true },
            children: { _ in [] })
        XCTAssertEqual(root, dir("/repo"))
    }

    func testNilWhenNeitherIsUsable() {
        XCTAssertNil(WorkspaceRoot.pickBrowsingRoot(
            codeDir: nil, fallback: nil, exists: { _ in true }, children: { _ in [] }))
        XCTAssertNil(WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"), fallback: nil,
            exists: { _ in false }, children: { _ in [] }))
    }

    func testCollapsesIntoASingleChildDirectory() {
        // The Explorer's display behaviour: `code/` holding exactly one clone
        // shows that clone as the tree root, not a one-item wrapper.
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: nil,
            exists: { _ in true },
            children: { _ in [self.node("/p/code/my-repo", isDirectory: true)] })
        XCTAssertEqual(root, dir("/p/code/my-repo"))
    }

    func testDoesNotCollapseIntoASingleFile() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: nil,
            exists: { _ in true },
            children: { _ in [self.node("/p/code/README.md", isDirectory: false)] })
        XCTAssertEqual(root, dir("/p/code"))
    }

    func testDoesNotCollapseWithTwoChildren() {
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: nil,
            exists: { _ in true },
            children: { _ in [self.node("/p/code/one", isDirectory: true),
                              self.node("/p/code/two", isDirectory: true)] })
        XCTAssertEqual(root, dir("/p/code"))
    }

    func testCollapsesOnlyOneLevel() {
        // Deliberate: matches ExplorerView.effectiveDisplayRoot, which calls
        // children(of:) exactly once. Deeper collapsing would cost an extra
        // filesystem read per render for no user-visible gain.
        var calls = 0
        let root = WorkspaceRoot.pickBrowsingRoot(
            codeDir: dir("/p/code"),
            fallback: nil,
            exists: { _ in true },
            children: { _ in
                calls += 1
                return [self.node("/p/code/only", isDirectory: true)]
            })
        XCTAssertEqual(root, dir("/p/code/only"))
        XCTAssertEqual(calls, 1)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter WorkspaceRootBrowsingTests`
Expected in a full-Xcode environment: FAIL with "type 'WorkspaceRoot' has no member 'pickBrowsingRoot'".
Expected here: `no such module 'XCTest'` — record it, then confirm with
`cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build --build-tests 2>&1 | head -20`

- [ ] **Step 3: Implement `browsingRoot` / `pickBrowsingRoot`**

In `mac/Sources/LlmIdeMac/Services/WorkspaceRoot.swift`, insert after `resolveOrHome` (line 40) and before the `// MARK: - Two-root context` comment:

```swift
    // MARK: - Browsing root (Explorer + Search)

    /// The folder the CODE-BROWSING panels display — Explorer's tree and, as
    /// of P4, Search's walk. This is deliberately narrower than `resolve`:
    /// browsing means code, so it roots at the active project's `code/`
    /// folder (where repos clone to) rather than the whole project, whose
    /// `source/`, `notes/` and `data/` are Library territory.
    ///
    /// The consequence is intentional and worth stating: with a project open,
    /// Search covers `code/` only. Explorer and Search showing different trees
    /// was the bug (design §3 finding #10); this is the single definition that
    /// fixes it.
    @MainActor
    static func browsingRoot(config: AppConfig, projectStore: ProjectStore) -> URL? {
        pickBrowsingRoot(codeDir: projectStore.activeProjectCodeDir,
                         fallback: resolve(config: config, projectStore: projectStore),
                         exists: { FileManager.default.fileExists(atPath: $0.path) },
                         children: { FileSystemTree.children(of: $0) })
    }

    /// Pure decision core, separated for unit tests exactly like `pick` above.
    ///
    /// `exists` is load-bearing, not defensive noise: a brand-new project has
    /// a `code/` path that has not been created yet, and without the check
    /// both panels would silently root at a folder that isn't there.
    ///
    /// The single-child collapse reproduces `ExplorerView`'s display rule —
    /// a `code/` holding exactly one clone shows that clone as the root rather
    /// than a one-item wrapper. One level only, one `children` call, matching
    /// the previous inline implementation's cost.
    static func pickBrowsingRoot(codeDir: URL?,
                                 fallback: URL?,
                                 exists: (URL) -> Bool,
                                 children: (URL) -> [FileSystemTree.Node]) -> URL? {
        var base: URL?
        if let codeDir, exists(codeDir) { base = codeDir } else { base = fallback }
        guard let base else { return nil }
        let kids = children(base)
        if kids.count == 1, kids[0].isDirectory { return kids[0].url }
        return base
    }
```

- [ ] **Step 4: Point `SearchView` at the shared root**

In `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift`, replace lines 36-38:

```swift
    private var root: URL? {
        WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }
```

with:

```swift
    /// The SAME folder the Explorer tree shows — `WorkspaceRoot.browsingRoot`
    /// is the one definition (design §3 finding #10: Search and Explorer used
    /// different root resolution). With a project open this is `code/`
    /// (collapsed to its single child when there is exactly one), so Search
    /// deliberately does not cover `source/`, `notes/` or `data/`.
    private var root: URL? {
        WorkspaceRoot.browsingRoot(config: config, projectStore: projectStore)
    }
```

- [ ] **Step 5: Delete `ExplorerView`'s two inline copies**

In `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift`, replace the `root` computed property at lines 53-60 (the doc comment plus the body):

```swift
    /// The Explorer is the code-browsing pane, so it roots at the active
    /// project's `code/` folder (where repos clone to) — not the whole project
    /// (source/data/notes are managed in the Library). Falls back to the
    /// resolved workspace root when no project is open (repo-only/legacy use).
    private var root: URL? {
        if let code = projectStore.activeProjectCodeDir { return code }
        return WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }
```

with:

```swift
    /// The Explorer is the code-browsing pane, so it roots at the active
    /// project's `code/` folder (where repos clone to) — not the whole project
    /// (source/data/notes are managed in the Library). Falls back to the
    /// resolved workspace root when no project is open (repo-only/legacy use).
    ///
    /// `WorkspaceRoot.browsingRoot` also applies the single-child collapse
    /// that `effectiveDisplayRoot` used to do inline, so Search sees the
    /// identical folder rather than a near-copy of this rule.
    private var root: URL? {
        WorkspaceRoot.browsingRoot(config: config, projectStore: projectStore)
    }
```

and replace `effectiveDisplayRoot` at lines 224-230:

```swift
    /// See `treePane` doc comment. Pure function of already-loaded children
    /// so it doesn't trigger extra filesystem work beyond the normal
    /// top-level `children(of:)` call the tree already makes.
    private func effectiveDisplayRoot(_ root: URL) -> URL {
        let kids = children(of: root)
        if kids.count == 1, kids[0].isDirectory { return kids[0].url }
        return root
    }
```

with:

```swift
    /// The collapse now happens inside `WorkspaceRoot.browsingRoot`, so `root`
    /// is ALREADY the display root. Kept as an identity function so the many
    /// `displayRoot:` call sites below don't all have to change in this
    /// commit, and so a future caller can't accidentally re-collapse.
    private func effectiveDisplayRoot(_ root: URL) -> URL { root }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter WorkspaceRootBrowsingTests`
Expected in a full-Xcode environment: PASS (8 tests).
Expected here: `no such module 'XCTest'` — state that the test did not execute, then:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build && swift build --build-tests`
Expected: both succeed. `children(of:)` in `ExplorerView` is still used by the tree itself, so there must be no unused-function warning.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/WorkspaceRoot.swift mac/Sources/LlmIdeMac/Views/Search/SearchView.swift mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift mac/Tests/LlmIdeMacTests/WorkspaceRootBrowsingTests.swift
git commit -m "fix(mac): Explorer と Search が同じ browsing root を使うよう統一"
```

---

### Task 5: `SearchView` consumes the stream

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift:372-398` (`scheduleSearch`)
- Modify: `mac/Sources/LlmIdeMac/Services/SearchService.swift` — delete the now-dead `search(query:root:options:include:exclude:)` (lines 35-50) and `walk(...)` (lines 52-107) and the `noiseNames` constant
- Test: none new. This is view glue with no live-view harness (design §9); the behaviour it drives is already covered by `SearchStreamTests`, and the interactive result is item 2 of the Manual Verification Checklist.

**Interfaces:**
- Consumes: `SearchService.makeRegex(query:options:) -> NSRegularExpression?`; `SearchService.stream(regex:root:include:exclude:) -> AsyncStream<SearchEvent>` (Task 3); `SearchEvent`; `SearchResults` incl. `truncated` (Task 3); `WorkspaceRoot.browsingRoot` via `root` (Task 4).
- Produces: no new API. `SearchView.results` is now filled incrementally, and `SearchService`'s batch API is gone — after this task `stream` is the only search entry point.

- [ ] **Step 1: Replace `scheduleSearch`'s body**

In `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift`, replace the tail of `scheduleSearch` — everything from `guard let root else { … }` (line 384) to the closing brace of the `debounce = Task { … }` block (line 397) — with:

```swift
        guard let root else { results = SearchResults(); return }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let opts = options
        let inc = include
        let exc = exclude
        guard !q.isEmpty else { results = SearchResults(); return }
        debounce = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            // The pattern is validated HERE, not inside the stream: an invalid
            // regex can only ever be known before the first event, so it stays
            // out of SearchEvent (see SearchService.stream's doc comment).
            guard let regex = SearchService.makeRegex(query: q, options: opts) else {
                results = SearchResults(invalidPattern: true)
                return
            }
            searching = true
            defer { searching = false }
            // Results are cleared only once the new run is actually starting,
            // so a debounced keystroke doesn't blank the list mid-typing.
            var accumulated = SearchResults()
            results = accumulated
            for await event in SearchService.stream(regex: regex, root: root,
                                                    include: inc, exclude: exc) {
                // Returning here tears down the AsyncStream's iterator, which
                // fires its onTermination and cancels the walk task — this is
                // the whole cancellation mechanism, not a belt-and-braces check.
                if Task.isCancelled { return }
                switch event {
                case .file(let fm):
                    // Events arrive pre-sorted by displayPath
                    // (SearchEngine.collectCandidates sorts), so appending
                    // keeps the list in order without an insertion search.
                    accumulated.files.append(fm)
                    accumulated.fileCount = accumulated.files.count
                    accumulated.totalMatches += fm.lineMatches.reduce(0) { $0 + $1.matches.count }
                case .truncated(let cap):
                    accumulated.truncated = true
                    _ = cap   // rendered by SearchHeaderText in Task 6
                case .finished(let total, let files):
                    accumulated.totalMatches = total
                    accumulated.fileCount = files
                }
                results = accumulated
            }
        }
```

Note the removed lines: the old `let q = query` / `let opts` / `let inc` / `let exc` block that sat *before* `debounce = Task {` is folded into the version above (with trimming added, since the empty-query guard used to live inside `SearchService.search`).

- [ ] **Step 2: Delete the dead batch API**

In `mac/Sources/LlmIdeMac/Services/SearchService.swift`, delete `search(query:root:options:include:exclude:)` in full (its doc comment at lines 35-39 plus the body at 40-50) and `walk(root:rootPath:regex:include:exclude:)` in full (lines 52 through its closing brace). Then delete the constant that only `walk` used:

```swift
    nonisolated private static let noiseNames = IgnoreList.directories
```

`SearchView` was the only consumer of `search(...)` (verified: the sole other mention of `SearchService` in the repo is a comment in `Services/IgnoreList.swift:5`), so nothing else breaks.

- [ ] **Step 3: Verify the build**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build && swift build --build-tests`
Expected: both succeed, with no "unused" or "cannot find" diagnostics referencing `search`, `walk`, `noiseNames`, or `GlobMatch` inside `SearchService.swift` (`GlobMatch` now lives only in `SearchEngine`).

- [ ] **Step 4: Run the existing suites to check nothing regressed**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter SearchStreamTests`
Expected in a full-Xcode environment: PASS.
Expected here: `no such module 'XCTest'` — the tests did not execute. Say so explicitly.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Search/SearchView.swift mac/Sources/LlmIdeMac/Services/SearchService.swift
git commit -m "feat(mac): Search パネルをストリーミング検索に切り替え、旧バッチ API を削除"
```

---

### Task 6: Truncation warning at the match cap

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/SearchHeaderText.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift:199-215` (`resultsHeader`, `headerText`) and the `.truncated` case added in Task 5
- Test: Create `mac/Tests/LlmIdeMacTests/SearchHeaderTextTests.swift`

**Interfaces:**
- Consumes: `SearchResults` incl. `truncated` (Task 3); `SearchEngine.maxMatches` (Task 2); `Theme.warning` (`Theme.swift:94`), `Theme.danger`, `Theme.textMuted`.
- Produces:
  - `static func SearchHeaderText.label(invalidPattern: Bool, searching: Bool, query: String, totalMatches: Int, fileCount: Int) -> String`
  - `static func SearchHeaderText.truncationWarning(truncated: Bool, cap: Int) -> String?`

**Why a Services file for view copy:** `Views/Search/` is excluded from the build in lite profiles (`Package.swift:56`), so a test targeting anything declared there would have to be excluded too. `ExplorerFileOps` (`Services/ExplorerFileOps.swift`, tested by `ExplorerFileOpsTests`) already establishes the pattern: the excluded view keeps only rendering; the testable decision lives in `Services/`.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/SearchHeaderTextTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// The results header is the only place the user learns that a search was
/// CUT SHORT. Getting this wrong means silently presenting the first 1000
/// matches as if they were all of them.
final class SearchHeaderTextTests: XCTestCase {

    func testInvalidPatternWins() {
        XCTAssertEqual(
            SearchHeaderText.label(invalidPattern: true, searching: false,
                                   query: "((", totalMatches: 0, fileCount: 0),
            "Invalid pattern")
    }

    func testEmptyQueryShowsNothing() {
        XCTAssertEqual(
            SearchHeaderText.label(invalidPattern: false, searching: false,
                                   query: "", totalMatches: 0, fileCount: 0),
            "")
    }

    func testNoResultsOnlyAfterTheSearchFinished() {
        XCTAssertEqual(
            SearchHeaderText.label(invalidPattern: false, searching: true,
                                   query: "zz", totalMatches: 0, fileCount: 0),
            "", "while searching, an empty list is not yet 'no results'")
        XCTAssertEqual(
            SearchHeaderText.label(invalidPattern: false, searching: false,
                                   query: "zz", totalMatches: 0, fileCount: 0),
            "No results")
    }

    func testCounts() {
        XCTAssertEqual(
            SearchHeaderText.label(invalidPattern: false, searching: false,
                                   query: "foo", totalMatches: 12, fileCount: 3),
            "12 results in 3 files")
    }

    func testTruncationWarningOnlyWhenTruncated() {
        XCTAssertNil(SearchHeaderText.truncationWarning(truncated: false, cap: 1000))
        XCTAssertEqual(
            SearchHeaderText.truncationWarning(truncated: true, cap: 1000),
            "Showing the first 1000 matches — narrow the query or use “files to include”.")
    }

    func testTruncationWarningUsesTheRealCap() {
        XCTAssertEqual(
            SearchHeaderText.truncationWarning(truncated: true, cap: SearchEngine.maxMatches),
            "Showing the first \(SearchEngine.maxMatches) matches — narrow the query or use “files to include”.")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter SearchHeaderTextTests`
Expected in a full-Xcode environment: FAIL with "cannot find 'SearchHeaderText' in scope".
Expected here: `no such module 'XCTest'` — record it, then confirm with `swift build --build-tests`.

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Services/SearchHeaderText.swift`:

```swift
import Foundation

/// Copy for the Search results header, as pure functions.
///
/// It lives in `Services/` rather than beside `SearchView` because
/// `Views/Search/` is excluded from lite builds (`Package.swift`), and a test
/// targeting an excluded type would have to be excluded too — the same reason
/// `ExplorerFileOps` sits here rather than in `Views/Explorer/`.
enum SearchHeaderText {

    /// The main header line.
    ///
    /// `searching` matters: while a streaming run is still producing results,
    /// an empty list is not yet "No results" — saying so would flash a wrong
    /// answer on every keystroke.
    static func label(invalidPattern: Bool,
                      searching: Bool,
                      query: String,
                      totalMatches: Int,
                      fileCount: Int) -> String {
        if invalidPattern { return "Invalid pattern" }
        if query.isEmpty { return "" }
        if fileCount == 0 { return searching ? "" : "No results" }
        return "\(totalMatches) results in \(fileCount) files"
    }

    /// Non-nil only when the run stopped at the match cap. Without this the
    /// UI presents a truncated list as if it were the complete answer.
    static func truncationWarning(truncated: Bool, cap: Int) -> String? {
        guard truncated else { return nil }
        return "Showing the first \(cap) matches — narrow the query or use “files to include”."
    }
}
```

- [ ] **Step 4: Render it in `SearchView`**

In `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift`, replace `resultsHeader` and `headerText` (lines 199-215) with:

```swift
    @ViewBuilder private var resultsHeader: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if searching { ProgressView().controlSize(.small) }
                Text(headerText)
                    .font(Typography.caption)
                    .foregroundStyle(results.invalidPattern ? theme.current.danger : theme.current.textMuted)
                Spacer()
            }
            if let warning = SearchHeaderText.truncationWarning(
                truncated: results.truncated, cap: SearchEngine.maxMatches) {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 9))
                    Text(warning)
                        .font(Typography.caption)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(theme.current.warning)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
    }

    private var headerText: String {
        SearchHeaderText.label(invalidPattern: results.invalidPattern,
                               searching: searching,
                               query: query,
                               totalMatches: results.totalMatches,
                               fileCount: results.files.count)
    }
```

Then, in the `scheduleSearch` stream loop written in Task 5, replace the placeholder discard in the `.truncated` case:

```swift
                case .truncated(let cap):
                    accumulated.truncated = true
                    _ = cap   // rendered by SearchHeaderText in Task 6
```

with:

```swift
                case .truncated:
                    // The cap itself is read straight from SearchEngine when
                    // the warning renders, so it can't drift from the value
                    // the walk actually enforced.
                    accumulated.truncated = true
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter SearchHeaderTextTests`
Expected in a full-Xcode environment: PASS (6 tests).
Expected here: `no such module 'XCTest'` — state that the test did not execute, then:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build && swift build --build-tests`
Expected: both succeed. `theme.current.warning` is a `Theme` semantic alias (`Theme.swift:94`), so no raw color is introduced.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SearchHeaderText.swift mac/Sources/LlmIdeMac/Views/Search/SearchView.swift mac/Tests/LlmIdeMacTests/SearchHeaderTextTests.swift
git commit -m "feat(mac): warn in the Search header when results hit the match cap"
```

---

### Task 7: Line-jump on result click

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shared/MonacoRevealGate.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift` — lines 11-18 (`FileDetailView`'s property), 20-35 (its `body` switch), 96-107 (`MarkdownDetailView`), 194-221 (`CodeDetailView`), 276-312 (`EditableTextDetailView`'s properties + init), 328-349 (`body`'s `.task`), 446-466 (`load`), 504-517 (the `Accessory == EmptyView` convenience init)
- Modify: `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift:28-30` (editor-pane state), `:260` (`lineRow`'s tap), `:270-276` (`editorPane`), `:336-339` (`open`)
- Test: Create `mac/Tests/LlmIdeMacTests/MonacoRevealGateTests.swift`

**Interfaces:**
- Consumes: `struct MonacoRevealRequest: Equatable { let line: Int; let id = UUID() }` (`Views/Shared/MonacoHost.swift:18-21`, built in P1); `MonacoEditorView(content:language:decorations:revealRequest:readOnly:onRequestSave:)` (`Views/Shared/MonacoEditorView.swift:56-66`); `MonacoLanguageMap.id(for:)`.
- Produces:
  - `static func MonacoRevealGate.shouldApply(target: MonacoRevealRequest?, contentIsEmpty: Bool) -> Bool`
  - `FileDetailView(url:onClose:revealTarget:)` — `initialLine: Int?` is REPLACED by `revealTarget: MonacoRevealRequest?`
  - `MarkdownDetailView(url:revealTarget:)`, `CodeDetailView(url:revealTarget:)`
  - `EditableTextDetailView(url:onSaved:startInPreview:language:decorations:revealTarget:accessory:preview:)` where `preview` becomes `(String, MonacoRevealRequest?) -> Preview`

**The two real problems this task fixes** (both verified against the current source):

1. **P1's `initialLine` is applied only inside `load()`**, which runs from `.task(id: url)` (`FileDetailView.swift:349, 458-460`). Clicking a *second* result in the SAME file changes `initialLine` but not `url`, so `load()` never re-runs and the editor never scrolls. `MonacoRevealRequest` carries a fresh `UUID` per construction precisely so a repeat request is distinguishable — so it becomes the parameter type, plus an `.onChange`.
2. **`CodeDetailView` passes `startInPreview: true`** (`FileDetailView.swift:208`), so code files open in the READ-ONLY Monaco preview — and that preview's `MonacoEditorView` is constructed with **no** `revealRequest` (`:213-218`). A result click would land in the preview and not scroll at all. The preview closure therefore becomes `(String, MonacoRevealRequest?) -> Preview`.

Reveal must be applied AFTER content loads: on first mount `content` is `""`, and `MonacoHost.Coordinator.applyPendingChanges` records `lastRevealRequestId` whether or not the reveal did anything (`MonacoHost.swift:166-169`) — so a reveal fired at an empty buffer is a silent no-op that never re-fires. That rule is what `MonacoRevealGate` encodes.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/MonacoRevealGateTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// The one rule that makes search line-jump work at all: never hand Monaco a
/// reveal for a buffer that has no content yet.
///
/// `MonacoHost.Coordinator.applyPendingChanges` records a reveal request's
/// `id` as soon as it fires it, whether or not the editor had anything to
/// scroll. So a reveal issued against an empty buffer is not merely a no-op —
/// it BURNS the request, and the same request can never fire again.
final class MonacoRevealGateTests: XCTestCase {

    func testNilTargetIsNeverApplied() {
        XCTAssertFalse(MonacoRevealGate.shouldApply(target: nil, contentIsEmpty: false))
        XCTAssertFalse(MonacoRevealGate.shouldApply(target: nil, contentIsEmpty: true))
    }

    func testTargetIsHeldBackWhileTheBufferIsEmpty() {
        XCTAssertFalse(MonacoRevealGate.shouldApply(
            target: MonacoRevealRequest(line: 42), contentIsEmpty: true))
    }

    func testTargetIsAppliedOnceContentIsLoaded() {
        XCTAssertTrue(MonacoRevealGate.shouldApply(
            target: MonacoRevealRequest(line: 42), contentIsEmpty: false))
    }

    func testTwoRequestsForTheSameLineAreDistinctValues() {
        // This is why the parameter type is MonacoRevealRequest and not Int:
        // clicking the SAME result twice must still look like a change to
        // SwiftUI's .onChange and to the Coordinator's id diff.
        let first = MonacoRevealRequest(line: 7)
        let second = MonacoRevealRequest(line: 7)
        XCTAssertNotEqual(first, second)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter MonacoRevealGateTests`
Expected in a full-Xcode environment: FAIL with "cannot find 'MonacoRevealGate' in scope".
Expected here: `no such module 'XCTest'` — record it, then confirm with `swift build --build-tests`.

- [ ] **Step 3: Write `MonacoRevealGate`**

Create `mac/Sources/LlmIdeMac/Views/Shared/MonacoRevealGate.swift`:

```swift
import Foundation

/// Whether a reveal request may be handed to Monaco right now.
///
/// One rule, learned from a real failure: a reveal fired against an EMPTY
/// buffer scrolls nothing, and `MonacoHost.Coordinator.applyPendingChanges`
/// records the request's `id` anyway — so the request is spent and can never
/// fire again. Callers must therefore hold a target back until content has
/// loaded, then apply it.
///
/// Pure and separated for tests, mirroring `WorkspaceRoot.pickGitRoot` and
/// `MonacoEditorMessageHandler.effect(for:)`.
enum MonacoRevealGate {
    static func shouldApply(target: MonacoRevealRequest?, contentIsEmpty: Bool) -> Bool {
        guard target != nil else { return false }
        return !contentIsEmpty
    }
}
```

- [ ] **Step 4: Thread `revealTarget` through `FileDetailView`**

In `mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift`:

(a) Replace `FileDetailView`'s property (lines 14-18) and the two forwarding cases in `body` (lines 23, 26):

```swift
    /// 1-based line to reveal once the editor has loaded (e.g. a search
    /// result's line-jump, P4). `nil` for the common "just open the file"
    /// case. Ignored by kinds that have no text editor (`.pdf`/`.image`/
    /// `.quicklook`).
    var initialLine: Int? = nil
```

becomes

```swift
    /// Where to scroll once the editor has content — a search result's
    /// line-jump. `MonacoRevealRequest` rather than a bare `Int` because it
    /// carries a fresh `UUID`: clicking the SAME result twice must still
    /// scroll, and an unchanged `Int` would look like no request at all.
    /// `nil` for the common "just open the file" case. Ignored by kinds with
    /// no text editor (`.pdf`/`.image`/`.quicklook`).
    var revealTarget: MonacoRevealRequest? = nil
```

and inside `body`'s switch:

```swift
            case .markdown:  MarkdownDetailView(url: url, revealTarget: revealTarget)
            case .pdf:       PDFDetailView(url: url)
            case .image:     ImageDetailView(url: url)
            case .code:      CodeDetailView(url: url, revealTarget: revealTarget)
            case .quicklook: QuickLookDetailView(url: url)
```

(b) Replace `MarkdownDetailView` (lines 96-107) with:

```swift
struct MarkdownDetailView: View {
    let url: URL
    var revealTarget: MonacoRevealRequest? = nil
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        // The rendered-markdown preview has no line model to scroll to, so it
        // ignores the reveal; Edit mode's MonacoEditorView still honours it.
        EditableTextDetailView(url: url, startInPreview: true, language: "markdown",
                               revealTarget: revealTarget) { content, _ in
            MarkdownWebView(markdown: content, isDark: theme.current.isDark)
        }
    }
}
```

(c) Replace `CodeDetailView`'s property and `body` (lines 196, 204-221) with:

```swift
    var revealTarget: MonacoRevealRequest? = nil
```

and

```swift
    var body: some View {
        EditableTextDetailView(
            url: url,
            onSaved: { await refreshGutter() },
            startInPreview: true,   // open code highlighted (read-only); Edit is one toggle away
            language: MonacoLanguageMap.id(for: url.pathExtension),
            decorations: changedLines,
            revealTarget: revealTarget
        ) { content, reveal in
            // The reveal MUST reach the preview too: code files open in
            // preview (startInPreview: true above), so a search-result click
            // lands here first. Before P4 this MonacoEditorView took no
            // revealRequest at all and the click simply never scrolled.
            MonacoEditorView(
                content: .constant(content),
                language: MonacoLanguageMap.id(for: url.pathExtension),
                decorations: changedLines,
                revealRequest: reveal,
                readOnly: true
            )
        }
        .task(id: url) { await refreshGutter() }
    }
```

(d) In `EditableTextDetailView`, replace the `initialLine` property + `preview` closure type (lines 286-292) with:

```swift
    /// Where to scroll once content has loaded — P4's search-result
    /// line-jump. Held back until `content` is non-empty (see
    /// `MonacoRevealGate`), then handed to BOTH the editor and the preview.
    var revealTarget: MonacoRevealRequest? = nil
    /// Optional toolbar accessory rendered just left of Revert/Save.
    let accessory: () -> Accessory
    /// The read-only renderer. Takes the reveal request as well as the text
    /// because code files open in preview, so the preview is where a
    /// search-result click lands first.
    let preview: (String, MonacoRevealRequest?) -> Preview
```

and the designated init (lines 294-312):

```swift
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         revealTarget: MonacoRevealRequest? = nil,
         @ViewBuilder accessory: @escaping () -> Accessory,
         @ViewBuilder preview: @escaping (String, MonacoRevealRequest?) -> Preview) {
        self.url = url
        self.onSaved = onSaved
        self.language = language
        self.decorations = decorations
        self.revealTarget = revealTarget
        self.accessory = accessory
        self.preview = preview
        // Code/markdown open in the rendered/highlighted Preview by default
        // (the VS Code "view" experience); Edit is one toggle away.
        _isPreview = State(initialValue: startInPreview)
    }
```

(e) In `body`, pass the reveal to the preview and add the `.onChange` that fixes the same-file repeat click. Replace line 337 (`preview(content)`) with `preview(content, revealRequest)`, and replace line 349 (`.task(id: url) { await load() }`) with:

```swift
        .task(id: url) { await load() }
        .onChange(of: revealTarget) { _, new in
            // THE same-file fix. `.task(id: url)` does not re-run when only
            // the line changes — clicking a second result in a file that is
            // already open changes `revealTarget` and nothing else — so
            // `load()` would never see it and the editor would never scroll.
            guard MonacoRevealGate.shouldApply(target: new, contentIsEmpty: content.isEmpty) else { return }
            revealRequest = new
        }
```

(f) In `load()`, replace lines 458-460:

```swift
            if let initialLine {
                revealRequest = MonacoRevealRequest(line: initialLine)
            }
```

with:

```swift
            // Applied here, after `content` is set, because a reveal against
            // an empty buffer scrolls nothing AND burns the request (see
            // MonacoRevealGate). This covers opening a NEW file at a line;
            // the `.onChange` above covers a second click in the same file.
            if MonacoRevealGate.shouldApply(target: revealTarget, contentIsEmpty: raw.isEmpty) {
                revealRequest = revealTarget
            }
```

(g) Update the convenience init (lines 504-517):

```swift
extension EditableTextDetailView where Accessory == EmptyView {
    /// Convenience init for callers that don't need a toolbar accessory.
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         revealTarget: MonacoRevealRequest? = nil,
         @ViewBuilder preview: @escaping (String, MonacoRevealRequest?) -> Preview) {
        self.init(url: url, onSaved: onSaved, startInPreview: startInPreview,
                  language: language, decorations: decorations, revealTarget: revealTarget,
                  accessory: { EmptyView() }, preview: preview)
    }
}
```

- [ ] **Step 5: Make `SearchView` send the reveal**

In `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift`:

(a) Replace the editor-pane state block (lines 28-30):

```swift
    // Editor pane
    @State private var tabs: [URL] = []
    @State private var activeTab: URL?
```

with:

```swift
    // Editor pane
    @State private var tabs: [URL] = []
    @State private var activeTab: URL?
    /// The pending line-jump and the file it belongs to. The URL is tracked
    /// alongside the request because the user can also change tabs from
    /// `EditorTabBar` — without it, switching to an unrelated tab would apply
    /// the last search result's line number to a completely different file.
    @State private var revealTarget: MonacoRevealRequest?
    @State private var revealTargetURL: URL?
```

(b) Replace `lineRow`'s tap (line 260):

```swift
        .onTapGesture { open(fm.url) }
```

with:

```swift
        .onTapGesture { open(fm.url, line: lm.line) }
```

(c) Replace `editorPane`'s detail line (line 273):

```swift
            if let activeTab { FileDetailView(url: activeTab).id(activeTab) }
```

with:

```swift
            if let activeTab {
                FileDetailView(url: activeTab,
                               revealTarget: activeTab == revealTargetURL ? revealTarget : nil)
                    .id(activeTab)
            }
```

(d) Replace `open(_:)` (lines 336-339):

```swift
    private func open(_ url: URL) {
        if !tabs.contains(url) { tabs.append(url) }
        activeTab = url
    }
```

with:

```swift
    /// Open the result's file and scroll to its line (design §3 finding #7 —
    /// there was no line-jump plumbing in the app before P1's
    /// `MonacoRevealRequest`, and nothing called it before this).
    ///
    /// A FRESH request every click, deliberately: `MonacoRevealRequest`
    /// carries a UUID, so clicking the same result twice still scrolls — a
    /// bare line number would look unchanged and do nothing the second time.
    /// Constructed here, in an action, never inline in `body`, exactly as
    /// `MonacoRevealRequest`'s own doc comment requires.
    private func open(_ url: URL, line: Int) {
        if !tabs.contains(url) { tabs.append(url) }
        activeTab = url
        revealTargetURL = url
        revealTarget = MonacoRevealRequest(line: line)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter MonacoRevealGateTests`
Expected in a full-Xcode environment: PASS (4 tests).
Expected here: `no such module 'XCTest'` — state that the test did not execute, then:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build && swift build --build-tests`
Expected: both succeed. The `preview` closure arity changed, so any missed call site is a hard compile error — there are exactly two (`MarkdownDetailView`, `CodeDetailView`), both updated above. Every other `FileDetailView(url:)` caller is unaffected because `revealTarget` defaults to `nil`.

- [ ] **Step 7: Manual verification (no automated harness exists — design §9)**

Run items 4, 5 and 6 of the Manual Verification Checklist at the end of this plan before committing.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shared/MonacoRevealGate.swift mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift mac/Sources/LlmIdeMac/Views/Search/SearchView.swift mac/Tests/LlmIdeMacTests/MonacoRevealGateTests.swift
git commit -m "feat(mac): 検索結果クリックでエディタを該当行にジャンプさせる

同一ファイル内の2回目のクリックは url が変わらず .task(id: url) が
再実行されないため、initialLine では届かなかった。P1 の
MonacoRevealRequest（UUID 付き）を引き回し、プレビュー側にも渡す。"
```

---

### Task 8: Replace preview

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/ReplacePreview.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift:251` (the line's `Text`) and `:288-306` (the highlighting section)
- Test: Create `mac/Tests/LlmIdeMacTests/ReplacePreviewTests.swift`

**Interfaces:**
- Consumes: `SearchService.makeRegex(query:options:)`, `SearchService.preserveCaseReplacement(matched:replacement:)` (both `nonisolated static`, `SearchService.swift:20, 120`); `SearchService.replaceInFile(file:query:options:replacement:preserveCase:) async -> Bool` (`:139`); `SearchOptions`; `LineMatch`; `Theme.diffAddedBg`/`diffAddedFg`/`diffDeletedBg`/`diffDeletedFg` (`Theme.swift:148-151`, added in P0).
- Produces:
  - `enum ReplacePreviewSegment: Equatable { case plain(String); case removed(String); case inserted(String) }`
  - `static func ReplacePreview.segments(lineText: String, regex: NSRegularExpression, replacement: String, options: SearchOptions, preserveCase: Bool) -> [ReplacePreviewSegment]`
  - `static func ReplacePreview.resultingLine(_ segments: [ReplacePreviewSegment]) -> String`

**Destructiveness note (Global Constraints):** the preview itself writes nothing, but it is a *promise* about a destructive operation. Its correctness test therefore runs `replaceInFile` against a REAL temp file and asserts the preview predicted the bytes that actually landed on disk.

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/ReplacePreviewTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// The replace preview is a PROMISE about a destructive operation. If it
/// disagrees with what `replaceInFile` writes, the user approves one thing and
/// gets another — so the last test here does a real round trip on disk.
final class ReplacePreviewTests: XCTestCase {

    private func regex(_ query: String, _ options: SearchOptions) -> NSRegularExpression {
        SearchService.makeRegex(query: query, options: options)!
    }

    func testNoMatchYieldsASinglePlainSegment() {
        let opts = SearchOptions()
        let out = ReplacePreview.segments(lineText: "nothing here",
                                          regex: regex("needle", opts),
                                          replacement: "x", options: opts, preserveCase: false)
        XCTAssertEqual(out, [.plain("nothing here")])
    }

    func testSingleMatchSplitsIntoPlainRemovedInsertedPlain() {
        let opts = SearchOptions()
        let out = ReplacePreview.segments(lineText: "let foo = 1",
                                          regex: regex("foo", opts),
                                          replacement: "bar", options: opts, preserveCase: false)
        XCTAssertEqual(out, [.plain("let "), .removed("foo"), .inserted("bar"), .plain(" = 1")])
    }

    func testMatchAtBothEndsProducesNoEmptyPlainSegments() {
        let opts = SearchOptions()
        let out = ReplacePreview.segments(lineText: "foo",
                                          regex: regex("foo", opts),
                                          replacement: "bar", options: opts, preserveCase: false)
        XCTAssertEqual(out, [.removed("foo"), .inserted("bar")])
    }

    func testPreserveCaseUppercasesTheReplacement() {
        let opts = SearchOptions()
        let out = ReplacePreview.segments(lineText: "FOO and Foo and foo",
                                          regex: regex("foo", opts),
                                          replacement: "bar", options: opts, preserveCase: true)
        XCTAssertEqual(out, [.removed("FOO"), .inserted("BAR"),
                             .plain(" and "), .removed("Foo"), .inserted("Bar"),
                             .plain(" and "), .removed("foo"), .inserted("bar")])
    }

    func testRegexTemplateExpandsCaptureGroups() {
        var opts = SearchOptions()
        opts.regex = true
        let out = ReplacePreview.segments(lineText: "key=value",
                                          regex: regex("(\\w+)=(\\w+)", opts),
                                          replacement: "$2=$1", options: opts, preserveCase: false)
        XCTAssertEqual(out, [.removed("key=value"), .inserted("value=key")])
    }

    func testNonRegexReplacementStaysLiteral() {
        // `replaceInFile` escapes the template in non-regex mode, so `$1` is
        // written literally — the preview must say the same.
        let opts = SearchOptions()
        let out = ReplacePreview.segments(lineText: "foo",
                                          regex: regex("foo", opts),
                                          replacement: "$1", options: opts, preserveCase: false)
        XCTAssertEqual(out, [.removed("foo"), .inserted("$1")])
    }

    func testResultingLineDropsRemovedSegments() {
        let segments: [ReplacePreviewSegment] =
            [.plain("let "), .removed("foo"), .inserted("bar"), .plain(" = 1")]
        XCTAssertEqual(ReplacePreview.resultingLine(segments), "let bar = 1")
    }

    /// The round trip: what the preview promised must be what lands on disk.
    @MainActor
    func testPreviewMatchesWhatReplaceInFileActuallyWrites() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("replace-preview-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("a.txt")
        let original = "Foo foo FOO bar\nsecond foo line\nno match here\n"
        try original.write(to: file, atomically: true, encoding: .utf8)

        let opts = SearchOptions()
        let re = regex("foo", opts)
        let predicted = original
            .split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
            .map { line in
                ReplacePreview.resultingLine(
                    ReplacePreview.segments(lineText: String(line), regex: re,
                                            replacement: "bar", options: opts,
                                            preserveCase: true))
            }
            .joined(separator: "\n")

        let service = SearchService()
        let ok = await service.replaceInFile(file: file, query: "foo", options: opts,
                                             replacement: "bar", preserveCase: true)
        XCTAssertTrue(ok)
        let written = try String(contentsOf: file, encoding: .utf8)
        XCTAssertEqual(written, predicted)
        XCTAssertEqual(written, "Bar bar BAR bar\nsecond bar line\nno match here\n")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ReplacePreviewTests`
Expected in a full-Xcode environment: FAIL with "cannot find 'ReplacePreview' in scope".
Expected here: `no such module 'XCTest'` — record it, then confirm with `swift build --build-tests`.

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Services/ReplacePreview.swift`:

```swift
import Foundation

/// One piece of a search-result line rendered under an active Replace term.
enum ReplacePreviewSegment: Equatable {
    /// Text outside any match.
    case plain(String)
    /// The matched text — struck through, this is what goes away.
    case removed(String)
    /// What will take its place.
    case inserted(String)
}

/// Builds the "before → after" preview VS Code shows on every result row once
/// a Replace term is typed, WITHOUT touching the file.
///
/// It must agree exactly with what `SearchService.replaceOne` /
/// `replaceInFile` will write, so it computes each replacement through the
/// same three branches, in the same order: preserve-case splice (non-regex
/// only), regex template expansion, or a verbatim literal.
///
/// Matching a single LINE here vs. the WHOLE FILE there is safe because
/// `SearchService.makeRegex` sets `.anchorsMatchLines` — its own doc comment
/// records that this is precisely what keeps find and replace on the same
/// match ordering. A pattern spanning a newline is out of scope on both sides:
/// a line-based search never finds one.
enum ReplacePreview {

    static func segments(lineText: String,
                         regex: NSRegularExpression,
                         replacement: String,
                         options: SearchOptions,
                         preserveCase: Bool) -> [ReplacePreviewSegment] {
        let ns = lineText as NSString
        let hits = regex.matches(in: lineText, options: [],
                                 range: NSRange(location: 0, length: ns.length))
        guard !hits.isEmpty else { return [.plain(lineText)] }

        var out: [ReplacePreviewSegment] = []
        var cursor = 0
        for hit in hits {
            if hit.range.location > cursor {
                out.append(.plain(ns.substring(
                    with: NSRange(location: cursor, length: hit.range.location - cursor))))
            }
            let matched = ns.substring(with: hit.range)
            out.append(.removed(matched))
            out.append(.inserted(replacementText(for: hit, in: lineText, matched: matched,
                                                 regex: regex, replacement: replacement,
                                                 options: options, preserveCase: preserveCase)))
            cursor = hit.range.location + hit.range.length
        }
        if cursor < ns.length {
            out.append(.plain(ns.substring(from: cursor)))
        }
        return out
    }

    /// The line as it will read AFTER the replace — `plain` + `inserted`,
    /// `removed` dropped. Used by the round-trip test that pins this preview
    /// to what `replaceInFile` really writes.
    static func resultingLine(_ segments: [ReplacePreviewSegment]) -> String {
        segments.reduce(into: "") { acc, seg in
            switch seg {
            case .plain(let s), .inserted(let s): acc += s
            case .removed: break
            }
        }
    }

    /// Mirrors `SearchService.replaceOne`'s three branches, in its order —
    /// keeping them literally parallel is what stops the preview from ever
    /// disagreeing with the write.
    private static func replacementText(for hit: NSTextCheckingResult,
                                        in lineText: String,
                                        matched: String,
                                        regex: NSRegularExpression,
                                        replacement: String,
                                        options: SearchOptions,
                                        preserveCase: Bool) -> String {
        if preserveCase && !options.regex {
            return SearchService.preserveCaseReplacement(matched: matched,
                                                         replacement: replacement)
        }
        if options.regex {
            return regex.replacementString(for: hit, in: lineText, offset: 0,
                                           template: replacement)
        }
        return replacement
    }
}
```

- [ ] **Step 4: Render the preview in `SearchView`**

In `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift`, replace the line's `Text` in `lineRow` (line 251):

```swift
            Text(highlighted(lm))
```

with:

```swift
            Text(lineAttributed(lm))
```

and add `lineAttributed` immediately above `highlighted(_:)` in the `// MARK: - Highlighting` section (before line 295):

```swift
    /// With an active Replace term, render the row VS Code-style: the matched
    /// text struck through in the delete color, immediately followed by what
    /// will replace it in the add color. Falls back to plain match
    /// highlighting when there is nothing to preview.
    ///
    /// Colors come from the `Theme` diff tokens P0 added — never raw
    /// `.red`/`.green`, which ignore the active palette.
    private func lineAttributed(_ lm: LineMatch) -> AttributedString {
        guard showReplace, !replaceText.isEmpty,
              let regex = SearchService.makeRegex(query: query, options: options) else {
            return highlighted(lm)
        }
        let segments = ReplacePreview.segments(lineText: lm.lineText,
                                               regex: regex,
                                               replacement: replaceText,
                                               options: options,
                                               preserveCase: preserveCase)
        var out = AttributedString()
        for seg in segments {
            switch seg {
            case .plain(let s):
                out += AttributedString(s)
            case .removed(let s):
                var piece = AttributedString(s)
                piece.backgroundColor = theme.current.diffDeletedBg
                piece.foregroundColor = theme.current.diffDeletedFg
                piece.strikethroughStyle = .single
                out += piece
            case .inserted(let s):
                var piece = AttributedString(s)
                piece.backgroundColor = theme.current.diffAddedBg
                piece.foregroundColor = theme.current.diffAddedFg
                out += piece
            }
        }
        return out
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter ReplacePreviewTests`
Expected in a full-Xcode environment: PASS (8 tests, including the temp-file round trip).
Expected here: `no such module 'XCTest'` — the round-trip test in particular did NOT execute, so say so explicitly and rely on checklist item 8 instead. Then:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build && swift build --build-tests`
Expected: both succeed. `highlighted(_:)` is still referenced by `lineAttributed`'s fallback, so there must be no unused-function warning.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ReplacePreview.swift mac/Sources/LlmIdeMac/Views/Search/SearchView.swift mac/Tests/LlmIdeMacTests/ReplacePreviewTests.swift
git commit -m "feat(mac): show an inline before/after preview for search replace"
```

---

### Task 9: ⌘⇧F opens and focuses the Search panel

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/SearchFocusGate.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/NotificationNames.swift` (in the `// MARK: - Shell / navigation` group, after `openSection`, line 27)
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift` (add a property beside `section`, line 112)
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift` (add an observer after the `.openSection` handler, line 115)
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift:425-451` (the `CommandGroup(after: .windowList)` block)
- Modify: `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift:3-9` (environment/state), `:40-46` (`body`), `:119` (the find `TextField`)
- Test: Create `mac/Tests/LlmIdeMacTests/SearchFocusGateTests.swift`

**Interfaces:**
- Consumes: `ShellState.Section.search` (`ShellState.swift:9`); `AppFeature.fileExplorer` (`Models/AppFeature.swift:4`) and `FeatureRegistry.shared.isEnabled(_:)` (`Services/FeatureRegistry.swift:66`); the `@Environment(ShellState.self)` pattern `PanelSectionTabs` already uses inside `SearchView` (`Views/Shell/PanelSectionTabs.swift:9`), which proves `shell` is reachable from this view's environment.
- Produces:
  - `static func SearchFocusGate.shouldFocus(token: UUID?, lastConsumed: UUID?) -> Bool`
  - `Notification.Name.focusSearchField`
  - `ShellState.searchFocusToken: UUID?`

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/SearchFocusGateTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// ⌘⇧F has to work in two different situations, and exactly one of them
/// mounts a fresh view:
///   * Search is NOT the current section → the panel appears, `onAppear`
///     fires, `onChange` does not.
///   * Search IS already showing → only the token changes, `onChange` fires,
///     `onAppear` does not.
/// Both paths call this gate; `lastConsumed` is what stops an unrelated
/// re-appear — switching sections away and back — from stealing focus on a
/// token that was already honoured.
final class SearchFocusGateTests: XCTestCase {

    func testNoTokenMeansNoFocus() {
        XCTAssertFalse(SearchFocusGate.shouldFocus(token: nil, lastConsumed: nil))
        XCTAssertFalse(SearchFocusGate.shouldFocus(token: nil, lastConsumed: UUID()))
    }

    func testAFreshTokenFocuses() {
        XCTAssertTrue(SearchFocusGate.shouldFocus(token: UUID(), lastConsumed: nil))
    }

    func testANewTokenFocusesAgain() {
        XCTAssertTrue(SearchFocusGate.shouldFocus(token: UUID(), lastConsumed: UUID()))
    }

    func testAnAlreadyConsumedTokenDoesNotRefocus() {
        let token = UUID()
        XCTAssertFalse(SearchFocusGate.shouldFocus(token: token, lastConsumed: token))
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter SearchFocusGateTests`
Expected in a full-Xcode environment: FAIL with "cannot find 'SearchFocusGate' in scope".
Expected here: `no such module 'XCTest'` — record it, then confirm with `swift build --build-tests`.

- [ ] **Step 3: Write `SearchFocusGate`**

Create `mac/Sources/LlmIdeMac/Services/SearchFocusGate.swift`:

```swift
import Foundation

/// Decides whether a Search panel that has just appeared — or just seen a new
/// focus token — should take keyboard focus.
///
/// ⌘⇧F is a global menu command, so it fires whether or not `SearchView` is
/// mounted. Routing it through a token on `ShellState` (rather than a
/// notification `SearchView` might not be alive to receive) means the request
/// survives the section switch and is picked up by whichever of `onAppear` /
/// `onChange` actually runs. `lastConsumed` keeps a stale token from stealing
/// focus later, when the user navigates back to Search on their own.
enum SearchFocusGate {
    static func shouldFocus(token: UUID?, lastConsumed: UUID?) -> Bool {
        guard let token else { return false }
        return token != lastConsumed
    }
}
```

- [ ] **Step 4: Add the notification and the shell token**

In `mac/Sources/LlmIdeMac/Services/NotificationNames.swift`, add immediately after the `openSection` declaration (line 27):

```swift
    /// Open the Search panel AND put the caret in its find field — ⌘⇧F,
    /// VS Code's "Find in Files". Posted by the app's Commands menu (global,
    /// so it works from any section); observed by `AppShell`, which switches
    /// the section and stamps `ShellState.searchFocusToken`. A notification
    /// alone would not do: `SearchView` may not be mounted yet when the
    /// command fires.
    static let focusSearchField = Notification.Name("focusSearchField")
```

In `mac/Sources/LlmIdeMac/Services/ShellState.swift`, add immediately after `var librarySelection: LibrarySelection?` (line 113):

```swift
    /// Stamped fresh each time ⌘⇧F is pressed. `SearchView` compares it
    /// against the last token it consumed (`SearchFocusGate`) so the find
    /// field takes focus exactly once per press — never again on an unrelated
    /// return to the Search section.
    var searchFocusToken: UUID?
```

In `mac/Sources/LlmIdeMac/Views/AppShell.swift`, add immediately after the closing brace of the `.onReceive(...openSection...)` handler (line 115):

```swift
        .onReceive(NotificationCenter.default.publisher(for: .focusSearchField)) { _ in
            shell.section = .search
            shell.searchFocusToken = UUID()
            NSApp.activate(ignoringOtherApps: true)
            for window in NSApp.windows where window.identifier?.rawValue == "main" {
                window.makeKeyAndOrderFront(nil)
                if window.isMiniaturized { window.deminiaturize(nil) }
            }
        }
```

- [ ] **Step 5: Add the ⌘⇧F command**

In `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`, inside the existing `CommandGroup(after: .windowList)` block, add immediately after the "LLM Chat…" button's `.keyboardShortcut("l", modifiers: [.command, .shift])` (line 433):

```swift
                // ⌘⇧F — VS Code's "Find in Files". A Commands entry rather
                // than a view modifier for the same reason Start/Stop
                // Recording moved here: a SwiftUI view's own
                // .keyboardShortcut only fires while that view is mounted,
                // and the whole point of this one is to open a panel that
                // is NOT currently on screen.
                if FeatureRegistry.shared.isEnabled(.fileExplorer) {
                    Button("Find in Files…") {
                        NotificationCenter.default.post(name: .focusSearchField, object: nil)
                    }
                    .keyboardShortcut("f", modifiers: [.command, .shift])
                }
```

- [ ] **Step 6: Take focus in `SearchView`**

In `mac/Sources/LlmIdeMac/Views/Search/SearchView.swift`:

(a) Add to the property block after `@State private var searchService = SearchService()` (line 8):

```swift
    @Environment(ShellState.self) private var shell
    @FocusState private var findFocused: Bool
    @State private var lastFocusToken: UUID?
```

(b) Replace `body` (lines 40-46) with:

```swift
    var body: some View {
        VStack(spacing: 0) {
            searchHeaderBar
            Divider()
            content
        }
        // Two entry points, one gate: the panel may be mounting FOR this
        // ⌘⇧F (onAppear runs, onChange doesn't) or already showing when the
        // token lands (onChange runs, onAppear doesn't).
        .onAppear { consumeFocusToken() }
        .onChange(of: shell.searchFocusToken) { _, _ in consumeFocusToken() }
    }

    private func consumeFocusToken() {
        guard SearchFocusGate.shouldFocus(token: shell.searchFocusToken,
                                          lastConsumed: lastFocusToken) else { return }
        lastFocusToken = shell.searchFocusToken
        findFocused = true
    }
```

(c) Attach the focus binding to the find field — in `findField`, add `.focused($findFocused)` to the `TextField("Search", text: $query)` chain, immediately after `.textFieldStyle(.plain)` (line 120):

```swift
            TextField("Search", text: $query)
                .textFieldStyle(.plain)
                .focused($findFocused)
                .padding(.horizontal, 8).padding(.vertical, 6)
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift test --filter SearchFocusGateTests`
Expected in a full-Xcode environment: PASS (4 tests).
Expected here: `no such module 'XCTest'` — state that the test did not execute, then:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && swift build && swift build --build-tests`
Expected: both succeed. Note `⌘⇧F` does not collide with anything: the existing Commands block uses ⌘P, ⌘⇧L and ⌘N only (`LlmIdeMacApp.swift:427, 433, 443/448`).

- [ ] **Step 8: Verify the lite build still compiles**

`Views/Search/` is excluded when `file_explorer` is off (`Package.swift:56`), while `NotificationNames.swift`, `ShellState.swift`, `SearchFocusGate.swift` and the menu command are always compiled. Confirm the exclusion path is intact:

Run: `cd /Users/dinesh.malla/llm-ide/.claude/worktrees/vscode-parity-p2/mac && LLMIDE_FEATURES=chat swift build 2>&1 | tail -20`
Expected: builds successfully — nothing outside `Views/Search/` references `SearchView`.

- [ ] **Step 9: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SearchFocusGate.swift mac/Sources/LlmIdeMac/Services/NotificationNames.swift mac/Sources/LlmIdeMac/Services/ShellState.swift mac/Sources/LlmIdeMac/Views/AppShell.swift mac/Sources/LlmIdeMac/LlmIdeMacApp.swift mac/Sources/LlmIdeMac/Views/Search/SearchView.swift mac/Tests/LlmIdeMacTests/SearchFocusGateTests.swift
git commit -m "feat(mac): ⌘⇧F で Search パネルを開き検索欄にフォーカスする"
```

---

## Self-Review

### 1. Spec coverage

| Spec requirement | Where it is implemented |
|---|---|
| §11 P4 — cancellable streaming search (§6.5) | Task 2 (`SearchEngine.scan`'s injected `isCancelled`), Task 3 (`SearchService.stream` + `onTermination`), Task 5 (`SearchView` consumes it; the old uncancellable `search`/`walk` deleted) |
| §11 P4 — line-jump on result click (via P1's `reveal`) | Task 7 |
| §11 P4 — `.gitignore` support | Task 1 (`GitIgnoreRules`), Task 3 (`collectCandidates` wires root + nested files into the walk) |
| §11 P4 — ⌘⇧F to open the panel | Task 9 |
| §11 P4 — truncation warning at the match cap | Task 3 (`SearchEvent.truncated`, `SearchResults.truncated`), Task 6 (`SearchHeaderText.truncationWarning` + the header row) |
| §11 P4 — root unification with Explorer | Task 4 |
| §11 P4 — replace preview | Task 8 |
| §3 finding #7 (no line-jump plumbing anywhere) | Task 7 |
| §3 finding #8 (`Task.detached` with zero cancellation checks) | Tasks 2, 3, 5 |
| §3 finding #10 (Search and Explorer use different root resolution) | Task 4 |
| §6.5 (`SearchService.search` → stream with `Task.isCancelled` in the walk loop) | Task 3, with the `SearchEvent`-not-`FileMatch` ruling restated in Global Constraints and in `SearchEvent`'s own doc comment |
| §8 (search cancellation: a superseded stream is simply not consumed further) | Task 3's `onTermination`, Task 5's `if Task.isCancelled { return }` inside `for await` |
| §9 (pure Swift logic tested without a WebView; view glue verified manually per phase) | Tasks 1, 2, 3, 4, 6, 7, 8, 9 all carry XCTest files; Tasks 5 and 7's view wiring is covered by the Manual Verification Checklist |
| §6.6 / project rule — no raw colors | Task 6 uses `Theme.warning`; Task 8 uses `Theme.diffAddedBg/Fg` and `diffDeletedBg/Fg` |

Not in P4 by design: `RepoFileWatcher`-driven live re-search, multi-select in the results list, and search history — none appear in §11's P4 bullet. Explorer's own P3 items are not touched here beyond the two-line root delegation in Task 4.

### 2. Placeholder scan

Searched for "TBD", "TODO", "similar to Task", "implement later", "add appropriate error handling", "handle edge cases", "write tests for the above" — none present. Every code step carries real, compilable code. The one `_ = cap` discard introduced in Task 5 is explicitly replaced in Task 6, Step 4, and both steps show the exact before/after text.

### 3. Type consistency

- `SearchEngine.maxMatches` is the single cap. It is declared in Task 2, consumed by Task 3's `scan`/`stream`, and read directly by Task 6's header (never re-declared or passed as a magic number).
- `SearchEngine.Candidate` is produced by Task 3's `collectCandidates` and consumed by Task 2's `scan` — the same type, `{ url, displayPath }`, in both.
- `SearchEngine.Outcome`'s three cases map one-to-one onto `stream`'s switch in Task 3.
- `SearchEvent`'s cases (`.file`, `.truncated(cap:)`, `.finished(totalMatches:fileCount:)`) match `SearchView`'s switch in Task 5 exactly, including labels.
- `GitIgnoreRules.isIgnored(relativePath:isDirectory:)` — same label order in Task 1's declaration, Task 1's tests, and Task 3's call site.
- `MonacoRevealRequest` is P1's existing type (`line`, `id`), used unchanged; `MonacoRevealGate.shouldApply(target:contentIsEmpty:)` has the same labels in Task 7's declaration, its two call sites, and its tests.
- `revealTarget` is the property name at every level — `FileDetailView`, `MarkdownDetailView`, `CodeDetailView`, `EditableTextDetailView`, both of its inits, and `SearchView`'s state. The old name `initialLine` survives nowhere.
- `preview: (String, MonacoRevealRequest?) -> Preview` is declared once and matched by both call sites (`MarkdownDetailView`'s `{ content, _ in }`, `CodeDetailView`'s `{ content, reveal in }`) and by both inits.
- `WorkspaceRoot.pickBrowsingRoot(codeDir:fallback:exists:children:)` — same labels in the declaration, `browsingRoot`'s call, and every test.
- `SearchHeaderText.label(invalidPattern:searching:query:totalMatches:fileCount:)` and `truncationWarning(truncated:cap:)` — same labels in declaration, tests, and `SearchView`.
- `ReplacePreview.segments(lineText:regex:replacement:options:preserveCase:)` — same labels in declaration, tests, and `lineAttributed`.
- `SearchFocusGate.shouldFocus(token:lastConsumed:)` — same labels in declaration, tests, and `consumeFocusToken`.
- `SearchResults.truncated` is added in Task 3 and read in Task 6; `SearchResults` stays `Equatable` (all members are).

---

## Manual Verification Checklist

Nothing below is reachable by an automated test in this environment: the toolchain cannot run XCTest at all, and even with a full Xcode there is no live-WebView harness for Monaco (design §9). Run these in the built app against a real project with a git repo under `code/`.

1. **Root unification.** Open a project whose `code/` holds exactly one clone. Explorer's tree root and Search's results paths must be relative to that clone — not to `code/`, and not to the project folder. Confirm Search returns nothing for a string that exists only in `<project>/notes/`; that exclusion is the intended, documented consequence of Task 4.
2. **Streaming + real cancellation.** Type a common term (e.g. `let`) one character at a time in a large repo. Results must appear progressively, in alphabetical path order, and each keystroke must visibly restart the list rather than stacking multiple runs. Watch the spinner: it must stop, not sit spinning after the final keystroke's run completes.
3. **Truncation warning.** Search for something with more than 1000 matches (a single space, or `e`). The yellow warning row must appear under the count and read "Showing the first 1000 matches — narrow the query or use “files to include”." Add an include glob that narrows it below 1000 and confirm the warning disappears.
4. **CRLF line numbers (the bug Task 2 fixes).** Create a file with Windows line endings inside the search root — `printf 'alpha\r\nbeta\r\nneedle\r\n' > crlf.txt` — search for `needle`, and confirm the result row shows **line 3**, not line 1. Click it and confirm the editor lands on line 3.
5. **Clicking the SAME result twice (Task 7, problem 1).** Click a result, scroll the editor far away with the mouse, then click the *exact same* result row again. The editor must scroll back to that line. Before this fix nothing happened, because only `initialLine` changed and `.task(id: url)` never re-ran.
6. **Clicking a second result in an ALREADY-OPEN file (Task 7, problems 1 and 2).** Expand a file with several matches. Click the first, then the third. The editor must jump to the third match's line — and it must do so while still in **Preview** mode, since code files open read-only (`startInPreview: true`). Then toggle to **Edit** and repeat: line-jump must work in both modes.
7. **Line-jump across files.** Click a result in file A, then one in file B. Both must open as tabs and land on the right line. Then switch tabs manually with `EditorTabBar` back to A — A must NOT re-scroll to B's line number (this is what `revealTargetURL` guards).
8. **Replace preview and the actual write.** Type a Find term, expand the Replace row, and type a replacement. Each result row must show the matched text struck through in the delete color followed by the replacement in the add color. Turn **AB** (preserve case) on and confirm `FOO`→`BAR`, `Foo`→`Bar`, `foo`→`bar` in the preview. Then click the row's Replace button and confirm the file on disk now contains exactly what the preview promised. Repeat once with **.\*** (regex) on and a capture-group replacement like `$2=$1`.
9. **`.gitignore`.** Add a pattern to the repo's `.gitignore` (e.g. `*.generated.swift`), create a matching file containing the search term, and confirm it does NOT appear in results. Add a nested `.gitignore` in a subfolder and confirm its rules apply only inside that subfolder. Confirm a `!negated` line re-includes a file.
10. **⌘⇧F.** From the Library section, press ⌘⇧F: the window must come forward, switch to Search, and put the caret in the find field (type immediately — the characters must land in the field). Press ⌘⇧F again while Search is already showing: focus must return to the find field. Switch to Explorer and back to Search by clicking the tabs: focus must NOT be stolen this time.
11. **Theme.** Repeat steps 3 and 8 in Dark, Light and Midnight themes. The truncation warning and both replace-preview colors must stay legible in all three — no raw green/red.
12. **Lite build.** Build with `LLMIDE_FEATURES=chat`. The app must compile and launch, and the "Find in Files…" menu item must be absent (its `FeatureRegistry.shared.isEnabled(.fileExplorer)` guard).
