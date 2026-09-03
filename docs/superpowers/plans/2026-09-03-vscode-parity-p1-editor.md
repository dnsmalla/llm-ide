# VS Code Parity P1: Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `FileDetailView`'s plain `TextEditor` (no gutter, no line numbers, no highlighting) and the read-only `CodeWebView` (highlight.js, hand-rolled CSS grid alignment) with a single new `MonacoEditorView`, built on P0's `MonacoHost`/`GitTruthStore`. This is the direct fix for "editing code shows no git change colors, no line numbers, no syntax highlighting" (design §3 finding #6) and retires one of the five duplicate diff/render implementations (design §3 finding #2 — `CodeWebView` specifically; the other four are P2's job).

**Architecture:** `MonacoEditorView` is the "owning view" P0's `MonacoHost` doc comment anticipated: it computes `content`/`language`/`decorations`/`revealRequest`/`readOnly` from its own state (a content binding, `GitTruthStore.lineMarks`, the active `Theme`, an optional reveal line) and passes them straight into a declarative `MonacoHost(...)`, mirroring how callers already use `SelfSizingMarkdownView`. It owns a message-handling core (pure, testable) that turns a `MonacoOutboundMessage` into a state update, and a 2-second `onReady` timeout (design §8) that falls back to the existing plain `TextEditor` if Monaco never signals ready — the current implementation becomes the safety net, not a component to delete.

**Tech Stack:** Swift 5 (macOS 14+ target), SwiftUI, WebKit (already wrapped by P0's `MonacoHost`), XCTest (this codebase's convention for non-WebView-dependent logic).

**Spec:** [docs/superpowers/specs/2026-09-03-vscode-parity-explorer-scm-search-design.md](../specs/2026-09-03-vscode-parity-explorer-scm-search-design.md) — read §5 (responsibility split), §6.1–6.2 (`GitTruthStore`, `MonacoHost` — both already built in P0), §7 (data flow), §8 (error handling — the load-failure fallback this plan implements), §11 P1 bullet, §12 (this plan makes the file-level calls the design explicitly deferred).

**Prior phase:** [docs/superpowers/plans/2026-09-03-vscode-parity-p0-foundation.md](2026-09-03-vscode-parity-p0-foundation.md) — P0 is merged to `main` (commit `63f23cca`). Everything this plan calls "existing" below is real, reviewed code already on `main`: `GitTruthStore` (`Services/GitTruthStore.swift`), `MonacoHost`/`MonacoRevealRequest`/`MonacoDiffRequest` (`Views/Shared/MonacoHost.swift`), `MonacoBridge` types (`Services/MonacoBridge.swift`), `GitGutter.Mark` with its `.deleted` case (`Services/GitGutter.swift`), and the `Theme` diff/git/editor tokens + `monacoTheme()`/`monacoThemeJSON()` (`Models/Theme.swift`).

## Global Constraints

- Swift 6 language mode is NOT enabled (`swiftLanguageModes: [.v5]` in `Package.swift`) — do not add strict-concurrency-only syntax.
- No raw `Color.green`/`.red`/`.orange` in new or touched view code — always a `Theme` token (existing project rule, `Theme.swift:88-91`).
- `MonacoHost`'s six bridge methods stay `private` on its `Coordinator` — nothing in this plan reaches into `Coordinator`. Every interaction with Monaco goes through `MonacoHost`'s declarative properties (`content`/`decorations`/`theme`/`revealRequest`/`diffRequest`/`readOnly`/`onReady`/`onMessage`), exactly as its own doc comment requires.
- `MonacoRevealRequest` MUST be held in `@State` and constructed only in response to a real reveal intent — never inline in a view's `body` (its own doc comment explains why: a fresh `UUID()` on every construction means inline construction re-fires `reveal` on every SwiftUI re-render). Every task below that creates one follows this.
- This toolchain (Xcode Command Line Tools only, no full Xcode) cannot run `swift test` (no XCTest/Testing runtime — see memory `mac-build-environment`). Every task's "run the test" step still means literally running the command; if it fails with `no such module 'XCTest'`, treat that as an environment limitation, not a task failure, and confirm via `swift build` (compiles, which this toolchain CAN do) instead. State this explicitly when it happens — do not claim the test passed.
- Per design §9: `MonacoEditorView` itself (SwiftUI view + WebView glue) has no live-WebView test harness in this codebase — the same limitation P0's `MonacoHost`/`Coordinator` bridge methods had (see P0 Task 13's note). Tasks that touch pure, extractable logic (language mapping, message-to-state-update decisions) get real tests; tasks that are pure SwiftUI wiring are verified by compile + the end-of-phase manual checklist.

---

## File Structure

**New files:**
- `mac/Sources/LlmIdeMac/Views/Shared/MonacoLanguageMap.swift` — file extension → Monaco language id (mirrors `HljsLanguageMap.swift`, scoped to the 10 languages P0 actually vendored)
- `mac/Sources/LlmIdeMac/Views/Shared/MonacoEditorView.swift` — the new owning view: `MonacoEditorView` (SwiftUI view) + `MonacoEditorMessageHandler` (pure, testable message-to-state-update core)
- `mac/Tests/LlmIdeMacTests/MonacoLanguageMapTests.swift`
- `mac/Tests/LlmIdeMacTests/MonacoEditorMessageHandlerTests.swift`

**Modified files:**
- `mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift` — `FileDetailView` gains `initialLine: Int?`; `EditableTextDetailView` gains `language`/`decorations`/`initialLine` and its `editor` computed property becomes `MonacoEditorView` instead of `TextEditor`; `CodeDetailView`'s gutter computation switches to `GitTruthStore`, its preview closure becomes `MonacoEditorView(readOnly: true, ...)`, and `CodeWebView` is deleted from this file; `MarkdownDetailView` passes `language: "markdown"`
- `mac/Sources/LlmIdeMac/Views/Shared/HljsLanguageMap.swift` — doc comment: drop the now-stale `CodeWebView` mention (still used by `DiffWebView`)
- `mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift` — doc comments: drop the now-stale `CodeWebView` cross-references (two comment lines only, no code change)

