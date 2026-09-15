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
seventeen features own a folder for that machinery to point at.

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
├── Features/        the 17 features, one folder each
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
| `Contracts/` — the two new cross-feature protocols (`LoopRunning`, `TaskLogWriting`) | new |
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
currently scattered, as is Chat. They get folders for the same reason as the
rest: seventeen folders, not fourteen — the fourteen menu sections plus Chat, Mobile Control and Terminal.

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

The seam set below was **measured by the gate script**, not inferred. Running it
against today's tree with comments and string literals stripped reports exactly
**four** cross-feature references, in four files:

```
AutoTask/Services/AutoCodeUpdateService+PipelineTasks.swift -> Loop
    [AgentLoopSkillExecutor, AgentLoopStageRepairer, LoopDefinition,
     LoopEngineConfigStore, LoopEngineRunner, LoopRunNotifier,
     LoopRunTrigger, LoopStage, RegressionRunnerSweepAdapter]
AutoTask/Services/AutoCodeUpdateService.swift               -> Loop  [LoopRunTrigger]
LoopEngine/Services/LoopRunService.swift                    -> AutoTask [AutoTask, TaskLogStore]
LoopEngine/Services/MobileLoopBridge.swift                  -> AutoTask [AutoCodeUpdateService, AutoTask]
```

Every other edge this design previously listed — AutoTask→Graph
(`GraphAutoUpdater`), AutoTask/Loop→Chat (`CodeAssistantPanel`), Chat→Loop
(`LoopEngineConfig`), Chat→Graph (`GraphSettingsSection`), Graph→Chat
(`ChatEngine`) — is **comments only** and was verified as such file by file. They
are not edges and need no seam.

Consequently the seam work is much smaller than first drafted:

| Edge | Files | Seam |
|---|---|---|
| AutoTask → Loop | 2 | `protocol LoopRunning` in `Core/Contracts/`; Loop conforms |
| Loop → AutoTask | 1 (`LoopRunService.logStore`) | `protocol TaskLogWriting` in `Core/Contracts/`; AutoTask conforms |
| `MobileLoopBridge` → AutoTask | 1 | **No protocol.** It is Mobile's file parked in `LoopEngine/`; moving it to `Features/MobileControl/` deletes the edge |
| `RegressionRunner` (4 consumers + `FeatureCatalog`) | — | **No protocol.** No feature owns it, so it moves to Core and every feature may import it directly |

Total: **two new protocols**. No `GraphRefreshing`, no `FeatureCatalog` view
factories, no extension to `MobileFeatureBridge` — all three were prescribed
against edges that do not exist.

Protocols live in `Core/Contracts/`. The conforming feature registers itself
through `FeatureRegistry` at boot, so a compiled-out feature leaves the consumer
holding `nil` and degrading — which is how `MobileFeatureBridge` already behaves.

### CORRECTION (2026-09-15, during execution): the measurement's scope

The four-reference figure above is accurate **only for the five folders that were
already classified** — `Chat/`, `AutoTask/`, `LoopEngine/`, `Graph/`,
`ClaudeLink/`. Every other feature still lived in `Services/` and `Views/`, which
the gate treats as exempt, so its references were never counted. The claim that
the six "leaf" features had zero cross-feature edges was an assertion, not a
measurement.

Executing Tasks 3–8 disproved it:

- **Review Conflicts** and **Visual** both embed `CodeAssistantPanel` — a real
  dependency on Chat. The `FeatureCatalog` view-factory seam this design deleted
  as unnecessary is in fact required, and is reinstated.
- **Gantt ↔ Issues** are coupled in both directions, and **Issues → Chat** through
  `RecentIssuesResolver`.
- **`Shell/AppShell.swift` uses `TerminalPanelState` unguarded.** Moving that type
  into a build-excludable folder breaks `build-mac-lite` and `build-mac-min`.

Two design changes follow, both of which make the gate stronger rather than
weaker:

1. **Seal at the end, not on arrival.** A feature cannot be soundly sealed while
   its collaborators are still invisible to the gate. Gantt "passed" sealing only
   because Issues had not moved yet. Features are classified on arrival and sealed
   in one final step.
2. **Unclassified is its own layer.** Unlisted paths no longer default to `Shell`.
   A classified feature referencing unclassified code emits a `pending` line, so
   an edge that will matter later is visible now instead of ambushing whichever
   task moves the other half.
3. **Shell's exemption is from the boundary rule, not the exclusion rule.** A file
   under `Shell/` or `Core/` referencing a symbol owned by a build-excludable
   `Features/` folder is an error. Nothing caught this before; it is the exact
   shape of the Terminal failure.

### Why the first draft was wrong, and what it implies

The first pass counted raw symbol names and reported seven Loop→AutoTask files
and a dozen edges across the app. Stripping comments reduced that to one real
file and two real edges. Prose in doc comments — "mirroring `AutoCodeView`'s
split", "same idiom as `CustomAutoTask`" — accounted for nearly all of it.

