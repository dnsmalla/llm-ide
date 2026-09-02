# Phase 2c: AutoTask + LoopEngine Build-Time Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AutoTask/` + `LoopEngine/` (ONE excludable unit — their mutual dependency cycle stays internal) removable from the compiled binary via the `auto_tasks` key of `LLMIDE_FEATURES`, with the iPhone bridge degrading gracefully when the unit is absent.

**Architecture:** Same FeatureCatalog mechanism as Phases 2a/2b. The one genuinely new structure: `MobileControlManager`'s ~550 lines of AutoTask/Loop handling move into two bridge classes living inside the excludable folders, connected to the core manager through a narrow core protocol (`MobileFeatureBridge`) plus promoted-to-internal transport helpers; the catalog wires bridges in when compiled, and the manager replies "not installed" when they are nil.

**Tech Stack:** Swift/SwiftUI, SPM env-driven manifest, XCTest.

**Spec:** `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Phase 2, extraction-order item 4)

## Global Constraints

- `#if FEATURE_*` confined to `mac/Sources/LlmIdeMac/FeatureCatalog.swift` (grep-gated). Couplings are fixed by file moves or catalog/protocol seams, never stray `#if`.
- Feature key `auto_tasks` → define `FEATURE_AUTOTASK` → excludes BOTH `AutoTask` and `LoopEngine` folders.
- Builds that must ALL succeed from `mac/` (sandbox off), each with `--manifest-cache none` when the selection differs from the previous build:
  - Full: `GIT_CONFIG_GLOBAL=/dev/null swift build`
  - View-lite (existing): `LLMIDE_FEATURES=agent_chat,auto_tasks,mobile_sync swift build --manifest-cache none`
  - AutoTask-less with Mobile IN: `LLMIDE_FEATURES=agent_chat,mobile_sync swift build --manifest-cache none` — this combination is the whole point: MobileControlManager compiles and runs with nil bridges.
- Full-build behavior parity: every phone auto-task/loop message, push observer, Settings surface, and AppShell route behaves exactly as today when the unit is compiled in.
- Degrade contract when compiled out: phone auto-task/loop requests get an explicit "not installed on this Mac" style reply through the existing ack/log mechanisms (never silence, never crash); the Auto Tasks and Loop sections disappear from toolbar/Home picker; Settings rows show "Not installed".
- Runtime capture note: `AutoCaptureService` (core) is started by `AutoTaskModule`; with the unit compiled out, automatic meeting-capture-on-app-launch does not arm (manual capture unaffected). This is per feature semantics ("Auto-Tasks & Activity Capture") — document it, don't fight it.
- Toolchain has NO XCTest: attempt `swift test --filter <name>`, fall back to `swift build`, say "build verified, XCTest unavailable locally". SourceKit diagnostics are stale here — only `swift build` verdicts count.
- Comments English. Commit style: Japanese conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Verified current-state facts (audited 2026-09-03 — do not re-derive)

