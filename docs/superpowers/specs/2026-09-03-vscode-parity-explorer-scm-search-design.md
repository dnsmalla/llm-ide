# VS Code parity: Explorer, Source Control, Search — design

**Status:** Draft, pending implementation plan
**Author:** Claude (brainstorming session with dinesh.malla)
**Date:** 2026-09-03

## 1. Problem

The Mac app's Explorer, Source Control, and Search panels exist and are functional, but fall well short of VS Code in the areas the user singled out: editing code shows no git change colors, no line numbers, no syntax highlighting; diff review is split across five independent, inconsistent implementations; and none of the three panels share a common, reliable git-truth layer. A prior audit (three parallel Explore agents, 2026-09-03) found the concrete gaps enumerated in §3.

## 2. Goals / non-goals

**Goals:**
- Editing a file shows live git gutter decorations (added/modified/deleted), line numbers, and real syntax highlighting.
- Source Control gets a premium diff experience: side-by-side or inline (user choice), word-level highlighting, expandable/collapsible context, and — new — hunk/line-level staging.
- Explorer and Search get the baseline VS Code interactions the audit found missing: live file-watching, multi-select, keyboard navigation, drag & drop, line-jump from search results, real search cancellation.
- The five duplicate diff implementations collapse into one.
- All git/diff colors flow through `Theme`, matching the existing "no raw `.green`/`.red`" rule, and read correctly in Dark/Light/Midnight.

