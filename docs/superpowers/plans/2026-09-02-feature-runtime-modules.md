# Feature Runtime Modules (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Workspace feature toggles actually stop a disabled feature's background work (timers, watchers, network listeners) instead of only hiding its views.

**Architecture:** Wire the existing-but-dead `AppModule`/`FeatureRegistry` lifecycle layer. Each feature gets a small module class that owns start/stop of its services; `FeatureRegistry.refresh()` reconciles running state against `activeFeatures` × each module's `runtimeReady` (auth, sub-settings). Services already have idempotent `start()`/`stop()`; modules wrap them, never reimplement them.

**Tech Stack:** Swift 5.9+/SwiftUI, swift-testing/XCTest (repo uses XCTest under `mac/Tests/LlmIdeMacTests/`), SPM.

**Spec:** `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Phase 1 section)

## Global Constraints

- Rule from the spec: **init is free; `start()` does the work; `stop()` undoes it**; both idempotent.
- `ActivityStore` stays always-on (core chrome, not a toggleable feature).
- Do not change view gating in `AppShell`/`StatusBar` — it already works.
- Persistence key `"active_features_json"` and its JSON format (array of rawValues) must not change — users' saved feature sets survive.
- Comments in English. Swift type suffix taxonomy per CLAUDE.md.
- **Test environment caveat:** on this machine the Swift toolchain has no `XCTest` module, so `swift test` fails at compile. For every "run test" step: attempt `swift test --filter <name>`; if the toolchain errors with `no such module 'XCTest'`, fall back to `GIT_CONFIG_GLOBAL=/dev/null swift build` (tests must still be written — they compile-check via CI and other machines). Never claim tests passed when they did not run; say "build verified, XCTest unavailable locally".
- Build command: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build` (sandbox off).

## Verified current-state facts (do not re-derive)

- `Services/FeatureRegistry.swift`: `AppModule` protocol exists with `start(environment:)`/`stop(environment:)`; `register(module:)` is never called anywhere; `@AppStorage("active_features_json")` holds a JSON string array of feature rawValues.
- `Services/AppEnvironment.swift` has a no-op `syncServiceLifecycles()`; only caller is `Views/Settings/FeatureProfileSettingsView.swift` (lines ~25, ~99), which also passes `environment:` into `applyPreset`/`updateFeatureSet`.
- Idempotence guards already present: `GraphAutoUpdater.start` (`guard !started`), `AutoCodeUpdateService.start` (`guard timer == nil`), `LiveSessionMirror.start` (`guard !isPolling`), `MobileControlManager.start` (status check). **`AutoCaptureService.start` has NO guard** (double-registers observers).
- `AutoCodeUpdateService.init` subscribes to `autoTaskSettings.$enabled` (dropFirst) and self-calls `start()`/`stop()` on master-toggle changes. App boot arms via `start()` only when already enabled.
- Direct start call sites to replace: `LlmIdeMacApp.swift:345` `autoCapture.start()` (unconditional), `:346` `if autoTaskSettings.enabled { autoCodeUpdate.start() }`, `:354`+`:405` `liveMirror.start()` (auth-gated), `autoStartMobileControl()` (config-gated), `Views/AppShell.swift:349-354` graph start inside `.task` gated by `registry.isEnabled(.codeGraph3D)`, `AppShell.swift:361` `.onDisappear { graphAutoUpdater.stop() }`.
- `MobileControlManager.swift:568` sets `autoTaskSettings?.enabled = m.enabled` from the phone with no feature gate.
- `mobileSync` is not in `AppFeature.settingsToggleable` but IS excluded by presets (`focusedAI`, `minimalEditor`), so a preset switch must stop the server.

---