- All `Services/`, `Models/`, `Chat/`, and non-AppShell `Views/` references to AutoTask/Loop types are **comment-only**. The only code edges are the four below.
- **LlmIdeMacApp.swift**: `extension AutoCodeUpdateService: FeatureService {}` (~:60); `@StateObject` decls for `autoTaskSettings`/`autoCodeUpdate`/`autoTaskTemplates`/`autoTaskSkills`(=`AutoTaskSkillCatalog()`)/`logStore` (~:78-87); constructions `AutoTaskRunHistory(storeURL:)` (~:141), `AutoTaskSettings()` (~:143), `TaskLogStore()` (~:155), `AutoCodeUpdateService(...)` (~:163), `AutoTaskTemplateStore()` (~:200) + `onTemplateIdChanged` wiring + `registry.onSaveError`/`runHistory.onSaveError` closures; `mobileControl.autoCode/.autoTaskSettings/.logStore` (~:228-230); `AutoTaskModule(scheduler:capture:schedulerEnabled:)` registration (~:249); five `.environmentObject(...)` lines (~:297-304). LoopEngine has ZERO composition wiring here.
- **Views/AppShell.swift**: env decls `autoTaskTemplates`/`autoTaskSkills`/`autoCodeUpdate` (~:15-17); `reloadDocTemplatesForActiveProject()` calls `autoTaskTemplates.bindProject(root:)`, `autoTaskSkills.reload(projectRoot:force:)`, `autoCodeUpdate.taskConfigs.bindProject(id:)` (~:885-897); `case .autoCode: AutoCodeView(api: api)` gated by `registry.isEnabled(.autoTasks)` + placeholder (~:639-644) but constructed DIRECTLY (not via catalog); `case .loopEngine: LoopEngineHomeView(api: api)` (~:653) — **ungated, no placeholder** (pre-existing gap).
- **Services/MobileControlManager.swift**: feature-typed properties `var autoCode: AutoCodeUpdateService?` (:83), `var logStore: TaskLogStore?` (:85), `var autoTaskSettings: AutoTaskSettings?` (:88). Feature-coupled methods (line spans approximate): `handleAutoTask` (536-673), `handleAutoTaskSetup` (685-790), `isKnownAutoTaskId` (793-795), `validatedProjectPath` (803-809), `replyAutoTaskSetupDecodeFailure` (811-816), `replyAutoTaskSetup` (824-837), `buildAutoTaskSetupReply` (839-858), `handleLoop` (1078-1184), `buildLoopState` (1190-1247), static nonisolated `resolveLoopConfig` (1275-1279), `loopHistory` (1288-1314), `buildAutoTaskState` (1351-1377), `replyAutoTaskStateOrAck` (1381-1388), `buildAutoTaskLogsReply` (1391-1413), auto-task portion of `installMobilePushObservers` (1419-1462), `pushAutoTaskStateIfPaired` (1484-1487), `pushAutoTaskSetupIfPaired` (1492-1496), `refreshAutoTaskStateForMobile` (1504-1506), `pushAutoTaskLogsIfPaired` (1508-…). Shared helpers used by those methods, all currently `private`: `append(_:_:)` (:1316), `reply(_:)` (:1329), `replyNotConfigured(commandId:logLabel:)` (:1344), plus `decoder` (:127) and loop-only state `loopStartedHere` (:99). `LoopRunSummary` is a wire type (not feature-owned). Loop state is pull-only (no Loop push observers).
- **ShellState.Section**: has a `.loopEngine` case; `backingFeature` does NOT map it to a feature today (that is why the section is ungated). `AppFeature` has no loop case — Loop belongs to `.autoTasks` per the product model (the scheduler runs loops; phone Loop tab lives behind the Mac's auto-task stack).
- **Tests referencing the unit** (43 files listed in the audit; the borderline two): `FeatureModulesTests.swift` contains the `AutoTaskModule` test alongside Chat/Mobile/Passive tests (needs a split, like `GraphModuleTests` was); `FeatureRegistryTests.swift` uses only its own `SpyModule` + `AppFeature` cases (stays).
- Reverse direction is already clean: PipelineTasks gates graph work via `FeatureCatalog.isGraphCompiled` + core `RepoGraphLocator`; `AutoTask/Views/LibraryFolderPicker` uses core `LibraryItem.Category`; no AppFeature/catalog reach-ins from the unit's views.
- Phase 2a/2b slice pattern applies: the catalog `#if FEATURE_AUTOTASK` branches land BEFORE the manifest key exists → the task that adds them ALSO adds a temporary unconditional `.define("FEATURE_AUTOTASK")` to Package.swift marked `// TEMP(Phase2c-Task3)`, replaced by the env-driven define in the manifest task.

---

### Task 1: MobileControlManager split — core bridge protocol + two feature bridge classes

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/MobileFeatureBridge.swift` (core protocol + transport surface doc)
- Modify: `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` (remove feature properties/methods; add bridge slots + degrade replies; promote helpers)
- Create: `mac/Sources/LlmIdeMac/AutoTask/Services/MobileAutoTaskBridge.swift`
- Create: `mac/Sources/LlmIdeMac/LoopEngine/Services/MobileLoopBridge.swift`
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` (replace `mobileControl.autoCode = …` wiring with bridge construction + registration — TEMPORARY direct construction; Task 2 moves it into the catalog)
- Test: `mac/Tests/LlmIdeMacTests/MobileFeatureBridgeTests.swift` (new)

**Interfaces:**
- Consumes: existing manager internals (read the file first; line spans in Verified facts).
- Produces (Task 2/3 rely on these exactly):

```swift
/// Core seam: a compiled-in feature registers a bridge that serves its
/// slice of the mobile protocol. When a feature is compiled out the slot
/// stays nil and the manager answers with a "not installed" ack instead.
@MainActor
protocol MobileFeatureBridge: AnyObject {
    /// Handle one inbound message. Return false when the type is not ours
    /// (the manager then falls through to its normal unknown-type path).
    func handle(type: String, data: Data?) -> Bool
    /// Install Combine push observers (called once from the manager's
    /// installMobilePushObservers).
    func installPushObservers()
}
```

- `MobileControlManager` gains `var autoTaskBridge: MobileFeatureBridge?`, `var loopBridge: MobileFeatureBridge?` and, replacing the old direct routing, forwards the auto-task/loop message types to the bridge (`if bridge?.handle(type:data:) == true { return }`) with a nil-bridge fallback `replyFeatureUnavailable(feature: "Auto Tasks" / "Loop", commandId:)` that logs via `append` and acks like `replyNotConfigured` does.
- Helper access: `append(_:_:)`, `reply(_:)`, `replyNotConfigured(commandId:logLabel:)`, and `decoder` change from `private` to `internal`, each with a one-line comment `// internal: shared with the Mobile*Bridge classes (feature folders)`. `MobileAutoTaskBridge(manager:autoCode:settings:logStore:)` and `MobileLoopBridge(manager:autoCode:)` hold `weak var manager: MobileControlManager?` and the strong feature refs; `loopStartedHere` moves INTO `MobileLoopBridge` (it is loop-only state).

- [ ] **Step 1: Write the failing test** — pure seam behavior, no sockets:

```swift
// mac/Tests/LlmIdeMacTests/MobileFeatureBridgeTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
private final class SpyBridge: MobileFeatureBridge {
    var handled: [String] = []
    var installs = 0
    var accepts: Bool = true
    func handle(type: String, data: Data?) -> Bool {
        handled.append(type); return accepts
    }
    func installPushObservers() { installs += 1 }
}

@MainActor
final class MobileFeatureBridgeTests: XCTestCase {
    func testManagerRoutesAutoTaskTypesToBridge() {
        let manager = MobileControlManager()
        let spy = SpyBridge()
        manager.autoTaskBridge = spy
        XCTAssertTrue(manager.routeToFeatureBridge(type: "auto_task_list", data: nil))
        XCTAssertEqual(spy.handled, ["auto_task_list"])
    }

    func testLoopTypesGoToLoopBridge() {
        let manager = MobileControlManager()
        let spy = SpyBridge()
        manager.loopBridge = spy
        XCTAssertTrue(manager.routeToFeatureBridge(type: "loop_status_list", data: nil))
        XCTAssertEqual(spy.handled, ["loop_status_list"])
    }

    func testNilBridgeStillReportsHandledSoCallerAcksUnavailable() {
        let manager = MobileControlManager()
        // No bridges installed: routing must still claim the message (true)
        // so the generic unknown-type path never sees a feature type; the
        // manager's replyFeatureUnavailable path is exercised internally.
        XCTAssertTrue(manager.routeToFeatureBridge(type: "auto_task_run", data: nil))
        XCTAssertTrue(manager.routeToFeatureBridge(type: "loop_stop", data: nil))
    }

    func testNonFeatureTypesAreNotClaimed() {
        let manager = MobileControlManager()
        XCTAssertFalse(manager.routeToFeatureBridge(type: "chat_send", data: nil))
    }
}
```

Adapt the exact message-type strings to the real dispatch switch (read it first); `routeToFeatureBridge(type:data:) -> Bool` is the new internal routing entry the dispatch switch calls, and it owns the feature-type membership sets (two `Set<String>` constants derived from the current switch cases — copy the exact strings).

- [ ] **Step 2: Extract the bridges.** Move the method bodies listed in Verified facts VERBATIM into the two bridge classes (adjusting `self` references to `manager?.append(...)`/`manager?.reply(...)` etc. and the stored-property reads to the bridge's own refs). `installMobilePushObservers()`'s auto-task subscriptions move to `MobileAutoTaskBridge.installPushObservers()`; the manager's remaining method calls `autoTaskBridge?.installPushObservers()` + `loopBridge?.installPushObservers()` at the end. Delete the three feature-typed properties from the manager. Static `resolveLoopConfig` and `loopHistory`/`buildLoopState`/`LoopRunSummary` plumbing move to `MobileLoopBridge` (keep `LoopRunSummary` itself wherever it lives today — it is a wire type).
- [ ] **Step 3: Rewire the dispatch + temporary composition.** In the manager's inbound switch, replace the auto-task/loop cases with the single `routeToFeatureBridge` call placed BEFORE the unknown-type fallback. In `LlmIdeMacApp.init()`, replace `mobileControl.autoCode = autoCode; mobileControl.autoTaskSettings = …; mobileControl.logStore = …` with:

```swift
        // TEMP(Phase2c-Task2): bridge construction moves into
        // FeatureCatalog.bootAutoTask in the next task.
        mobileControl.autoTaskBridge = MobileAutoTaskBridge(
            manager: mobileControl, autoCode: autoCode,
            settings: autoTaskSettingsInstance, logStore: taskLogStore)
        mobileControl.loopBridge = MobileLoopBridge(
            manager: mobileControl, autoCode: autoCode)
```

Check for any OTHER `mobileControl.autoCode`/`autoTaskSettings`/`logStore` accessors elsewhere (grep) and route them through the bridge or delete.
- [ ] **Step 4: Build + focused verification.** `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build` → green. `swift test --filter MobileFeatureBridgeTests` (XCTest caveat applies). Grep: `grep -n "AutoCodeUpdateService\|AutoTaskSettings\|TaskLogStore\|LoopEngineConfigStore\|LoopEngineRunner\|CustomAutoTask\|AutoTask\b" mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` → comments only.
- [ ] **Step 5: Commit** — `refactor(mac): MobileControlManager の AutoTask/Loop 処理をブリッジに分離`

---

### Task 2: FeatureCatalog bootAutoTask + AppShell/section gating

**Files:**
- Modify: `mac/Sources/LlmIdeMac/FeatureCatalog.swift`
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift` (`backingFeature`: `.loopEngine → .autoTasks`, and `.autoCode → .autoTasks` if not already mapped)
- Modify: `mac/Sources/LlmIdeMac/AutoTask/Services/AutoTaskModule.swift` (receives the `FeatureService` conformance for `AutoCodeUpdateService`)
- Modify: `mac/Package.swift` (TEMP unconditional `.define("FEATURE_AUTOTASK")` marked `// TEMP(Phase2c-Task3)`)
- Test: update `mac/Tests/LlmIdeMacTests/ShellStateHomeTests.swift` mapping-pinning test (backingFeature range gains `.autoTasks`)

**Interfaces (produced):**
- `FeatureCatalog.bootAutoTask(config:projectStore:api:capture:mobileControl:registry:appSupportDir:)` — constructs the ENTIRE stack that LlmIdeMacApp built inline (ProcessedActionsRegistry+AutoTaskRunHistory with their storeURLs and onSaveError closures, AutoTaskSettings, TaskLogStore, AutoCodeUpdateService, AutoTaskTemplateStore + onTemplateIdChanged, AutoTaskSkillCatalog), registers `AutoTaskModule`, installs the two mobile bridges, and stores the objects in catalog statics. Signature may be trimmed to what the real code needs — read the current init block and mirror it; construction ORDER and every wiring line must survive.
- `FeatureCatalog.installAutoTaskEnvironment(_ view: AnyView) -> AnyView` (injects the five env objects; identity when compiled out).
- `FeatureCatalog.autoTasksPane(api:) -> AnyView`, `FeatureCatalog.loopEnginePane(api:) -> AnyView`.
- `FeatureCatalog.rebindAutoTaskProject(root: URL?, projectId: String?)` — the three rebinding calls from AppShell's `reloadDocTemplatesForActiveProject`; no-op when compiled out.
- `compiledFeatures` drops `.autoTasks` under `#if !FEATURE_AUTOTASK`.

- [ ] **Step 1:** Move the composition block (Verified facts, LlmIdeMacApp list) into `bootAutoTask` inside `#if FEATURE_AUTOTASK`; delete the app's five `@StateObject` decls + five `.environmentObject` lines (catalog installer wraps them, graph-pattern); delete the Task-1 TEMP bridge construction (bridges now built in bootAutoTask); move the `FeatureService` conformance into `AutoTaskModule.swift`. Keep `AutoCaptureService` construction in the App (core) and pass it into bootAutoTask.
- [ ] **Step 2:** AppShell: `.autoCode` case → `FeatureCatalog.autoTasksPane(api:)` (keep the existing gate/placeholder); `.loopEngine` case → gate with `registry.isEnabled(.autoTasks)` + `DisabledFeaturePlaceholderView(featureName: "Loop Engine", isCompiled: registry.compiledFeatures.contains(.autoTasks))` and render via `FeatureCatalog.loopEnginePane(api:)`; delete the three env decls; `reloadDocTemplatesForActiveProject` calls `FeatureCatalog.rebindAutoTaskProject(root:projectId:)` (keep the non-autotask lines of that function untouched). ShellState `backingFeature` gains the loop mapping — note in the commit body that this ALSO makes the Phase-1 runtime toggle hide the Loop section (correct per feature semantics; previously ungated).
- [ ] **Step 3:** Update the ShellStateHomeTests mapping-pinning test for the enlarged backingFeature range. Build + grep gate: `grep -rn "AutoCodeUpdateService\|AutoTaskSettings\|AutoTaskTemplateStore\|AutoTaskSkillCatalog\|TaskLogStore\|AutoCodeView\|LoopEngineHomeView\|AutoTaskRunHistory\|AutoTaskModule\|MobileAutoTaskBridge\|MobileLoopBridge" mac/Sources/LlmIdeMac --include="*.swift" | grep -v "^mac/Sources/LlmIdeMac/AutoTask/" | grep -v "^mac/Sources/LlmIdeMac/LoopEngine/" | grep -v FeatureCatalog.swift` → comments only.
- [ ] **Step 4: Commit** — `feat(mac): AutoTask/Loop の合成とビューを FeatureCatalog 経由に分離`

---

### Task 3: Package.swift key + test excludes + build matrix

**Files:**
- Modify: `mac/Package.swift` (env key `auto_tasks` → excludes `["AutoTask", "LoopEngine"]` + define replaces TEMP; unset-default list gains `auto_tasks`)
- Modify: `mac/Sources/LlmIdeMac/Models/AppFeature.swift` (`buildTimeExcludable` gains `.autoTasks`)
- Modify: `mac/Tests/LlmIdeMacTests/FeatureRebuildServiceTests.swift` (pinned CSV → `auto_tasks,code_graph_3d,doc_gen,file_explorer,gantt_issues,terminal`)
- Split: move the AutoTaskModule test out of `FeatureModulesTests.swift` into new `mac/Tests/LlmIdeMacTests/AutoTaskModuleTests.swift` (own private SpyService copy, GraphModuleTests pattern)
- Modify: `Makefile` (lite target unchanged — auto_tasks stays IN the non-engineer build; add the verification line for the autotask-less combination to the `regression` target or as `build-mac-min`)

- [ ] **Step 1:** Manifest: add the key with BOTH folder excludes; test-target excludes = the 43 audited files MINUS `FeatureModulesTests.swift`/`FeatureRegistryTests.swift` PLUS the new `AutoTaskModuleTests.swift` and `MobileFeatureBridgeTests.swift`... STOP: `MobileFeatureBridgeTests` tests core routing with a local SpyBridge only — verify it references no AutoTask types; if clean it STAYS included. Recheck each borderline file by grep before finalizing the list; record the final list in the report.
- [ ] **Step 2:** `AppFeature.buildTimeExcludable` + pinned CSV test + `FeatureCatalog.compiledFeatures` `#if !FEATURE_AUTOTASK` removal (if not already added in Task 2) all land together.
- [ ] **Step 3:** Build matrix (record all tails): full → view-lite (`agent_chat,auto_tasks,mobile_sync`) → autotask-less (`agent_chat,mobile_sync`) → full again; all `--manifest-cache none` except the first. nm gate on the autotask-less binary: `nm .build/debug/LlmIdeMac | grep -c "AutoCodeUpdateService\|LoopEngineRunner"` → 0 (plus a nonzero full-build baseline).
- [ ] **Step 4:** Makefile: add `build-mac-min: ## Build with only Chat + Mobile (no AutoTask/Loop/Graph/view features)` using `LLMIDE_FEATURES=agent_chat,mobile_sync`; add it to `regression` after `build-mac-lite`.
- [ ] **Step 5: Commit** — `feat(mac): auto_tasks キーで AutoTask/LoopEngine をビルド時除外可能にする`

---

### Task 4: Docs + gates

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Status → `…; Phase 2c (AutoTask+LoopEngine) implemented; 2d pending`; extraction-order item 4 marked DONE)
- Modify: `docs/spec/macos-app.md` (six excludable features now; the MobileFeatureBridge seam; phone degrade behavior; capture-arming note)
- Modify: `CLAUDE.md` (build-mac-min line; Mobile Control section notes the bridge seam)

- [ ] **Step 1:** Run + record verbatim: `#if FEATURE_` confinement grep; the Task 2 Step 3 reference grep; `grep -rn "autoTaskBridge\|loopBridge" mac/Sources/LlmIdeMac --include="*.swift" | grep -v MobileControlManager.swift | grep -v FeatureCatalog.swift | grep -v AutoTask/ | grep -v LoopEngine/` → empty.
- [ ] **Step 2:** Doc edits (facts only — six keys, bridge protocol name, degrade reply behavior, `build-mac-min`, capture note, Loop section now backed by autoTasks).
- [ ] **Step 3:** Full build once more; commit — `docs: AutoTask/LoopEngine のビルド時除外(Phase 2c)を文書化`
