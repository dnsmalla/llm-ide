# Phase 2b: View-Feature Build-Time Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four view features — Explorer, Gantt & Issues, DocGen, Terminal — excludable from the compiled binary via `LLMIDE_FEATURES`, reusing the Phase 2a mechanism (FeatureCatalog seam + env-driven `exclude:`), so a non-engineer build ships without them (and without SwiftTerm).

**Architecture:** Same as Phase 2a (see `docs/superpowers/plans/2026-09-02-phase2a-graph-exclusion.md` for the proven pattern): move the few core-consumed pieces out of the excludable folders, add per-feature branches to the ONE `#if` file (`FeatureCatalog.swift`), replace AppShell's direct view constructions with catalog factories, extend `Package.swift`'s selection logic.

**Tech Stack:** Swift/SwiftUI, SPM env-driven manifest, XCTest.

**Spec:** `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Phase 2, extraction order item 2)

## Global Constraints

- `#if FEATURE_*` stays confined to `mac/Sources/LlmIdeMac/FeatureCatalog.swift` (grep-gated).
- Feature keys → defines → excluded paths (target-relative):
  - `file_explorer` → `FEATURE_EXPLORER` → `Views/Explorer`
  - `gantt_issues` → `FEATURE_GANTT` → `Views/Gantt`, `Views/Issues`
  - `doc_gen` → `FEATURE_DOCGEN` → `Views/DocGen`
  - `terminal` → `FEATURE_TERMINAL` → `Views/Terminal`
- Both builds must succeed from `mac/` (sandbox off):
  - Full: `GIT_CONFIG_GLOBAL=/dev/null swift build`
  - Lite: `GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat,auto_tasks,mobile_sync swift build --manifest-cache none` (excludes graph + all four view features)
  then full again with `--manifest-cache none`.
- Runtime fallbacks when compiled out: sections hidden from toolbar/Home picker (generalize the 2a pattern), `DisabledFeaturePlaceholderView(isCompiled: false)` on any residual route, Settings rows show "Not installed", Help topics hidden.
- Full-build behavior must not change; Phase 1 toggle semantics stay.
- Toolchain has NO XCTest: attempt `swift test --filter <name>`, fall back to `swift build`, say "build verified, XCTest unavailable locally". Never claim tests ran when they did not.
- Comments English. Commit style: Japanese conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Verified current-state facts (do not re-derive)

- Inbound references to the four features' types outside their folders are ONLY:
  - AppShell view constructions: `RepoIssuesView(api: api)` (~:644), `GanttContainerView(api: api)` (~:653), `DocGenView` (in the section switch), `ExplorerView` (section switch), `TerminalPanelView(projectDirectory:)` (~:549, ~:560) + `@State terminalPanelState = TerminalPanelState()` (~:39) + a key-handler taking `terminalPanelState:` (~:171).
  - `Views/Shell/StatusBar.swift:9` `@Environment(TerminalPanelState.self)`.
  - `Views/Explorer/ExplorerView.swift:45,107` uses `TerminalPanelState` + `TerminalPanelView` (feature→feature edge; goes through the catalog).
  - `ViewModels/GanttViewModel.swift` and `ViewModels/DocGenViewModel.swift` are feature-owned (no other consumers found; all other grep hits are comments).
  - `BottomDockTabBar` is consumed only inside `Views/Terminal/`.
  - `ExplorerView.root` in MobileControlManager is a COMMENT only.
- Phase 2a already shipped: `FeatureCatalog.swift` with `compiledFeatures`/`isGraphCompiled`/graph factories; `FeatureRegistry.compiledFeatures` intersection; `DisabledFeaturePlaceholderView(isCompiled:)`; Home-opens picker filtered for `.codeGraph`; `HelpGuideView.visibleTopics` filtered for `.codeGraph`; Package.swift `LLMIDE_FEATURES` parsing with `graphIncluded`, `libExcludes`, `testExcludes`, `featureDefines`, gated graph-kit products; Makefile `build-mac`/`build-mac-lite`.
- SwiftTerm is imported ONLY by `Views/Terminal/TerminalSession.swift` + `TerminalSessionView.swift` → the `.product(name: "SwiftTerm", …)` dependency can be gated on `terminal`.
- `AppFeature.requiredDependencies`: `ganttIssues`/`docGen`/`codeGraph3D` require `.fileExplorer` (runtime validation). Build-time selection is NOT auto-closed over dependencies — the Phase 3 script passes registry-validated sets; hand-written env values are the caller's responsibility (document this in Package.swift's comment).