### Task 1: FeatureRegistry rework — new protocols, injectable defaults, `refresh()`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/FeatureRegistry.swift` (full rewrite of the class body; keep file)
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/FeatureProfileSettingsView.swift` (drop `environment` plumbing)
- Modify: `mac/Sources/LlmIdeMac/Services/AppEnvironment.swift` (delete `syncServiceLifecycles()`)
- Test: `mac/Tests/LlmIdeMacTests/FeatureRegistryTests.swift` (new)

**Interfaces:**
- Consumes: `AppFeature`, `ProfilePreset` (unchanged, `Models/AppFeature.swift`)
- Produces (later tasks rely on these exact signatures):
  - `@MainActor protocol FeatureService: AnyObject { func start(); func stop() }`
  - `@MainActor protocol AppModule: AnyObject { var feature: AppFeature { get }; var runtimeReady: Bool { get }; func start(); func stop() }` with default `runtimeReady == true`
  - `FeatureRegistry.init(defaults: UserDefaults = .standard)` (no longer private), `static let shared`
  - `func register(module: AppModule)`
  - `func refresh()` — reconciles running state
  - `func updateFeatureSet(_ newFeatures: Set<AppFeature>, markCustom: Bool = true)` (environment param REMOVED)
  - `func applyPreset(_ preset: ProfilePreset)` (environment param REMOVED)
  - `func isEnabled(_ feature: AppFeature) -> Bool` (unchanged)

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/FeatureRegistryTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
private final class SpyModule: AppModule {
    let feature: AppFeature
    var ready = true
    var startCount = 0
    var stopCount = 0
    var runtimeReady: Bool { ready }
    init(_ feature: AppFeature) { self.feature = feature }
    func start() { startCount += 1 }
    func stop() { stopCount += 1 }
}

@MainActor
final class FeatureRegistryTests: XCTestCase {

    private func makeRegistry() -> FeatureRegistry {
        let name = "FeatureRegistryTests-\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: name)!
        suite.removePersistentDomain(forName: name)
        return FeatureRegistry(defaults: suite)
    }

    func testRefreshStartsOnlyEnabledModules() {
        let registry = makeRegistry()
        let graph = SpyModule(.codeGraph3D)
        let gantt = SpyModule(.ganttIssues)
        registry.register(module: graph)
        registry.register(module: gantt)
        registry.updateFeatureSet([.fileExplorer, .codeGraph3D], markCustom: false)
        XCTAssertEqual(graph.startCount, 1)
        XCTAssertEqual(gantt.startCount, 0)
    }

    func testDisablingFeatureStopsItsModule() {
        let registry = makeRegistry()
        let graph = SpyModule(.codeGraph3D)
        registry.register(module: graph)
        registry.updateFeatureSet([.fileExplorer, .codeGraph3D], markCustom: false)
        registry.updateFeatureSet([.fileExplorer], markCustom: false)
        XCTAssertEqual(graph.stopCount, 1)
    }

    func testRefreshIsIdempotent() {
        let registry = makeRegistry()
        let graph = SpyModule(.codeGraph3D)
        registry.register(module: graph)
        registry.updateFeatureSet([.fileExplorer, .codeGraph3D], markCustom: false)
        registry.refresh()
        registry.refresh()
        XCTAssertEqual(graph.startCount, 1)
        XCTAssertEqual(graph.stopCount, 0)
    }

    func testRuntimeReadyGatesStartAndTriggersStop() {
        let registry = makeRegistry()
        let chat = SpyModule(.agentChat)
        chat.ready = false
        registry.register(module: chat)
        registry.updateFeatureSet(Set(AppFeature.allCases), markCustom: false)
        XCTAssertEqual(chat.startCount, 0)      // not ready → never started
        chat.ready = true
        registry.refresh()
        XCTAssertEqual(chat.startCount, 1)      // became ready → started
        chat.ready = false
        registry.refresh()
        XCTAssertEqual(chat.stopCount, 1)       // lost readiness → stopped
    }

    func testPresetChangeStopsExcludedFeature() {
        let registry = makeRegistry()
        let mobile = SpyModule(.mobileSync)
        registry.register(module: mobile)
        registry.applyPreset(.fullPower)
        XCTAssertEqual(mobile.startCount, 1)
        registry.applyPreset(.focusedAI)        // preset excludes mobileSync
        XCTAssertEqual(mobile.stopCount, 1)
    }

    func testPersistenceRoundTripKeepsKeyFormat() {
        let suite = UserDefaults(suiteName: "FeatureRegistryTests-persist")!
        suite.removePersistentDomain(forName: "FeatureRegistryTests-persist")
        let registry = FeatureRegistry(defaults: suite)
        registry.updateFeatureSet([.fileExplorer, .terminal], markCustom: true)
        // Same key + JSON string-array format as the old @AppStorage code.
        let raw = suite.string(forKey: "active_features_json")!
        let decoded = try! JSONDecoder().decode([String].self, from: Data(raw.utf8))
        XCTAssertEqual(Set(decoded), ["file_explorer", "terminal"])
        let reloaded = FeatureRegistry(defaults: suite)
        XCTAssertEqual(reloaded.activeFeatures, [.fileExplorer, .terminal])
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter FeatureRegistryTests`
Expected: compile FAILURE (`FeatureRegistry` has no `init(defaults:)`, `updateFeatureSet` wrong arity). If toolchain has no XCTest, `swift build` and confirm the NEW registry below is what makes it compile.