**Deleted:**
- `CodeWebView` struct and its `html()` method (currently `FileDetailView.swift:479-645`) — the read-only, highlight.js-based code preview. Fully superseded by `MonacoEditorView(readOnly: true)`. Confirmed (before writing this plan) that nothing outside `FileDetailView.swift` references `CodeWebView` except two doc-comment mentions in `HljsLanguageMap.swift` and `UnifiedDiffView.swift` (updated above, not code dependencies).
- `mac/Tests/LlmIdeMacTests/CodeWebViewGutterTests.swift` — tests `CodeWebView.html()`'s CSS output directly; its entire subject is deleted by this plan, so the file has nothing left to test. The alignment properties it guarded (row height, gutter/code sync) are Monaco's own responsibility now, not hand-rolled CSS.

---

### Task 1: `MonacoLanguageMap` — file extension → Monaco language id

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shared/MonacoLanguageMap.swift`
- Test: Create `mac/Tests/LlmIdeMacTests/MonacoLanguageMapTests.swift`

**Interfaces:**
- Produces: `MonacoLanguageMap.id(for extension: String) -> String`

This is a NEW, separate map from `HljsLanguageMap` (`Views/Shared/HljsLanguageMap.swift`) — do not modify or reuse that file. `HljsLanguageMap` targets highlight.js's language set (which includes `json`, `ruby`, `go`, `rust`, etc. — languages hljs supports but this app's vendored Monaco bundle does not). P0 vendored exactly 10 Monaco `basic-languages` tokenizers: `markdown`, `javascript`, `typescript`, `python`, `sql`, `shell`, `yaml`, `html`, `css`, `swift` (confirmed against the actual installed `monaco-editor@0.50.0` package during P0 — `json` was deliberately excluded, since Monaco has never shipped a standalone Monarch tokenizer for it). Any extension not in this list must fall back to `"plaintext"` — Monaco's core editor handles plain text with zero language files, per `build-monaco-bundle.mjs`'s own top comment.

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/MonacoLanguageMapTests.swift
import XCTest
@testable import LlmIdeMacLib

final class MonacoLanguageMapTests: XCTestCase {
    func testKnownExtensionsMapToTheirMonacoLanguageId() {
        let cases: [String: String] = [
            "swift": "swift",
            "md": "markdown", "markdown": "markdown",
            "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript",
            "ts": "typescript", "tsx": "typescript",
            "py": "python",
            "sql": "sql",
            "sh": "shell", "bash": "shell", "zsh": "shell",
            "yml": "yaml", "yaml": "yaml",
            "html": "html", "htm": "html",
            "css": "css",
        ]
        for (ext, expected) in cases {
            XCTAssertEqual(MonacoLanguageMap.id(for: ext), expected, "extension \"\(ext)\"")
        }
    }

    func testUppercaseExtensionNormalizesLikeLowercase() {
        XCTAssertEqual(MonacoLanguageMap.id(for: "SWIFT"), "swift")
        XCTAssertEqual(MonacoLanguageMap.id(for: "Py"), "python")
    }

    func testUnsupportedExtensionsFallBackToPlaintext() {
        // json specifically: Monaco has never shipped a basic-languages
        // tokenizer for it (confirmed against the vendored package in P0) —
        // this is not an oversight, it must stay plaintext.
        for ext in ["json", "rb", "go", "rs", "toml", "xml", "unknownext", ""] {
            XCTAssertEqual(MonacoLanguageMap.id(for: ext), "plaintext", "extension \"\(ext)\"")
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL with `cannot find 'MonacoLanguageMap' in scope` (or similar — the type doesn't exist yet).

- [ ] **Step 3: Create `MonacoLanguageMap.swift`**

```swift
// mac/Sources/LlmIdeMac/Views/Shared/MonacoLanguageMap.swift

/// Shared source of truth for mapping a file extension to a vendored Monaco
/// `basic-languages` id (`MonacoEditorView`'s `language` parameter). Separate
/// from `HljsLanguageMap` deliberately: Monaco's vendored bundle (P0,
/// `Scripts/build-monaco-bundle.mjs`) covers exactly 10 languages, a
/// different set than highlight.js's — most notably no `json`, since
/// monaco-editor has never shipped a standalone Monarch tokenizer for it
/// (confirmed against the installed package during P0; only the excluded
/// `language/json/` full-mode plugin has JSON support).
///
/// Unknown/unsupported extensions fall back to `"plaintext"` — Monaco's core
/// editor edits any text with zero language files loaded, just without
/// syntax coloring.
enum MonacoLanguageMap {
    static let map: [String: String] = [
        "swift": "swift",
        "md": "markdown", "markdown": "markdown",
        "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript",
        "ts": "typescript", "tsx": "typescript",
        "py": "python",
        "sql": "sql",
        "sh": "shell", "bash": "shell", "zsh": "shell",
        "yml": "yaml", "yaml": "yaml",
        "html": "html", "htm": "html",
        "css": "css",
    ]