---

### Task 1: Move feature-owned/core-shared files

**Files:**
- Move: `ViewModels/GanttViewModel.swift` → `Views/Gantt/GanttViewModel.swift`
- Move: `ViewModels/DocGenViewModel.swift` → `Views/DocGen/DocGenViewModel.swift`
- Move: `Views/Terminal/TerminalPanelState.swift` → `Views/Shell/TerminalPanelState.swift` (core: AppShell/StatusBar own dock state even when the terminal feature is compiled out)

**Interfaces:** no API changes; same module, `git mv` only.

- [ ] **Step 1:** Confirm with grep that `GanttViewModel` and `DocGenViewModel` have no consumers outside their feature's views (report the outputs; if a consumer exists, STOP and report DONE_WITH_CONCERNS naming it).
- [ ] **Step 2:** `git mv` the three files.
- [ ] **Step 3:** Build: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build` → Build complete.
- [ ] **Step 4:** Commit: `git add -A mac/Sources && git commit -m "refactor(mac): View 機能の ViewModel を機能フォルダへ、TerminalPanelState をコアへ移動"`

---

### Task 2: FeatureCatalog factories + AppShell/Help/Settings generalization

**Files:**
- Modify: `mac/Sources/LlmIdeMac/FeatureCatalog.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` (terminal edge via catalog)
- Modify: `mac/Sources/LlmIdeMac/Views/HelpGuideView.swift` (generalize topic→feature map)
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/FeatureProfileSettingsView.swift` (generalize the Home-opens filter if it is still graph-specific)
- Test: extend `mac/Tests/LlmIdeMacTests/FeatureRegistryTests.swift`