- [ ] **Step 3: Rewrite FeatureRegistry**

```swift
// mac/Sources/LlmIdeMac/Services/FeatureRegistry.swift
import SwiftUI
import Combine

/// Anything a feature module can switch on and off. The concrete services
/// (GraphAutoUpdater, LiveSessionMirror, …) already have these methods;
/// conformance is declared where each module is defined.
@MainActor
protocol FeatureService: AnyObject {
    func start()
    func stop()
}

/// One per toggleable feature. Owns the mapping feature → services and is
/// the only place that starts/stops them. Rule: init is free, `start()`
/// does the work, `stop()` undoes it; both idempotent.
@MainActor
protocol AppModule: AnyObject {
    var feature: AppFeature { get }
    /// Runtime preconditions beyond the feature flag (auth, sub-settings).
    /// `refresh()` re-reads this, so call sites signal changes (login,
    /// logout) by calling `FeatureRegistry.refresh()`.
    var runtimeReady: Bool { get }
    func start()
    func stop()
}

extension AppModule {
    var runtimeReady: Bool { true }
}

@MainActor
final class FeatureRegistry: ObservableObject {
    static let shared = FeatureRegistry()

    /// Same key + format the old @AppStorage code used, so existing users'
    /// saved feature sets survive this rewrite.
    static let defaultsKey = "active_features_json"

    @Published private(set) var activeFeatures: Set<AppFeature> = Set(AppFeature.allCases)
    @Published private(set) var currentPreset: ProfilePreset = .fullPower

    private let defaults: UserDefaults
    private var modules: [AppFeature: AppModule] = [:]
    /// Features whose module is currently started. Registry-level guard so
    /// a module's start/stop is called once per transition even if the
    /// underlying service forgot its own guard.
    private var running: Set<AppFeature> = []

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        loadSavedFeatures()
    }

    func register(module: AppModule) {
        modules[module.feature] = module
    }

    func isEnabled(_ feature: AppFeature) -> Bool {
        activeFeatures.contains(feature)
    }

    /// Reconcile running modules with `activeFeatures` × `runtimeReady`.
    /// Idempotent; call after login/logout and any feature-set change.
    func refresh() {
        for feature in AppFeature.allCases {
            guard let module = modules[feature] else { continue }
            let shouldRun = activeFeatures.contains(feature) && module.runtimeReady
            if shouldRun && !running.contains(feature) {
                module.start()
                running.insert(feature)
            } else if !shouldRun && running.contains(feature) {
                module.stop()
                running.remove(feature)
            }
        }
    }

    func applyPreset(_ preset: ProfilePreset) {
        currentPreset = preset
        if preset != .custom {
            updateFeatureSet(preset.features, markCustom: false)
        }
    }

    func updateFeatureSet(_ newFeatures: Set<AppFeature>, markCustom: Bool = true) {
        var validated = newFeatures
        for feature in newFeatures {
            validated.formUnion(feature.requiredDependencies)
        }
        validated = AppFeature.validated(validated)

        if markCustom, currentPreset != .custom {
            currentPreset = .custom
        }
        // Unchanged set still refreshes: a preset re-apply must reconcile
        // modules registered after the set was first persisted.
        guard validated != activeFeatures else { refresh(); return }
        activeFeatures = validated
        saveFeatures()
        refresh()
    }

    private func saveFeatures() {
        let array = activeFeatures.map { $0.rawValue }
        if let data = try? JSONEncoder().encode(array),
           let json = String(data: data, encoding: .utf8) {
            defaults.set(json, forKey: Self.defaultsKey)
        }
    }

    private func loadSavedFeatures() {
        guard let json = defaults.string(forKey: Self.defaultsKey),
              let data = json.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String].self, from: data) else {
            activeFeatures = Set(AppFeature.allCases)
            return
        }
        activeFeatures = Set(decoded.compactMap { AppFeature(rawValue: $0) })
    }
}
```

