# Phase 2a: Graph Build-Time Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Graph feature (`mac/Sources/LlmIdeMac/Graph/`) excludable from the compiled binary via `LLMIDE_FEATURES`, proving the whole Phase 2 mechanism (core carve-out → catalog decoupling → env-driven `exclude:`) end-to-end on the cleanest feature.

**Architecture:** Move the pieces of `Graph/` that core code consumes (fault/QA memory, generic FS watcher, repo→graph path mapping, the code-graph API extension's home) so `Graph/` has zero inbound compile-time edges except the composition root; concentrate all conditional compilation in ONE new `FeatureCatalog.swift`; then let `Package.swift` exclude `Graph/` (and its tests) when deselected.

**Tech Stack:** Swift/SwiftUI, SPM (env-driven manifest + `--manifest-cache none`), XCTest.

**Spec:** `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Phase 2, revised selection mechanism + extraction order)

## Global Constraints

- `#if FEATURE_GRAPH` may appear in exactly ONE file: `mac/Sources/LlmIdeMac/FeatureCatalog.swift`. Zero `#if FEATURE_*` anywhere else (grep-gated in the final task).
- After this plan, `grep -rn "GraphAutoUpdater\|GraphSessionStore\|UAGraphView\|GraphModule\|KnowledgeGraphService\|GraphEngine" mac/Sources/LlmIdeMac --include="*.swift" | grep -v "^mac/Sources/LlmIdeMac/Graph/" | grep -v "FeatureCatalog.swift"` must return only comment lines (no type references).
- Both builds must succeed from `mac/`:
  - Full: `GIT_CONFIG_GLOBAL=/dev/null swift build`
  - Lite: `GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=file_explorer,agent_chat,gantt_issues,terminal,doc_gen,mobile_sync,auto_tasks swift build --manifest-cache none`
  (Sandbox off for both. Feature raw values come from `AppFeature`; absence of `code_graph_3d` excludes Graph.)
- Behavior when Graph is compiled IN and merely toggled OFF must not change (Phase 1 semantics stay).
- Runtime fallbacks when compiled OUT: Code Graph sidebar entry hidden; Settings shows the feature as "Not installed"; auto-task pipeline's graph step reports skip, never crashes.
- Existing `Graph/`-internal code must NOT be rewritten — only moved files change module-internally referenced paths (same module, so imports don't change).
- This machine's toolchain has NO XCTest: attempt `swift test --filter <name>`; on "no such module 'XCTest'" fall back to `swift build` and say "build verified, XCTest unavailable locally". Never claim tests passed when they did not run.
- Comments in English. Commit style: Japanese conventional commits, body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Verified current-state facts (do not re-derive)

- `mac/Package.swift`: single library target `LlmIdeMacLib` at `path: "Sources/LlmIdeMac"` (products: Yams? no — Sparkle, SwiftTerm, GraphCore, GraphKit, SharedProtocol), thin `LlmIdeMacMain` executable, `LlmIdeMacTests` at `Tests/LlmIdeMacTests` with `exclude: ["README-truncated-tests.md"]`.
- `Graph/` inventory: `Engine/{BuiltinGraphEngine,GraphEngine,GraphEngineLocator,PluginGraphEngine}`, `Memory/{FaultReport,FaultStatus+UI,MemoryStore,QAEntry}`, `Notes/{AnalyzePhase,BatchPlanner,CodeNoteError,CodeNoteGenerator,CodeNoteService}`, `Services/{CodeGraphUploadService,FileClassifier,GraphAutoUpdater,GraphModule,KnowledgeGraphService,RepoFileWatcher}`, `Views/{CGPalette,CodeGraphCanvas,Graph3DView,GraphSessionStore,UAGraphView}`.
- Core code consuming Graph/ types today:
  - `Services/RegressionRunner.swift` (`MemoryStore`, `FaultReport`), `Services/FaultRepairer.swift` + `Services/VerifyCommandAuthor.swift` (`FaultReport`), `Models/Config.swift` (`MemoryStore` at ~:906), `Views/CodeAssistant/CodeAssistantPanel+Session.swift` (`QAEntry`).
  - `Services/MobileControlManager.swift` (`RepoFileWatcher` ×4: properties :112-113, constructions :258, :1535).
  - `AutoTask/Services/AutoCodeUpdateService+PipelineTasks.swift:531` (`GraphAutoUpdater.repoToGraph(projectRoot:)`).
  - `LlmIdeMacApp.swift` (:58 conformance ext, :90-91 @StateObjects, :206-209 construction, :257 GraphModule registration, :300-301 environmentObject injection).
  - `Views/AppShell.swift` (:17-18 @EnvironmentObject decls, :625 `UAGraphView()`).
  - `Views/Settings/GraphMemorySettingsSection.swift` (234 lines, "Graph & Memory" card: graph interval + upload truncation + `GraphMemoryState` memory-file listing).
  - `Services/API/LlmIdeAPIClient+CodeGraph.swift` (`import GraphCore`, `CGNode`/`CGData` payloads) — the only `import GraphCore/GraphKit` outside `Graph/`.
- Graph-only test files: `CodeGraphUploadServiceTests.swift`, `CodeNotePruneTests.swift`, `GraphAutoUpdaterRepoResolutionTests.swift`, `GraphMemoryStateCountsTests.swift`, `KnowledgeGraphEndToEndTests.swift`, `KnowledgeGraphServiceTests.swift`; `FeatureModulesTests.swift` currently contains the `GraphModule` test.
- Phase 1 wiring in place: `FeatureRegistry.refresh()`, modules registered in `LlmIdeMacApp.init()`.

---

### Task 1: Carve core-owned code out of Graph/

**Files:**
- Move (git mv, no content edits unless stated): `Graph/Memory/FaultReport.swift`, `Graph/Memory/MemoryStore.swift`, `Graph/Memory/QAEntry.swift`, `Graph/Memory/FaultStatus+UI.swift` → `Services/Memory/` (new folder)
- Move: `Graph/Services/RepoFileWatcher.swift` → `Services/RepoFileWatcher.swift`
- Move: `Services/API/LlmIdeAPIClient+CodeGraph.swift` → `Graph/Services/LlmIdeAPIClient+CodeGraph.swift` (feature-owned API surface; extensions may live in the feature folder)
- Create: `Services/RepoGraphLocator.swift`
- Modify: `Graph/Services/GraphAutoUpdater.swift` (delegate `repoToGraph` to the locator)
- Modify: `AutoTask/Services/AutoCodeUpdateService+PipelineTasks.swift:531` (call the locator)

**Interfaces:**
- Consumes: existing `GraphAutoUpdater.repoToGraph(projectRoot:)` semantics (static, returns optional repo URL).
- Produces: `enum RepoGraphLocator { static func repoToGraph(projectRoot: URL) -> URL? }` — exact same body/behavior as today's `GraphAutoUpdater.repoToGraph`; `GraphAutoUpdater.repoToGraph` becomes a one-line forwarder (kept so Graph-internal callers and tests are untouched).

- [ ] **Step 1: Check one fact and record it in your report** — do `Graph/Memory/*.swift` import `GraphCore`? Run `grep -l "import GraphCore\|import GraphKit" mac/Sources/LlmIdeMac/Graph/Memory/*.swift`. The moves happen regardless (same module), but Task 3 needs this answer to decide whether the `GraphCore` product can be dropped in lite builds. Also record the same check for `Services/Memory` consumers after the move.

- [ ] **Step 2: git mv the five files** as listed above (create `Services/Memory/`).

- [ ] **Step 3: Extract the locator.** Create `Services/RepoGraphLocator.swift`:

```swift
import Foundation

/// Maps a project root to the repo directory the code graph is generated
/// from. Lives in core (not Graph/) because the auto-task pipeline needs the
/// mapping even in builds where the Graph feature is excluded.
enum RepoGraphLocator {
    /// Moved verbatim from `GraphAutoUpdater.repoToGraph` — same behavior.
    static func repoToGraph(projectRoot: URL) -> URL? {
        // <copy the existing implementation body from GraphAutoUpdater>
    }
}
```

Copy the existing body verbatim (do not "improve" it). In `GraphAutoUpdater`, replace the body of `static func repoToGraph(projectRoot:)` with `RepoGraphLocator.repoToGraph(projectRoot: projectRoot)` and add a comment that the logic moved to core. In `AutoCodeUpdateService+PipelineTasks.swift:531`, replace `GraphAutoUpdater.repoToGraph(` with `RepoGraphLocator.repoToGraph(`.

- [ ] **Step 4: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: Build complete (moves are module-internal; no import changes needed).

- [ ] **Step 5: Commit**

```bash
git add -A mac/Sources/LlmIdeMac
git commit -m "refactor(mac): コア所有のメモリ/監視/パス解決コードを Graph/ から分離"
```

---

### Task 2: FeatureCatalog + composition/view decoupling

**Files:**
- Create: `mac/Sources/LlmIdeMac/FeatureCatalog.swift`
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/FeatureRegistry.swift` (compiled-set awareness)
- Modify: `mac/Sources/LlmIdeMac/Graph/Services/GraphModule.swift` (receives the `FeatureService` conformance)
- Split: `mac/Sources/LlmIdeMac/Views/Settings/GraphMemorySettingsSection.swift`
- Test: extend `mac/Tests/LlmIdeMacTests/FeatureRegistryTests.swift`; move the GraphModule test out of `FeatureModulesTests.swift` into new `mac/Tests/LlmIdeMacTests/GraphModuleTests.swift`

**Interfaces:**
- Consumes: Task 1's moved files; Phase 1's `FeatureRegistry`, `GraphModule(updater:isAuthenticated:)`.
- Produces (Task 3 and later slices rely on these):
  - `FeatureCatalog.compiledFeatures: Set<AppFeature>` (static)
  - `FeatureCatalog.bootGraph(projectStore:config:api:activity:registry:isAuthenticated:)` (static; no-op when compiled out)
  - `FeatureCatalog.installGraphEnvironment(_ view: AnyView) -> AnyView` (static; identity when compiled out)
  - `FeatureCatalog.graphMainPane() -> AnyView` (static; `AnyView(EmptyView())` when compiled out — AppShell already prevents reaching the pane via section gating)
  - `FeatureCatalog.graphSettingsSection() -> AnyView?` (static; nil when compiled out)
  - `FeatureRegistry.compiledFeatures: Set<AppFeature>` (var, default `Set(AppFeature.allCases)`) and `isEnabled(_:)` returning `activeFeatures ∩ compiledFeatures` membership.

- [ ] **Step 1: Write the failing tests**

Append to `FeatureRegistryTests`:

```swift
    func testCompiledOutFeatureIsNeverEnabledOrStarted() {
        let registry = makeRegistry()
        let graph = SpyModule(.codeGraph3D)
        registry.register(module: graph)
        registry.compiledFeatures = Set(AppFeature.allCases).subtracting([.codeGraph3D])
        registry.updateFeatureSet(Set(AppFeature.allCases), markCustom: false)
        XCTAssertFalse(registry.isEnabled(.codeGraph3D))
        XCTAssertEqual(graph.startCount, 0)
    }
```

Create `GraphModuleTests.swift` containing the existing `testGraphModuleRoutesStartStopAndGatesOnAuth` moved VERBATIM out of `FeatureModulesTests.swift` (new file needs its own `SpyService` copy since the original is `private`; name the class `GraphModuleTests`).

- [ ] **Step 2: FeatureRegistry compiled-set awareness**

In `FeatureRegistry`:

```swift
    /// Features present in this binary. LlmIdeMacApp sets this from
    /// FeatureCatalog at boot; a compiled-out feature can never be enabled,
    /// started, or shown as available. Kept as a settable property (not a
    /// FeatureCatalog reference) so this core type stays catalog-agnostic.
    var compiledFeatures: Set<AppFeature> = Set(AppFeature.allCases) {
        didSet { refresh() }
    }

    func isEnabled(_ feature: AppFeature) -> Bool {
        activeFeatures.contains(feature) && compiledFeatures.contains(feature)
    }
```

and in `refresh()` change the `shouldRun` line to `let shouldRun = isEnabled(feature) && module.runtimeReady`.

- [ ] **Step 3: Create FeatureCatalog.swift** — the ONLY `#if FEATURE_*` file:

```swift
import SwiftUI

/// The single seam between the app chrome and build-time-excludable
/// features. Every `#if FEATURE_*` in the app lives in THIS file; the rest
/// of the codebase talks to features through the catalog's factories.
/// When a feature is compiled out, its factory returns an inert value and
/// `compiledFeatures` omits it, so Settings shows "Not installed" and the
/// registry never starts it.
@MainActor
enum FeatureCatalog {

    static var compiledFeatures: Set<AppFeature> {
        var set = Set(AppFeature.allCases)
        #if !FEATURE_GRAPH
        set.remove(.codeGraph3D)
        #endif
        return set
    }

    // MARK: - Graph

    #if FEATURE_GRAPH
    private static var graphAutoUpdater: GraphAutoUpdater?
    private static var graphSessionStore: GraphSessionStore?
    #endif

    /// Build + wire the graph stack and register its module. No-op when the
    /// feature is compiled out. Mirrors what LlmIdeMacApp.init used to do
    /// inline (construction order and wiring preserved).
    static func bootGraph(projectStore: ProjectStore,
                          config: AppConfig,
                          api: LlmIdeAPIClient,
                          activity: ActivityStore,
                          registry: FeatureRegistry,
                          isAuthenticated: @escaping () -> Bool) {
        #if FEATURE_GRAPH
        let updater = GraphAutoUpdater(projectStore: projectStore,
                                       intervalMinutes: config.graphAutoUpdateMinutes)
        updater.activity = activity
        updater.uploader.api = api
        let sessionStore = GraphSessionStore()
        updater.sessionStore = sessionStore
        graphAutoUpdater = updater
        graphSessionStore = sessionStore
        registry.register(module: GraphModule(
            updater: updater, isAuthenticated: isAuthenticated))
        #endif
    }

    /// Inject the graph environment objects (identity when compiled out).
    static func installGraphEnvironment(_ view: AnyView) -> AnyView {
        #if FEATURE_GRAPH
        guard let updater = graphAutoUpdater, let store = graphSessionStore else { return view }
        return AnyView(view.environmentObject(updater).environmentObject(store))
        #else
        return view
        #endif
    }

    static func graphMainPane() -> AnyView {
        #if FEATURE_GRAPH
        return AnyView(UAGraphView())
        #else
        return AnyView(EmptyView())
        #endif
    }

    static func graphSettingsSection() -> AnyView? {
        #if FEATURE_GRAPH
        return AnyView(GraphSettingsSection())
        #else
        return nil
        #endif
    }
}
```

Adapt member names to the real code (e.g. the exact `uploader.api` chain from LlmIdeMacApp today). NOTE: until Task 3 adds the define, `FEATURE_GRAPH` is not set anywhere — so ALSO in Task 3 the define is added for full builds; for THIS task to keep the full build green, temporarily add `.define("FEATURE_GRAPH")` to `LlmIdeMacLib`'s `swiftSettings` in `mac/Package.swift` (Task 3 replaces it with the env-driven version). This is the one allowed Package.swift touch in this task.

- [ ] **Step 4: Rewire LlmIdeMacApp**

- Delete `extension GraphAutoUpdater: FeatureService {}` (line ~58) here and add it at the bottom of `Graph/Services/GraphModule.swift` instead.
- Delete the two graph `@StateObject` properties, the `GraphAutoUpdater`/`GraphSessionStore` construction + wiring lines in `init`, and the `GraphModule` registration line; in their place (same position in init as the old registration) call:

```swift
        FeatureCatalog.bootGraph(
            projectStore: projectStoreInstance,
            config: cfg,
            api: client,
            activity: activity,
            registry: featureRegistry,
            isAuthenticated: { store.isAuthenticated })
        featureRegistry.compiledFeatures = FeatureCatalog.compiledFeatures
```

- Replace `.environmentObject(graphAutoUpdater)` + `.environmentObject(graphSessionStore)` (lines ~300-301): wrap the modifier chain's result at that point via the catalog. The clean mechanical form: the long `ContentView()...environmentObject(...)` chain currently produces `some View`; split it so the graph objects are installed by the catalog:

```swift
            FeatureCatalog.installGraphEnvironment(AnyView(
                ContentView(...)
                    .environmentObject(theme)
                    // ... all existing non-graph environmentObject lines stay ...
            ))
```

  Preserve every other modifier exactly; if other `.environmentObject` chains at :459/:521 inject graph objects too, treat them the same way (check; the verified facts list only :300-301).

- [ ] **Step 5: Rewire AppShell + Settings**

- AppShell: delete the two graph `@EnvironmentObject` properties (:17-18); replace `UAGraphView()` (:625) with `FeatureCatalog.graphMainPane()`.
- Split `Views/Settings/GraphMemorySettingsSection.swift`:
  - The memory-file listing (`GraphMemoryState` and the UI parts that need no graph types) stays in core, renamed file `Views/Settings/MemorySettingsSection.swift`, struct `MemorySettingsSection`, card title "Memory".
  - The graph parts (interval editor using `graphAutoUpdater.setIntervalMinutes`, upload-truncation banner) move to a new `Graph/Views/GraphSettingsSection.swift` (struct `GraphSettingsSection`, card title "Code Graph", keeps the `@EnvironmentObject var graphAutoUpdater`).
  - In `Views/SettingsView.swift`, replace the single old section usage with `MemorySettingsSection()` followed by `if let graph = FeatureCatalog.graphSettingsSection() { graph }`. If `GraphMemoryStateCountsTests.swift` tests `GraphMemoryState`, update its references to the new file location only if the type name changed (keep the type name `GraphMemoryState` to avoid test churn).
- `Views/Settings/FeatureProfileSettingsView.swift`: for a feature not in `registry.compiledFeatures`, render the row disabled with a trailing `Text("Not installed")` instead of the toggle (keep it in the list so users learn the edition lacks it).

- [ ] **Step 6: Build + grep gates**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: Build complete.
Run the Global-Constraints grep (references outside `Graph/` + `FeatureCatalog.swift`): only comments may remain.
Run: `swift test --filter FeatureRegistryTests` (expect the XCTest caveat; then `swift build` stands as verification).

- [ ] **Step 7: Commit**

```bash
git add -A mac
git commit -m "feat(mac): FeatureCatalog を導入し Graph への直接参照を合成ルートから排除"
```

---

### Task 3: Package.swift env-driven exclusion + build entry points

**Files:**
- Modify: `mac/Package.swift`
- Modify: `Makefile` (repo root — add `build-mac-lite` target)
- Test: none new (the lite build IS the test)

**Interfaces:**
- Consumes: `FEATURE_GRAPH` define contract from Task 2; `AppFeature` raw values (`code_graph_3d` etc.).
- Produces: `LLMIDE_FEATURES` env contract — comma-separated included-feature rawValues, unset = all; recognized excludable key this slice: `code_graph_3d` → excludes `Graph` sources + graph tests + (if Task 1 Step 1 found no `GraphCore` import under `Services/Memory/`) the `GraphKit`/`GraphCore` products.

- [ ] **Step 1: Env-driven manifest.** At the top of `mac/Package.swift` (it is a Swift file):

```swift
// Build-time feature selection (Phase 2): LLMIDE_FEATURES lists the
// INCLUDED features by AppFeature rawValue, comma-separated; unset = all.
// Deselected features' source folders are excluded from compilation and
// their defines omitted, so FeatureCatalog compiles the inert branches.
// SwiftPM does not key its manifest cache on env vars — selection changes
// must build with `--manifest-cache none` (the Makefile targets do).
let envFeatures = ProcessInfo.processInfo.environment["LLMIDE_FEATURES"]
let includedFeatures: Set<String> = envFeatures.map {
    Set($0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
} ?? ["code_graph_3d"]   // unset → everything (list each excludable key here)

let graphIncluded = includedFeatures.contains("code_graph_3d")

var libExcludes: [String] = []
var testExcludes: [String] = ["README-truncated-tests.md"]
var featureDefines: [SwiftSetting] = []
if graphIncluded {
    featureDefines.append(.define("FEATURE_GRAPH"))
} else {
    libExcludes.append("Graph")
    testExcludes.append(contentsOf: [
        "CodeGraphUploadServiceTests.swift",
        "CodeNotePruneTests.swift",
        "GraphAutoUpdaterRepoResolutionTests.swift",
        "KnowledgeGraphEndToEndTests.swift",
        "KnowledgeGraphServiceTests.swift",
        "GraphModuleTests.swift",
    ])
}
```

(`import Foundation` is already available in manifests; add it if missing.) Wire `exclude: libExcludes`, the test target's `exclude: testExcludes`, and merge `featureDefines` into the existing `swiftSettings` (REPLACING Task 2's temporary unconditional `.define("FEATURE_GRAPH")`). `GraphMemoryStateCountsTests.swift` stays included (its type lives in core after the split); verify and adjust if the lite build says otherwise.
Product gating: if Task 1 Step 1 found `Services/Memory` free of `GraphCore` imports AND no other non-Graph file imports GraphCore/GraphKit, make the two graph-kit `.product` lines conditional on `graphIncluded` (build the dependency array in a `var`); otherwise keep `GraphCore` always and gate only `GraphKit`, preserving the existing `// UNPLUG` comment either way.

- [ ] **Step 2: Makefile entry points.** Add to the repo-root `Makefile`, following its existing style:

```makefile
build-mac: ## Build the full mac app
	cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build

build-mac-lite: ## Build the mac app without excludable features (currently: Graph)
	cd mac && GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=file_explorer,agent_chat,gantt_issues,terminal,doc_gen,mobile_sync,auto_tasks swift build --manifest-cache none
```

(If a `build-mac` target already exists, extend rather than duplicate.)

- [ ] **Step 3: Verify BOTH builds**

Run full: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build` → Build complete.
Run lite: the `build-mac-lite` command line → Build complete. If the lite build fails, the error names the remaining coupling — fix it in the pattern of Task 2 (catalog seam or Task 1 move), never by adding `#if` outside FeatureCatalog.
Then run full AGAIN with `--manifest-cache none` to prove selection flips back cleanly.

- [ ] **Step 4: Commit**

```bash
git add mac/Package.swift Makefile
git commit -m "feat(mac): LLMIDE_FEATURES による Graph のビルド時除外を実装"
```

---

### Task 4: Verification hardening + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (status)
- Modify: `docs/spec/macos-app.md` (build-time selection paragraph)
- Modify: `CLAUDE.md` (build commands section: add `make build-mac-lite`)

**Interfaces:** consumes everything above; produces documentation only.

- [ ] **Step 1: grep gates as a checklist run** (record outputs in the report):
  - `grep -rn "#if FEATURE_" mac/Sources --include="*.swift" | grep -v FeatureCatalog.swift` → empty.
  - The Global-Constraints reference grep → comments only.
  - `grep -rn "import GraphCore\|import GraphKit" mac/Sources/LlmIdeMac --include="*.swift" | grep -v "^mac/Sources/LlmIdeMac/Graph/"` → empty (or exactly the documented exceptions if Task 1 Step 1 found Memory imports).

- [ ] **Step 2: Docs.**
  - Design spec Status line → `Phase 1 implemented; Phase 2a (Graph exclusion) implemented; Phase 2b–d, 3 pending`.
  - `docs/spec/macos-app.md`: append to the Phase-1 lifecycle paragraph: build-time selection via `LLMIDE_FEATURES` (+ `--manifest-cache none` rule, `make build-mac-lite`), FeatureCatalog as the single `#if` seam, Settings "Not installed" behavior.
  - CLAUDE.md "Development & Building": add the `make build-mac-lite` line with a one-phrase explanation.

- [ ] **Step 3: Build once more (full), commit**

```bash
git add docs CLAUDE.md
git commit -m "docs: Graph のビルド時除外(Phase 2a)を文書化"
```
