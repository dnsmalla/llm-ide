# VS Code Parity P0: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation the Explorer/Source Control/Search premium upgrade depends on: theme-correct diff/git colors, a single git-truth store with the file-tree decoration bug fixed and live file-watching, and a working Monaco (VS Code's editor) host that loads offline and can be driven from Swift.

**Architecture:** Swift owns truth (git execution, status, line-level change marks); Monaco (loaded once into a `WKWebView`, updated afterward only via a small typed JS bridge — never reloaded) owns rendering. This phase delivers both halves as standalone, unit-testable pieces with no UI wiring yet — Explorer/editor/Source Control consume them in later phases (P1–P4). Resource resolution and the JS-message bridge contract are unit-tested here; actually rendering Monaco on screen is proven manually once P1 wires the first real caller — no UI in this app shows a `MonacoHost` at the end of this phase.

**Tech Stack:** Swift 5 (macOS 14+ target), SwiftUI + AppKit (`NSViewRepresentable`), WebKit (`WKWebView`, `WKScriptMessageHandler`), Foundation `Process` for git, Node.js (build-time only, to vendor Monaco), XCTest (this codebase's SCM/Explorer test convention).

**Spec:** [docs/superpowers/specs/2026-09-03-vscode-parity-explorer-scm-search-design.md](../specs/2026-09-03-vscode-parity-explorer-scm-search-design.md) — read §5 (responsibility split), §6.1–6.3 and §6.6 (this phase's new types and theme tokens), §11 (P0 scope) before starting.

## Global Constraints

- Swift 6 language mode is NOT enabled (`swiftLanguageModes: [.v5]` in `Package.swift`) — do not add strict-concurrency-only syntax.
- `RepoManager` stays `@MainActor`. Do **not** attempt to make `MemoryStore` (a `Sendable` struct, deliberately usable off the main actor) or any `AutoCodeUpdateService+CLI.swift` function call into `RepoManager` — that migration is explicitly out of scope for this spec (see design §6.5).
- No raw `Color.green` / `.red` / `.orange` in new or touched view code — always a `Theme` token (existing project rule, `Theme.swift:88-91`).
- No remote CDN for any web asset (matches `HljsWebView.swift`'s existing "vendored, offline, no MITM" policy) — Monaco ships from `Resources/monaco/`, loaded via `Bundle.main`.
- Every new test file follows this codebase's existing XCTest convention for SCM/Explorer code (`import XCTest`, `final class ... : XCTestCase`) — not the newer `swift-testing` (`@Test`/`#expect`) convention used elsewhere in the chat domain. Match the domain you're in.
- This toolchain (Xcode Command Line Tools only, no full Xcode) cannot run `swift test` (no XCTest/Testing runtime) — see memory `mac-build-environment`. Every task's "run the test" step still means literally running the command; if it fails with `no such module 'XCTest'`, treat that as an environment limitation, not a task failure, and confirm via `swift build` (compiles, which this toolchain CAN do) instead. State this explicitly when it happens — do not claim the test passed.

---

## File Structure

**New files:**
- `mac/Sources/LlmIdeMac/Services/GitTruthStore.swift` — the git-truth `@Observable` store (supersedes `GitStatusStore`'s role; `GitStatusStore.swift` itself is deleted once `GitTruthStore` covers everything it did, in Task 7)
- `mac/Sources/LlmIdeMac/Services/MonacoBridge.swift` — Codable message types crossing the Swift↔JS boundary
- `mac/Sources/LlmIdeMac/Views/Shared/MonacoHost.swift` — the `NSViewRepresentable` WKWebView wrapper + its `Coordinator`
- `mac/Scripts/build-monaco-bundle.mjs` — Node script that vendors Monaco's prebuilt files into `Resources/monaco/vs/`
- `mac/Sources/LlmIdeMac/Resources/monaco-src/index.html` — hand-authored HTML shell Monaco boots from (source of truth; copied verbatim by the build script)
- `mac/Sources/LlmIdeMac/Resources/monaco-src/bootstrap.js` — hand-authored JS that wires Monaco to the Swift bridge (source of truth; copied verbatim by the build script)
- `mac/Sources/LlmIdeMac/Resources/monaco/` — **generated** output of the build script (committed, like `Resources/highlight.min.js`): `vs/` (vendored Monaco) + `index.html` + `bootstrap.js` copied in
- `mac/Tests/LlmIdeMacTests/GitTruthStoreTests.swift`
- `mac/Tests/LlmIdeMacTests/GitGutterTests.swift`
- `mac/Tests/LlmIdeMacTests/ThemeGitTokensTests.swift`
- `mac/Tests/LlmIdeMacTests/RepairScopeGuardTests.swift`
- `mac/Tests/LlmIdeMacTests/MemoryStoreGitTests.swift`
- `mac/Tests/LlmIdeMacTests/MonacoBridgeTests.swift`
- `mac/Tests/LlmIdeMacTests/MonacoHostHTMLTests.swift`

**Modified files:**
- `mac/Sources/LlmIdeMac/Models/Theme.swift` — new semantic extension (diff/git/editor tokens, `color(for:)`, `monacoTheme()`/`monacoThemeJSON()`)
- `mac/Sources/LlmIdeMac/Services/GitGutter.swift` — `.deleted` mark
- `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` — `color(_:)` reads `Theme` instead of raw SwiftUI colors
- `mac/Sources/LlmIdeMac/LoopEngine/Services/RepairScopeGuard.swift` — parser dedup
- `mac/Sources/LlmIdeMac/Services/Memory/MemoryStore.swift` — deadlock-safe pipe draining
- `mac/Package.swift` — new `Resources/monaco` resource copy

**Deleted (end of Task 7):**
- `mac/Sources/LlmIdeMac/Services/GitStatusStore.swift` — fully superseded by `GitTruthStore`

Every consumer of `GitStatusStore` today is `ExplorerView.swift` (per the P0/P3 split in the design, Task 7 does **not** touch `ExplorerView` — that rewiring is P3's job). Because deleting `GitStatusStore.swift` in this phase would break `ExplorerView`'s build, **Task 7 does not delete the old file** — it is left in place, unused by anything new, and the deletion + `ExplorerView` rewiring both happen together in P3. This plan's Task 7 title says "supersede" rather than "delete" for that reason.

---

### Task 1: Theme diff/git/editor semantic tokens

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/Theme.swift` (append to the existing `// MARK: - Semantic aliases` extension, after `tint(for:)`, i.e. after line 137)
- Test: Create `mac/Tests/LlmIdeMacTests/ThemeGitTokensTests.swift`

**Interfaces:**
- Produces: `Theme.diffAddedFg`, `.diffAddedBg`, `.diffDeletedFg`, `.diffDeletedBg`, `.diffModifiedBg`, `.diffWordHighlight`, `.gutterAddedMark`, `.gutterModifiedMark`, `.gutterDeletedMark`, `.editorBackground`, `.editorLineNumber` — all `Color`, all computed (no stored-property changes to the `Theme` struct, so no palette literal needs touching).

These are derived from the existing semantic aliases (`success`/`danger`/`warning`/`info`, already computed from `accent3`/`danger`/`accent4`/`accent2`) rather than new hardcoded literals — this is what makes them theme-correct by construction and keeps `Theme.dark`/`.light`/`.midnight` untouched.

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/ThemeGitTokensTests.swift
import XCTest
@testable import LlmIdeMacLib

final class ThemeGitTokensTests: XCTestCase {
    func testDiffTokensDeriveFromExistingSemanticAliases() {
        for theme in Theme.all {
            XCTAssertEqual(theme.diffAddedFg, theme.success, "\(theme.id): added must track success")
            XCTAssertEqual(theme.diffDeletedFg, theme.danger, "\(theme.id): deleted must track danger")
            XCTAssertEqual(theme.gutterAddedMark, theme.success, "\(theme.id): gutter added must track success")
            XCTAssertEqual(theme.gutterModifiedMark, theme.info, "\(theme.id): gutter modified must track info")
            XCTAssertEqual(theme.gutterDeletedMark, theme.danger, "\(theme.id): gutter deleted must track danger")
        }
    }

    func testEditorBaseTokensTrackBodyAndMutedText() {
        for theme in Theme.all {
            XCTAssertEqual(theme.editorBackground, theme.body, "\(theme.id): editor background must track body")
            XCTAssertEqual(theme.editorLineNumber, theme.textMuted, "\(theme.id): line numbers must track textMuted")
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL with `value of type 'Theme' has no member 'diffAddedFg'` (or similar — the properties don't exist yet).

- [ ] **Step 3: Add the tokens to `Theme.swift`**

Insert immediately after the closing `}` of `func tint(for category: LibraryItem.Category) -> Color { ... }` (the last member of the `extension Theme` block that starts at `Theme.swift:92`), still inside that same `extension Theme { ... }`:

```swift
    // MARK: - Diff / git / editor tokens
    //
    // Derived from the existing semantic aliases, not new literals: this is
    // what keeps them theme-correct (Dark/Light/Midnight all agree with the
    // rest of the app's palette) without touching the three `static let`
    // palette definitions above. Views must read these — never raw
    // `Color.green`/`.red`/`.orange` — the rule `Theme.swift`'s own header
    // comment already states for `success`/`warning`/`info`.

    var diffAddedFg: Color { success }
    var diffAddedBg: Color { success.opacity(0.16) }
    var diffDeletedFg: Color { danger }
    var diffDeletedBg: Color { danger.opacity(0.16) }
    var diffModifiedBg: Color { info.opacity(0.16) }
    /// Word-level (intra-line) diff highlight, used by the Monaco diff editor.
    var diffWordHighlight: Color { warning.opacity(0.35) }

    // Editor gutter marks (added/modified/deleted line markers).
    var gutterAddedMark: Color { success }
    var gutterModifiedMark: Color { info }
    var gutterDeletedMark: Color { danger }

    // Monaco theme base colors.
    var editorBackground: Color { body }
    var editorLineNumber: Color { textMuted }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly (no `has no member` errors). If a full Xcode toolchain is available, additionally run `swift test --filter ThemeGitTokensTests` and expect `Test Suite 'ThemeGitTokensTests' passed`.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/Theme.swift mac/Tests/LlmIdeMacTests/ThemeGitTokensTests.swift
git commit -m "feat(mac): add diff/git/editor Theme tokens"
```

---

### Task 2: `Theme.color(for:)` and the `SourceControlView` raw-color fix

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/Theme.swift` (same extension as Task 1)
- Modify: `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift:637-644`
- Test: Append to `mac/Tests/LlmIdeMacTests/ThemeGitTokensTests.swift`

**Interfaces:**
- Consumes: `FileChange.Status` (existing, `Services/SCMModels.swift:4`)
- Produces: `Theme.color(for status: FileChange.Status) -> Color`

- [ ] **Step 1: Write the failing test**

Append to `ThemeGitTokensTests.swift`:

```swift
    func testColorForStatusUsesThemeTokensNotRawColors() {
        let t = Theme.dark
        XCTAssertEqual(t.color(for: .added), t.success)
        XCTAssertEqual(t.color(for: .untracked), t.success)
        XCTAssertEqual(t.color(for: .deleted), t.danger)
        XCTAssertEqual(t.color(for: .conflicted), t.warning)
        XCTAssertEqual(t.color(for: .modified), t.accent2)
        XCTAssertEqual(t.color(for: .renamed), t.accent2)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL with `value of type 'Theme' has no member 'color'`.

- [ ] **Step 3: Add `Theme.color(for:)`**

Append inside the same `extension Theme` block (after the tokens added in Task 1):

```swift
    /// Source Control changes-list badge/text color for a file's status.
    /// Mirrors `SourceControlView`'s original raw-color mapping — same
    /// cases, same fallback — but through Theme so Midnight reads correctly.
    func color(for status: FileChange.Status) -> Color {
        switch status {
        case .added, .untracked: return success
        case .deleted: return danger
        case .conflicted: return warning
        default: return accent2
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly.

- [ ] **Step 5: Replace `SourceControlView.color(_:)`'s body**

In `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift`, replace lines 637-644:

```swift
    private func color(_ s: FileChange.Status) -> Color {
        switch s {
        case .added, .untracked: return .green
        case .deleted: return .red
        case .conflicted: return .orange
        default: return theme.current.accent2
        }
    }
```

with:

```swift
    private func color(_ s: FileChange.Status) -> Color {
        theme.current.color(for: s)
    }
```

- [ ] **Step 6: Run full build to verify no regressions**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20`
Expected: `Build complete!` — `theme` is already an `@EnvironmentObject var theme: ThemeStore` on this view (line 9), so `theme.current` is already in scope.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/Theme.swift mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift mac/Tests/LlmIdeMacTests/ThemeGitTokensTests.swift
git commit -m "fix(mac): Source Control status colors read Theme instead of raw SwiftUI colors"
```

---

### Task 3: `Color.hexRGB()` and `Theme.monacoTheme()`/`monacoThemeJSON()`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/Theme.swift` (new extension block, after the existing `extension Theme` block; needs `import AppKit`)
- Test: Append to `mac/Tests/LlmIdeMacTests/ThemeGitTokensTests.swift`

**Interfaces:**
- Produces: `Color.hexRGB() -> String` ("#RRGGBB"), `MonacoThemeRule` (Codable), `MonacoTheme` (Codable), `Theme.monacoTheme() -> MonacoTheme`, `Theme.monacoThemeJSON() -> String`
- Consumed later by: `MonacoBridge.setTheme(_:)` (Task 13)

- [ ] **Step 1: Write the failing tests**

Append to `ThemeGitTokensTests.swift`:

```swift
    func testHexRGBFormatsAsUppercaseSixDigitHex() {
        XCTAssertEqual(Color.white.hexRGB(), "#FFFFFF")
        XCTAssertEqual(Color.black.hexRGB(), "#000000")
    }

    func testMonacoThemeBaseMatchesIsDark() {
        XCTAssertEqual(Theme.dark.monacoTheme().base, "vs-dark")
        XCTAssertEqual(Theme.midnight.monacoTheme().base, "vs-dark")
        XCTAssertEqual(Theme.light.monacoTheme().base, "vs")
    }

    func testMonacoThemeColorsMatchThemeTokens() {
        let t = Theme.dark
        let m = t.monacoTheme()
        XCTAssertEqual(m.colors["editor.background"], t.editorBackground.hexRGB())
        XCTAssertEqual(m.colors["editor.foreground"], t.text.hexRGB())
        XCTAssertEqual(m.colors["editorLineNumber.foreground"], t.editorLineNumber.hexRGB())
        XCTAssertTrue(m.inherit)
    }

    func testMonacoThemeJSONIsValidJSONWithExpectedKeys() throws {
        let json = Theme.dark.monacoThemeJSON()
        let data = try XCTUnwrap(json.data(using: .utf8))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["base"] as? String, "vs-dark")
        XCTAssertNotNil(obj["colors"] as? [String: String])
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `hexRGB`/`monacoTheme`/`monacoThemeJSON` don't exist yet.

- [ ] **Step 3: Implement, appended to the end of `Theme.swift`**

```swift
// MARK: - Monaco theme bridge

import AppKit

extension Color {
    /// "#RRGGBB", best-effort. Used only for embedding into Monaco's theme
    /// JSON — Theme's `Color` values remain the actual source of truth for
    /// every SwiftUI view; this is a one-way, lossy export for the WebView.
    func hexRGB() -> String {
        guard let rgb = NSColor(self).usingColorSpace(.deviceRGB) else { return "#000000" }
        let r = Int((rgb.redComponent * 255).rounded())
        let g = Int((rgb.greenComponent * 255).rounded())
        let b = Int((rgb.blueComponent * 255).rounded())
        return String(format: "#%02X%02X%02X", r, g, b)
    }
}

/// One entry of Monaco's `IStandaloneThemeData.rules` — a token-type →
/// color mapping for syntax highlighting. Kept minimal (foreground only,
/// no fontStyle) since only line/diff decoration colors are theme-critical
/// here; Monaco's bundled default-dark/default-light token colors are fine
/// for syntax highlighting itself.
struct MonacoThemeRule: Codable, Equatable {
    let token: String
    let foreground: String?
}

/// Mirrors Monaco's `monaco.editor.defineTheme(name, data)` `data` shape
/// (`IStandaloneThemeData`). `base` must be one of Monaco's four built-in
/// base themes; `inherit: true` means unset `colors` keys fall back to that
/// base theme's own values.
struct MonacoTheme: Codable, Equatable {
    let base: String
    let inherit: Bool
    let rules: [MonacoThemeRule]
    let colors: [String: String]
}

extension Theme {
    /// The `IStandaloneThemeData` Monaco needs to render in this app's
    /// palette. `base` selects Monaco's built-in dark/light base (Midnight
    /// is a dark palette, so it inherits "vs-dark" too — `Theme.isDark`
    /// already models exactly this distinction for every other consumer).
    func monacoTheme() -> MonacoTheme {
        MonacoTheme(
            base: isDark ? "vs-dark" : "vs",
            inherit: true,
            rules: [],
            colors: [
                "editor.background": editorBackground.hexRGB(),
                "editor.foreground": text.hexRGB(),
                "editorLineNumber.foreground": editorLineNumber.hexRGB(),
                "editorLineNumber.activeForeground": text.hexRGB(),
                "editorGutter.addedBackground": gutterAddedMark.hexRGB(),
                "editorGutter.modifiedBackground": gutterModifiedMark.hexRGB(),
                "editorGutter.deletedBackground": gutterDeletedMark.hexRGB(),
                "diffEditor.insertedTextBackground": diffAddedBg.hexRGB(),
                "diffEditor.removedTextBackground": diffDeletedBg.hexRGB(),
            ]
        )
    }

    /// `monacoTheme()` as a JSON string, ready to cross the JS bridge as a
    /// `callAsyncJavaScript` argument (never spliced into JS source — see
    /// `MonacoBridge.setTheme`). Falls back to an empty object rather than
    /// throwing: a failed encode should degrade to Monaco's own default
    /// theme, not crash the host.
    func monacoThemeJSON() -> String {
        guard let data = try? JSONEncoder().encode(monacoTheme()),
              let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/Theme.swift mac/Tests/LlmIdeMacTests/ThemeGitTokensTests.swift
git commit -m "feat(mac): Theme -> Monaco theme JSON bridge"
```

---

### Task 4: `RepairScopeGuard` parser dedup

**Files:**
- Modify: `mac/Sources/LlmIdeMac/LoopEngine/Services/RepairScopeGuard.swift:180-201`
- Test: Create `mac/Tests/LlmIdeMacTests/RepairScopeGuardTests.swift` (none exists today)

**Interfaces:**
- Consumes: `StatusParser.parse(porcelain:) -> [FileChange]` (existing, `Services/SCMParsers.swift:7`), `FaultVerifier` protocol (existing, `Services/FaultVerifier.swift:46-48`: `func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome`), `VerifyOutcome(exitCode: Int32, output: String)` (existing, `FaultVerifier.swift:9-12`)
- No public interface changes — `GitRepairScopeGuard.snapshot(gitRoot:) async -> RepairScopeSnapshot` (existing, `RepairScopeGuard.swift:117-124`, internal access) keeps its exact signature; the fix is entirely inside the `private func dirtyPaths(gitRoot:)` it calls (lines 180-201) — `dirtyPaths` itself is `private`, so this task tests through `snapshot`, the public method that calls it, rather than `dirtyPaths` directly.

- [ ] **Step 1: Write the failing test**

`GitRepairScopeGuard(verifier: FaultVerifier = ShellFaultVerifier(), timeout: TimeInterval = 60)` takes its git-command runner as a protocol dependency, so a fake `FaultVerifier` can supply canned `git status --porcelain` output without touching a real repo:

```swift
// mac/Tests/LlmIdeMacTests/RepairScopeGuardTests.swift
import XCTest
@testable import LlmIdeMacLib

final class RepairScopeGuardTests: XCTestCase {
    /// Always answers exit 0 with fixed `output` — enough to drive
    /// `GitRepairScopeGuard.snapshot`'s `git status --porcelain` probe
    /// without a real git process or working tree.
    private struct FakeVerifier: FaultVerifier {
        let output: String
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            VerifyOutcome(exitCode: 0, output: output)
        }
    }

    /// The case most likely to break during a parser swap: a rename must
    /// keep only the NEW path, exactly like `StatusParser` (`SCMParsers.swift:16-18`)
    /// already does and `SCMParsersTests` already pins — the pre-fix inline
    /// parser here reimplemented the same "XY <path>" / " -> " splitting
    /// independently, so this proves the swap doesn't silently flip which
    /// side of the arrow survives.
    func testSnapshotKeepsOnlyTheNewPathForRenamesUntrackedAndPlainModifications() async {
        let porcelain = "R  old.txt -> new.txt\n M plain.txt\n?? untracked.txt\n"
        let guardService = GitRepairScopeGuard(verifier: FakeVerifier(output: porcelain))
        let snapshot = await guardService.snapshot(gitRoot: URL(fileURLWithPath: "/tmp"))
        XCTAssertTrue(snapshot.usable)
        XCTAssertEqual(snapshot.dirtyPaths, ["new.txt", "plain.txt", "untracked.txt"])
    }

    func testSnapshotUnusableWhenVerifierFails() async {
        struct FailingVerifier: FaultVerifier {
            func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
                VerifyOutcome(exitCode: 128, output: "fatal: not a git repository")
            }
        }
        let guardService = GitRepairScopeGuard(verifier: FailingVerifier())
        let snapshot = await guardService.snapshot(gitRoot: URL(fileURLWithPath: "/tmp"))
        XCTAssertFalse(snapshot.usable)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds and BOTH tests already pass against the current (pre-fix) inline parser — this rename case happens not to trip the existing bug (the old code already split on `" -> "` and kept the right-hand side, same as `StatusParser`). That is fine: this task is a safe refactor pinned by a test that must keep passing across the swap, not a bug-fix pinned by a test that starts red. Confirm the build succeeds here before proceeding.

- [ ] **Step 3: Replace the inline parser**

In `RepairScopeGuard.swift`, replace the body of `dirtyPaths(gitRoot:)` (lines 180-201):

```swift
    private func dirtyPaths(gitRoot: URL) async -> Probe<Set<String>> {
        switch await run("git status --porcelain --untracked-files=all", gitRoot: gitRoot) {
        case .failure(let reason):
            return .failure(reason)
        case .success(let output):
            let paths = StatusParser.parse(porcelain: output).map(\.path)
            return .success(Set(paths))
        }
    }
```

This drops the now-redundant local `line.count > 3` / arrow-splitting / quote-stripping logic — `StatusParser.parse` already implements all three (`SCMParsers.swift:11-19`), tested by `SCMParsersTests`. `run(_:gitRoot:)` (the `FaultVerifier`-backed sandboxed command execution, `RepairScopeGuard.swift:203-213`) is untouched — this change is a parser dedup only, not an execution-path change.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly; both Step 1 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/LoopEngine/Services/RepairScopeGuard.swift mac/Tests/LlmIdeMacTests/RepairScopeGuardTests.swift
git commit -m "refactor(mac): RepairScopeGuard reuses StatusParser instead of its own porcelain parser"
```

---

### Task 5: `MemoryStore.runGit` deadlock-safe pipe draining

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/Memory/MemoryStore.swift:244-254`
- Test: Create `mac/Tests/LlmIdeMacTests/MemoryStoreGitTests.swift`

**Interfaces:**
- No signature change: `private static func runGit(_ args: [String], at repo: URL) throws -> String` keeps its exact signature (called by `gitDiff`/`gitCheckout`, `MemoryStore.swift:231-232,241`).

- [ ] **Step 1: Write the failing test**

`runGit`'s current bug is that it reads stdout to EOF *before* draining stderr, and both happen *before* `waitUntilExit()` — a process that writes enough to fill the stderr pipe buffer while `runGit` is still blocked reading stdout will deadlock. Reproduce with a command that writes a large amount to stderr while producing normal stdout:

```swift
// mac/Tests/LlmIdeMacTests/MemoryStoreGitTests.swift
import XCTest
@testable import LlmIdeMacLib

final class MemoryStoreGitTests: XCTestCase {
    var repo: URL!

    override func setUp() {
        super.setUp()
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("memorystore-git-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        _ = try? runShell("/usr/bin/git", ["init", "-q"], cwd: repo)
        _ = try? runShell("/usr/bin/git", ["config", "user.email", "test@example.com"], cwd: repo)
        _ = try? runShell("/usr/bin/git", ["config", "user.name", "Test"], cwd: repo)
        try? "line1\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        _ = try? runShell("/usr/bin/git", ["add", "-A"], cwd: repo)
        _ = try? runShell("/usr/bin/git", ["commit", "-q", "-m", "init"], cwd: repo)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
        super.tearDown()
    }

    /// Fixture helper — plain synchronous Process, used only to set up the
    /// test repo (not the code under test).
    @discardableResult
    private func runShell(_ exe: String, _ args: [String], cwd: URL) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.currentDirectoryURL = cwd
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// A command that writes MORE than one pipe buffer (~64KB) to stderr
    /// while producing normal stdout — the shape that deadlocks a
    /// stdout-then-stderr sequential reader. `runGit` is private, so this
    /// goes through `gitDiff`, its one real caller inside MemoryStore.
    func testGitDiffDoesNotDeadlockOnLargeStderrOutput() throws {
        // Modify the tracked file so `git diff` has real stdout output...
        try "line1\nline2\n".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        // ...and add a git config alias that shells out to something noisy on
        // stderr for the SAME invocation is awkward via the public API, so
        // instead assert the simpler, always-true property: gitDiff completes
        // within a generous timeout at all (a deadlock hangs forever; a fixed
        // XCTestExpectation timeout turns "hangs forever" into "test fails
        // instead of the whole suite hanging").
        let store = MemoryStore()
        let exp = expectation(description: "gitDiff returns")
        var result: MemoryStore.GitDiff?
        DispatchQueue.global().async {
            result = try? store.gitDiff(at: self.repo)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 10)
        XCTAssertEqual(result?.changedPaths, ["a.txt"])
        XCTAssertTrue(result?.unified.contains("+line2") ?? false)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds and (on a toolchain that can run tests) this specific test likely *passes* even before the fix, since `git diff` here doesn't produce enough stderr to hit the deadlock window — that's expected and fine: this test's job is to pin correct behavior going forward and give the diff-draining fix a real exercise path, not to prove the old code hangs (a real deadlock reproduction would need a synthetic subprocess, which is out of scope here — the fix itself is justified by the same reasoning `RepoManager.git`'s own doc comment gives, `RepoManager.swift:440-445`).

- [ ] **Step 3: Fix `runGit`**

Replace `MemoryStore.swift:244-254`:

```swift
    private static func runGit(_ args: [String], at repo: URL) throws -> String {
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
```

with:

```swift
    /// Drains stdout and stderr CONCURRENTLY, before `waitUntilExit()`. A
    /// sequential stdout-then-stderr reader deadlocks if git writes more than
    /// one pipe buffer (~64KB) to stderr — a large-repo `git diff` doing
    /// binary/rename detection is exactly the pathological case. Mirrors
    /// `RepoManager.git`'s dual-pipe drain (`RepoManager.swift:440-458`) —
    /// same fix, smaller surface, so this stays its own small `Process` call
    /// rather than a `RepoManager` migration (see this plan's Global
    /// Constraints: `MemoryStore` must stay usable off the main actor).
    private static func runGit(_ args: [String], at repo: URL) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = args
        p.currentDirectoryURL = repo
        let stdout = Pipe(); let stderr = Pipe()
        p.standardOutput = stdout; p.standardError = stderr

        var outData = Data()
        let readGroup = DispatchGroup()
        readGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            outData = stdout.fileHandleForReading.readDataToEndOfFile()
            readGroup.leave()
        }
        readGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            _ = stderr.fileHandleForReading.readDataToEndOfFile()
            readGroup.leave()
        }

        try p.run()
        p.waitUntilExit()
        readGroup.wait()
        return String(data: outData, encoding: .utf8) ?? ""
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly; the Step 1 test still passes (result unchanged, just deadlock-safe now).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/Memory/MemoryStore.swift mac/Tests/LlmIdeMacTests/MemoryStoreGitTests.swift
git commit -m "fix(mac): MemoryStore.runGit drains stdout/stderr concurrently to avoid a pipe-buffer deadlock"
```

---

### Task 6: `GitGutter` — add the `.deleted` mark

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/GitGutter.swift`
- Test: Create `mac/Tests/LlmIdeMacTests/GitGutterTests.swift`

**Interfaces:**
- Consumes: `UnifiedDiffParser.parse(_:) -> [DiffHunk]` (existing, unchanged)
- Produces: `GitGutter.Mark` gains a third case `.deleted`; `changedLines(fromDiff:) -> [Int: Mark]` behavior extended (existing `.added`/`.modified` cases for any given diff are **unchanged** — this only adds new entries the old code produced none for)

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/GitGutterTests.swift
import XCTest
@testable import LlmIdeMacLib

final class GitGutterTests: XCTestCase {
    // MARK: - Existing behavior, pinned before extending

    func testPureInsertIsAdded() {
        let diff = """
        @@ -1,2 +1,3 @@
         line1
        +line2
         line3
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [2: .added])
    }

    func testDeleteFollowedByInsertIsModified() {
        let diff = """
        @@ -1,2 +1,2 @@
        -old
        +new
         line3
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [1: .modified])
    }

    // MARK: - New: pure deletion produces a .deleted anchor

    func testPureDeletionMidFileAnchorsAtFollowingLine() {
        let diff = """
        @@ -1,4 +1,3 @@
         line1
        -deleted
         line3
         line4
        """
        // new-side line numbers: line1=1, (deleted has none), line3=2, line4=3.
        // The deletion anchors at the line immediately after it in the NEW
        // file — line 2 (where "line3" now sits).
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [2: .deleted])
    }

    func testPureDeletionAtStartOfHunkAnchorsAtLineOne() {
        let diff = """
        @@ -1,3 +1,2 @@
        -deleted
         line2
         line3
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [1: .deleted])
    }

    func testPureDeletionAtEndOfHunkAnchorsAfterLastSurvivingLine() {
        let diff = """
        @@ -1,3 +1,2 @@
         line1
         line2
        -deleted
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [3: .deleted])
    }

    func testMultipleHunksEachTrackTheirOwnAnchor() {
        let diff = """
        @@ -1,3 +1,2 @@
         line1
        -deleted1
         line3
        @@ -10,3 +9,2 @@
         line10
        -deleted2
         line12
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [2: .deleted, 10: .deleted])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `GitGutter.Mark` has no case `.deleted` yet.

- [ ] **Step 3: Extend `GitGutter`**

Replace `GitGutter.swift` in full:

```swift
import Foundation

enum GitGutter {
    /// `: Equatable` is required (not synthesized for a plain no-raw-value
    /// enum without it) — `GitGutterTests` compares `[Int: Mark]` dictionaries
    /// via `XCTAssertEqual`, which needs `Mark: Equatable`.
    enum Mark: Equatable { case added, modified, deleted }

    /// New-side line number -> change mark, derived from a unified diff.
    ///
    /// - A run of inserts adjacent to deletes is "modified".
    /// - Pure inserts are "added".
    /// - A pure deletion (no adjacent insert) has no new-side line of its
    ///   own — VS Code and most diff UIs render it as a thin marker attached
    ///   to the line immediately after the deleted content, so that's the
    ///   anchor used here: `lastNewLine + 1`, where `lastNewLine` is the most
    ///   recent context/insert row's new-line number (0 if the deletion is
    ///   the very first row of the hunk, anchoring it at line 1).
    static func changedLines(fromDiff diff: String) -> [Int: Mark] {
        var marks: [Int: Mark] = [:]
        for hunk in UnifiedDiffParser.parse(diff) {
            var sawDeleteInRun = false
            var lastNewLine = 0
            var deleteAnchor: Int?
            for row in hunk.rows {
                switch row.kind {
                case .delete:
                    if !sawDeleteInRun { deleteAnchor = lastNewLine + 1 }
                    sawDeleteInRun = true
                case .insert:
                    if let n = row.newLine {
                        marks[n] = sawDeleteInRun ? .modified : .added
                        lastNewLine = n
                    }
                    sawDeleteInRun = false
                    deleteAnchor = nil
                case .context:
                    if sawDeleteInRun, let anchor = deleteAnchor, marks[anchor] == nil {
                        marks[anchor] = .deleted
                    }
                    sawDeleteInRun = false
                    deleteAnchor = nil
                    if let n = row.newLine { lastNewLine = n }
                }
            }
            // A deletion as the LAST row(s) of a hunk never sees a trailing
            // context/insert row to trigger the branch above.
            if sawDeleteInRun, let anchor = deleteAnchor, marks[anchor] == nil {
                marks[anchor] = .deleted
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. On a toolchain that can run tests: `swift test --filter GitGutterTests` — all 6 pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/GitGutter.swift mac/Tests/LlmIdeMacTests/GitGutterTests.swift
git commit -m "feat(mac): GitGutter marks pure deletions, not just inserts/modifications"
```

---

### Task 7: `GitTruthStore`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/GitTruthStore.swift`
- Test: Create `mac/Tests/LlmIdeMacTests/GitTruthStoreTests.swift`

**Interfaces:**
- Consumes: `RepoManager.runGit(_:at:) async throws -> String` (existing, `RepoManager.swift:390`), `StatusParser.parse(porcelain:)` (existing)
- Produces:
  ```swift
  @MainActor @Observable
  final class GitTruthStore {
      enum Decoration: Equatable { case modified, added, untracked, deleted, conflicted }
      private(set) var byPath: [String: Decoration]
      private(set) var dirsWithChanges: Set<String>
      init(repo: RepoManager = RepoManager())
      func refresh(root: URL?) async
      func decoration(forAbsolute url: URL, root: URL, isDirectory: Bool) -> Decoration?
  }
  ```
  This is a straight port of `GitStatusStore` (same names, same behavior) — Task 8 adds `lineMarks`, Task 9 adds `startWatching`/`stopWatching`. Splitting the port from the additions keeps this task's diff reviewable against the file it supersedes.

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/GitTruthStoreTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class GitTruthStoreTests: XCTestCase {
    var repo: URL!

    override func setUp() async throws {
        try await super.setUp()
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("git-truth-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try run(["init", "-q"])
        try run(["config", "user.email", "test@example.com"])
        try run(["config", "user.name", "Test"])
        try "line1\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
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

    // MARK: - The regression this store exists to fix (design doc finding #1):
    // a root with no `.git` (e.g. a container folder holding several clones)
    // must report NO decorations, never throw, never crash.

    func testRefreshOnNonGitRootProducesNoDecorations() async {
        let notARepo = FileManager.default.temporaryDirectory
            .appendingPathComponent("not-a-repo-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: notARepo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: notARepo) }

        let store = GitTruthStore()
        await store.refresh(root: notARepo)
        XCTAssertTrue(store.byPath.isEmpty)
        XCTAssertTrue(store.dirsWithChanges.isEmpty)
    }

    func testRefreshOnRealRepoPopulatesStatus() async throws {
        try "line1\nline2\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        try "new\n".write(to: repo.appendingPathComponent("added.txt"), atomically: true, encoding: .utf8)

        let store = GitTruthStore()
        await store.refresh(root: repo)

        XCTAssertEqual(store.byPath["tracked.txt"], .modified)
        XCTAssertEqual(store.byPath["added.txt"], .untracked)
    }

    func testDirsWithChangesRollsUpToEveryAncestor() async throws {
        try FileManager.default.createDirectory(
            at: repo.appendingPathComponent("a/b"), withIntermediateDirectories: true)
        try "x\n".write(to: repo.appendingPathComponent("a/b/c.txt"), atomically: true, encoding: .utf8)

        let store = GitTruthStore()
        await store.refresh(root: repo)

        XCTAssertTrue(store.dirsWithChanges.contains("a"))
        XCTAssertTrue(store.dirsWithChanges.contains("a/b"))
    }

    func testDecorationForAbsoluteResolvesRelativeToRoot() async throws {
        try "changed\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        let store = GitTruthStore()
        await store.refresh(root: repo)

        let fileURL = repo.appendingPathComponent("tracked.txt")
        XCTAssertEqual(store.decoration(forAbsolute: fileURL, root: repo, isDirectory: false), .modified)

        let outsideURL = URL(fileURLWithPath: "/tmp/unrelated.txt")
        XCTAssertNil(store.decoration(forAbsolute: outsideURL, root: repo, isDirectory: false))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `GitTruthStore` doesn't exist yet.

- [ ] **Step 3: Create `GitTruthStore.swift`**

```swift
import Foundation
import Observation

/// Repo-relative path -> effective git status, for file-tree decorations and
/// (Task 8) editor gutter marks. Supersedes `GitStatusStore` — same
/// behavior, same names, so P3's Explorer rewiring is a type swap, not a
/// rewrite. `GitStatusStore.swift` is deleted once that swap happens; it is
/// deliberately left in place (unused by anything new) until then so this
/// task doesn't break `ExplorerView`'s build.
///
/// The bug `GitStatusStore` had in practice was never in this logic — it was
/// that Explorer passed a root with no `.git` of its own (a container
/// folder holding several clones). `refresh` already degrades safely for
/// that case (empty status, no throw); the fix is entirely in what root
/// callers pass — see `WorkspaceRoot.gitWorkingTree(config:projectStore:)`,
/// which P1/P3 must use instead of a raw project/container path.
@MainActor @Observable
final class GitTruthStore {
    /// `: Equatable` (the original `GitStatusStore.Decoration` this is
    /// ported from has no test exercising `==` on it, so the gap was latent
    /// there — `GitTruthStoreTests` compares `Decoration?` via
    /// `XCTAssertEqual`, which needs it).
    enum Decoration: Equatable { case modified, added, untracked, deleted, conflicted }

    private(set) var byPath: [String: Decoration] = [:]   // repo-relative path
    private(set) var dirsWithChanges: Set<String> = []     // repo-relative dir paths
    private let repo: RepoManager

    init(repo: RepoManager = RepoManager()) {
        self.repo = repo
    }

    func refresh(root: URL?) async {
        guard let root,
              FileManager.default.fileExists(atPath: root.appendingPathComponent(".git").path) else {
            byPath = [:]; dirsWithChanges = []; return
        }
        guard let out = try? await repo.runGit(
            ["status", "--porcelain=v1", "--untracked-files=all"], at: root) else { return }
        let changes = StatusParser.parse(porcelain: out)
        var map: [String: Decoration] = [:]
        for c in changes {
            // Prefer the strongest signal if a path appears staged+unstaged.
            map[c.path] = decoration(for: c.status, existing: map[c.path])
        }
        // Roll up: every ancestor dir of a changed path is "has changes".
        var dirs = Set<String>()
        for path in map.keys {
            var comps = path.split(separator: "/").map(String.init)
            guard !comps.isEmpty else { continue }
            comps.removeLast()
            var acc = ""
            for comp in comps {
                acc = acc.isEmpty ? comp : acc + "/" + comp
                dirs.insert(acc)
            }
        }
        byPath = map; dirsWithChanges = dirs
    }

    /// Decoration for an absolute file/dir URL within `root` (nil = clean).
    func decoration(forAbsolute url: URL, root: URL, isDirectory: Bool) -> Decoration? {
        let rootPath = root.standardizedFileURL.path
        let p = url.standardizedFileURL.path
        guard p.hasPrefix(rootPath + "/") else { return nil }
        let rel = String(p.dropFirst(rootPath.count + 1))
        if isDirectory { return dirsWithChanges.contains(rel) ? .modified : nil }  // folder tint = changed
        return byPath[rel]
    }

    private func decoration(for s: FileChange.Status, existing: Decoration?) -> Decoration {
        switch s {
        case .untracked:  return existing ?? .untracked
        case .added:      return .added
        case .deleted:    return .deleted
        case .renamed:    return .modified
        case .conflicted: return .conflicted
        case .modified:   return existing == .added ? .added : .modified
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. On a toolchain that can run tests: `swift test --filter GitTruthStoreTests` — all 4 pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/GitTruthStore.swift mac/Tests/LlmIdeMacTests/GitTruthStoreTests.swift
git commit -m "feat(mac): add GitTruthStore, the git-status half of the git-truth layer"
```

---

### Task 8: `GitTruthStore.lineMarks(root:path:)`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/GitTruthStore.swift`
- Modify: `mac/Tests/LlmIdeMacTests/GitTruthStoreTests.swift`

**Interfaces:**
- Consumes: `GitGutter.changedLines(fromDiff:) -> [Int: GitGutter.Mark]` (Task 6), `self.byPath` (Task 7)
- Produces: `func lineMarks(root: URL, path: String) async -> [Int: GitGutter.Mark]`

This computes the CURRENT WORKING TREE's line marks — i.e. what the editor buffer should decorate. `git diff HEAD -- <path>` in one call already combines staged AND unstaged changes with new-line numbers relative to the current working file, so no separate staged/unstaged merge is needed. An untracked/newly-added file has no HEAD blob to diff against (`git diff HEAD` produces nothing for it), so that case is handled separately: the whole file is `.added`.

- [ ] **Step 1: Write the failing tests**

Append to `GitTruthStoreTests.swift`:

```swift
    // MARK: - lineMarks

    func testLineMarksForModifiedTrackedFile() async throws {
        try "line1\nCHANGED\nline3\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        let store = GitTruthStore()
        await store.refresh(root: repo)
        let marks = await store.lineMarks(root: repo, path: "tracked.txt")
        XCTAssertEqual(marks[2], .modified)
    }

    func testLineMarksForStagedAndUnstagedChangesBothAppear() async throws {
        // Stage one change, leave another unstaged, in the same file.
        try "STAGED\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        try run(["add", "-A"])
        try "STAGED\nUNSTAGED\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)

        let store = GitTruthStore()
        await store.refresh(root: repo)
        let marks = await store.lineMarks(root: repo, path: "tracked.txt")
        // Both lines differ from HEAD (which still has "line1"), regardless
        // of staged/unstaged — `git diff HEAD` sees the whole delta at once.
        XCTAssertEqual(marks[1], .modified)
        XCTAssertEqual(marks[2], .added)
    }

    func testLineMarksForNewUntrackedFileMarksEveryLineAdded() async throws {
        try "a\nb\nc\n".write(to: repo.appendingPathComponent("new.txt"), atomically: true, encoding: .utf8)
        let store = GitTruthStore()
        await store.refresh(root: repo)
        let marks = await store.lineMarks(root: repo, path: "new.txt")
        XCTAssertEqual(marks, [1: .added, 2: .added, 3: .added])
    }

    func testLineMarksForCleanFileIsEmpty() async throws {
        let store = GitTruthStore()
        await store.refresh(root: repo)
        let marks = await store.lineMarks(root: repo, path: "tracked.txt")
        XCTAssertTrue(marks.isEmpty)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `lineMarks` doesn't exist yet.

- [ ] **Step 3: Add `lineMarks` to `GitTruthStore`**

Append inside the `GitTruthStore` class, after `decoration(forAbsolute:root:isDirectory:)`:

```swift
    /// Working-tree line marks for one file — what the editor gutter should
    /// decorate. `git diff HEAD -- path` combines staged and unstaged changes
    /// in one call, with new-line numbers already relative to the CURRENT
    /// working file, so no separate staged/unstaged merge is needed.
    ///
    /// A file this store's own `byPath` reports as `.added`/`.untracked` has
    /// no HEAD blob — `git diff HEAD` produces nothing for it even though the
    /// whole file is new content, so that case is handled directly from the
    /// file's current contents instead of a diff.
    func lineMarks(root: URL, path: String) async -> [Int: GitGutter.Mark] {
        if byPath[path] == .added || byPath[path] == .untracked {
            guard let text = try? String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) else {
                return [:]
            }
            if text.isEmpty { return [:] }
            let lineCount = text.components(separatedBy: .newlines).count
            return Dictionary(uniqueKeysWithValues: (1...lineCount).map { ($0, GitGutter.Mark.added) })
        }
        guard let diff = try? await repo.runGit(["diff", "HEAD", "--", path], at: root), !diff.isEmpty else {
            return [:]
        }
        return GitGutter.changedLines(fromDiff: diff)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. On a toolchain that can run tests: `swift test --filter GitTruthStoreTests` — all 8 pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/GitTruthStore.swift mac/Tests/LlmIdeMacTests/GitTruthStoreTests.swift
git commit -m "feat(mac): GitTruthStore.lineMarks computes working-tree gutter marks"
```

---

### Task 9: `GitTruthStore.startWatching`/`stopWatching`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/GitTruthStore.swift`
- Modify: `mac/Tests/LlmIdeMacTests/GitTruthStoreTests.swift`

**Interfaces:**
- Consumes: `RepoFileWatcher.init?(repoRoot:debounce:onChange:)`, `.stop()` (existing, `Services/RepoFileWatcher.swift:38,98`)
- Produces: `func startWatching(root: URL)`, `func stopWatching()`

`RepoFileWatcher.onChange` fires on the watcher's own background `queue`, not the main actor — `startWatching` must hop back before touching `self` (an `@MainActor` type).

- [ ] **Step 1: Write the failing test**

Append to `GitTruthStoreTests.swift`:

```swift
    // MARK: - startWatching

    func testStartWatchingRefreshesOnFileChange() async throws {
        let store = GitTruthStore()
        await store.refresh(root: repo)
        XCTAssertTrue(store.byPath.isEmpty)

        store.startWatching(root: repo)
        defer { store.stopWatching() }

        try "changed\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)

        // FSEvents + the watcher's debounce is asynchronous and real-clock —
        // poll rather than sleep-then-assert-once, so this isn't flaky on a
        // loaded CI machine.
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline, store.byPath["tracked.txt"] != .modified {
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        XCTAssertEqual(store.byPath["tracked.txt"], .modified)
    }

    func testStopWatchingStopsFurtherRefreshes() async throws {
        let store = GitTruthStore()
        await store.refresh(root: repo)
        store.startWatching(root: repo)
        store.stopWatching()

        try "changed\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
        try await Task.sleep(nanoseconds: 3_000_000_000)   // longer than the watcher's own 2s debounce
        XCTAssertTrue(store.byPath.isEmpty, "no refresh should have happened after stopWatching")
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `startWatching`/`stopWatching` don't exist yet.

- [ ] **Step 3: Add watching to `GitTruthStore`**

Add a stored property and the two methods:

```swift
    private var watcher: RepoFileWatcher?

    /// Start live-refreshing on filesystem changes under `root`. Debounced
    /// 2s by `RepoFileWatcher`'s default — the same coalescing window
    /// `GraphAutoUpdater` already relies on. Safe to call repeatedly (e.g. on
    /// every workspace-root change): replaces any existing watcher.
    /// `RepoFileWatcher.init?` returns nil if FSEvents can't start (rare) —
    /// in that case this is a silent no-op and callers keep whatever manual
    /// refresh path they already have.
    func startWatching(root: URL) {
        stopWatching()
        watcher = RepoFileWatcher(repoRoot: root, debounce: 2.0) { [weak self] in
            // Fires on the watcher's own background queue — hop back to the
            // main actor before touching `self`.
            Task { @MainActor in
                await self?.refresh(root: root)
            }
        }
    }

    func stopWatching() {
        watcher?.stop()
        watcher = nil
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. On a toolchain that can run tests: `swift test --filter GitTruthStoreTests` — all 10 pass (the two new tests are real-clock and may take a few seconds each).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/GitTruthStore.swift mac/Tests/LlmIdeMacTests/GitTruthStoreTests.swift
git commit -m "feat(mac): GitTruthStore watches the repo for live status refresh"
```

---

### Task 10: `MonacoBridge` message types

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/MonacoBridge.swift`
- Test: Create `mac/Tests/LlmIdeMacTests/MonacoBridgeTests.swift`

**Interfaces:**
- Produces (all `Codable`):
  ```swift
  enum GutterAction: String, Codable { case stage, unstage, revert }
  enum HunkAction: String, Codable { case stage, unstage }
  struct MonacoDecoration: Codable, Equatable { let line: Int; let kind: String /* "added"|"modified"|"deleted" */ }

  enum MonacoOutboundMessage: Decodable {
      case ready
      case contentChanged(text: String)
      case requestSave
      case gutterAction(line: Int, action: GutterAction)
      case cursorMoved(line: Int, column: Int)
      case diffHunkAction(hunkId: String, action: HunkAction)
      init(from decoder: Decoder) throws
  }
  ```
  This is JS→Swift only (Swift→JS calls go directly through `MonacoHost`'s `callAsyncJavaScript` in Task 13 — they don't need a `Codable` envelope since Swift controls both the call and its arguments). `MonacoOutboundMessage` is what `MonacoHost`'s `WKScriptMessageHandler` decodes from `message.body`.

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/MonacoBridgeTests.swift
import XCTest
@testable import LlmIdeMacLib

final class MonacoBridgeTests: XCTestCase {
    private func decode(_ json: String) throws -> MonacoOutboundMessage {
        try JSONDecoder().decode(MonacoOutboundMessage.self, from: Data(json.utf8))
    }

    func testDecodesReady() throws {
        guard case .ready = try decode(#"{"type":"ready"}"#) else { return XCTFail("expected .ready") }
    }

    func testDecodesContentChanged() throws {
        guard case .contentChanged(let text) = try decode(#"{"type":"contentChanged","text":"let a = 1"}"#) else {
            return XCTFail("expected .contentChanged")
        }
        XCTAssertEqual(text, "let a = 1")
    }

    func testDecodesRequestSave() throws {
        guard case .requestSave = try decode(#"{"type":"requestSave"}"#) else { return XCTFail("expected .requestSave") }
    }

    func testDecodesGutterAction() throws {
        guard case .gutterAction(let line, let action) = try decode(#"{"type":"gutterAction","line":42,"action":"stage"}"#) else {
            return XCTFail("expected .gutterAction")
        }
        XCTAssertEqual(line, 42)
        XCTAssertEqual(action, .stage)
    }

    func testDecodesCursorMoved() throws {
        guard case .cursorMoved(let line, let column) = try decode(#"{"type":"cursorMoved","line":3,"column":7}"#) else {
            return XCTFail("expected .cursorMoved")
        }
        XCTAssertEqual(line, 3)
        XCTAssertEqual(column, 7)
    }

    func testDecodesDiffHunkAction() throws {
        guard case .diffHunkAction(let id, let action) = try decode(#"{"type":"diffHunkAction","hunkId":"h1","action":"unstage"}"#) else {
            return XCTFail("expected .diffHunkAction")
        }
        XCTAssertEqual(id, "h1")
        XCTAssertEqual(action, .unstage)
    }

    func testUnknownTypeThrows() {
        XCTAssertThrowsError(try decode(#"{"type":"bogus"}"#))
    }

    // MARK: - MonacoDecoration.decorations(from:) — the GitGutter.Mark -> wire mapping

    func testDecorationsMapsEachGitGutterMarkToItsWireKind() {
        let marks: [Int: GitGutter.Mark] = [1: .added, 2: .modified, 3: .deleted]
        let decorations = MonacoDecoration.decorations(from: marks).sorted { $0.line < $1.line }
        XCTAssertEqual(decorations, [
            MonacoDecoration(line: 1, kind: "added"),
            MonacoDecoration(line: 2, kind: "modified"),
            MonacoDecoration(line: 3, kind: "deleted"),
        ])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `MonacoOutboundMessage` doesn't exist yet.

- [ ] **Step 3: Create `MonacoBridge.swift`**

```swift
import Foundation

/// Gutter-row action offered on the plain editor's decoration hover (stage
/// this file's change / revert it) — file-level actions, since Task 8's
/// `lineMarks` are per-line but P0 has no per-hunk model in the plain editor
/// (that arrives with the diff editor in P2).
enum GutterAction: String, Codable {
    case stage, unstage, revert
}

/// Action on one hunk inside Monaco's diff editor (P2's hunk staging).
enum HunkAction: String, Codable {
    case stage, unstage
}

/// One line's decoration, as sent TO Monaco (`MonacoHost.setDecorations`,
/// Task 13) — `kind` mirrors `GitGutter.Mark`'s three cases as plain strings
/// since the wire format is JSON, not a Swift enum.
struct MonacoDecoration: Codable, Equatable {
    let line: Int
    let kind: String   // "added" | "modified" | "deleted"
}

extension MonacoDecoration {
    /// `GitGutter.Mark` -> the wire string Monaco's `bootstrap.js` switches
    /// on (Task 13's JS: `'llmide-gutter-' + d.kind`).
    static func kind(for mark: GitGutter.Mark) -> String {
        switch mark {
        case .added: return "added"
        case .modified: return "modified"
        case .deleted: return "deleted"
        }
    }

    /// `GitTruthStore.lineMarks`' output, converted to what `MonacoHost`
    /// sends across the bridge (Task 13's `setDecorations`).
    static func decorations(from marks: [Int: GitGutter.Mark]) -> [MonacoDecoration] {
        marks.map { MonacoDecoration(line: $0.key, kind: kind(for: $0.value)) }
    }
}

/// A message Monaco's bootstrap script posts to
/// `window.webkit.messageHandlers.monacoBridge`. Decoded from the message
/// body's JSON by `MonacoHost`'s `WKScriptMessageHandler` (Task 13).
enum MonacoOutboundMessage: Decodable {
    case ready
    case contentChanged(text: String)
    case requestSave
    case gutterAction(line: Int, action: GutterAction)
    case cursorMoved(line: Int, column: Int)
    case diffHunkAction(hunkId: String, action: HunkAction)

    private enum CodingKeys: String, CodingKey {
        case type, text, line, column, action, hunkId
    }

    private enum Kind: String, Decodable {
        case ready, contentChanged, requestSave, gutterAction, cursorMoved, diffHunkAction
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Kind.self, forKey: .type) {
        case .ready:
            self = .ready
        case .contentChanged:
            self = .contentChanged(text: try c.decode(String.self, forKey: .text))
        case .requestSave:
            self = .requestSave
        case .gutterAction:
            self = .gutterAction(line: try c.decode(Int.self, forKey: .line),
                                 action: try c.decode(GutterAction.self, forKey: .action))
        case .cursorMoved:
            self = .cursorMoved(line: try c.decode(Int.self, forKey: .line),
                                column: try c.decode(Int.self, forKey: .column))
        case .diffHunkAction:
            self = .diffHunkAction(hunkId: try c.decode(String.self, forKey: .hunkId),
                                   action: try c.decode(HunkAction.self, forKey: .action))
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. On a toolchain that can run tests: `swift test --filter MonacoBridgeTests` — all 7 pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/MonacoBridge.swift mac/Tests/LlmIdeMacTests/MonacoBridgeTests.swift
git commit -m "feat(mac): add MonacoBridge JS->Swift message types"
```

---

### Task 11: Vendor the Monaco bundle

**Files:**
- Create: `mac/Scripts/build-monaco-bundle.mjs`
- Create: `mac/Sources/LlmIdeMac/Resources/monaco-src/index.html`
- Create: `mac/Sources/LlmIdeMac/Resources/monaco-src/bootstrap.js`
- Generate (by running the script): `mac/Sources/LlmIdeMac/Resources/monaco/` (committed output)
- Modify: `mac/Package.swift` (resource entry)

**Interfaces:**
- Produces: a loadable `mac/Sources/LlmIdeMac/Resources/monaco/index.html` that, opened via `WKWebView.loadFileURL`, boots Monaco and exposes `window.__llmide.*` (consumed by `MonacoHost` in Tasks 12-13).

This task has a real external-network step (`npm install`) — verify connectivity before writing code, and note the fallback if this environment can't reach the npm registry.

- [ ] **Step 1: Verify npm registry reachability**

Run: `npm view monaco-editor version`

If this fails with a network error: this task's script (Step 2) still gets written and committed, but the actual bundle generation (Step 4) must happen on a machine with network access — `npm install` there, run the script, then commit the resulting `Resources/monaco/` from that machine. State this explicitly rather than fabricating a bundle. If it succeeds, continue normally.

- [ ] **Step 2: Write the hand-authored bootstrap files**

`mac/Sources/LlmIdeMac/Resources/monaco-src/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body, #container, #diff-container { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
  #diff-container { display: none; }
</style>
</head>
<body>
<div id="container"></div>
<div id="diff-container"></div>
<script src="vs/loader.js"></script>
<script src="bootstrap.js"></script>
</body>
</html>
```

`mac/Sources/LlmIdeMac/Resources/monaco-src/bootstrap.js`:

```javascript
// Wires Monaco to the Swift MonacoBridge (see MonacoBridge.swift for the
// message shapes) and exposes window.__llmide as the ONLY surface
// MonacoHost's Swift code calls into via callAsyncJavaScript. Kept as a
// hand-authored source file (copied verbatim by build-monaco-bundle.mjs,
// never minified/regenerated) so it stays readable and diffable.
(function () {
  'use strict';

  function post(message) {
    try {
      window.webkit.messageHandlers.monacoBridge.postMessage(message);
    } catch (e) {
      // No bridge (e.g. loaded outside a WKWebView while iterating on this
      // file locally) — degrade to a no-op rather than throwing.
    }
  }

  require.config({ paths: { vs: './vs' } });

  window.__llmide = {
    editor: null,
    diffEditor: null,
    decorationIds: [],

    setContent: function (text, language) {
      var container = document.getElementById('container');
      container.style.display = 'block';
      document.getElementById('diff-container').style.display = 'none';
      if (this.diffEditor) { this.diffEditor.dispose(); this.diffEditor = null; }
      if (this.editor) {
        var model = this.editor.getModel();
        monaco.editor.setModelLanguage(model, language);
        model.setValue(text);
      } else {
        this.editor = monaco.editor.create(container, {
          value: text,
          language: language,
          automaticLayout: true,
          minimap: { enabled: true },
        });
        this.editor.onDidChangeModelContent(function () {
          post({ type: 'contentChanged', text: window.__llmide.editor.getValue() });
        });
        this.editor.onDidChangeCursorPosition(function (e) {
          post({ type: 'cursorMoved', line: e.position.lineNumber, column: e.position.column });
        });
        this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
          post({ type: 'requestSave' });
        });
        this.editor.onMouseDown(function (e) {
          if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
              && e.target.position) {
            post({ type: 'gutterAction', line: e.target.position.lineNumber, action: 'stage' });
          }
        });
      }
    },

    setDecorations: function (decorations) {
      if (!this.editor) return;
      var monacoDecorations = decorations.map(function (d) {
        var cls = 'llmide-gutter-' + d.kind;
        return {
          range: new monaco.Range(d.line, 1, d.line, 1),
          options: { isWholeLine: false, linesDecorationsClassName: cls },
        };
      });
      this.decorationIds = this.editor.deltaDecorations(this.decorationIds, monacoDecorations);
    },

    setTheme: function (themeJSON) {
      var theme = JSON.parse(themeJSON);
      monaco.editor.defineTheme('llmide', theme);
      monaco.editor.setTheme('llmide');
    },

    reveal: function (line) {
      if (this.editor) this.editor.revealLineInCenter(line);
    },

    showDiff: function (original, modified, language) {
      var diffContainer = document.getElementById('diff-container');
      document.getElementById('container').style.display = 'none';
      diffContainer.style.display = 'block';
      if (!this.diffEditor) {
        this.diffEditor = monaco.editor.createDiffEditor(diffContainer, { automaticLayout: true });
      }
      var originalModel = monaco.editor.createModel(original, language);
      var modifiedModel = monaco.editor.createModel(modified, language);
      this.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    },

    setReadOnly: function (readOnly) {
      if (this.editor) this.editor.updateOptions({ readOnly: readOnly });
    },
  };

  require(['vs/editor/editor.main'], function () {
    post({ type: 'ready' });
  });
})();
```

- [ ] **Step 3: Write the build script**

`mac/Scripts/build-monaco-bundle.mjs`:

```javascript
#!/usr/bin/env node
// Vendors a MINIMAL Monaco Editor build into
// Sources/LlmIdeMac/Resources/monaco/ — the loader + core editor, plus
// Monarch tokenizers (basic-languages/) for ONLY the languages this repo
// actually uses. Deliberately skips monaco-editor's `language/` folder
// entirely (the heavier JSON/TypeScript/CSS/HTML "language service" mode
// files, including their web-worker IntelliSense backends) — this app wants
// syntax highlighting, not IntelliSense, and the basic-languages Monarch
// tokenizers cover every one of these languages on their own.
//
// Usage: cd mac && npm install monaco-editor@<version> --no-save && node Scripts/build-monaco-bundle.mjs

import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const macRoot = path.resolve(__dirname, '..');
const monacoPkg = path.join(macRoot, 'node_modules', 'monaco-editor');
const srcVs = path.join(monacoPkg, 'min', 'vs');
const outDir = path.join(macRoot, 'Sources', 'LlmIdeMac', 'Resources', 'monaco');
const outVs = path.join(outDir, 'vs');
const monacoSrc = path.join(macRoot, 'Sources', 'LlmIdeMac', 'Resources', 'monaco-src');

// The 12 languages this repo's files actually use (verified against
// `git ls-files` extension counts in the design doc) — see design §4.
const LANGUAGES = [
  'markdown', 'javascript', 'typescript', 'json', 'sql',
  'python', 'shell', 'yaml', 'html', 'css', 'swift',
];

function must(condition, message) {
  if (!condition) {
    console.error(`build-monaco-bundle: ${message}`);
    process.exit(1);
  }
}

must(existsSync(srcVs),
  `${srcVs} not found — run "npm install monaco-editor --no-save" in mac/ first`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outVs, { recursive: true });

// Core: loader + editor engine (works as a plain-text editor with zero
// language files; language files below are purely additive highlighting).
cpSync(path.join(srcVs, 'loader.js'), path.join(outVs, 'loader.js'));
cpSync(path.join(srcVs, 'editor'), path.join(outVs, 'editor'), { recursive: true });
cpSync(path.join(srcVs, 'base'), path.join(outVs, 'base'), { recursive: true });

// Per-language Monarch tokenizers only — never the `language/` folder.
const basicLanguagesDir = path.join(srcVs, 'basic-languages');
mkdirSync(path.join(outVs, 'basic-languages'), { recursive: true });
for (const lang of LANGUAGES) {
  const from = path.join(basicLanguagesDir, lang);
  must(existsSync(from),
    `expected basic-languages/${lang} in the installed monaco-editor package but it's missing — ` +
    `check the language id against monaco-editor's actual basic-languages/ directory listing`);
  cpSync(from, path.join(outVs, 'basic-languages', lang), { recursive: true });
}

// The hand-authored shell + bridge script, copied verbatim (never
// minified/regenerated) so they stay readable and diffable in source form.
cpSync(path.join(monacoSrc, 'index.html'), path.join(outDir, 'index.html'));
cpSync(path.join(monacoSrc, 'bootstrap.js'), path.join(outDir, 'bootstrap.js'));

console.log(`build-monaco-bundle: wrote ${outDir}`);
```

- [ ] **Step 4: Run the build**

Run:
```bash
cd mac
npm install monaco-editor --no-save
node Scripts/build-monaco-bundle.mjs
```
Expected: `build-monaco-bundle: wrote .../Resources/monaco`, and `du -sh Sources/LlmIdeMac/Resources/monaco` reports roughly 1.5-3MB (design target: ~2MB). If any `LANGUAGES` entry fails the `must(existsSync(...))` check, the script prints exactly which language id doesn't match monaco-editor's actual directory name — fix the id in `LANGUAGES` (e.g. `"js"` → `"javascript"`) and rerun; do not delete a language from the list to work around a naming mismatch without confirming the language truly has no basic-language tokenizer.

- [ ] **Step 5: Register the resource in `Package.swift`**

In `mac/Package.swift`, add to the `resources:` array (after `.copy("Resources/source_connectors")`, `Package.swift:253`):

```swift
                // Vendored Monaco editor (offline, no CDN — same policy as
                // highlight.min.js above). Generated by
                // Scripts/build-monaco-bundle.mjs from monaco-editor's
                // prebuilt files; do not hand-edit anything under
                // Resources/monaco/ except by re-running that script — edit
                // Resources/monaco-src/ instead for the hand-authored parts.
                .copy("Resources/monaco"),
```

- [ ] **Step 6: Run full build to verify the package resolves**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 7: Commit**

```bash
git add mac/Scripts/build-monaco-bundle.mjs mac/Sources/LlmIdeMac/Resources/monaco-src mac/Sources/LlmIdeMac/Resources/monaco mac/Package.swift
git commit -m "feat(mac): vendor a minimal, 12-language Monaco Editor build"
```

---

### Task 12: `MonacoHost` — declarative shell + resource resolution

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shared/MonacoHost.swift`
- Test: Create `mac/Tests/LlmIdeMacTests/MonacoHostHTMLTests.swift`

**Interfaces:**
- Consumes: `Bundle(for:)`/`Bundle(url:)` resource lookup — **not** `Bundle.main.url(...)` alone (see Step 3's rationale: that alone is what `Hljs.bundled` does, and it is known to silently fail under `swift test`) and **never** `Bundle.module` (traps). Mirrors `SourceConnectorManifest.bundledResourceDirectories()` (`Sources/LlmIdeMac/SourceConnectors/SourceConnectorManifest.swift:158-187`) — read that function and its doc comment (lines 110-132) before writing Step 3.
- Produces (the FULL public surface — a caller only ever sets these properties, exactly like `SelfSizingMarkdownView(markdown:isDark:onHeight:)`; it never reaches into `Coordinator`):
  ```swift
  struct MonacoHost: NSViewRepresentable {
      var content: String?
      var language: String = "plaintext"
      var decorations: [Int: GitGutter.Mark] = [:]
      var theme: Theme
      var revealRequest: MonacoRevealRequest?
      var diffRequest: MonacoDiffRequest?
      var readOnly: Bool = false
      var onReady: (() -> Void)?
      var onMessage: ((MonacoOutboundMessage) -> Void)?
  }
  struct MonacoRevealRequest: Equatable { let line: Int; let id: UUID }
  struct MonacoDiffRequest: Equatable { let original: String; let modified: String; let language: String }
  ```
  This task builds the shell, the declarative diffing skeleton (`Coordinator.sync`/`applyPendingChanges`), and resource resolution, with the actual bridge calls (`setContent`/`setDecorations`/`setTheme`/`reveal`/`showDiff`/`setReadOnly`) stubbed as no-ops — Task 13 fills those in. Splitting it this way keeps this task's own tests (resource resolution) independent of whether the bridge calls are implemented yet, while still leaving the file in a compiling, working state at the end of this task.
  
  **Why declarative, not an externally-held coordinator reference:** SwiftUI does not hand a `NSViewRepresentable`'s coordinator to code outside the view — `Context.coordinator` is only reachable from inside `makeNSView`/`updateNSView` themselves. The correct way for a parent view to drive Monaco imperatively (reveal a line, show a diff, change the theme) is the same pattern `SelfSizingMarkdownView` already uses: pass the DESIRED STATE as plain properties, and let `updateNSView` diff against what was last actually sent (tracked on the coordinator, mirroring `SelfSizingMarkdownView.Coordinator`'s `lastMarkdown`/`lastDark`) and call the bridge only for what changed. `revealRequest`/`diffRequest` carry a fresh identity (`MonacoRevealRequest`'s `id`, `MonacoDiffRequest`'s full value) precisely so re-requesting the same line/diff twice in a row still fires — a bare `Int` would look unchanged the second time.

- [ ] **Step 1: Write the failing test**

Since there's no live-WebView test harness in this codebase (confirmed precedent: `CodeWebViewGutterTests.swift` tests `CodeWebView.html()`'s STRING output, never a running `WKWebView`), this task's tests exercise the pure "which local file does the host load" logic, not live rendering:

```swift
// mac/Tests/LlmIdeMacTests/MonacoHostHTMLTests.swift
import XCTest
@testable import LlmIdeMacLib

final class MonacoHostHTMLTests: XCTestCase {
    func testMonacoIndexHTMLIsBundled() throws {
        // Unlike Hljs.bundled (Bundle.main only — silently empty under
        // `swift test`, see SourceConnectorManifestTests.swift's comment),
        // MonacoHost.indexURL() must resolve here too: it also checks the
        // SwiftPM resource bundle by URL, the same way
        // SourceConnectorManifest.bundledResourceDirectories() does.
        let url = MonacoHost.indexURL()
        XCTAssertNotNil(url, "Resources/monaco/index.html must be bundled — did Task 11's Package.swift edit land?")
    }

    func testMonacoDirectoryContainsTheLoader() throws {
        guard let indexURL = MonacoHost.indexURL() else {
            return XCTFail("index.html not found")
        }
        let vsLoader = indexURL.deletingLastPathComponent().appendingPathComponent("vs/loader.js")
        XCTAssertTrue(FileManager.default.fileExists(atPath: vsLoader.path),
                      "vs/loader.js must sit alongside index.html for the relative <script src> to resolve")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `MonacoHost` doesn't exist yet.

- [ ] **Step 3: Create `MonacoHost.swift`**

```swift
import SwiftUI
import WebKit

/// One request to scroll the plain editor to a line. Carries an `id` (not
/// just the line number) so setting `revealRequest` to the SAME line twice
/// in a row — e.g. clicking the same search result again — still triggers a
/// fresh call: a bare `Int` would look unchanged to `Coordinator.sync`'s
/// diff the second time.
struct MonacoRevealRequest: Equatable {
    let line: Int
    let id = UUID()
}

/// One request to show Monaco's diff editor instead of the plain editor.
/// Equatable on its full value (not an id) — showing the identical diff
/// twice is a legitimate no-op, unlike `MonacoRevealRequest`.
struct MonacoDiffRequest: Equatable {
    let original: String
    let modified: String
    let language: String
}

/// Hosts the vendored Monaco editor in a `WKWebView`, loaded ONCE via
/// `loadFileURL` (Monaco is a multi-file asset tree — `loader.js` fetches
/// sibling files by relative path, which `loadHTMLString`'s `baseURL: nil`
/// cannot resolve; `HljsWebView`'s single-inlined-string approach doesn't
/// apply here).
///
/// Purely declarative from the caller's side, exactly like
/// `SelfSizingMarkdownView(markdown:isDark:onHeight:)`: set `content`/
/// `decorations`/`theme`/etc. and SwiftUI's normal re-render cycle applies
/// the change. `Coordinator.sync` diffs each property against what was last
/// actually SENT to Monaco (mirroring `SelfSizingMarkdownView.Coordinator`'s
/// `lastMarkdown`/`lastDark`) and calls only the bridge method for what
/// changed — never a page reload. The bridge methods themselves
/// (`setContent`/`setDecorations`/etc., Task 13) are `private` on
/// `Coordinator`: nothing outside this file calls them directly.
struct MonacoHost: NSViewRepresentable {
    var content: String?
    var language: String = "plaintext"
    var decorations: [Int: GitGutter.Mark] = [:]
    var theme: Theme
    var revealRequest: MonacoRevealRequest?
    var diffRequest: MonacoDiffRequest?
    var readOnly: Bool = false
    /// Fired once, when Monaco has finished loading and `window.__llmide` is
    /// ready to receive calls (mirrors `SelfSizingMarkdownView`'s
    /// `documentReady` gate).
    var onReady: (() -> Void)?
    /// Fired for every message Monaco's bootstrap script posts.
    var onMessage: ((MonacoOutboundMessage) -> Void)?

    /// `Resources/monaco/index.html`, resolved across BOTH places it can
    /// live — mirrors `SourceConnectorManifest.bundledResourceDirectories()`
    /// (`SourceConnectorManifest.swift:158-187`) exactly, because a plain
    /// `Bundle.main.url(...)` (what `Hljs.bundled` does) is confirmed to
    /// silently fail under `swift test` — see that file's doc comment
    /// (lines 110-132) for the full reasoning:
    ///   * Shipped app — `Scripts/build.sh` rsyncs `Resources/` into
    ///     `Contents/Resources/`, so `Bundle.main` finds it directly.
    ///   * `swift test` — `Bundle.main` is the xctest runner and finds
    ///     nothing; the SwiftPM resource bundle
    ///     (`LlmIdeMac_LlmIdeMacLib.bundle`) sits next to the test bundle
    ///     instead, opened here by URL (`Bundle(url:)` returns nil rather
    ///     than trapping, unlike the generated `Bundle.module` accessor —
    ///     never reference `Bundle.module` in this file).
    static func indexURL() -> URL? {
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "monaco") {
            return url
        }
        let bundleName = "LlmIdeMac_LlmIdeMacLib.bundle"
        let owning = Bundle(for: MonacoBundleLocator.self)
        var roots: [URL] = []
        for base in [owning.bundleURL, Bundle.main.bundleURL] {
            roots.append(base)
            roots.append(base.deletingLastPathComponent())
        }
        if let r = owning.resourceURL { roots.append(r) }
        if let r = Bundle.main.resourceURL { roots.append(r) }
        for root in roots {
            guard let bundle = Bundle(url: root.appendingPathComponent(bundleName)) else { continue }
            if let url = bundle.url(forResource: "index", withExtension: "html", subdirectory: "monaco") {
                return url
            }
        }
        return nil
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "monacoBridge")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.setValue(false, forKey: "drawsBackground")
        context.coordinator.webView = web
        if let indexURL = Self.indexURL() {
            web.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.sync(self)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        fileprivate var webView: WKWebView?
        private var parent: MonacoHost
        /// Monaco's bootstrap script has posted "ready" — before this, every
        /// bridge call would hit an undefined `window.__llmide`, so
        /// `applyPendingChanges` is skipped and re-run once `didReceive`
        /// sees `.ready` (picking up whatever `parent` was last set to).
        private var documentReady = false
        private var lastContent: String?
        private var lastDecorations: [Int: GitGutter.Mark] = [:]
        private var lastTheme: Theme?
        private var lastRevealRequestId: UUID?
        private var lastDiffRequest: MonacoDiffRequest?
        private var lastReadOnly = false

        init(_ parent: MonacoHost) { self.parent = parent }

        /// Called from `updateNSView` on every SwiftUI re-render.
        func sync(_ newParent: MonacoHost) {
            parent = newParent
            applyPendingChanges()
        }

        private func applyPendingChanges() {
            guard documentReady else { return }
            if let content = parent.content, content != lastContent {
                setContent(content, language: parent.language)
                lastContent = content
            }
            if parent.decorations != lastDecorations {
                setDecorations(parent.decorations)
                lastDecorations = parent.decorations
            }
            if parent.theme != lastTheme {
                setTheme(parent.theme)
                lastTheme = parent.theme
            }
            if let request = parent.revealRequest, request.id != lastRevealRequestId {
                reveal(line: request.line)
                lastRevealRequestId = request.id
            }
            if let diff = parent.diffRequest, diff != lastDiffRequest {
                showDiff(original: diff.original, modified: diff.modified, language: diff.language)
                lastDiffRequest = diff
            }
            if parent.readOnly != lastReadOnly {
                setReadOnly(parent.readOnly)
                lastReadOnly = parent.readOnly
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Monaco's own `require(['vs/editor/editor.main'], ...)` callback
            // posts the "ready" message once the editor module has actually
            // loaded — `didFinish` only means the HTML document loaded, which
            // is earlier. `documentReady` flips on that "ready" message in
            // `userContentController` below, not here.
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let dict = message.body as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: dict),
                  let decoded = try? JSONDecoder().decode(MonacoOutboundMessage.self, from: data) else {
                return
            }
            if case .ready = decoded {
                documentReady = true
                applyPendingChanges()   // apply whatever `parent` already held before load finished
                parent.onReady?()
            }
            parent.onMessage?(decoded)
        }

        // MARK: - Bridge calls (Task 13)
        //
        // Private: `applyPendingChanges` above is their only caller.
        // `MonacoHost`'s declarative properties are the public surface, not
        // these methods. Stubbed as no-ops here so this task's own tests
        // (resource resolution) don't depend on Task 13 landing first; Task
        // 13 replaces every body with a real `callAsyncJavaScript` call.

        private func setContent(_ text: String, language: String) {}
        private func setDecorations(_ marks: [Int: GitGutter.Mark]) {}
        private func setTheme(_ theme: Theme) {}
        private func reveal(line: Int) {}
        private func showDiff(original: String, modified: String, language: String) {}
        private func setReadOnly(_ readOnly: Bool) {}
    }
}

/// Anchor used only with `Bundle(for:)` to find the image `MonacoHost` was
/// loaded from. Deliberately not `Bundle.module` — see `indexURL()`'s doc
/// comment and `SourceConnectorManifest.swift`'s `BundleLocator`, which this
/// mirrors.
private final class MonacoBundleLocator {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. On a toolchain that can run tests: `swift test --filter MonacoHostHTMLTests` — both pass (given Task 11 landed).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shared/MonacoHost.swift mac/Tests/LlmIdeMacTests/MonacoHostHTMLTests.swift
git commit -m "feat(mac): add MonacoHost, the declarative WKWebView shell for the vendored Monaco bundle"
```

---

### Task 13: `MonacoHost` bridge methods

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Shared/MonacoHost.swift`

**Interfaces:**
- Produces (on `MonacoHost.Coordinator`, `private` — called only from `applyPendingChanges`, never externally; see Task 12's rationale):
  ```swift
  private func setContent(_ text: String, language: String)
  private func setDecorations(_ marks: [Int: GitGutter.Mark])
  private func setTheme(_ theme: Theme)
  private func reveal(line: Int)
  private func showDiff(original: String, modified: String, language: String)
  private func setReadOnly(_ readOnly: Bool)
  ```
- Consumes: `GitGutter.Mark` (Task 6), `Theme.monacoThemeJSON()` (Task 3), `MonacoBridge`'s `MonacoDecoration.decorations(from:)` (Task 10)

These are genuinely untestable without a live WebView (they call `callAsyncJavaScript`) — no test is written for this task; correctness is verified manually once P1 wires a real caller (per this plan's Global Constraints and the design's §9 testing strategy, which reserves live-WebView behavior for manual per-phase verification).

- [ ] **Step 1: Replace the six stub bodies in `Coordinator`**

In `MonacoHost.swift`, replace the six no-op methods added at the end of Task 12's `Coordinator` (under `// MARK: - Bridge calls (Task 13)`):

```swift
        private func setContent(_ text: String, language: String) {
            webView?.callAsyncJavaScript(
                "window.__llmide.setContent(text, language);",
                arguments: ["text": text, "language": language],
                in: nil, in: .page, completionHandler: nil)
        }

        private func setDecorations(_ marks: [Int: GitGutter.Mark]) {
            // MonacoDecoration.decorations(from:) does the typed, tested
            // Mark -> wire-kind mapping (Task 10); this just reshapes that
            // into the plist-compatible [String: Any] array
            // callAsyncJavaScript's `arguments` requires (a custom Codable
            // struct can't cross that boundary directly).
            let decorations = MonacoDecoration.decorations(from: marks).map {
                ["line": $0.line, "kind": $0.kind] as [String: Any]
            }
            webView?.callAsyncJavaScript(
                "window.__llmide.setDecorations(decorations);",
                arguments: ["decorations": decorations],
                in: nil, in: .page, completionHandler: nil)
        }

        private func setTheme(_ theme: Theme) {
            webView?.callAsyncJavaScript(
                "window.__llmide.setTheme(themeJSON);",
                arguments: ["themeJSON": theme.monacoThemeJSON()],
                in: nil, in: .page, completionHandler: nil)
        }

        private func reveal(line: Int) {
            webView?.callAsyncJavaScript(
                "window.__llmide.reveal(line);",
                arguments: ["line": line],
                in: nil, in: .page, completionHandler: nil)
        }

        private func showDiff(original: String, modified: String, language: String) {
            webView?.callAsyncJavaScript(
                "window.__llmide.showDiff(original, modified, language);",
                arguments: ["original": original, "modified": modified, "language": language],
                in: nil, in: .page, completionHandler: nil)
        }

        private func setReadOnly(_ readOnly: Bool) {
            webView?.callAsyncJavaScript(
                "window.__llmide.setReadOnly(readOnly);",
                arguments: ["readOnly": readOnly],
                in: nil, in: .page, completionHandler: nil)
        }
```

- [ ] **Step 2: Run full build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shared/MonacoHost.swift
git commit -m "feat(mac): MonacoHost bridge methods (setContent/setDecorations/setTheme/reveal/showDiff/setReadOnly)"
```

---

## End-of-phase verification

- [ ] Run the full test suite: `cd mac && swift build --build-tests 2>&1 | tail -40` (compiles everything written above). If a full Xcode toolchain is available, also run `swift test 2>&1 | tail -60` and confirm every test from Tasks 1-10, 12 passes (Task 13 has no automated test — see that task's note).
- [ ] Run `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -5` and confirm `Build complete!` with no new warnings in the files this plan touched.
- [ ] Confirm `du -sh mac/Sources/LlmIdeMac/Resources/monaco` is in the 1.5-3MB range (design target ~2MB) — if it's much larger, a `language/*` folder or an unused `basic-languages` entry likely slipped in; check `build-monaco-bundle.mjs`'s copy list.
- [ ] `git log --oneline -13` shows one commit per task, in order.
- [ ] Confirm `GitStatusStore.swift` still exists and is unmodified (P3 deletes it, not this phase) and `ExplorerView.swift` was not touched by this plan.

## What P1 inherits

- `GitTruthStore` — ready to replace `GitStatusStore` wherever a caller is updated to pass the correct root (P1's editor gutter is that first real caller; P3 does the same for Explorer).
- `MonacoHost` — ready to host a real editor. It is fully declarative (`content`/`decorations`/`theme`/`revealRequest`/`diffRequest`/`readOnly`, §Task 12) — P1's job is designing the owning SwiftUI view (replacing `FileDetailView`'s `TextEditor`) that computes those property values from its own state (the open file's text, `GitTruthStore.lineMarks(root:path:)`'s output, the active `Theme`) and passes them straight into a `MonacoHost(...)` — no coordinator plumbing needed, the same way a caller uses `SelfSizingMarkdownView`.
- `Theme.monacoThemeJSON()` — already wired: `MonacoHost.Coordinator` calls it internally whenever the `theme` property changes. P1 never calls it directly.