- [ ] **Step 4: Update the two callers**

In `Views/Settings/FeatureProfileSettingsView.swift`:
- Delete the `@Environment(AppEnvironment.self) private var environment` property.
- `registry.applyPreset(newPreset, environment: environment)` → `registry.applyPreset(newPreset)`; delete the following `environment.syncServiceLifecycles()` line.
- `registry.updateFeatureSet(updated, environment: environment)` → `registry.updateFeatureSet(updated)`; delete the following `environment.syncServiceLifecycles()` line.

In `Services/AppEnvironment.swift`: delete the whole `syncServiceLifecycles()` method (lifecycle now lives in `FeatureRegistry.refresh()`; two entry points invite drift).

- [ ] **Step 5: Run tests / build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter FeatureRegistryTests`
Expected: PASS (or, without XCTest locally: `swift build` succeeds).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/FeatureRegistry.swift \
        mac/Sources/LlmIdeMac/Views/Settings/FeatureProfileSettingsView.swift \
        mac/Sources/LlmIdeMac/Services/AppEnvironment.swift \
        mac/Tests/LlmIdeMacTests/FeatureRegistryTests.swift
git commit -m "feat(mac): FeatureRegistry にモジュールライフサイクル reconcile を実装"
```

---

### Task 2: Feature modules — Graph, Chat, AutoTask, Mobile, passive four

**Files:**
- Create: `mac/Sources/LlmIdeMac/Graph/Services/GraphModule.swift`
- Create: `mac/Sources/LlmIdeMac/Services/ChatModule.swift`
- Create: `mac/Sources/LlmIdeMac/AutoTask/Services/AutoTaskModule.swift`
- Create: `mac/Sources/LlmIdeMac/Services/MobileModule.swift`
- Create: `mac/Sources/LlmIdeMac/Services/PassiveModule.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCaptureService.swift` (add missing idempotence guard)
- Test: `mac/Tests/LlmIdeMacTests/FeatureModulesTests.swift` (new)

**Interfaces:**
- Consumes (from Task 1): `FeatureService`, `AppModule`, default `runtimeReady`.
- Produces (Task 3 constructs these exactly):
  - `GraphModule(updater: any FeatureService, isAuthenticated: @escaping () -> Bool)`
  - `ChatModule(mirror: any FeatureService, isAuthenticated: @escaping () -> Bool)`
  - `AutoTaskModule(scheduler: any FeatureService, capture: any FeatureService, schedulerEnabled: @escaping () -> Bool)`
  - `MobileModule(manager: any FeatureService, controlEnabled: @escaping () -> Bool, autoStart: @escaping () -> Bool)`
  - `PassiveModule(feature: AppFeature)`

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/FeatureModulesTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
private final class SpyService: FeatureService {
    var startCount = 0
    var stopCount = 0
    func start() { startCount += 1 }
    func stop() { stopCount += 1 }
}

@MainActor
final class FeatureModulesTests: XCTestCase {

    func testGraphModuleRoutesStartStopAndGatesOnAuth() {
        let spy = SpyService()
        var authed = false
        let module = GraphModule(updater: spy, isAuthenticated: { authed })
        XCTAssertFalse(module.runtimeReady)
        authed = true
        XCTAssertTrue(module.runtimeReady)
        module.start()
        module.stop()
        XCTAssertEqual(spy.startCount, 1)
        XCTAssertEqual(spy.stopCount, 1)
        XCTAssertEqual(module.feature, .codeGraph3D)
    }

    func testChatModuleGatesOnAuth() {
        let spy = SpyService()
        let module = ChatModule(mirror: spy, isAuthenticated: { true })
        XCTAssertTrue(module.runtimeReady)
        XCTAssertEqual(module.feature, .agentChat)
        module.start()
        XCTAssertEqual(spy.startCount, 1)
    }