    /// Look up the Monaco language id for a file extension (case-insensitive,
    /// leading-dot tolerant). Falls back to `"plaintext"` for anything not in
    /// `map` — never an empty string, unlike `HljsLanguageMap.id(for:)`.
    static func id(for extension: String) -> String {
        let key = `extension`.hasPrefix(".") ? String(`extension`.dropFirst()) : `extension`
        return map[key.lowercased()] ?? "plaintext"
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. If a full Xcode toolchain is available, additionally run `swift test --filter MonacoLanguageMapTests` and expect all 3 tests to pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shared/MonacoLanguageMap.swift mac/Tests/LlmIdeMacTests/MonacoLanguageMapTests.swift
git commit -m "feat(mac): add MonacoLanguageMap, extension -> vendored Monaco language id"
```

---

### Task 2: `MonacoEditorMessageHandler` — pure core for JS→Swift message handling

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Shared/MonacoEditorView.swift` (this task adds only the pure handler; Task 3 adds the SwiftUI view to the same file)
- Test: Create `mac/Tests/LlmIdeMacTests/MonacoEditorMessageHandlerTests.swift`

**Interfaces:**
- Consumes: `MonacoOutboundMessage` (existing, `Services/MonacoBridge.swift`)
- Produces:
  ```swift
  struct MonacoEditorMessageHandler {
      enum Effect: Equatable {
          case updateContent(String)
          case requestSave
          case none
      }
      static func effect(for message: MonacoOutboundMessage) -> Effect
  }
  ```

This mirrors `WorkspaceRoot.pickGitRoot` — a pure decision core pulled out of the view specifically so it can be unit-tested without a live `WKWebView`. `MonacoEditorView` (Task 3) calls this from its `onMessage` closure and applies the `Effect`; the handler itself makes no SwiftUI or state changes.

Only `.contentChanged` and `.requestSave` produce an effect in P1. `.ready` is handled separately by `MonacoHost`'s own `onReady` callback (Task 3), not through this handler. `.cursorMoved`, `.gutterAction`, `.diffHunkAction` are P2/P3 concerns (hunk staging, cursor-position UI) — not consumed yet, so they produce `.none`. Producing `.none` rather than omitting these cases keeps the `switch` exhaustive: a future phase that needs one of them changes this function, not a silent gap.

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/MonacoEditorMessageHandlerTests.swift
import XCTest
@testable import LlmIdeMacLib

final class MonacoEditorMessageHandlerTests: XCTestCase {
    func testContentChangedProducesUpdateContentEffect() {
        let effect = MonacoEditorMessageHandler.effect(for: .contentChanged(text: "let a = 1"))
        XCTAssertEqual(effect, .updateContent("let a = 1"))
    }

    func testRequestSaveProducesRequestSaveEffect() {
        let effect = MonacoEditorMessageHandler.effect(for: .requestSave)
        XCTAssertEqual(effect, .requestSave)
    }

    func testReadyProducesNoEffect() {
        // .ready is handled by MonacoHost's own onReady callback, not this handler.
        XCTAssertEqual(MonacoEditorMessageHandler.effect(for: .ready), .none)
    }

    func testUnhandledMessagesProduceNoEffect() {
        XCTAssertEqual(MonacoEditorMessageHandler.effect(for: .cursorMoved(line: 3, column: 7)), .none)
        XCTAssertEqual(MonacoEditorMessageHandler.effect(for: .gutterAction(line: 1, action: .stage)), .none)
        XCTAssertEqual(MonacoEditorMessageHandler.effect(for: .diffHunkAction(hunkId: "h1", action: .stage)), .none)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: FAIL — `MonacoEditorMessageHandler` doesn't exist yet.

- [ ] **Step 3: Create `MonacoEditorView.swift` with the handler**

```swift
// mac/Sources/LlmIdeMac/Views/Shared/MonacoEditorView.swift
import SwiftUI

/// Pure decision core for `MonacoEditorView`'s `MonacoHost.onMessage`
/// callback — pulled out so it's unit-testable without a live `WKWebView`,
/// mirroring `WorkspaceRoot.pickGitRoot`'s "pure core, separated for tests"
/// pattern. `MonacoEditorView` applies the returned `Effect`; this function
/// touches no state itself.
enum MonacoEditorMessageHandler {
    enum Effect: Equatable {
        case updateContent(String)
        case requestSave
        /// `.ready` (handled by `MonacoHost.onReady`, not here),
        /// `.cursorMoved`/`.gutterAction`/`.diffHunkAction` (P2/P3) — no
        /// action in P1. Kept as an explicit case, not an unhandled default,
        /// so the switch below stays exhaustive as new message cases arrive.
        case none
    }

    static func effect(for message: MonacoOutboundMessage) -> Effect {
        switch message {
        case .contentChanged(let text):
            return .updateContent(text)
        case .requestSave:
            return .requestSave
        case .ready, .cursorMoved, .gutterAction, .diffHunkAction:
            return .none
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: builds cleanly. If a full Xcode toolchain is available, additionally run `swift test --filter MonacoEditorMessageHandlerTests` and expect all 4 tests to pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shared/MonacoEditorView.swift mac/Tests/LlmIdeMacTests/MonacoEditorMessageHandlerTests.swift
git commit -m "feat(mac): add MonacoEditorMessageHandler, the pure JS-message decision core"
```

---

### Task 3: `MonacoEditorView` — the owning SwiftUI view, with load-failure fallback

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Shared/MonacoEditorView.swift` (append below Task 2's handler)

**Interfaces:**
- Consumes: `MonacoHost`, `MonacoRevealRequest`, `MonacoOutboundMessage` (existing, `Views/Shared/MonacoHost.swift`), `GitGutter.Mark` (existing, `Services/GitGutter.swift`), `Theme`/`ThemeStore` (existing, `Models/Theme.swift`), `MonacoEditorMessageHandler.effect(for:)` (Task 2)
- Produces:
  ```swift
  struct MonacoEditorView: View {
      @Binding var content: String
      var language: String = "plaintext"
      var decorations: [Int: GitGutter.Mark] = [:]
      var revealRequest: MonacoRevealRequest? = nil
      var readOnly: Bool = false
      var onRequestSave: (() -> Void)? = nil
  }
  ```
  Consumed by Task 4 (`EditableTextDetailView`) and Task 6 (`CodeDetailView`'s preview closure).

This task has no automated test of its own (SwiftUI view + `WKWebView` glue — the same "genuinely untestable without a live WebView" situation P0's Task 13 documented for `MonacoHost`'s bridge methods; §9 of the design doc explicitly scopes this kind of code to manual per-phase verification). Its correctness rests on: (a) Task 2's handler, already tested; (b) `MonacoHost`, already tested/reviewed in P0; (c) the end-of-phase manual verification checklist. Read `MonacoHost.swift`'s full doc comment before writing this task — this view's entire contract is "compute the right property values and pass them straight into a `MonacoHost(...)`, exactly like a caller already uses `SelfSizingMarkdownView`."

- [ ] **Step 1: No test to write for this step** — proceed to Step 2. (Per this task's own note above: no automated test exists for SwiftUI/`WKWebView` glue in this codebase.)

- [ ] **Step 2: Append `MonacoEditorView` to `MonacoEditorView.swift`**

```swift
/// The owning view `MonacoHost`'s own doc comment anticipated: computes
/// `content`/`decorations`/`theme`/`revealRequest`/`readOnly` from its own
/// state and passes them straight into a declarative `MonacoHost(...)` — no
/// coordinator plumbing, the same way a caller already uses
/// `SelfSizingMarkdownView(markdown:isDark:onHeight:)`.
///
/// Content flows two ways but never fights itself: Swift sets `content` on
/// `MonacoHost` only when it actually changes (new file, or an external
/// revert); every keystroke instead arrives as a `.contentChanged` message,
/// which updates `$content` directly. The updated value then round-trips
/// back into `MonacoHost(content: content, ...)` on the next render, but
/// `MonacoHost.Coordinator.applyPendingChanges` only calls `setContent` when
/// its own `lastContent` differs from the incoming value (`MonacoHost.swift`,
/// `applyPendingChanges`) — since the round-tripped value already equals
/// what `Coordinator` just recorded as `lastContent`, the diff is a no-op.
/// The bridge only ever pushes a full `setContent` for a genuine external
/// change, never as an echo of what Monaco itself just reported.
///
/// Per design §8: if Monaco doesn't signal `.ready` within 2 seconds
/// (WebView init failure, missing bundled assets), this view falls back to
/// the existing plain `TextEditor` — the pre-P1 implementation becomes the
/// safety net rather than being deleted.
struct MonacoEditorView: View {
    @Binding var content: String
    var language: String = "plaintext"
    var decorations: [Int: GitGutter.Mark] = [:]
    var revealRequest: MonacoRevealRequest? = nil
    var readOnly: Bool = false
    /// Fired when Monaco's Cmd+S command posts `.requestSave` — the caller
    /// owns actually saving (disk I/O, dirty-state bookkeeping), matching
    /// how `EditableTextDetailView.save()` already works.
    var onRequestSave: (() -> Void)? = nil

    @EnvironmentObject private var theme: ThemeStore
    @State private var loadFailed = false
    @State private var readyTimeoutTask: Task<Void, Never>?

    var body: some View {
        Group {
            if loadFailed {
                fallbackEditor
            } else {
                MonacoHost(
                    content: content,
                    language: language,
                    decorations: decorations,
                    theme: theme.current,
                    revealRequest: revealRequest,
                    readOnly: readOnly,
                    onReady: handleReady,
                    onMessage: handleMessage
                )
                .onAppear(perform: startReadyTimeout)
                .onDisappear { readyTimeoutTask?.cancel() }
            }
        }
    }

    /// The pre-P1 implementation, preserved verbatim as the fallback
    /// `MonacoHost`'s own doc comment (design §8) calls for. `readOnly`
    /// still applies here — a failed-to-load preview must not become
    /// silently editable.
    private var fallbackEditor: some View {
        TextEditor(text: $content)
            .font(.system(size: 13, design: .monospaced))
            .textEditorStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(nsColor: .textBackgroundColor))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .disabled(readOnly)
    }

    private func startReadyTimeout() {
        readyTimeoutTask?.cancel()
        readyTimeoutTask = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            loadFailed = true
        }
    }

    private func handleReady() {
        readyTimeoutTask?.cancel()
    }

    private func handleMessage(_ message: MonacoOutboundMessage) {
        switch MonacoEditorMessageHandler.effect(for: message) {
        case .updateContent(let text):
            content = text
        case .requestSave:
            onRequestSave?()
        case .none:
            break
        }
    }
}
```

- [ ] **Step 3: Run full build to verify no regressions**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20`
Expected: `Build complete!` — `MonacoEditorView` is not wired into any call site yet (Task 4 does that), so this step only confirms the file itself compiles standalone.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Shared/MonacoEditorView.swift
git commit -m "feat(mac): add MonacoEditorView, the declarative editor/preview owning view"
```

---

### Task 4: Wire `MonacoEditorView` into `EditableTextDetailView`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift:262-477` (the `EditableTextDetailView` struct and its `editor` computed property, plus its two call sites' `preview` closures stay untouched here — only the shared `editor` slot and the struct's parameter list change)

**Interfaces:**
- Consumes: `MonacoEditorView` (Task 3)
- Produces: `EditableTextDetailView` gains two new parameters, `language: String` and `decorations: [Int: GitGutter.Mark]`

No test for this step (SwiftUI wiring — same rationale as Task 3). Verified by compile + the end-of-phase manual checklist.

- [ ] **Step 1: No test to write** — proceed to Step 2.

- [ ] **Step 2: Add `language`/`decorations` parameters to `EditableTextDetailView`**

In `FileDetailView.swift`, `EditableTextDetailView`'s property list (currently lines 263-267):

```swift
struct EditableTextDetailView<Preview: View, Accessory: View>: View {
    let url: URL
    var onSaved: (() async -> Void)? = nil
    /// Optional toolbar accessory rendered just left of Revert/Save.
    let accessory: () -> Accessory
    let preview: (String) -> Preview
```

becomes:

```swift
struct EditableTextDetailView<Preview: View, Accessory: View>: View {
    let url: URL
    var onSaved: (() async -> Void)? = nil
    /// Monaco language id for the editor (Task 1's `MonacoLanguageMap`, or a
    /// literal like `"markdown"`). Callers own this decision — the shared
    /// editor doesn't infer a language from `url` itself.
    var language: String = "plaintext"
    /// Git gutter marks for the editor, keyed by line number. Empty for
    /// content types (markdown) that don't track a git gutter.
    var decorations: [Int: GitGutter.Mark] = [:]
    /// Optional toolbar accessory rendered just left of Revert/Save.
    let accessory: () -> Accessory
    let preview: (String) -> Preview
```

And its `init` (currently lines 269-281):

```swift
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         @ViewBuilder accessory: @escaping () -> Accessory,
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.url = url
        self.onSaved = onSaved
        self.accessory = accessory
        self.preview = preview
        // Code/markdown open in the rendered/highlighted Preview by default
        // (the VS Code "view" experience); Edit is one toggle away.
        _isPreview = State(initialValue: startInPreview)
    }
```

becomes:

```swift
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         @ViewBuilder accessory: @escaping () -> Accessory,
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.url = url
        self.onSaved = onSaved
        self.language = language
        self.decorations = decorations
        self.accessory = accessory
        self.preview = preview
        // Code/markdown open in the rendered/highlighted Preview by default
        // (the VS Code "view" experience); Edit is one toggle away.
        _isPreview = State(initialValue: startInPreview)
    }
```

And the convenience `init` for `Accessory == EmptyView` (currently lines 468-477):

```swift
extension EditableTextDetailView where Accessory == EmptyView {
    /// Convenience init for callers that don't need a toolbar accessory.
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.init(url: url, onSaved: onSaved, startInPreview: startInPreview,
                  accessory: { EmptyView() }, preview: preview)
    }
}
```

becomes:

```swift
extension EditableTextDetailView where Accessory == EmptyView {
    /// Convenience init for callers that don't need a toolbar accessory.
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.init(url: url, onSaved: onSaved, startInPreview: startInPreview,
                  language: language, decorations: decorations,
                  accessory: { EmptyView() }, preview: preview)
    }
}
```

- [ ] **Step 3: Replace the `editor` computed property**

Currently (lines 400-411):

```swift
    private var editor: some View {
        TextEditor(text: $content)
            .font(.system(size: 13, design: .monospaced))
            .textEditorStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(nsColor: .textBackgroundColor))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onChange(of: content) { _, _ in
                // Clear stale save-errors when the user resumes editing.
                saveError = nil
            }
    }
```

becomes:

```swift
    private var editor: some View {
        MonacoEditorView(
            content: $content,
            language: language,
            decorations: decorations,
            onRequestSave: { Task { await saveWithToast() } }
        )
        .onChange(of: content) { _, _ in
            // Clear stale save-errors when the user resumes editing.
            saveError = nil
        }
    }
```

`MonacoEditorView`'s own Cmd+S handling (Monaco's built-in keybinding, posting `.requestSave` — see `Resources/monaco-src/bootstrap.js`'s `addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, ...)`, vendored in P0) now drives the SAME `saveWithToast()` the toolbar's Save button already calls (`EditableTextDetailView.swift`'s existing `toolbar` property, unchanged by this task) — Cmd+S inside the Monaco editor and the toolbar's Save button converge on one code path.

- [ ] **Step 4: Run full build to verify no regressions**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20`
Expected: `Build complete!` — `MarkdownDetailView` and `CodeDetailView` (the two current callers) both still compile because every new parameter has a default value; neither passes `language`/`decorations` yet (Tasks 5-6 add that).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift
git commit -m "feat(mac): EditableTextDetailView's editor becomes MonacoEditorView"
```

---

### Task 5: `CodeDetailView`'s gutter switches to `GitTruthStore`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift:187-254` (`CodeDetailView`)

**Interfaces:**
- Consumes: `GitTruthStore` (existing, `Services/GitTruthStore.swift`) — `init(repo: RepoManager? = nil)`, `func refresh(root: URL?) async`, `func lineMarks(root: URL, path: String) async -> [Int: GitGutter.Mark]`
- No public interface changes to `CodeDetailView` itself.

This task changes ONLY how `refreshGutter()` computes marks — from P0's lower-level `GitGutter.changedLines(repo:filePath:runGit:)` (a raw, one-shot call with no persistent state) to the `GitTruthStore`-based path design §7 specifies. The `containingRepo(of:preferred:)` / `relativePath(of:inside:)` static helpers (lines 228-253) are UNCHANGED — they still resolve which repo root and relative path to use; only what's done with that root+path changes.

- [ ] **Step 1: No test to write** — `refreshGutter()` is `@MainActor`, SwiftUI-`@State`-driven glue calling an already-tested store (`GitTruthStoreTests`, P0); nothing new and pure to extract here. Proceed to Step 2.

- [ ] **Step 2: Add a `GitTruthStore` instance and switch `refreshGutter()`**

In `CodeDetailView` (`FileDetailView.swift`), add a stored property alongside the existing `@State private var changedLines`:

```swift
    @State private var changedLines: [Int: GitGutter.Mark] = [:]
    @State private var gitTruthStore = GitTruthStore()
```

Replace `refreshGutter()` (currently lines 211-224):

```swift
    /// Compute git change markers for `url`'s containing repo. No-op (empty
    /// map) when the file isn't inside a git repo — never blocks the editor.
    @MainActor
    private func refreshGutter() async {
        let preferred = WorkspaceRoot.gitWorkingTree(config: config, projectStore: projectStore)
        guard let repo = Self.containingRepo(of: url, preferred: preferred) else {
            changedLines = [:]
            return
        }
        let relPath = Self.relativePath(of: url, inside: repo)
        let manager = RepoManager()
        let marks = await GitGutter.changedLines(repo: repo, filePath: relPath) { args, cwd in
            try await manager.runGit(args, at: cwd)
        }
        changedLines = marks
    }
```

with:

```swift
    /// Compute git change markers for `url`'s containing repo via
    /// `GitTruthStore` (design §7's data flow: `refresh` populates
    /// `byPath` so `lineMarks` can tell an untracked/new file — which has
    /// no HEAD blob to diff — from a normally-diffable one). No-op (empty
    /// map) when the file isn't inside a git repo — never blocks the editor.
    @MainActor
    private func refreshGutter() async {
        let preferred = WorkspaceRoot.gitWorkingTree(config: config, projectStore: projectStore)
        guard let repo = Self.containingRepo(of: url, preferred: preferred) else {
            changedLines = [:]
            return
        }
        let relPath = Self.relativePath(of: url, inside: repo)
        await gitTruthStore.refresh(root: repo)
        changedLines = await gitTruthStore.lineMarks(root: repo, path: relPath)
    }
```

- [ ] **Step 3: Run full build to verify no regressions**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20`
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift
git commit -m "refactor(mac): CodeDetailView's gutter now sources from GitTruthStore"
```

---

### Task 6: Retire `CodeWebView`; `CodeDetailView` and `MarkdownDetailView` pass `language`/`decorations`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift` — `CodeDetailView` (lines 187-207), `MarkdownDetailView` (lines 91-100); delete `CodeWebView` (lines 479-645, exact range as of this plan's writing — confirm via the struct's actual `// MARK: - Code / plain text` to `// MARK: - QuickLook` boundaries at edit time, since Task 4/5's edits shift line numbers)
- Modify: `mac/Sources/LlmIdeMac/Views/Shared/HljsLanguageMap.swift:1-4` (doc comment only)
- Modify: `mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift:4,41` (doc comments only)
- Delete: `mac/Tests/LlmIdeMacTests/CodeWebViewGutterTests.swift`

**Interfaces:**
- Consumes: `MonacoLanguageMap.id(for:)` (Task 1), `MonacoEditorView` (Task 3, via `EditableTextDetailView`'s `preview` closure)
- No new public interfaces — this task finishes `CodeWebView`'s replacement design §6.6 calls for ("both consumers... are fully replaced by Monaco in P2 and P1 respectively") and updates the two callers of `EditableTextDetailView` to actually pass `language`/`decorations`.

Before touching code: confirm nothing outside `FileDetailView.swift` depends on `CodeWebView` beyond doc-comment mentions — run `grep -rln "CodeWebView\b" mac/Sources/ mac/Tests/` and expect exactly the four files this task's **Files** section lists (three doc-comment mentions + the test file). If that grep turns up a fifth file or an actual code reference (not a comment), STOP and report — the delete step below assumes this is the complete, current picture (verified true when this plan was written; re-verify since P1 execution may start well after).

- [ ] **Step 1: No test to write** — deleting dead code and wiring existing, already-tested pieces together; nothing new and pure here. Proceed to Step 2.

- [ ] **Step 2: `MarkdownDetailView` passes `language: "markdown"`**

Currently (lines 91-100):

```swift
struct MarkdownDetailView: View {
    let url: URL
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        EditableTextDetailView(url: url, startInPreview: true) { content in
            MarkdownWebView(markdown: content, isDark: theme.current.isDark)
        }
    }
}
```

becomes:

```swift
struct MarkdownDetailView: View {
    let url: URL
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        EditableTextDetailView(url: url, startInPreview: true, language: "markdown") { content in
            MarkdownWebView(markdown: content, isDark: theme.current.isDark)
        }
    }
}
```

`MarkdownWebView` (the rendered-HTML preview, unchanged) stays the `preview` closure — Monaco is a source-text editor, not a markdown renderer, so the rendered-output preview mode is untouched by this plan. Only the raw-source editing mode (now `MonacoEditorView` via Task 4's shared `editor` property) gets syntax highlighting.

- [ ] **Step 3: `CodeDetailView` passes `language`/`decorations`, preview becomes `MonacoEditorView(readOnly: true)`**

Currently (lines 195-207):

```swift
    var body: some View {
        EditableTextDetailView(
            url: url,
            onSaved: { await refreshGutter() },
            startInPreview: true   // open code highlighted (read-only); Edit is one toggle away
        ) { content in
            CodeWebView(code: content,
                        language: url.pathExtension,
                        isDark: theme.current.isDark,
                        changedLines: changedLines)
        }
        .task(id: url) { await refreshGutter() }
    }
```

becomes:

```swift
    var body: some View {
        EditableTextDetailView(
            url: url,
            onSaved: { await refreshGutter() },
            startInPreview: true,   // open code highlighted (read-only); Edit is one toggle away
            language: MonacoLanguageMap.id(for: url.pathExtension),
            decorations: changedLines
        ) { content in
            MonacoEditorView(
                content: .constant(content),
                language: MonacoLanguageMap.id(for: url.pathExtension),
                decorations: changedLines,
                readOnly: true
            )
        }
        .task(id: url) { await refreshGutter() }
    }
```

The preview closure's `MonacoEditorView` is a SEPARATE instance from the one `EditableTextDetailView`'s shared `editor` property creates for edit mode (Task 4) — this matches the pre-existing behavior exactly (today's `CodeWebView` preview and `TextEditor` edit mode are already two separate view instances that get created fresh on every Edit/Preview toggle; this task changes what those two instances ARE, not whether there are two of them). `content: .constant(content)` is correct here: the preview closure receives `content` as a `String` (already-loaded file text, read-only in this context — `EditableTextDetailView` itself owns the real `@State private var content`), so the preview's `MonacoEditorView` needs a binding but must never actually push edits back (`readOnly: true` already prevents Monaco from accepting keystrokes, and `.constant` makes that a compile-time guarantee, not just a runtime one).

- [ ] **Step 4: Delete `CodeWebView`**

Delete the entire `CodeWebView` struct — from its `// MARK: - Code / plain text  (WKWebView — same engine as MarkdownDetailView)` section comment through the end of its `html()` method's closing brace, immediately before the `// MARK: - QuickLook` section comment. (This spans what were lines 479-645 before Tasks 4-5's edits shifted the file — locate it by the `struct CodeWebView: View {` declaration and its matching closing brace at edit time, not by the line numbers themselves.)

- [ ] **Step 5: Delete the orphaned test file**

```bash
git rm mac/Tests/LlmIdeMacTests/CodeWebViewGutterTests.swift
```

- [ ] **Step 6: Update the two stale doc-comment mentions**

In `mac/Sources/LlmIdeMac/Views/Shared/HljsLanguageMap.swift`, the header comment currently reads:

```swift
/// Shared source of truth for mapping a file extension to a highlight.js
/// language id. Used by both `CodeWebView` (file preview) and `DiffWebView`
/// (unified diff) so the two never drift.
```

becomes:

```swift
/// Shared source of truth for mapping a file extension to a highlight.js
/// language id. Used by `DiffWebView` (unified diff) — `CodeWebView`, the
/// other former consumer, was retired in P1 (VS Code parity plan) in favor
/// of `MonacoEditorView`.
```

In `mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift`, two doc comments name `CodeWebView`. The first (lines 3-6):

```swift
/// Read-only unified diff renderer backed by a `WKWebView` + vendored
/// highlight.js — the same offline highlighter scaffold `CodeWebView`
/// uses (Resources/highlight.min.js + atom-one-dark/light CSS). Each
/// `DiffRow` becomes a table row with old/new line gutters, a +/−/space
```

becomes:

```swift
/// Read-only unified diff renderer backed by a `WKWebView` + vendored
/// highlight.js — the same offline highlighter scaffold pattern
/// `Resources/highlight.min.js` + atom-one-dark/light CSS already use
/// elsewhere in this app. Each `DiffRow` becomes a table row with old/new
/// line gutters, a +/−/space
```

The second (lines 40-42):

```swift
/// Renders a parsed unified diff as a highlighted HTML table. Mirrors
/// `CodeWebView`'s vendored highlight.js loading: the JS + theme CSS are
/// inlined from `Bundle.main` Resources (no remote CDN — offline + no MITM).
```

becomes:

```swift
/// Renders a parsed unified diff as a highlighted HTML table. Vendored
/// highlight.js loading: the JS + theme CSS are inlined from `Bundle.main`
/// Resources (no remote CDN — offline + no MITM).
```

Wording fix only — `UnifiedDiffView`/`DiffWebView` themselves are P2's job, not touched further here.

- [ ] **Step 7: Run full build to verify no regressions**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20`
Expected: `Build complete!` — no references to the deleted `CodeWebView` remain anywhere.

- [ ] **Step 8: Run the build-tests target to confirm the deleted test file isn't referenced**

Run: `cd mac && swift build --build-tests 2>&1 | tail -30`
Expected: compiles (module-wide XCTest-missing error aside, per Global Constraints) — confirms `CodeWebViewGutterTests.swift`'s removal didn't leave a dangling reference anywhere else.

- [ ] **Step 9: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift mac/Sources/LlmIdeMac/Views/Shared/HljsLanguageMap.swift mac/Sources/LlmIdeMac/Views/SourceControl/UnifiedDiffView.swift
git commit -m "refactor(mac): retire CodeWebView in favor of MonacoEditorView"
```

---

### Task 7: Line-jump — `FileDetailView(initialLine:)` end-to-end

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift` — `FileDetailView` (lines 9-30), `MarkdownDetailView`, `CodeDetailView`, `EditableTextDetailView`

**Interfaces:**
- Produces: `FileDetailView.init(url:onClose:initialLine:)` — `initialLine: Int? = nil`, backward-compatible default (all 5 existing call sites — `UAGraphView.swift:1025`, `ReviewView.swift:240`, `ExplorerView.swift:393`, `LibraryDetailView.swift:22`, `SearchView.swift:273` — keep compiling unchanged; confirmed via `grep -rn "FileDetailView("` before writing this plan).

This delivers the "line-jump API (reveal)" design §11's P1 bullet calls for. No caller passes `initialLine` yet in this plan — `SearchView.swift` (P4's job) is the design-intended first real consumer, matching exactly how P0 shipped `MonacoHost`'s bridge with no UI caller and P1 (this plan) became its first real caller. Verify this task manually per the checklist below rather than inventing a placeholder UI trigger — a fake caller would be scope creep this plan doesn't need.

- [ ] **Step 1: No test to write** — SwiftUI parameter threading over an already-tested primitive (`MonacoRevealRequest`, P0). Proceed to Step 2.

- [ ] **Step 2: Thread `initialLine` through `FileDetailView`**

Currently (lines 9-24):

```swift
struct FileDetailView: View {
    let url: URL
    /// When set (Library detail pane), shows a close control that clears the
    /// selection so the file list can use the full detail column again.
    var onClose: (() -> Void)? = nil

    var body: some View {
        Group {
            switch fileKind {
            case .markdown:  MarkdownDetailView(url: url)
            case .pdf:       PDFDetailView(url: url)
            case .image:     ImageDetailView(url: url)
            case .code:      CodeDetailView(url: url)
            case .quicklook: QuickLookDetailView(url: url)
            }
        }
```

becomes:

```swift
struct FileDetailView: View {
    let url: URL
    /// When set (Library detail pane), shows a close control that clears the
    /// selection so the file list can use the full detail column again.
    var onClose: (() -> Void)? = nil
    /// 1-based line to reveal once the editor has loaded (e.g. a search
    /// result's line-jump, P4). `nil` for the common "just open the file"
    /// case. Ignored by kinds that have no text editor (`.pdf`/`.image`/
    /// `.quicklook`).
    var initialLine: Int? = nil

    var body: some View {
        Group {
            switch fileKind {
            case .markdown:  MarkdownDetailView(url: url, initialLine: initialLine)
            case .pdf:       PDFDetailView(url: url)
            case .image:     ImageDetailView(url: url)
            case .code:      CodeDetailView(url: url, initialLine: initialLine)
            case .quicklook: QuickLookDetailView(url: url)
            }
        }
```

- [ ] **Step 3: Thread `initialLine` through `MarkdownDetailView` and `CodeDetailView`**

`MarkdownDetailView` (lines 91-100, as left by Task 6's Step 2):

```swift
struct MarkdownDetailView: View {
    let url: URL
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        EditableTextDetailView(url: url, startInPreview: true, language: "markdown") { content in
            MarkdownWebView(markdown: content, isDark: theme.current.isDark)
        }
    }
}
```

becomes:

```swift
struct MarkdownDetailView: View {
    let url: URL
    var initialLine: Int? = nil
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        EditableTextDetailView(url: url, startInPreview: true, language: "markdown",
                               initialLine: initialLine) { content in
            MarkdownWebView(markdown: content, isDark: theme.current.isDark)
        }
    }
}
```

`CodeDetailView`'s property list, as left by Task 5's Step 2, reads:

```swift
struct CodeDetailView: View {
    let url: URL
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var projectStore: ProjectStore

    @State private var changedLines: [Int: GitGutter.Mark] = [:]
    @State private var gitTruthStore = GitTruthStore()
```

Add `initialLine` immediately below `url`:

```swift
struct CodeDetailView: View {
    let url: URL
    var initialLine: Int? = nil
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var projectStore: ProjectStore

    @State private var changedLines: [Int: GitGutter.Mark] = [:]
    @State private var gitTruthStore = GitTruthStore()
```

Its `body`, as left by Task 6's Step 3, reads:

```swift
    var body: some View {
        EditableTextDetailView(
            url: url,
            onSaved: { await refreshGutter() },
            startInPreview: true,   // open code highlighted (read-only); Edit is one toggle away
            language: MonacoLanguageMap.id(for: url.pathExtension),
            decorations: changedLines
        ) { content in
            MonacoEditorView(
                content: .constant(content),
                language: MonacoLanguageMap.id(for: url.pathExtension),
                decorations: changedLines,
                readOnly: true
            )
        }
        .task(id: url) { await refreshGutter() }
    }
```

becomes:

```swift
    var body: some View {
        EditableTextDetailView(
            url: url,
            onSaved: { await refreshGutter() },
            startInPreview: true,   // open code highlighted (read-only); Edit is one toggle away
            language: MonacoLanguageMap.id(for: url.pathExtension),
            decorations: changedLines,
            initialLine: initialLine
        ) { content in
            MonacoEditorView(
                content: .constant(content),
                language: MonacoLanguageMap.id(for: url.pathExtension),
                decorations: changedLines,
                readOnly: true
            )
        }
        .task(id: url) { await refreshGutter() }
    }
```

- [ ] **Step 4: `EditableTextDetailView` computes a `revealRequest` once content loads**

`EditableTextDetailView`'s property list, as left by Task 4's Step 2, reads:

```swift
struct EditableTextDetailView<Preview: View, Accessory: View>: View {
    let url: URL
    var onSaved: (() async -> Void)? = nil
    /// Monaco language id for the editor (Task 1's `MonacoLanguageMap`, or a
    /// literal like `"markdown"`). Callers own this decision — the shared
    /// editor doesn't infer a language from `url` itself.
    var language: String = "plaintext"
    /// Git gutter marks for the editor, keyed by line number. Empty for
    /// content types (markdown) that don't track a git gutter.
    var decorations: [Int: GitGutter.Mark] = [:]
    /// Optional toolbar accessory rendered just left of Revert/Save.
    let accessory: () -> Accessory
    let preview: (String) -> Preview
```

Add `initialLine` immediately below `decorations`:

```swift
    /// Optional Monaco line-jump target for `MonacoRevealRequest`
    /// (design's line-jump API — P4's search results are the first real
    /// caller). `nil` for the common "just open the file" case.
    var initialLine: Int? = nil
```

Its `init` (as left by Task 4's Step 2) reads:

```swift
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         @ViewBuilder accessory: @escaping () -> Accessory,
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.url = url
        self.onSaved = onSaved
        self.language = language
        self.decorations = decorations
        self.accessory = accessory
        self.preview = preview
        _isPreview = State(initialValue: startInPreview)
    }
```

becomes:

```swift
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         initialLine: Int? = nil,
         @ViewBuilder accessory: @escaping () -> Accessory,
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.url = url
        self.onSaved = onSaved
        self.language = language
        self.decorations = decorations
        self.initialLine = initialLine
        self.accessory = accessory
        self.preview = preview
        _isPreview = State(initialValue: startInPreview)
    }
```

And the `Accessory == EmptyView` convenience extension (as left by Task 4's Step 2) reads:

```swift
extension EditableTextDetailView where Accessory == EmptyView {
    /// Convenience init for callers that don't need a toolbar accessory.
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.init(url: url, onSaved: onSaved, startInPreview: startInPreview,
                  language: language, decorations: decorations,
                  accessory: { EmptyView() }, preview: preview)
    }
}
```

becomes:

```swift
extension EditableTextDetailView where Accessory == EmptyView {
    /// Convenience init for callers that don't need a toolbar accessory.
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         initialLine: Int? = nil,
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.init(url: url, onSaved: onSaved, startInPreview: startInPreview,
                  language: language, decorations: decorations, initialLine: initialLine,
                  accessory: { EmptyView() }, preview: preview)
    }
}
```

Add a `@State` property alongside the existing `@State private var content: String = ""`:

```swift
    @State private var revealRequest: MonacoRevealRequest?
```

In `load()` (currently lines 413-430), after a successful read, construct the reveal request — inside the method body, never inline in `body` (per `MonacoRevealRequest`'s own doc comment, restated in this plan's Global Constraints):

```swift
    @MainActor
    private func load() async {
        loadError = nil
        saveError = nil
        do {
            // Read off the main actor so a large file doesn't stall the editor.
            let fileURL = url
            let raw = try await Task.detached(priority: .userInitiated) {
                try String(contentsOf: fileURL, encoding: .utf8)
            }.value
            content = raw
            savedContent = raw
            if let initialLine {
                revealRequest = MonacoRevealRequest(line: initialLine)
            }
        } catch {
            loadError = "The file could not be decoded as text. (\(error.localizedDescription))"
            content = ""
            savedContent = ""
        }
    }
```

And pass it to the `editor` property's `MonacoEditorView` (Task 4's replacement, `mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift`'s `EditableTextDetailView.editor`):

```swift
    private var editor: some View {
        MonacoEditorView(
            content: $content,
            language: language,
            decorations: decorations,
            revealRequest: revealRequest,
            onRequestSave: { Task { await saveWithToast() } }
        )
        .onChange(of: content) { _, _ in
            saveError = nil
        }
    }
```

- [ ] **Step 5: Run full build to verify no regressions**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20`
Expected: `Build complete!` — all 5 existing `FileDetailView(url:)` call sites still compile unchanged (`initialLine` defaults to `nil` at every level).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift
git commit -m "feat(mac): FileDetailView(initialLine:) threads through to MonacoEditorView's reveal"
```

---

## End-of-phase verification

- [ ] Run the full test suite: `cd mac && swift build --build-tests 2>&1 | tail -40` (compiles everything written above). If a full Xcode toolchain is available, also run `swift test 2>&1 | tail -60` and confirm every test from Tasks 1-2 passes (Tasks 3-7 have no automated test — see each task's note).
- [ ] Run `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -5` and confirm `Build complete!` with no new warnings in the files this plan touched.
- [ ] `grep -rn "CodeWebView\b" mac/Sources/ mac/Tests/` returns nothing — confirms the retirement in Task 6 is complete (no stale references anywhere, comments included).
- [ ] `git log --oneline -7` shows one commit per task, in order.
- [ ] **Manual verification** (per design §9 — this repo has no runnable XCTest, so this is the real acceptance gate for everything in Tasks 3-7): launch the Mac app against a real git repo and, in the Library/Explorer file viewer:
  - [ ] Open a tracked file with uncommitted changes (some added lines, some deleted lines, some modified lines) — confirm the editor shows a gutter with distinct green/blue/red marks matching P0's `GitGutter.Mark` semantics, and that they match what `git diff` reports for that file.
  - [ ] Confirm syntax highlighting renders for at least one file per vendored language you can produce a real fixture for (swift, markdown, python, javascript, css — the ones most likely to already exist in this repo).
  - [ ] Open a `.json` file — confirm it's still fully editable, just without syntax coloring (Task 1's documented fallback).
  - [ ] Toggle Edit ↔ Preview on a code file — confirm both modes render via Monaco now (no more highlight.js gutter), and that Preview is genuinely read-only (typing does nothing).
  - [ ] Edit a file, press Cmd+S inside the Monaco editor (not the toolbar Save button) — confirm it saves and the toast/dirty-indicator behave exactly as the toolbar Save button already does.
  - [ ] Press Cmd+F inside the editor — confirm Monaco's built-in find widget appears (no code in this plan wires it explicitly; it's Monaco's default keybinding, and this check is here specifically to catch a regression if bootstrap.js's `create(...)` options ever change to disable it).
  - [ ] Rename/move the vendored Monaco bundle temporarily (or otherwise force `MonacoHost.indexURL()` to fail) and confirm the editor falls back to the plain `TextEditor` within ~2 seconds instead of showing a blank pane — then restore the bundle.
  - [ ] Open a markdown file, confirm the raw-source Edit mode now has line numbers/highlighting via Monaco, while Preview mode is unchanged (still the rendered-HTML `MarkdownWebView`).

## What P2 inherits

- `MonacoEditorView` — ready to host a diff view too, but P2's `showDiff` integration is a SEPARATE call path (`MonacoHost.diffRequest`, already built in P0) — P2 decides whether that's a second view or a mode of this one.
- `MonacoLanguageMap` — P2's `UnifiedDiffView` replacement needs the same extension → language mapping; reuse this, don't duplicate it.
- The retired `CodeWebView` pattern (readOnly Monaco instance) is the template P2's `DiffWebView` replacement can follow for its own retirement.
- `FileDetailView(initialLine:)` — P4's line-jump-on-click consumes this directly; no further plumbing needed on the editor side.
