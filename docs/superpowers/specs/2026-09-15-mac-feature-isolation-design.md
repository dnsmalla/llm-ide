# Mac Feature Isolation — Design

**Date:** 2026-09-15
**Status:** Approved design, pending implementation plan
**Goal:** Every menu feature in the macOS app owns one folder, so upgrading one
feature cannot affect another.

## Problem

`mac/Sources/LlmIdeMac/` holds 511 Swift files. Five features are already
vertical slices — `Chat/` (71), `LoopEngine/` (32), `AutoTask/` (27), `Graph/`
(23), `ClaudeLink/` (6). The other eleven are smeared across two undifferentiated
buckets: `Services/` (147) and `Views/` (146).

The isolation *machinery* already exists and works: `AppFeature`,
`FeatureCatalog` as the single `#if FEATURE_*` seam, `AppModule`/`FeatureRegistry`
for start/stop, and `Package.swift` folder excludes. The gap is that only five of
sixteen features own a folder for that machinery to point at.

The cost is concrete and already being paid:

- `Package.swift` needs a **16-entry file-level exclude list** for Mobile Control
  instead of one folder line, and three separate `Views/*` lines for Explorer.
- An invalid SwiftPM exclude path is a **warning**, not an error — the build still
  exits 0. A feature file that moves out from under an exclude silently rejoins
  the lite build, undetected.
- Feature-owned services sit beside genuinely shared infrastructure in
  `Services/`: `Explorer*` (7), `Mobile*` (11), `Git*`/`SCM*` (8), `Doc*` (4),
  next to `ProjectStore`, `LlmIdeAPIClient`, `AppEnvironment`, `KeychainStore`.

## Measured starting point

Coupling was measured, not assumed. Method: collect every type declared exactly
once module-wide (251 distinctive symbols), then count files in each folder
referencing another folder's symbols.

Result: only **46 files of 511** cross a slice boundary, and roughly a dozen of
those are legitimate shell wiring (`AppShell`, `FeatureRegistry`,
`FeatureCatalog`).

A first pass on raw symbol names badly overstated the coupling — Loop→AutoTask
appeared to be 7 files. Inspection showed **five were prose in doc comments**
("mirroring `AutoCodeView`'s split", "same idiom as `CustomAutoTask`"). This is
the single most important measurement finding, and it becomes a hard requirement
on the gate (see below).

## Target architecture

```
Sources/LlmIdeMac/
├── Core/            leaf infrastructure — knows nothing about any feature
├── Features/        the 16 features, one folder each
└── Shell/           composition root — the ONLY layer that may name every feature
```

**Dependency rule, enforced:** `Shell → Features → Core`.
A feature may import Core. A feature may **never** import another feature, and
never imports Shell.

### Core

| Contents | Moved from |
|---|---|
| `LlmIdeAPIClient` + `API/` (17 files) | `Services/`, `Services/API/` |
| `ProjectStore`, `ProjectPaths`, `ProjectLayout`, `WorkspaceRoot` | `Services/` |
| `AppEnvironment`, `KeychainStore`, `Config`, `AppIdentity` | `Services/`, `Models/` |
| `Theme`, `Strings`, `Date+ISO`, `FileIconKit` | `Models/` |
| `BashService`, `ResourceGuard` | `Services/` |
| `RegressionRunner` (no single feature owns it — 4 consumers + `FeatureCatalog`) | `Services/` |
| `DesignSystem/` — the 9 files of `Views/Components/` | `Views/Components/` |
| `Editor/` — `Monaco*` (6), `Hljs`, `HtmlPreviewWebView`, `Mermaid`, `GitGutter` | `Views/Shared/`, `Services/` |
| `Contracts/` — the three new cross-feature protocols | new |
| `ClaudeLink/` (6, unmoved in place) | already a slice; the SDK layer, not a feature |

### Shell

`LlmIdeMacApp`, `AppShell`, `ContentView`, `FeatureCatalog`, `FeatureRegistry`,
`AppFeature`, `ShellState`, `DeepLinkRouter`, and `Views/Shell/` (12 files).

These are *allowed* to name every feature. That is why they must be an explicitly
named layer rather than hidden inside Core — the gate grants Shell a blanket
exemption, so the exemption has to be visible in the directory structure.

### Features

Each is `Features/<Name>/{Models,Services,Views}`, matching the shape `AutoTask/`
and `LoopEngine/` already use.