This is the strongest argument for the gate existing at all: the codebase's
cross-feature coupling was widely over-estimated, including by this design a
draft ago. A measured number, enforced, replaces a guess.

## The gate

Swift enforces no boundaries inside a single target, so the rule is checked
textually by `mac/Scripts/feature-boundaries.sh`, wired into `make regression`.
The script exists in prototype and its output is quoted above; the plan
productionises it.

1. **Strip comments and string literals** from every file before any matching.
2. Build a declaration map: symbol → owning layer. Only **top-level**
   declarations count (column 0) and only symbols declared once module-wide.
3. Classify each file by path via `mac/Scripts/feature-map.txt`
   (`path-prefix  layer  [sealed]`). Unclassified paths default to `Shell`,
   which is exempt — so the map shrinks the exempt bucket as migration proceeds.
4. Flag references where the consumer is a Feature and the owner is a
   *different* Feature. Core and Shell owners are always allowed; Shell
   consumers are always allowed.
5. Enforce (see ratchet below).

### Two requirements the measurement proved are not optional

- **Strip comments and string literals.** Without this the script reported 13
  violations, 9 of them prose. A gate that counts doc comments fails honest
  commits and trains people to ignore it.
- **Count top-level declarations only.** A *nested* `enum Error` inside a Loop
  type otherwise claims ownership of every stdlib `Error` in the module — that
  single bug produced 8 of the 13 false positives. Nested declarations are
  indented; column-0 matching removes them precisely.

Both fixes were validated against known-good and known-bad cases: stripping must
remove `LoopEngineStatus.swift`'s comment reference to `AutoCodeUpdateService`
while preserving `LoopRunService.swift:32`'s real `TaskLogStore` reference.

### The ratchet, and why it must be per-feature

A naive "total must never rise" ratchet **would block this migration**. Moving
Explorer into `Features/Explorer/` makes previously-invisible Explorer↔Source
Control references countable for the first time, so the total goes *up* — the
migration's own progress would fail the gate.

So enforcement is per-feature, via a third column in `feature-map.txt`:

- A feature marked **`sealed`** must have **zero** cross-feature references.
  The build fails otherwise. Sealing is permanent — a sealed feature can never
  regain an edge.
- An unsealed feature is **reported but not enforced**, so discovery is free.

Migration is therefore "seal features one at a time," and the exit condition is
every feature sealed. This is strictly stronger than a total-count ratchet: it
cannot be satisfied by trading one feature's violations for another's.

### Also checked by the same script

**Every `Package.swift` exclude path must exist.** SwiftPM only warns on an
invalid exclude and exits 0, so a file moved out from under an exclude silently
rejoins the lite build. This restructure moves ~250 files past exactly that
hazard. Three lines, same script.

### Cost

The prototype runs the full 511-file scan in ~16 s on this machine. That is
acceptable inside `make regression`, which already runs four Swift builds.

### What this buys `Package.swift`

Mobile Control's 16-entry exclude list and Explorer's three `Views/*` lines each
collapse to one line: `libExcludes.append("Features/MobileControl")`. The build
system stops needing to know anything about a feature except its folder name.
That is the isolation goal made mechanical.

## Migration sequence

Leaves first, entangled last. Roughly 23 commits (Tasks 0–22), each independently shippable
and each lowering the ratchet.

| Step | Commits | Content |
|---|---|---|
| 0 | 1 | Gate script + measured baseline. **No file moves.** Proves the measurement before it is trusted. |
| 1 | 2 | `Core/` then `Shell/` extraction — establishes the layers everything else moves against. |
| 2 | 6 | Zero-edge leaves: Search, Conflicts, Visual, Gantt, Issues, Terminal. Cheap, and they validate the ratchet on real moves. |
| 3 | 6 | Medium: Live, Explorer, Source Control, Doc Gen, Settings, Library. |
| 4 | 1 | Mobile Control — frees `MobileLoopBridge`, collapses the 16-entry exclude list. |
| 5 | 2 | The two Core protocols, one commit each. |
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
  from correct compiled-out behavior. Each of the two commits carries a named
  manual GUI check, e.g. for `LoopRunning`: the Loop Engineering auto task
  actually starts a run rather than a no-op.

Operational notes for whoever runs this:

- Run `make regression` **unpiped** — piping to `tail` returns tail's exit code
  and has masked a red gate in this repo before.
- Run `make regression` before pushing; a cold `mac/.build` makes the push-time
  gate die with SIGPIPE, reporting PASS while pushing nothing.
- `git push` must be foreground with a long timeout.

## Decisions

- **Branch:** all ~23 commits land on `refactor/mac-feature-slices`, merged to
  `main` once the ratchet reaches zero.

## Open decisions

- **The two manual checks in step 5** require the user at the GUI; they cannot be
  automated on this toolchain.

## Out of scope

Behavior changes of any kind. This restructure moves files, introduces two
protocols to replace two direct calls, and adds one gate script. Any feature
improvement discovered along the way is recorded, not implemented.