    func testAutoTaskModuleStartsCaptureAlwaysSchedulerOnlyWhenEnabled() {
        let scheduler = SpyService()
        let capture = SpyService()
        var masterEnabled = false
        let module = AutoTaskModule(
            scheduler: scheduler, capture: capture,
            schedulerEnabled: { masterEnabled })
        module.start()
        XCTAssertEqual(capture.startCount, 1)
        XCTAssertEqual(scheduler.startCount, 0)   // master off → no cron arm
        module.stop()
        masterEnabled = true
        module.start()
        XCTAssertEqual(scheduler.startCount, 1)
        module.stop()
        XCTAssertEqual(scheduler.stopCount, 2)
        XCTAssertEqual(capture.stopCount, 2)
    }

    func testMobileModuleRespectsControlEnabledAndAutoStart() {
        let spy = SpyService()
        let module = MobileModule(
            manager: spy, controlEnabled: { true }, autoStart: { false })
        XCTAssertTrue(module.runtimeReady)
        module.start()
        XCTAssertEqual(spy.startCount, 0)   // autoStart off → no server launch
        module.stop()
        XCTAssertEqual(spy.stopCount, 1)    // stop always stops the server
    }

    func testPassiveModuleCoversViewOnlyFeatures() {
        let module = PassiveModule(feature: .terminal)
        XCTAssertEqual(module.feature, .terminal)
        module.start()   // must be a no-op, must not crash
        module.stop()
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter FeatureModulesTests`
Expected: compile FAILURE (module types don't exist). Without XCTest: `swift build` after Step 3 is the check.

- [ ] **Step 3: Implement the five module types**

```swift
// mac/Sources/LlmIdeMac/Graph/Services/GraphModule.swift
import Foundation

/// Feature module for `.codeGraph3D`: owns the GraphAutoUpdater lifecycle.
/// Auth-scoped — the updater talks to the backend, so it only runs while
/// signed in; login/logout call sites trigger `FeatureRegistry.refresh()`.
@MainActor
final class GraphModule: AppModule {
    let feature: AppFeature = .codeGraph3D
    private let updater: any FeatureService
    private let isAuthenticated: () -> Bool

    var runtimeReady: Bool { isAuthenticated() }

    init(updater: any FeatureService, isAuthenticated: @escaping () -> Bool) {
        self.updater = updater
        self.isAuthenticated = isAuthenticated
    }

    func start() { updater.start() }
    func stop() { updater.stop() }
}
```

```swift
// mac/Sources/LlmIdeMac/Services/ChatModule.swift
import Foundation

/// Feature module for `.agentChat`: owns the LiveSessionMirror polling
/// lifecycle. Auth-scoped — unauthenticated polling just 401s in a loop.
@MainActor
final class ChatModule: AppModule {
    let feature: AppFeature = .agentChat
    private let mirror: any FeatureService
    private let isAuthenticated: () -> Bool

    var runtimeReady: Bool { isAuthenticated() }

    init(mirror: any FeatureService, isAuthenticated: @escaping () -> Bool) {
        self.mirror = mirror
        self.isAuthenticated = isAuthenticated
    }

    func start() { mirror.start() }
    func stop() { mirror.stop() }
}
```

```swift
// mac/Sources/LlmIdeMac/AutoTask/Services/AutoTaskModule.swift
import Foundation

/// Feature module for `.autoTasks`: activity capture plus the cron
/// scheduler. Capture runs whenever the feature is on; the scheduler arms
/// only when the user's master toggle is on — later master-toggle flips are
/// self-managed by AutoCodeUpdateService's `$enabled` subscription, so this
/// module only mirrors the app-boot arming rule.
@MainActor
final class AutoTaskModule: AppModule {
    let feature: AppFeature = .autoTasks
    private let scheduler: any FeatureService
    private let capture: any FeatureService
    private let schedulerEnabled: () -> Bool

    init(scheduler: any FeatureService,
         capture: any FeatureService,
         schedulerEnabled: @escaping () -> Bool) {
        self.scheduler = scheduler
        self.capture = capture
        self.schedulerEnabled = schedulerEnabled
    }

    func start() {
        capture.start()
        if schedulerEnabled() { scheduler.start() }
    }

    func stop() {
        scheduler.stop()
        capture.stop()
    }
}
```

```swift
// mac/Sources/LlmIdeMac/Services/MobileModule.swift
import Foundation

/// Feature module for `.mobileSync`: the native WebSocket server + Bonjour.
/// `start()` only launches the server when the user opted into auto-start;
/// the manual Start button in Settings keeps calling the manager directly.
/// `stop()` always stops the server — a preset that excludes mobileSync
/// (Focused AI, Minimal Editor) must tear the listener down.
@MainActor
final class MobileModule: AppModule {
    let feature: AppFeature = .mobileSync
    private let manager: any FeatureService
    private let controlEnabled: () -> Bool
    private let autoStart: () -> Bool

    var runtimeReady: Bool { controlEnabled() }

    init(manager: any FeatureService,
         controlEnabled: @escaping () -> Bool,
         autoStart: @escaping () -> Bool) {
        self.manager = manager
        self.controlEnabled = controlEnabled
        self.autoStart = autoStart
    }

    func start() {
        if autoStart() { manager.start() }
    }

    func stop() { manager.stop() }
}
```

```swift
// mac/Sources/LlmIdeMac/Services/PassiveModule.swift
import Foundation

/// No-op module for view-only features (Explorer, Gantt, DocGen, Terminal):
/// they have no background work today, but registering them keeps the
/// registry's coverage total — Phase 2 (SPM split) requires every feature
/// to have a module, and future background work gets an obvious home.
@MainActor
final class PassiveModule: AppModule {
    let feature: AppFeature
    init(feature: AppFeature) { self.feature = feature }
    func start() {}
    func stop() {}
}
```

- [ ] **Step 4: Add the missing idempotence guard to AutoCaptureService**

In `Services/AutoCaptureService.swift`, at the top of `func start()` insert:

```swift
        // Idempotent like every FeatureService: a second start() must not
        // register a duplicate observer pair.
        guard observers.isEmpty else { return }
```

- [ ] **Step 5: Run tests / build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter FeatureModulesTests`
Expected: PASS (or `swift build` succeeds without XCTest).

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Graph/Services/GraphModule.swift \
        mac/Sources/LlmIdeMac/Services/ChatModule.swift \
        mac/Sources/LlmIdeMac/AutoTask/Services/AutoTaskModule.swift \
        mac/Sources/LlmIdeMac/Services/MobileModule.swift \
        mac/Sources/LlmIdeMac/Services/PassiveModule.swift \
        mac/Sources/LlmIdeMac/Services/AutoCaptureService.swift \
        mac/Tests/LlmIdeMacTests/FeatureModulesTests.swift
git commit -m "feat(mac): 機能別 AppModule 実装を追加(Graph/Chat/AutoTask/Mobile/Passive)"
```

---

### Task 3: Composition root — register modules, replace direct starts with `refresh()`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift` (remove graph start `.task` + `.onDisappear` stop)
- Modify: `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` (feature-gate the phone's master toggle)

**Interfaces:**
- Consumes (Task 1): `FeatureRegistry.shared`, `register(module:)`, `refresh()`, `isEnabled(_:)`. (Task 2): the five module initializers, exactly as declared there.
- Produces: nothing new — this task is wiring only.

- [ ] **Step 1: Declare FeatureService conformances and register modules in `LlmIdeMacApp.init()`**

At the END of `public init()` (after `mobileControl.installMobilePushObservers()`), add:

```swift
        // Register one module per feature. The registry starts nothing here;
        // the launch `.task` below calls refresh() once shells are mounted.
        let registry = FeatureRegistry.shared
        registry.register(module: AutoTaskModule(
            scheduler: autoCode,
            capture: self.autoCapture,
            schedulerEnabled: { autoTaskSettingsInstance.enabled }))
        registry.register(module: GraphModule(
            updater: autoUpdater,
            isAuthenticated: { store.isAuthenticated }))
        registry.register(module: ChatModule(
            mirror: mirror,
            isAuthenticated: { store.isAuthenticated }))
        registry.register(module: MobileModule(
            manager: mobileControl,
            controlEnabled: { cfg.mobileControlEnabled },
            autoStart: { cfg.mobileControlAutoStart }))
        for feature in [AppFeature.fileExplorer, .ganttIssues, .docGen, .terminal] {
            registry.register(module: PassiveModule(feature: feature))
        }
```

Note: `mobileControl` is a `@State` value already constructed at property
initialization; referencing it inside `init` after all stored properties are
set is fine (the wiring block above it already does).

Add the conformance declarations in the same file, above `public struct LlmIdeMacApp`:

```swift
// FeatureService conformances — the methods already exist on each type;
// these declarations let feature modules hold them behind one protocol.
extension GraphAutoUpdater: FeatureService {}
extension LiveSessionMirror: FeatureService {}
extension AutoCodeUpdateService: FeatureService {}
extension AutoCaptureService: FeatureService {}
extension MobileControlManager: FeatureService {}
```

If any of these types is not `@MainActor`, move that one's conformance next
to the type's own definition and align isolation there instead of forcing it
here.

- [ ] **Step 2: Replace the direct start call sites in `LlmIdeMacApp.swift`**

In the launch `.task` (around line 336–347):
- Delete `if config.mobileControlEnabled, config.mobileControlAutoStart { autoStartMobileControl() }` and delete the now-unused `autoStartMobileControl()` helper method.
- Delete `autoCapture.start()`.
- Delete `if autoTaskSettings.enabled { autoCodeUpdate.start() }`.
- In their place (after `await session.bootstrap(api: api)` so auth state is known), add:

```swift
                    // Single lifecycle entry point: start every enabled
                    // feature whose runtime conditions hold.
                    FeatureRegistry.shared.refresh()
```

In `.onChange(of: session.isAuthenticated)` (around line 352): replace `liveMirror.start()` with `FeatureRegistry.shared.refresh()`. Keep the other statements in that branch (sourceLinkStore refresh, provider sync, language pref) untouched. Add an `else` branch if none exists so logout also reconciles:

```swift
                .onChange(of: session.isAuthenticated) { _, authed in
                    FeatureRegistry.shared.refresh()
                    if authed {
                        // …existing authed-only side effects stay here…
                    }
                }
```

In the second `.task { if session.isAuthenticated { liveMirror.start() } }` (around line 404): replace the body with `FeatureRegistry.shared.refresh()` (idempotent, so double-refresh with the launch task is harmless).

Keep `willTerminateNotification` handling as-is (`backend.stop()`, `mobileControl.stop()` — process teardown stays direct and unconditional).

- [ ] **Step 3: Remove the graph lifecycle hooks from `AppShell.swift`**

- Delete the `.task { if registry.isEnabled(.codeGraph3D) { … graphAutoUpdater.start() } }` block (around lines 348–355) — registration replaces it. Move its one non-lifecycle line, `graphAutoUpdater.sessionStore = graphSessionStore`, into `LlmIdeMacApp.init()` right after `autoUpdater.uploader.api = client` (cheap assignment, belongs to construction):

```swift
        autoUpdater.sessionStore = graphSessionStoreInstance
```

If `graphSessionStore` is currently only a `@StateObject` property default (`= GraphSessionStore()`), hoist it into `init` as `let graphSessionStoreInstance = GraphSessionStore()` + `self._graphSessionStore = StateObject(wrappedValue: graphSessionStoreInstance)` so the wiring can reference it — same pattern the file already uses for `autoTaskSettingsInstance`.
- Delete `.onDisappear { graphAutoUpdater.stop() }` (line ~361). Logout now reconciles via the `onChange(of: session.isAuthenticated)` refresh (AppShell unmount and that flag flip are the same moment; the module's `runtimeReady` turns false and the registry stops the updater).

- [ ] **Step 4: Feature-gate the phone's master toggle in `MobileControlManager.swift`**

At line ~568 where the master toggle is applied, wrap:

```swift
                } else if m.taskId == "master" {
                    guard FeatureRegistry.shared.isEnabled(.autoTasks) else {
                        append(.info, "Auto-task master toggle ignored: feature disabled on Mac")
                        break
                    }
                    autoTaskSettings?.enabled = m.enabled
                    append(.info, "Auto-task master=\(m.enabled)")
                }
```

Match the actual surrounding syntax at that site (it may be a `case`/`if` chain — preserve it; the added `guard` + log line is the change). Use the file's existing logging helper as shown by neighboring lines.

- [ ] **Step 5: Build and verify no orphan references**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: Build complete. Then `grep -rn "autoStartMobileControl\|syncServiceLifecycles" mac/Sources/` → no hits.

- [ ] **Step 6: Manual smoke test (launch + toggle)**

Run the app (`cd mac && swift run` or the built binary). Verify:
1. Sign in → Graph auto-updater and live mirror behave as before (Console.app, subsystem `com.llmide.macapp`: look for "live mirror polling started").
2. Settings → Workspace: switch Profile to "Focused AI Assistant" → log shows mobile server stop (if it was running) and no crash; switch back to Full → services return.
3. Toggle "3D Code Graph Engine" off → `GraphAutoUpdater` stops (its timer log goes quiet); on → resumes.

Record what was actually observed in the commit body.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/LlmIdeMacApp.swift \
        mac/Sources/LlmIdeMac/Views/AppShell.swift \
        mac/Sources/LlmIdeMac/Services/MobileControlManager.swift
git commit -m "feat(mac): 機能トグルをモジュールライフサイクルに接続し無条件起動を廃止"
```

---

### Task 4: Registry coverage test + docs

**Files:**
- Modify: `mac/Tests/LlmIdeMacTests/FeatureRegistryTests.swift` (add coverage test)
- Modify: `docs/spec/macos-app.md` (Workspace/feature section: describe lifecycle behavior)
- Modify: `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (mark Phase 1 as implemented)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: nothing — verification and documentation.

- [ ] **Step 1: Add the coverage test**

Every `AppFeature` case must have a module class in the codebase. The
composition root can't run in unit tests (it builds real services), so the
test pins the *intent* — update it when adding a feature:

```swift
    func testEveryFeatureHasAModuleRegisteredInComposition() {
        // Mirror of the registration list in LlmIdeMacApp.init(). If this
        // fails after adding an AppFeature case, add a module there AND here.
        let covered: Set<AppFeature> = [
            .autoTasks,      // AutoTaskModule
            .codeGraph3D,    // GraphModule
            .agentChat,      // ChatModule
            .mobileSync,     // MobileModule
            .fileExplorer, .ganttIssues, .docGen, .terminal,  // PassiveModule
        ]
        XCTAssertEqual(covered, Set(AppFeature.allCases))
    }
```

- [ ] **Step 2: Run tests / build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift test --filter FeatureRegistryTests`
Expected: PASS (or `swift build` without XCTest).

- [ ] **Step 3: Update docs**

In `docs/spec/macos-app.md`, find the Workspace settings / feature-profile
description and extend it with one paragraph:

> Feature toggles are wired to `FeatureRegistry.refresh()`: each feature has
> an `AppModule` (`AutoTaskModule`, `GraphModule`, `ChatModule`,
> `MobileModule`, `PassiveModule` for the view-only four) owning its
> services' `start()`/`stop()`. Disabling a feature stops its timers,
> watchers, and listeners; presets do the same in bulk. Rule: init is free,
> `start()` does the work, `stop()` undoes it, both idempotent. Auth changes
> call `refresh()`, so auth-scoped modules (graph, chat mirror) stop on
> logout via `runtimeReady`.

In the design spec, change `**Status:** Proposed` to
`**Status:** Phase 1 implemented (<commit>); Phases 2–3 pending`, and in the
Phase 1 module table change the `fileExplorer` row's "Module owns" cell to
"none in Phase 1 (PassiveModule)" with this note appended below the table:

> `fileExplorer` is passive in Phase 1: `LibraryItemStore` scanning and index
> watching are project-lifecycle-driven and shared by Library/meetings
> surfaces, so feature-gating them would break non-explorer consumers.
> Revisit when Phase 2 separates those consumers.

- [ ] **Step 4: Commit**

```bash
git add mac/Tests/LlmIdeMacTests/FeatureRegistryTests.swift \
        docs/spec/macos-app.md \
        docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md
git commit -m "test(mac)+docs: 機能モジュールのカバレッジテストとライフサイクル文書を追加"
```