| Feature | Moves in | Approx. size |
|---|---|---|
| Library | `Views/Library/`(25), `Services/NotesFolder/`(16), `LibraryItemStore`, `NoteService`, `SourceIngestService`, `SourceLinkStore`, `Meeting*`(2), `Plugin*`(2), `LegacyExporter` | 50 |
| Live | `Services/CaptionScraper/`(5), `AutoCaptureService`, `LiveSessionMirror`, `PermissionsService`, `Caption`, `MeetingCaptureMatrix`, `TranscriptView` | 12 |
| Explorer | `Views/Explorer/`(4), `Explorer*`(7), `FileSystemTree`, `IgnoreList`, `GlobMatch`, `GitIgnoreRules`, `FileTreePanel`, `EditorTabBar`, `Views/CodeCompletion/`(3) | 20 |
| Search | `Views/Search/`, `SearchEngine`, `SearchService` | 3 |
| Review Conflicts | `ReviewView` | 1 |
| Source Control | `SourceControlService`, `SCM*`(2), `GitLog`, `GitTruthStore`, `GitHubClient`, `GitLabClient`, `GlabAuthSync`, `Services/Repo/`(6), `RepoManager`, 3 sheets, `HunkStagingList` | 20 |
| Issues | `Views/Issues/`(4), `RecentIssuesResolver`, `ExistingIssuePicker` | 6 |
| Gantt | `Views/Gantt/`(5) | 5 |
| Visual | `Views/Visual/`(4) | 4 |
| Doc Gen | `Views/DocGen/`(4), `Doc*Store`(3), `ProjectDoc*Seeder`(2), `Generation*`(7) | 16 |
| Auto Tasks | `AutoTask/`(27), `CronExpression` | 28 |
| Code Graph | `Graph/`(23), `RepoGraphLocator` | 24 |
| Loop | `LoopEngine/`(32), `Fault*`(2), `VerifyApprovalStore`, `Services/Memory/`(4) | 39 |
| Settings | `Views/Settings/`(17), `SettingsView`, `UpdateService`, `FeatureRebuildService` | 20 |
| Chat | `Chat/`(71), `CodeAssistantSession`, `CodeWorkflowService`, `VoiceInputService` | 74 |
| Mobile Control | the 11 `Mobile*` files, `PairingThrottle`, `MobileControlSettingsSection` | 13 |
| Terminal | `Views/Terminal/`(6), `TerminalPanelState` | 7 |

Mobile Control and Terminal are not menu sections but are build-excludable and
currently scattered. They get folders for the same reason as the rest: sixteen
folders, not fourteen.

### Two structural decisions

**`Views/Shared/` is split, not moved.** Its 25 files are three unrelated things
wearing one name: `Monaco*`/`Hljs`/`Mermaid` are real Core editor infrastructure;
`Generation*` (7) belongs to Doc Gen and Visual; `FileTreePanel`/`EditorTabBar`
belong to Explorer; `HunkStagingList` to Source Control; `FirstLaunchChat` to Chat.

**Settings collects contributed sections.** Its 17 sections are each owned by a
different feature — `GitLabSettingsSection` is Source Control's,
`MobileControlSettingsSection` is Mobile's. `Features/Settings/` becomes a shell
that collects sections each feature contributes, matching
`FeatureCatalog.graphSettingsSection()`, which already works exactly this way.
Upgrading GitLab must not require touching a Settings folder.

## Cross-feature seams

After the moves, this is the complete set of genuine edges.

| Edge | Reality | Seam |
|---|---|---|
| AutoTask → Loop | 1 file (`AutoCodeUpdateService+PipelineTasks.swift`) constructs `LoopEngineRunner` | `protocol LoopRunning` in Core; Loop conforms |
| Loop → AutoTask | 1 weak `TaskLogStore` reference in `LoopRunService` | `protocol TaskLogWriting` in Core; AutoTask conforms |
| Loop/AutoTask/Graph/Chat → `RegressionRunner` | 4 consumers + `FeatureCatalog` | No protocol needed — no single feature owns it, so it **moves to Core** and every feature may import it directly |
| AutoTask → Graph | `GraphAutoUpdater`, 2 files | `protocol GraphRefreshing` in Core |
| Mobile → AutoTask, Loop, Chat | already mediated for two of three | **extend the existing `MobileFeatureBridge`** to cover Chat; invent nothing |
| AutoTask → Chat, Loop → Chat | `CodeAssistantPanel`, 1 file each | `FeatureCatalog` factory returning `AnyView`, exactly like `graphMainPane()` |
| Chat → Loop (`LoopEngineConfig`), Chat → Graph (`GraphSettingsSection`) | 1 file each, config/settings reads | resolved by the Settings-contribution pattern; no new protocol |
| Chat → ClaudeLink, 11 files | **not an edge** | ClaudeLink is Core |
| `MobileLoopBridge` in `LoopEngine/` | Mobile's file parked in Loop's folder | deleted as an edge by moving the file to `Features/MobileControl/` |