**Interfaces:**
- Produces on `FeatureCatalog` (all static, following the existing graph factories' style; inert `AnyView(EmptyView())` / `nil` when compiled out):
  - `explorerPane(...) -> AnyView` (parameters = whatever `ExplorerView`'s current AppShell construction needs — read the call site and mirror it)
  - `issuesPane(api: LlmIdeAPIClient) -> AnyView`
  - `ganttPane(api: LlmIdeAPIClient) -> AnyView`
  - `docGenPane(...) -> AnyView` (mirror the AppShell call site)
  - `terminalPanel(projectDirectory: URL) -> AnyView` (used by BOTH AppShell call sites and ExplorerView)
  - `compiledFeatures` extended with `#if !FEATURE_EXPLORER / !FEATURE_GANTT / !FEATURE_DOCGEN / !FEATURE_TERMINAL` removals.

- [ ] **Step 1: Failing test.** Append to `FeatureRegistryTests` (mirrors the 2a compiled-set test, pinning that ANY feature can be compiled out, not just graph):

```swift
    func testCompiledOutViewFeatureIsHiddenFromEnabledSet() {
        let registry = makeRegistry()
        registry.compiledFeatures = Set(AppFeature.allCases)
            .subtracting([.terminal, .ganttIssues])
        registry.updateFeatureSet(Set(AppFeature.allCases), markCustom: false)
        XCTAssertFalse(registry.isEnabled(.terminal))
        XCTAssertFalse(registry.isEnabled(.ganttIssues))
        XCTAssertTrue(registry.isEnabled(.fileExplorer))
    }
```

- [ ] **Step 2: Catalog.** Add the four `#if` blocks + factories listed under Interfaces, extending `compiledFeatures`. Follow the graph factories' existing shape exactly (no stored objects needed — these features have no module-owned services; construction happens per-render like AppShell did).
- [ ] **Step 3: AppShell.** Replace the five direct constructions with catalog factories. For each of the four features' section rendering, pass `isCompiled: registry.compiledFeatures.contains(<feature>)` to `DisabledFeaturePlaceholderView` at the corresponding placeholder call sites (the 2a change added the parameter with default `true` — set it explicitly at these sites). The `terminalPanelState` `@State` and key handler stay (core state). Do NOT touch the `registry.isEnabled` gating that already exists.
- [ ] **Step 4: ExplorerView.** Replace its `TerminalPanelView(projectDirectory:)` construction with `FeatureCatalog.terminalPanel(projectDirectory:)`. Its `TerminalPanelState` usage stays (core type now).
- [ ] **Step 5: Help + Home picker.** Generalize `HelpGuideView.visibleTopics`: build a `topicFeature: [HelpTopic: AppFeature]` map for topics tied to excludable features (code graph — existing; explorer/gantt/terminal/docGen topics if such topics exist — read `HelpTopic.allCases` and map what's there) and filter on `FeatureRegistry.shared.compiledFeatures`. Generalize the Home-opens picker filter: a section is offered only if its backing feature (same mapping AppShell's availability switch uses) is in `registry.compiledFeatures` — replace the graph-specific check from 2a with the general one.
- [ ] **Step 6: Build + grep gate.** Build full. Then: `grep -rn "ExplorerView\|GanttContainerView\|RepoIssuesView\|DocGenView\|TerminalPanelView\|TerminalSessionView\|BottomDockTabBar\|GanttViewModel\|DocGenViewModel" mac/Sources/LlmIdeMac --include="*.swift" | grep -v "^mac/Sources/LlmIdeMac/Views/\(Explorer\|Gantt\|Issues\|DocGen\|Terminal\)/" | grep -v FeatureCatalog.swift` → comments only.
- [ ] **Step 7: Commit:** `feat(mac): View 機能4種を FeatureCatalog 経由に分離`

---

### Task 3: Package.swift + Makefile + lite verification

**Files:**
- Modify: `mac/Package.swift`
- Modify: `Makefile`

**Interfaces:** extends the existing `LLMIDE_FEATURES` contract with the four keys; SwiftTerm product present only when `terminal` selected.

- [ ] **Step 1:** Extend the selection block: per key compute `included`, append defines (`FEATURE_EXPLORER`, `FEATURE_GANTT`, `FEATURE_DOCGEN`, `FEATURE_TERMINAL`) and `libExcludes` entries per the Global Constraints table. Update the unset-default list to include ALL excludable keys (`code_graph_3d,file_explorer,gantt_issues,doc_gen,terminal`). Gate `.product(name: "SwiftTerm", …)` on terminal. Extend the Package.swift header comment: dependency closure over `AppFeature.requiredDependencies` is NOT applied here — callers (the Phase 3 script, Makefile targets) pass validated sets.
- [ ] **Step 2:** Test excludes: grep `mac/Tests/LlmIdeMacTests` for the four features' types (`grep -rln "GanttViewModel\|DocGenViewModel\|TerminalSession\|TerminalPanel\|ExplorerView\|RepoIssuesView\|GanttContainerView" mac/Tests/LlmIdeMacTests`) and add any hit files to the corresponding feature's `testExcludes`. Record the list in your report.
- [ ] **Step 3:** Makefile: update `build-mac-lite` to `LLMIDE_FEATURES=agent_chat,auto_tasks,mobile_sync` and its `##` help text ("non-engineer build: no Explorer/Gantt/DocGen/Terminal/Graph").
- [ ] **Step 4:** Verify: full build → lite build → full build (`--manifest-cache none` on the latter two). All three tails in the report. A lite failure names remaining coupling — fix via catalog seam or Task-1-style move, never a stray `#if`.
- [ ] **Step 5:** Commit: `feat(mac): View 機能4種と SwiftTerm の LLMIDE_FEATURES ビルド時除外を実装`

---

### Task 4: Docs + gates

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Status → `…; Phase 2b (view features) implemented; Phase 3, 2c–d pending`)
- Modify: `docs/spec/macos-app.md` (extend the build-time selection subsection: the five excludable features, SwiftTerm drop, lite = non-engineer build)
- Modify: `CLAUDE.md` (`make build-mac-lite` comment line updated)

- [ ] **Step 1:** Run + record: the `#if FEATURE_` confinement grep; the Task 2 Step 6 reference grep; `grep -rn "import SwiftTerm" mac/Sources/LlmIdeMac --include="*.swift" | grep -v "Views/Terminal"` → empty.
- [ ] **Step 2:** Make the three doc edits.
- [ ] **Step 3:** Full build once more; commit: `docs: View 機能のビルド時除外(Phase 2b)を文書化`