**Non-goals (this spec):**
- Blame, per-file timeline, commit graph, 3-way merge/conflict-resolution UI (deferred — "P5", not designed here).
- Multi-root workspaces as a first-class concept (Explorer's pseudo-multi-root behavior is preserved, not redesigned).
- Any change to the iPhone/mobile search or explore surfaces.
- Remote/cloud editing, LSP-based IntelliSense (Monaco is used as an editor + diff surface only, not a language server client).

## 3. Audit findings this design responds to

Full detail lives in the session transcript; the load-bearing findings are:

1. **Explorer git decoration is dead in the common case.** `GitStatusStore.refresh` (`Services/GitStatusStore.swift:14-17`) requires `root/.git` to exist, but `ExplorerView` passes `<project>/code` (`Views/Explorer/ExplorerView.swift:58`) — a container of clones with no `.git` of its own. The rendering layer (`TreeRowLabel`) is fully built and correct; only the root is wrong.
2. **Five independent diff implementations**, each with its own `DiffRow` type, own parser, own colors: `UnifiedDiffParser`+`UnifiedDiffView` (the good one — WKWebView, tested), `UpdateFileSheet`'s private diff (SwiftUI, recomputed every keystroke, no highlighting), `DiffStats` (agent approval card preview, explicitly documented as a duplicate), `CodeWorkflowService.parseDiffFiles` (lossy, zero coloring), `RepairScopeGuard`'s inline porcelain parser (duplicates `StatusParser`).
3. **Diff/git colors bypass `Theme` entirely.** `Hljs.Palette` and `UnifiedDiffView` hardcode GitHub-ish hex; `SourceControlView.color(_:)` (`Views/SourceControl/SourceControlView.swift:637-644`) returns raw `.green`/`.red`/`.orange`, which `Theme.swift`'s own doc comment (lines 88-91) forbids.
4. **No hunk/line staging anywhere** — no call site runs `git apply --cached`. Staging is file-level only.
5. **`RepoFileWatcher` (FSEvents) exists and works but is wired to nothing relevant** — Explorer relies on a manual Refresh button; Source Control polls every 3s and stops polling on `.onDisappear`.
6. **Editing has no gutter, no line numbers, no highlighting.** `FileDetailView`'s edit mode is a plain SwiftUI `TextEditor` (`Views/Library/FileDetailView.swift:401`); preview is a separate WKWebView + highlight.js renderer. There is no code-editing surface capable of hosting decorations at all.
7. **Search never jumps to a line on click** — `FileDetailView(url:)` takes no line parameter; there is no line-jump plumbing anywhere in the app.
8. **Search cancellation is broken.** `SearchService.search` runs in an unstructured `Task.detached` with zero `Task.isCancelled` checks in the walk loop; typing quickly queues multiple uncancellable full-repo walks.
9. **Explorer has no keyboard navigation, no multi-select, no drag & drop**, and mutates `@State` (`childrenCache`) during view-body evaluation (`ExplorerView.swift:426-431`).
10. Numerous smaller gaps are catalogued in the audit (icon collisions, indent guides not connecting, tail truncation losing extensions, tree width hardcoded to 240pt and non-resizable, Search and Explorer using different root resolution, etc.) — addressed opportunistically within the relevant phase below, not exhaustively re-listed here.

## 4. Approach decision: editor foundation

Three options were considered for the code-editing surface that git decorations, line numbers, and syntax highlighting all depend on:

- **Native `NSTextView`** — best AppKit integration, but requires hand-building syntax highlighting, gutter/line-number rendering, and find/replace from scratch. Rejected: largest effort for the smallest feature set.
- **CodeMirror 6** — lighter (~1MB) web editor with a decoration API, but the diff view (merge-view package) and the full gutter/git logic would still be self-built.
- **Monaco (VS Code's own editor), selected.** Same editor VS Code ships. Comes with gutter decorations (`deltaDecorations`), a real diff editor (`createDiffEditor` — side-by-side/inline toggle, word-level diff, collapsible unchanged regions), find/replace widget, minimap, multi-cursor, and syntax highlighting for ~100 languages out of the box. Runs the same way the existing `HljsWebView` pattern already runs highlight.js: a `WKWebView` loading a bundled, offline HTML/JS payload — no architecture shift, just a bigger and more capable payload.

**Packaging:** a custom Monaco build limited to the languages the repo actually uses (swift, markdown, javascript, typescript/tsx, json, sql, python, shell, yaml, html, css — 12 languages, verified against `git ls-files` extension counts), with the TypeScript language service worker excluded (no IntelliSense needed). This keeps the bundle to ~2MB (vs. 5-6MB for the stock `min/vs` folder) and is built once via a checked-in Node script (`mac/Scripts/build-monaco-bundle.mjs`), committed to `Resources/monaco/` like the existing vendored `highlight.min.js`. Rebuilding is a manual step when a new language is needed.

## 5. Responsibility split: Swift vs. Monaco

This is the central architectural decision and mirrors how VS Code itself separates its extension host from the editor:

- **Swift owns truth**: git command execution (funneled through `RepoManager`, the one already-hardened runner), git status, per-line change marks (staged+unstaged+deleted, computed via the existing `UnifiedDiffParser`), hunk-to-patch synthesis for staging, file I/O and dirty-state bookkeeping, search execution, and Theme → Monaco theme generation.
- **Monaco owns editor internals**: text buffer, undo stack, multi-cursor, code folding, syntax tokenization, the find/replace widget, *rendering* of marks Swift supplies (via `deltaDecorations`), *rendering* of diffs from old/new text Swift supplies (via `createDiffEditor`), and reveal-to-line.
- **The bridge is a small typed contract**, not a general-purpose RPC layer:
  - Swift → JS: `setContent`, `setDecorations`, `setTheme`, `reveal(line:)`, `showDiff(original:modified:language:)`, `setReadOnly`, `applyEdit`
  - JS → Swift: `contentChanged`, `requestSave`, `gutterAction(line:kind:)` (stage/revert this hunk), `cursorMoved`, `diffHunkAction(hunkId:action:)`

This keeps every git/diff *decision* (what counts as staged, how a hunk's patch is built, which root is the repo root) in Swift, where the existing test suite (`SCMParsersTests`, `ExplorerFileOpsTests`) already lives and where new tests can run without a WebView. Monaco is treated as a rendering engine that Swift drives, never as a second source of truth.

A direct consequence: the agent's `ProposedEdit { original, proposed }` (today rendered by a bespoke SwiftUI diff in `UpdateFileSheet`) becomes just another `showDiff(original:modified:)` call — the same code path Source Control uses. This is what collapses the five diff implementations into one.

## 6. New/changed components

Only four new Swift types are introduced; everything else is an extension of existing services.

### 6.1 `GitTruthStore` (new) — supersedes `GitStatusStore` + extends `GitGutter`

```swift
@MainActor @Observable
final class GitTruthStore {
    private(set) var status: [FileChange] = []
    private(set) var dirsWithChanges: Set<String> = []

    func decoration(for path: String) -> Decoration?
    func lineMarks(root: URL, path: String) async -> [Int: LineMark]
    func refresh(root: URL) async
    func startWatching(root: URL)   // wires RepoFileWatcher, 2s debounce -> refresh
    func stopWatching()
}

enum LineMark { case added, modified, deleted }   // GitGutter.Mark + .deleted
```

- Fixes finding #1: every call site passes `WorkspaceRoot.gitWorkingTree(config:projectStore:)`, never a raw project/container path.
- `lineMarks` merges `git diff --cached` and `git diff` (today `GitGutter` only reads unstaged) and adds a `.deleted` mark for pure-deletion hunks (today produces no mark at all).
- One shared instance per workspace root, consumed by Explorer (tree decoration), the editor (gutter), and — indirectly, via the same `status` — Source Control's changes list.

### 6.2 `MonacoHost` (new) — the shared editor/diff surface

```swift
// Declarative — the caller sets these properties (content/decorations/
// theme/revealRequest/diffRequest/readOnly) exactly like
// SelfSizingMarkdownView(markdown:isDark:onHeight:); SwiftUI's normal
// re-render cycle applies the change. There is no externally-held bridge
// object — SwiftUI never exposes a NSViewRepresentable's Coordinator outside
// the view itself, so the actual JS-calling methods (setContent/
// setDecorations/setTheme/reveal/showDiff/setReadOnly) live PRIVATE on
// MonacoHost.Coordinator, invoked only by its own diff-and-apply logic.
struct MonacoHost: NSViewRepresentable {
    var content: String?
    var language: String = "plaintext"
    var decorations: [Int: GitGutter.Mark] = [:]   // GitGutter.Mark gains .deleted; no separate LineMark type
    var theme: Theme
    var revealRequest: MonacoRevealRequest?         // carries an id so the same line can be re-requested
    var diffRequest: MonacoDiffRequest?
    var readOnly: Bool = false
    var onReady: (() -> Void)?
    var onMessage: ((MonacoOutboundMessage) -> Void)?
}
```

`MonacoOutboundMessage` (JS→Swift, decoded from the `WKScriptMessageHandler` callback) carries `.ready`, `.contentChanged(text:)`, `.requestSave`, `.gutterAction(line:action:)`, `.cursorMoved(line:column:)`, `.diffHunkAction(hunkId:action:)` — see §6.4.

Unlike `HljsWebView.updateNSView`, which reloads the entire HTML document on every update (losing scroll position — a real bug in the current code), `MonacoHost` loads once and every subsequent update goes through the JS bridge (`callAsyncJavaScript`), matching how a real editor host must behave.

### 6.3 `ExplorerTreeStore` (new) — supersedes `ExplorerView`'s inline `@State`

```swift
@MainActor @Observable
final class ExplorerTreeStore {
    private(set) var children: [String: [FileSystemTree.Node]] = [:]
    var expanded: Set<String> = []
    var selection: Set<URL> = []

    func loadChildren(of dir: URL) async   // off-main-actor FileManager work, no longer inside body
    func invalidate(_ dir: URL)
    func persistState(for root: URL)       // expansion + selection, keyed by workspace
    func restoreState(for root: URL)
}
```

Fixes finding #9 (state mutation during view-body evaluation) by moving the cache into an `@Observable` model with an explicit async load method, and adds the persistence the audit found entirely absent.

### 6.4 `MonacoBridge` message types

Plain `Codable` types for the JS↔Swift JSON contract — no new abstraction beyond this, the bridge is intentionally small:

```swift
enum MonacoOutboundMessage: Decodable {
    case ready
    case contentChanged(text: String)
    case requestSave
    case gutterAction(line: Int, action: GutterAction)
    case cursorMoved(line: Int, column: Int)
    case diffHunkAction(hunkId: String, action: HunkAction)
}
enum GutterAction: String, Codable { case stage, unstage, revert }
enum HunkAction: String, Codable { case stage, unstage }
struct MonacoDecoration: Codable, Equatable { let line: Int; let kind: String }
```

`MonacoOutboundMessage` is JS→Swift only — decoded by `MonacoHost.Coordinator`'s `WKScriptMessageHandler` callback. Swift→JS calls (§6.2) go straight through `callAsyncJavaScript`, not this envelope; `MonacoDecoration` is the one exception, used to shape `setDecorations`' argument array from `GitGutter.Mark`.

### 6.5 Extended existing types (no new abstractions)

- `RepoManager` — becomes the *only* git execution path for the code this spec's panels (Explorer/Source Control/Search/editor) touch; it is **not** retrofitted onto unrelated subsystems. Two of the audit's three "bypass" findings turn out, on inspection, to be actor-isolation-incompatible with `RepoManager` (`@MainActor final class`) and not worth the redesign risk:
  - `MemoryStore.swift` is a `public struct: Sendable`, deliberately usable off the main actor (`RegressionRunner.swift:263,270` call `gitDiff` synchronously via `try?`). Its `runGit` stays its own `Process` call but gets the same deadlock-safe concurrent stdout/stderr draining `RepoManager.git` already has (today it reads stdout only, after `waitUntilExit()` — the same large-diff pipe-block risk `RepoManager`'s design comment warns about).
  - `RepairScopeGuard.swift` doesn't shell out directly at all — its `run(_:gitRoot:)` goes through a LoopEngine sandboxed command verifier (`verifier.verify(command:repoRoot:timeout:)`), which stays untouched. The only real duplication is its inline porcelain parser (`RepairScopeGuard.swift:184-198`), replaced with `StatusParser.parse(porcelain:)`.
  - `AutoCodeUpdateService+CLI.swift`'s 12 `nonisolated static` git helpers are **out of scope**: unrelated Auto Task automation, no credentials passed, and the same actor-isolation mismatch at 6x the surface area. Candidate for a future, separate cleanup — not this spec.
- `GitTruthStore.stagePatch(root:hunk:) async` / `unstagePatch` — new methods, added to the existing `SourceControlService`'s sibling rather than a new service, since they operate on the same `RepoManager` and the same `status`.
- `ExplorerFileOps` — gains `move(from:to:)` / `copy(from:to:)`, following its existing `validate`/`createFile`/`rename`/`trash` pattern and test style.
- `SearchService.search` — restructured to an `AsyncStream<FileMatch>` (or a callback-per-file API), with `Task.isCancelled` checked inside the walk loop, replacing the current `Task.detached` with zero cancellation checks.
- `Theme` — gains the diff/git token set (§6.6) and `ThemeStore.monacoThemeJSON()`.
- `StatusParser` — gains old-path retention for renames (`R` status currently discards the "from" path).

### 6.6 New `Theme` tokens

```swift
// Diff / SCM
var diffAddedBg: Color, diffAddedFg: Color
var diffDeletedBg: Color, diffDeletedFg: Color
var diffModifiedBg: Color
var diffWordHighlight: Color
// Gutter (editor)
var gutterAddedMark: Color, gutterModifiedMark: Color, gutterDeletedMark: Color
// Editor base (Monaco theme generation)
var editorBackground: Color, editorLineNumber: Color
```

Added the same way `success`/`warning`/`info` semantic aliases already are (`Theme.swift:92-96`) — computed from those existing tokens, not new stored literals, so the three palette definitions never need touching. `SourceControlView.color(_:)` is updated to read these instead of raw SwiftUI colors, closing finding #3 for that file. `UnifiedDiffView` and `Hljs.Palette`'s hardcoded hex are **deliberately left alone in P0**: both consumers (`DiffWebView`, `CodeWebView`) are fully replaced by Monaco in P2 and P1 respectively, so threading `Theme` through code about to be deleted would be throwaway work — YAGNI. Their raw-color cleanup happens implicitly when P1/P2 delete them, not as a separate fix.

## 7. Data flow (representative: editor gutter)

```
GitTruthStore.lineMarks(root, path)
  -> RepoManager.runGit(["diff", "HEAD", "--", path])    (ONE call: combines
                                                           staged + unstaged,
                                                           new-line numbers
                                                           already relative
                                                           to the working file)
  -> UnifiedDiffParser.parse (existing, unchanged)
  -> GitGutter.changedLines(fromDiff:) extended with .deleted
  -> [Int: GitGutter.Mark]

  (A file GitTruthStore's own status reports as .added/.untracked has no HEAD
  blob — `diff HEAD` produces nothing for it — so that case is handled
  directly from the file's current contents: every line is marked .added.)

MonacoEditorView.onChange(of: lineMarks)
  -> MonacoBridge.setDecorations(lineMarks)
  -> JS: editor.deltaDecorations(...) renders 3px border-left,
         same visual language as today's CodeWebView gutter
```

Diff review (Source Control) follows the same shape but calls `showDiff(original:, modified:, language:)` instead of `setDecorations`, with `original` sourced from `git show HEAD:<path>` (or the staged blob) and `modified` from the working tree or `git show <sha>:<path>` for history mode.

Hunk staging: `GitTruthStore.stagePatch(root:hunk:)` synthesizes a minimal unified-diff patch for exactly one `DiffHunk` (reusing the existing `DiffHunk` model — no new patch format) and calls `RepoManager.git(["apply", "--cached", "-"], stdin: patch)`; `unstagePatch` adds `--reverse`.

## 8. Error handling

- **Monaco fails to load** (WebView init failure, missing bundled assets): `MonacoHost` expects an `onReady` bridge message within 2s; if it doesn't arrive, host state flips to `.loadFailed` and the call site falls back to the current plain `TextEditor` — the existing implementation becomes the safety net rather than being deleted.
- **Hunk staging fails** (`git apply` reports a conflict — e.g. the file changed since the hunk was computed): surfaced through the existing `SourceControlService.opError` sticky-banner pattern; a failed `git apply --cached` is a no-op on the index, so no partial-state cleanup is needed.
- **Malformed bridge messages**: `MonacoBridge`'s `Codable` decode is wrapped in `do/catch`; a decode failure logs and is dropped, never crashes the host.
- **Search cancellation**: a superseded search's `AsyncStream` is simply not consumed further; the walk loop's `Task.isCancelled` check ensures it stops promptly rather than running to completion in the background.

## 9. Testing strategy

- **Swift, no WebView required** (the responsibility split in §5 makes this possible):
  - `GitTruthStore`: root resolution (regression test pinning finding #1), staged+unstaged merge, `.deleted` marks, watcher debounce timing.
  - Hunk-to-patch synthesis (`stagePatch`): golden-file comparison of generated patches, following `SCMParsersTests`' existing style.
  - `ExplorerTreeStore`: expansion/selection persistence round-trip, cache invalidation.
  - `SearchService`: cancellation actually short-circuits the walk (inject a slow `FileManager` double and assert the walk observes `isCancelled`).
  - `ExplorerFileOps.move`/`copy`: same validation-first pattern as existing tests.
- **JS/Monaco bridge**: pure functions (decoration-list building, theme JSON generation) get Node-based unit tests, following the existing Node test pattern already used in `mac/LocalPackages/graph-kit/typescript`.
- **Manual verification per phase** (this repo has no XCTest/Testing runner in the current toolchain — see memory `mac-build-environment`): each phase ends with an in-app check of the specific behavior it targets (git colors while editing, hunk staging round-trip, search line-jump, drag & drop) before moving to the next phase.

## 10. Build/packaging

- Monaco assets ship under `Resources/monaco/` (~2MB), built by a checked-in `mac/Scripts/build-monaco-bundle.mjs` and committed — same "vendored, offline, no CDN" policy `HljsWebView.swift`'s header comment already states for highlight.js.
- Follows the existing `.fileExplorer` feature flag: `make build-mac-lite` / `build-mac-min`, which already exclude Explorer/Source Control/Search, exclude the Monaco bundle too (no dead weight in builds that don't ship these panels).

## 11. Phased rollout

Each phase is independently implementable and endable; later phases depend on earlier ones but not vice versa. P5 (blame, timeline, commit graph, 3-way merge UI) is explicitly out of scope for this spec.

- **P0 — Foundation.** Theme tokens (§6.6) + hex/raw-color cleanup. Git-layer hardening scoped to what's actually safe (§6.5): `RepairScopeGuard`'s parser dedup, `MemoryStore.runGit`'s pipe-draining fix — no actor-isolation-incompatible migrations. `GitTruthStore` (§6.1) with the root-bug fix and `RepoFileWatcher` wired in. `MonacoHost`/`MonacoBridge` scaffolding with the bundled asset pipeline (§4, §10) — resource resolution and the JS-message bridge contract are unit-tested; actually rendering Monaco on screen is proven manually once P1 wires the first real caller (no UI in this app shows a `MonacoHost` yet at the end of P0).
- **P1 — Editor.** Replace `FileDetailView`'s `TextEditor` with `MonacoEditorView`: gutter decorations from `GitTruthStore`, syntax highlighting, line numbers, find/replace (Monaco's built-in widget), line-jump API (`reveal`). This is the direct answer to "git colors while editing."
- **P2 — Source Control.** Replace `UnifiedDiffView` with `MonacoHost.showDiff`. Add hunk/line staging (§7). Collapse the five diff implementations onto `showDiff` (§5), including the agent's edit-approval flow. Changes list gets multi-select, keyboard nav, a context menu, and rename `old → new` display.
- **P3 — Explorer.** `ExplorerTreeStore` (§6.3), live updates via `GitTruthStore.startWatching`, `List(selection:)`-based rows for multi-select/keyboard/full-width selection, drag & drop and cut/copy/paste (backed by `ExplorerFileOps.move`/`copy`), inline rename, resizable+persisted tree width, Copy Path, Find in Folder.
- **P4 — Search.** Cancellable streaming search (§6.5), line-jump on result click (via P1's `reveal`), `.gitignore` support, ⌘⇧F to open the panel, truncation warning at the match cap, root unification with Explorer, replace preview.

## 12. Open questions for the implementation plan

None blocking — the three decisions that would have blocked design (editor foundation, packaging, responsibility split) were resolved during brainstorming (§4, §5, and the Monaco-packaging choice). The implementation plan should decide, per phase, the exact file-level diff (which functions move where) rather than re-litigate architecture.