Total: **three new protocols** (`LoopRunning`, `TaskLogWriting`, `GraphRefreshing`),
one extension to an existing bridge, two
`FeatureCatalog` view factories following a pattern already in the file.
Everything else dissolves when files land in the right folder.

Protocols live in `Core/Contracts/`. The conforming feature registers itself
through `FeatureRegistry` at boot, so a compiled-out feature leaves the consumer
holding `nil` and degrading — which is how `MobileFeatureBridge` already behaves.

## The gate

Swift enforces no boundaries inside a single target, so the rule is checked
textually by `mac/Scripts/feature-boundaries.sh`, wired into `make regression`.

1. Build a declaration map: symbol → owning folder. Keep only symbols declared
   exactly once module-wide; ambiguous names are skipped rather than guessed.
2. Classify each file by path: `Core` / `Features/<Name>` / `Shell`.
3. Flag references where the consumer is a Feature and the owner is a *different*
   Feature. Core and Shell owners are always allowed; Shell consumers are always
   allowed.
4. Compare the violation count to `feature-boundaries-baseline.txt`. Fail if it
   rose. Each migration commit lowers it. Target: zero.

Two requirements the measurement proved are not optional:

- **Strip comments and string literals before matching.** Five of seven apparent
  Loop→AutoTask edges were doc-comment prose. A gate that counts those fails
  honest commits and trains people to ignore it.
- **Verify every `Package.swift` exclude path exists.** SwiftPM only warns on an
  invalid exclude and exits 0. This restructure moves ~250 files past exactly
  that hazard. Three lines, same script.

The baseline is committed at whatever count the tree actually produces when
measured — not a predicted number.

### What this buys `Package.swift`

Mobile Control's 16-entry exclude list and Explorer's three `Views/*` lines each
collapse to one line: `libExcludes.append("Features/MobileControl")`. The build
system stops needing to know anything about a feature except its folder name.
That is the isolation goal made mechanical.

## Migration sequence

Leaves first, entangled last. Roughly 23 commits, each independently shippable
and each lowering the ratchet.

| Step | Commits | Content |
|---|---|---|
| 0 | 1 | Gate script + measured baseline. **No file moves.** Proves the measurement before it is trusted. |
| 1 | 2 | `Core/` then `Shell/` extraction — establishes the layers everything else moves against. |
| 2 | 6 | Zero-edge leaves: Search, Conflicts, Visual, Gantt, Issues, Terminal. Cheap, and they validate the ratchet on real moves. |
| 3 | 6 | Medium: Live, Explorer, Source Control, Doc Gen, Settings, Library. |
| 4 | 1 | Mobile Control — frees `MobileLoopBridge`, collapses the 16-entry exclude list. |
| 5 | 3 | The three Core protocols, one commit each. |
| 6 | 4 | Chat, Graph, AutoTask, Loop move under `Features/` — edge-removal and `Package.swift` commits, not bulk moves. |

## Verification

This toolchain has **no XCTest**: `swift test` never runs and `make regression`
skips it. The real gate is four builds — full, lite, min, mobile-only — plus the
graph and chat contract labs.

- **Steps 1–4 and 6 are well covered.** A pure file move that compiles in all four
  feature configurations is correct close to by construction: the compiler
  resolves every reference, and the lite/min builds prove the excludes. Each
  commit additionally greps the build log for `Invalid Exclude`.
- **Step 5 is not covered.** Replacing a direct call with a protocol seam changes
  runtime wiring, and nothing automated catches a seam that compiles but is never
  registered — the consumer silently sees `nil` and degrades, indistinguishable
  from correct compiled-out behavior. Each of the three commits carries a named
  manual GUI check, e.g. for `LoopRunning`: the Loop Engineering auto task
  actually starts a run rather than a no-op.

Operational notes for whoever runs this:

- Run `make regression` **unpiped** — piping to `tail` returns tail's exit code
  and has masked a red gate in this repo before.
- Run `make regression` before pushing; a cold `mac/.build` makes the push-time
  gate die with SIGPIPE, reporting PASS while pushing nothing.
- `git push` must be foreground with a long timeout.

## Open decisions

- **Branch vs `main`.** Whether these ~23 commits land directly on `main` or on
  `refactor/mac-feature-slices`. Not yet decided.
- **The three manual checks in step 5** require the user at the GUI; they cannot be
  automated on this toolchain.

## Out of scope

Behavior changes of any kind. This restructure moves files, introduces three
protocols to replace three direct calls, and adds one gate script. Any feature
improvement discovered along the way is recorded, not implemented.
