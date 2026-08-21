# Loop Engineering — Independent Named Loops (Mac Core) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Loop Engineering from "one shared pipeline per project" into "a project holds several independently configured, run, and tracked named loops" — mirroring Auto Tasks' list+detail layout for the UI only, with Auto Tasks itself left untouched.

**Architecture:** A new `LoopDefinition` wraps the existing, unchanged `LoopEngineConfig` with identity (`id`, `name`, `isPrimary`) and a richer per-loop contract (`goal`, `acceptanceCriteria`, `scopeGlobs`). `system/loop.json`'s schema becomes `LoopEngineProjectStore { loops: [LoopDefinition] }`, with a 3-step decode migration (new schema → legacy bare-config file → legacy UserDefaults) so an existing project's config becomes "Main Loop, ★ Primary" with no user action. `LoopEngineRunner.run(...)` gains `loopId`/`loopName`/`goal`/`acceptanceCriteria`/`scopeGlobs` params (all defaulted, so the ~40 existing runner tests are untouched); goal/acceptance are woven into the repair/skill prompts already built inside the runner (no protocol changes to `LoopStageRepairer`/`LoopSkillExecuting`), and the scope allowlist is checked entirely inside the runner's own `withScopeGuard` (no changes to `RepairScopeGuard.swift`/its tests). `LoopEngineView` becomes a per-loop workspace (it already is one internally); a new `LoopEngineHomeView` adds the loop-list pane in front of it, mirroring `AutoCodeView`'s list+detail split. Two existing call sites (`AutoCodeUpdateService`'s scheduled sweep, `MobileControlManager`'s phone snapshot) mechanically resolve the Primary loop instead of "the" config — no UI or behavior change for either.

**Tech Stack:** Swift (SwiftUI Mac app), XCTest.

**Spec:** `docs/superpowers/specs/2026-08-21-loop-engineering-multi-loop-design.md`

**Environment notes for the executor:**
- Mac builds: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build` (a real global git config breaks SwiftPM here; sandbox must be off for `swift build`).
- `cd mac && swift test` silently no-ops on this machine (Command Line Tools have no XCTest) — write the tests anyway; they run in CI/full-Xcode. Verify every change compiles via `swift build`.
- The pre-push hook runs `make regression` (mac build + extension tests). The extension (`extension/`) is untouched by this plan — do not run its test suite for these changes.
- Out of scope (Spec B, later): `ios_app/SharedProtocol` wire changes, the iOS Loop screen, and an Auto Task "which loop" scheduler picker.

**Deliberate refinement vs. the spec doc:** the spec's "Log key" paragraph proposed a composite `"loopEngineering:\(loopId)"` key for `TaskLogStore`. This plan does NOT implement that: `LoopEngineView`'s own log pane already reads `runner.log` directly (each loop's `LoopEngineView` instance owns its own `LoopEngineRunner`, already fully isolated per loop — no shared-key problem exists there), and the ONLY consumers of the shared `TaskLogStore` bucket are Auto Tasks' own page and the phone's log tail, both of which must render **exactly as they do today** per this session's tightened "Auto Task fully untouched" scope. Introducing a composite key would empty both of those out for any run that isn't the Primary loop. No task below changes any `logStore.append`/`onLog` call site.

---

## File map

| File | Change |
|---|---|
| `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopDefinition.swift` | New: `LoopDefinition`, `LoopEngineProjectStore` |
| `mac/Tests/LlmIdeMacTests/LoopDefinitionTests.swift` | New: Codable round-trip / decode-defaults tests |
| `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopRunRecord.swift` | `LoopRunRecord`/`LoopRunIndexEntry` gain `loopId`/`loopName` |
| `mac/Tests/LlmIdeMacTests/LoopRunJournalTests.swift` | Round-trip test for the new fields |
| `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfigStore.swift` | Rewritten for `LoopEngineProjectStore` + `primaryLoop(...)` + migration |
| `mac/Tests/LlmIdeMacTests/LoopEngineConfigStoreTests.swift` | Rewritten for the new API/migration |
| `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift` | `loopId`/`loopName`/`goal`/`acceptanceCriteria`/`scopeGlobs` threading; `activeLoopId(gitRoot:)`; goal/acceptance prompt composition; scope-allowlist check in `withScopeGuard` |
| `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift` | New tests appended (existing ~40 tests untouched — all new params default) |
| `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift` | `runLoopEngineeringSweep` resolves the Primary loop |
| `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift` | `runLoopEngineeringFromChat` resolves the Primary loop |
| `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` | `resolveLoopConfig`/`buildLoopState` resolve the Primary loop (return shape unchanged) |
| `mac/Tests/LlmIdeMacTests/MobileLoopStateTests.swift` | Two `LoopEngineConfigStore.save` calls updated to the new API |
| `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift` | Takes `loopId`; load/save retargeted to the per-loop API; Goal/Acceptance/Scope `@State`; "New Loop" toolbar+sheet removed; past runs filtered by loop |
| `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView+DetailPane.swift` | OVERVIEW gains Goal/Acceptance fields; SETTINGS gains a Scope editor |
| `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineHomeView.swift` | New: loop-list pane + hosts `LoopEngineView` for the selected loop + hosts `NewLoopWizardView` |
| `mac/Sources/LlmIdeMac/Views/AppShell.swift` | `.loopEngine` case instantiates `LoopEngineHomeView` |

---

### Task 1: `LoopDefinition` + `LoopEngineProjectStore`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopDefinition.swift`
- Test: `mac/Tests/LlmIdeMacTests/LoopDefinitionTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `mac/Tests/LlmIdeMacTests/LoopDefinitionTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

final class LoopDefinitionTests: XCTestCase {
    private func makeConfig() -> LoopEngineConfig {
        LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5)
    }

    func testDefaultsWhenOnlyNameAndConfigAreGiven() {
        let loop = LoopDefinition(name: "Main Loop", config: makeConfig())
        XCTAssertFalse(loop.id.isEmpty)
        XCTAssertFalse(loop.isPrimary)
        XCTAssertNil(loop.goal)
        XCTAssertNil(loop.acceptanceCriteria)
        XCTAssertEqual(loop.scopeGlobs, [])
    }

    func testRoundTripPreservesEveryField() throws {
        let loop = LoopDefinition(id: "loop-1", name: "Fix flaky tests", isPrimary: true,
                                  goal: "Stabilize the auth test suite",
                                  acceptanceCriteria: "swift test passes 3 times in a row",
                                  scopeGlobs: ["mac/Tests/**"], config: makeConfig())
        let data = try JSONEncoder().encode(loop)
        let decoded = try JSONDecoder().decode(LoopDefinition.self, from: data)
        XCTAssertEqual(decoded, loop)
    }

    /// Every field beyond `name`/`config` must decode with a default when
    /// absent — the same rule `LoopStage.init(from:)` documents, so a future
    /// field addition here can't turn an old `LoopDefinition` into a decode
    /// failure.
    func testMissingOptionalKeysDecodeToDefaults() throws {
        let json = Data("""
        {"name":"Bare","config":{"stages":[]}}
        """.utf8)
        let decoded = try JSONDecoder().decode(LoopDefinition.self, from: json)
        XCTAssertEqual(decoded.name, "Bare")
        XCTAssertFalse(decoded.isPrimary)
        XCTAssertNil(decoded.goal)
        XCTAssertNil(decoded.acceptanceCriteria)
        XCTAssertEqual(decoded.scopeGlobs, [])
        XCTAssertFalse(decoded.id.isEmpty, "a missing id must still mint one, not decode as empty")
    }

    func testProjectStoreRoundTrips() throws {
        let store = LoopEngineProjectStore(loops: [
            LoopDefinition(name: "Main Loop", isPrimary: true, config: makeConfig()),
            LoopDefinition(name: "Refactor auth", config: makeConfig())
        ])
        let data = try JSONEncoder().encode(store)
        let decoded = try JSONDecoder().decode(LoopEngineProjectStore.self, from: data)
        XCTAssertEqual(decoded, store)
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -30`
Expected: BUILD FAILURE — `LoopDefinition`/`LoopEngineProjectStore` not defined.

- [ ] **Step 3: Implement `LoopDefinition` and `LoopEngineProjectStore`**

Create `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopDefinition.swift`:

```swift
import Foundation

/// One independently configured, run, and tracked Loop within a project.
///
/// `LoopEngineConfig` (stages, budgets, protected-path policy) keeps meaning
/// exactly what it means today — this only gives it identity and a richer
/// per-loop contract, so a project can hold several unrelated loops (e.g.
/// "fix flaky tests" and "refactor auth") instead of being forced to share
/// one pipeline.
struct LoopDefinition: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    /// Exactly one loop per project is Primary — the loop the scheduled
    /// `.loopEngineering` Auto Task and the phone target. Not enforced at
    /// the type level; `LoopEngineConfigStore` and the Loop page's "Set as
    /// Primary" action are what keep the invariant.
    var isPrimary: Bool
    /// Free text: what this loop is trying to achieve. When set, appended to
    /// the repair/skill prompts `LoopEngineRunner` builds, so a loop's "done"
    /// signal is more than "the stages passed".
    var goal: String?
    /// Free text: the observable condition that means done. Same treatment
    /// as `goal`.
    var acceptanceCriteria: String?
    /// Optional path allowlist. Empty (the default) means unrestricted —
    /// today's behavior for every existing and migrated loop. When non-empty,
    /// `LoopEngineRunner.withScopeGuard` treats a changed path outside every
    /// glob here the same way it treats a protected-path violation.
    var scopeGlobs: [String]
    var config: LoopEngineConfig

    init(id: String = UUID().uuidString, name: String, isPrimary: Bool = false,
         goal: String? = nil, acceptanceCriteria: String? = nil,
         scopeGlobs: [String] = [], config: LoopEngineConfig) {
        self.id = id
        self.name = name
        self.isPrimary = isPrimary
        self.goal = goal
        self.acceptanceCriteria = acceptanceCriteria
        self.scopeGlobs = scopeGlobs
        self.config = config
    }

    // MARK: - Codable backward compatibility

    enum CodingKeys: String, CodingKey {
        case id, name, isPrimary, goal, acceptanceCriteria, scopeGlobs, config
    }

    /// Every field beyond `name`/`config` is `decodeIfPresent` + a default —
    /// same rule `LoopStage.init(from:)` documents, so a future field added
    /// here can't turn an existing `LoopDefinition` into a decode failure.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try container.decode(String.self, forKey: .name)
        isPrimary = try container.decodeIfPresent(Bool.self, forKey: .isPrimary) ?? false
        goal = try container.decodeIfPresent(String.self, forKey: .goal)
        acceptanceCriteria = try container.decodeIfPresent(String.self, forKey: .acceptanceCriteria)
        scopeGlobs = try container.decodeIfPresent([String].self, forKey: .scopeGlobs) ?? []
        config = try container.decode(LoopEngineConfig.self, forKey: .config)
    }
}

/// A project's full set of Loops — the schema `system/loop.json` holds. See
/// `LoopEngineConfigStore` for the load/save/migration contract.
struct LoopEngineProjectStore: Codable, Equatable {
    var loops: [LoopDefinition]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build && GIT_CONFIG_GLOBAL=/dev/null swift test --filter LoopDefinitionTests 2>&1 | tail -30`
Expected: build succeeds (`swift test` itself may no-op per the environment note — confirm via build success + reading the test code matches the implementation).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopDefinition.swift mac/Tests/LlmIdeMacTests/LoopDefinitionTests.swift
git commit -m "$(cat <<'EOF'
feat(mac): add LoopDefinition and LoopEngineProjectStore

A project's Loop config becomes a list of independently identified
loops instead of one bare LoopEngineConfig — the data-model half of
letting a project run several unrelated loops side by side.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `LoopRunRecord`/`LoopRunIndexEntry` carry loop identity

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopRunRecord.swift`
- Test: `mac/Tests/LlmIdeMacTests/LoopRunJournalTests.swift`

- [ ] **Step 1: Write the failing test**

Add to `mac/Tests/LlmIdeMacTests/LoopRunJournalTests.swift` (inside the existing test class — check the file's existing helpers for a `makeRecord(...)`-style factory and reuse it; if none exists, construct a `LoopRunRecord` directly as other tests in the file do):

```swift
    func testLoopIdAndLoopNameRoundTripThroughEncodeDecode() throws {
        var record = LoopRunRecord(
            id: "run-1", projectId: "proj-1", trigger: .manual, gitRoot: "/tmp/repo",
            startedAt: Date(), endedAt: Date(), iterationsUsed: 1,
            config: LoopRunConfigSnapshot(LoopEngineConfig(stages: [])),
            iterations: [], statusCode: "success", statusSummary: "done")
        record.loopId = "loop-1"
        record.loopName = "Fix flaky tests"

        let data = try JSONEncoder().encode(record)
        let decoded = try JSONDecoder().decode(LoopRunRecord.self, from: data)
        XCTAssertEqual(decoded.loopId, "loop-1")
        XCTAssertEqual(decoded.loopName, "Fix flaky tests")

        let indexEntry = LoopRunIndexEntry(decoded)
        XCTAssertEqual(indexEntry.loopId, "loop-1")
        XCTAssertEqual(indexEntry.loopName, "Fix flaky tests")
    }

    /// A record written before this feature existed has no `loopId` key at
    /// all — it must decode as `nil`, not fail, since `system/loop-runs/`
    /// is append-only and never migrated.
    func testRecordWithoutLoopIdKeyDecodesAsNil() throws {
        let json = Data("""
        {"id":"run-0","trigger":"manual","gitRoot":"/tmp/repo",
         "startedAt":0,"endedAt":0,"iterationsUsed":1,
         "config":{"stages":[],"maxIterations":10,"consecutiveFailureStop":2,
                    "maxRepairsPerStage":3,"protectedPathPolicy":"revert"},
         "iterations":[],"statusCode":"success","statusSummary":"done"}
        """.utf8)
        let decoded = try JSONDecoder().decode(LoopRunRecord.self, from: json)
        XCTAssertNil(decoded.loopId)
        XCTAssertNil(decoded.loopName)
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -30`
Expected: BUILD FAILURE — `LoopRunRecord` has no member `loopId`/`loopName`.

- [ ] **Step 3: Add the fields**

In `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopRunRecord.swift`, modify `LoopRunRecord` (around line 148):

```swift
struct LoopRunRecord: Codable, Equatable {
    var id: String
    var projectId: String?
    var trigger: LoopRunTrigger
    var gitRoot: String
    var startedAt: Date
    var endedAt: Date
    var iterationsUsed: Int
    var config: LoopRunConfigSnapshot
    var iterations: [LoopIterationRecord]
    var statusCode: String
    var statusSummary: String
    /// Which `LoopDefinition` this run executed, and its name at the time —
    /// `nil` for every record written before Loop Engineering supported more
    /// than one loop per project (treated as "the legacy/primary loop" by
    /// readers). Plain `Optional` properties decode missing keys as `nil`
    /// automatically — no custom `Decodable` needed, same as `projectId`.
    var loopId: String? = nil
    var loopName: String? = nil

    var durationSeconds: Double { endedAt.timeIntervalSince(startedAt) }
}
```

And `LoopRunIndexEntry` (around line 170):

```swift
struct LoopRunIndexEntry: Codable, Equatable {
    var id: String
    var trigger: LoopRunTrigger
    var startedAt: Date
    var durationSeconds: Double
    var iterationsUsed: Int
    var statusCode: String
    var statusSummary: String
    var loopId: String? = nil
    var loopName: String? = nil

    init(_ record: LoopRunRecord) {
        id = record.id
        trigger = record.trigger
        startedAt = record.startedAt
        durationSeconds = record.durationSeconds
        iterationsUsed = record.iterationsUsed
        statusCode = record.statusCode
        statusSummary = record.statusSummary
        loopId = record.loopId
        loopName = record.loopName
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -30`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopRunRecord.swift mac/Tests/LlmIdeMacTests/LoopRunJournalTests.swift
git commit -m "$(cat <<'EOF'
feat(mac): LoopRunRecord carries which loop a run belongs to

Optional loopId/loopName, nil for every run journalled before a
project could hold more than one loop. Lets the Past Runs list and
history filter by loop once the runner starts setting them.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Rewrite `LoopEngineConfigStore` for multiple loops

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfigStore.swift`
- Modify: `mac/Tests/LlmIdeMacTests/LoopEngineConfigStoreTests.swift` (full rewrite)

This is the load-bearing migration: every existing project's `system/loop.json` (a bare `LoopEngineConfig`) must become a `LoopEngineProjectStore` with one loop named "Main Loop", marked Primary, on first load — with no action from the user.

- [ ] **Step 1: Write the failing tests (full replacement of the test file)**

Replace the entire contents of `mac/Tests/LlmIdeMacTests/LoopEngineConfigStoreTests.swift`:

```swift
import XCTest
@testable import LlmIdeMacLib

/// This store is what makes a project's Loop contract reload after a fresh
/// clone or on a second machine, and what upgrades an existing single-loop
/// project to the multi-loop schema with no action from the user. A silent
/// write failure or a migration that does not fire looks exactly like "the
/// loop forgot my stages" — the symptom the file was introduced to remove.
final class LoopEngineConfigStoreTests: XCTestCase {
    private var projectRoot: URL!
    private var defaults: UserDefaults!
    private let projectId = "proj-1"

    override func setUpWithError() throws {
        try super.setUpWithError()
        projectRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-config-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: projectRoot, withIntermediateDirectories: true)
        defaults = UserDefaults(suiteName: "loop-config-store-\(UUID().uuidString)")!
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: projectRoot)
        try super.tearDownWithError()
    }

    private func makeConfig(iterations: Int = 7, stage: String = "Test") -> LoopEngineConfig {
        LoopEngineConfig(
            stages: [LoopStage(id: "t1", name: stage, kind: .shellCommand,
                               command: "swift test", order: 0)],
            maxIterations: iterations)
    }

    private func makeStore(iterations: Int = 7, stage: String = "Test",
                           name: String = "Main Loop") -> LoopEngineProjectStore {
        LoopEngineProjectStore(loops: [
            LoopDefinition(name: name, isPrimary: true, config: makeConfig(iterations: iterations, stage: stage))
        ])
    }

    // MARK: - Location

    func testConfigLivesAtSystemLoopJson() {
        XCTAssertEqual(LoopEngineConfigStore.fileURL(projectRoot: projectRoot).lastPathComponent,
                       "loop.json")
        XCTAssertEqual(
            LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
                .deletingLastPathComponent().lastPathComponent,
            "system")
    }

    // MARK: - Round trip

    func testSaveWritesTheFileAndLoadReadsItBack() {
        let store = makeStore()
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)

        XCTAssertTrue(FileManager.default.fileExists(
            atPath: LoopEngineConfigStore.fileURL(projectRoot: projectRoot).path))
        XCTAssertEqual(
            LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId, defaults: defaults),
            store)
    }

    /// The file is committed, so its diff has to be readable.
    func testFileIsPrettyPrintedWithSortedKeys() throws {
        LoopEngineConfigStore.save(makeStore(), projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)
        let text = try String(contentsOf: LoopEngineConfigStore.fileURL(projectRoot: projectRoot),
                              encoding: .utf8)
        XCTAssertTrue(text.contains("\n"), "expected pretty-printed JSON")
        let keyOrder = ["isPrimary", "loops", "name"]
        let positions = keyOrder.compactMap { text.range(of: "\"\($0)\"")?.lowerBound }
        XCTAssertEqual(positions.count, keyOrder.count)
        XCTAssertEqual(positions, positions.sorted(), "keys should be sorted")
    }

    func testWritingTwiceProducesAnIdenticalFile() throws {
        let store = makeStore()
        let url = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        let first = try Data(contentsOf: url)
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        XCTAssertEqual(try Data(contentsOf: url), first)
    }

    func testSaveCreatesTheSystemDirectoryIfMissing() {
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: projectRoot.appendingPathComponent("system").path))
        LoopEngineConfigStore.save(makeStore(), projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)
        XCTAssertNotNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                   defaults: defaults))
    }

    // MARK: - No saved config

    func testLoadReturnsNilForAProjectWithNoConfig() {
        XCTAssertNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults))
        XCTAssertFalse(LoopEngineConfigStore.exists(projectRoot: projectRoot, projectId: projectId,
                                                    defaults: defaults))
    }

    func testCorruptFileReadsAsNoConfig() throws {
        let url = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: url)
        XCTAssertNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults))
    }

    // MARK: - Migration: legacy bare-config FILE (pre-multi-loop)

    /// The exact scenario every existing project is in the moment this ships:
    /// `system/loop.json` holds a bare `LoopEngineConfig`, no `loops` key.
    func testLegacyBareConfigFileMigratesToOneWrappedPrimaryLoop() throws {
        let url = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let legacyConfig = makeConfig(iterations: 4, stage: "Legacy")
        try JSONEncoder().encode(legacyConfig).write(to: url)

        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults)
        XCTAssertEqual(loaded?.loops.count, 1)
        XCTAssertEqual(loaded?.loops.first?.name, "Main Loop")
        XCTAssertEqual(loaded?.loops.first?.isPrimary, true)
        XCTAssertEqual(loaded?.loops.first?.config, legacyConfig)

        // The migration is the point: the NEXT read must decode the NEW
        // schema, not re-run the migration.
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.contains("\"loops\""))
    }

    // MARK: - Migration from UserDefaults (pre-file era)

    func testLegacyUserDefaultsConfigIsMigratedToTheFileAsOnePrimaryLoop() {
        makeConfig(iterations: 4, stage: "Legacy").save(for: projectId, defaults: defaults)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: LoopEngineConfigStore.fileURL(projectRoot: projectRoot).path))

        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults)
        XCTAssertEqual(loaded?.loops.first?.config.maxIterations, 4)
        XCTAssertEqual(loaded?.loops.first?.config.stages.first?.name, "Legacy")
        XCTAssertEqual(loaded?.loops.first?.isPrimary, true)
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: LoopEngineConfigStore.fileURL(projectRoot: projectRoot).path))
    }

    /// Once the file exists it is authoritative — a stale UserDefaults entry
    /// must not win, or edits would silently revert.
    func testFileWinsOverAStaleUserDefaultsEntry() {
        makeConfig(iterations: 2, stage: "Stale").save(for: projectId, defaults: defaults)
        LoopEngineConfigStore.save(makeStore(iterations: 9, stage: "Current"),
                                   projectRoot: projectRoot, projectId: projectId, defaults: defaults)

        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults)
        XCTAssertEqual(loaded?.loops.first?.config.maxIterations, 9)
        XCTAssertEqual(loaded?.loops.first?.config.stages.first?.name, "Current")
    }

    func testSaveDoesNotWriteBackToUserDefaultsWhenAFolderIsAvailable() {
        LoopEngineConfigStore.save(makeStore(), projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)
        XCTAssertNil(LoopEngineConfig.load(for: projectId, defaults: defaults))
    }

    // MARK: - No project folder

    /// With no resolvable project folder there is nowhere to put a file, so
    /// the fallback persists the PRIMARY loop's bare config to the legacy
    /// UserDefaults slot — a non-primary loop has nowhere to go in this
    /// corner case, same degraded-but-not-broken behavior this path always had.
    func testFallsBackToUserDefaultsWhenNoProjectRootIsAvailable() {
        let store = makeStore(iterations: 5)
        LoopEngineConfigStore.save(store, projectRoot: nil, projectId: projectId, defaults: defaults)
        XCTAssertEqual(
            LoopEngineConfigStore.load(projectRoot: nil, projectId: projectId, defaults: defaults),
            store)
        XCTAssertEqual(LoopEngineConfig.load(for: projectId, defaults: defaults), store.loops[0].config)
    }

    // MARK: - Portability

    func testConfigTravelsWithTheProjectFolderToAFreshUserDefaults() throws {
        let store = LoopEngineProjectStore(loops: [
            LoopDefinition(name: "Main Loop", isPrimary: true, config: LoopEngineConfig(
                stages: [
                    LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, order: 0),
                    LoopStage(id: "l1", name: "Lint", kind: .shellCommand, command: "make lint",
                              order: 1, severity: .advisory, timeoutSeconds: 60)
                ],
                maxIterations: 3, consecutiveFailureStop: 4,
                wallClockBudgetSeconds: nil, maxRepairsPerStage: 2,
                protectedPathPolicy: .stop, extraProtectedGlobs: ["fixtures/**"],
                writeSummaryNote: true))
        ])
        LoopEngineConfigStore.save(store, projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)

        let freshDefaults = UserDefaults(suiteName: "fresh-\(UUID().uuidString)")!
        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot,
                                                 projectId: "some-other-id",
                                                 defaults: freshDefaults)
        XCTAssertEqual(loaded, store)
    }

    // MARK: - primaryLoop

    func testPrimaryLoopResolvesTheLoopMarkedPrimary() {
        let store = LoopEngineProjectStore(loops: [
            LoopDefinition(name: "Secondary", isPrimary: false, config: makeConfig(stage: "A")),
            LoopDefinition(name: "Main Loop", isPrimary: true, config: makeConfig(stage: "B"))
        ])
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        let primary = LoopEngineConfigStore.primaryLoop(projectRoot: projectRoot, projectId: projectId,
                                                        defaults: defaults)
        XCTAssertEqual(primary?.name, "Main Loop")
    }

    /// Defensive fallback — should never happen via the UI, but a hand-edited
    /// file with no `isPrimary: true` loop must not resolve to nil.
    func testPrimaryLoopFallsBackToFirstLoopWhenNoneIsMarkedPrimary() {
        let store = LoopEngineProjectStore(loops: [
            LoopDefinition(name: "First", isPrimary: false, config: makeConfig())
        ])
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        let primary = LoopEngineConfigStore.primaryLoop(projectRoot: projectRoot, projectId: projectId,
                                                        defaults: defaults)
        XCTAssertEqual(primary?.name, "First")
    }

    func testPrimaryLoopIsNilWhenNoConfigExists() {
        XCTAssertNil(LoopEngineConfigStore.primaryLoop(projectRoot: projectRoot, projectId: projectId,
                                                        defaults: defaults))
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -40`
Expected: BUILD FAILURE — `LoopEngineConfigStore.load`/`.save` still take/return bare `LoopEngineConfig`, and `primaryLoop` doesn't exist.

- [ ] **Step 3: Rewrite `LoopEngineConfigStore`**

Replace the entire contents of `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfigStore.swift`:

```swift
import Foundation

/// Reads and writes a project's Loop contract at `<projectRoot>/system/loop.json`.
///
/// **Why a file and not UserDefaults.** The loop list, its stages, budgets
/// and protected-path policy describe *this repo's* verification contract,
/// so it belongs to the repo — not to one macOS user account on one Mac.
/// Stored in UserDefaults it survived closing the app and logging out, but a
/// fresh clone, a second machine, or a teammate got none of it. The file sits
/// next to `system/project.json` and is committed, so the contract travels
/// with the code it verifies.
///
/// **Schema.** The file holds a `LoopEngineProjectStore` — a project's full
/// list of `LoopDefinition`s, each with its own stages/budgets/goal/scope.
/// Before this existed the file held a single bare `LoopEngineConfig`; `load`
/// migrates that transparently (see below) so an existing project becomes
/// "one loop, named Main Loop, marked Primary" the first time it is opened
/// after this ships, with no action from the user.
///
/// **What deliberately stays local.** Shell-command approvals
/// (`VerifyApprovalStore`) are NOT moved here, for the same reason as before:
/// each machine must approve a command before it runs, or a cloned repo could
/// ship pre-approved arbitrary shell commands for a loop to run unattended.
/// `LoopEngineDefaults` also stays in UserDefaults — a per-user preference for
/// *new* loops, not a property of any one repo.
enum LoopEngineConfigStore {
    /// `<projectRoot>/system/loop.json`.
    static func fileURL(projectRoot: URL) -> URL {
        projectRoot.appendingPathComponent("system", isDirectory: true)
            .appendingPathComponent("loop.json")
    }

    /// Pretty-printed with sorted keys because this file is committed: a
    /// compact single-line JSON blob would make every budget tweak an
    /// unreviewable diff, and unsorted keys would churn between writes.
    private static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }

    /// This project's saved loops, or `nil` when it has none yet.
    ///
    /// Resolution order:
    /// 1. The file, decoded as the current `LoopEngineProjectStore` schema.
    /// 2. The file, decoded as the legacy bare `LoopEngineConfig` schema —
    ///    wrapped as one Primary loop named "Main Loop" and **written back
    ///    immediately** in the new schema, so the next read hits step 1.
    /// 3. The legacy UserDefaults entry (pre-file era) — wrapped the same way
    ///    and written to the file if a `projectRoot` is available.
    ///
    /// `projectRoot == nil` (no resolvable project folder) skips the file
    /// entirely and falls back to UserDefaults, same as before this existed —
    /// there is nowhere to put a file.
    static func load(projectRoot: URL?, projectId: String,
                     defaults: UserDefaults = .standard) -> LoopEngineProjectStore? {
        guard let projectRoot else {
            return LoopEngineConfig.load(for: projectId, defaults: defaults).map(wrapAsMainLoop)
        }
        let url = fileURL(projectRoot: projectRoot)
        if let data = try? Data(contentsOf: url) {
            if let store = try? JSONDecoder().decode(LoopEngineProjectStore.self, from: data) {
                return store
            }
            if let legacyConfig = try? JSONDecoder().decode(LoopEngineConfig.self, from: data) {
                let wrapped = wrapAsMainLoop(legacyConfig)
                write(wrapped, to: url)
                return wrapped
            }
        }
        if let legacy = LoopEngineConfig.load(for: projectId, defaults: defaults) {
            let wrapped = wrapAsMainLoop(legacy)
            write(wrapped, to: url)
            return wrapped
        }
        return nil
    }

    /// Wraps a pre-multi-loop config as the project's one Primary loop. The
    /// SAME wrapping used by both migration steps in `load`, so a project
    /// migrated via the file path and one migrated via the UserDefaults path
    /// end up with an identical "Main Loop".
    private static func wrapAsMainLoop(_ config: LoopEngineConfig) -> LoopEngineProjectStore {
        LoopEngineProjectStore(loops: [LoopDefinition(name: "Main Loop", isPrimary: true, config: config)])
    }

    /// Persists `store` for this project.
    ///
    /// With a resolvable `projectRoot` the file is the sole source of truth —
    /// the legacy UserDefaults entry is deliberately NOT kept in step, same
    /// reasoning as before. With no `projectRoot`, the Primary loop's bare
    /// `LoopEngineConfig` is written to the legacy UserDefaults slot as a
    /// degraded fallback; a non-Primary loop has nowhere to persist in that
    /// corner case (no project folder resolvable at all), which is an
    /// existing limitation of that fallback, not a new one.
    static func save(_ store: LoopEngineProjectStore, projectRoot: URL?, projectId: String,
                     defaults: UserDefaults = .standard) {
        guard let projectRoot else {
            if let primary = store.loops.first(where: \.isPrimary) ?? store.loops.first {
                primary.config.save(for: projectId, defaults: defaults)
            }
            return
        }
        write(store, to: fileURL(projectRoot: projectRoot))
    }

    /// Whether this project has a saved contract. Goes through `load`, so a
    /// project still on an old schema is migrated by asking this question —
    /// idempotent, and the earliest point we want the migration to happen.
    static func exists(projectRoot: URL?, projectId: String,
                       defaults: UserDefaults = .standard) -> Bool {
        load(projectRoot: projectRoot, projectId: projectId, defaults: defaults) != nil
    }

    /// The loop the scheduled Auto Task sweep and the phone target. Resolves
    /// to the loop marked `isPrimary`, or the first loop if (defensively)
    /// none is marked — the UI never allows unsetting the only Primary
    /// without designating a new one first, so this fallback should not be
    /// reachable in practice.
    static func primaryLoop(projectRoot: URL?, projectId: String,
                            defaults: UserDefaults = .standard) -> LoopDefinition? {
        guard let store = load(projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        else { return nil }
        return store.loops.first(where: \.isPrimary) ?? store.loops.first
    }

    private static func write(_ store: LoopEngineProjectStore, to url: URL) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try encoder().encode(store).write(to: url, options: .atomic)
        } catch {
            NSLog("LoopEngineConfigStore: write failed at \(url.path): \(error.localizedDescription)")
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -40`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfigStore.swift mac/Tests/LlmIdeMacTests/LoopEngineConfigStoreTests.swift
git commit -m "$(cat <<'EOF'
feat(mac): LoopEngineConfigStore persists a list of named loops

system/loop.json's schema moves from a bare LoopEngineConfig to
LoopEngineProjectStore. A 3-step decode fallback (new schema, legacy
file schema, legacy UserDefaults) upgrades any existing project to
one Primary loop named "Main Loop" the first time it's opened, with
no action needed. primaryLoop(...) is the convenience the sweep,
chat command, and mobile bridge resolve against until they support
targeting any loop.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `LoopEngineRunner` — loop identity threading + concurrency ownership

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`
- Modify: `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift` (append new tests only)

All new parameters are defaulted, so none of the ~40 existing tests in this file change.

- [ ] **Step 1: Write the failing tests**

Append to `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift`, inside the `LoopEngineRunnerTests` class (after the existing tests, before the closing `}`):

```swift
    // MARK: - Loop identity (multi-loop)

    func testRunRecordsTheLoopIdAndNamePassedIn() async {
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             loopId: "loop-42", loopName: "Fix flaky tests")
        XCTAssertEqual(journal.written.last?.loopId, "loop-42")
        XCTAssertEqual(journal.written.last?.loopName, "Fix flaky tests")
    }

    /// Existing call sites that don't pass a loop identity (every test above
    /// this one) must keep working — the defaults exist precisely so this
    /// file didn't need touching for Task 4.
    func testRunWithNoLoopIdentityPassedStillJournalsSomeDefault() async {
        let journal = InMemoryJournal()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            journal: journal
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertFalse(journal.written.last?.loopId?.isEmpty ?? true)
    }

    func testActiveLoopIdReflectsWhichLoopOwnsAnInFlightRun() async {
        let repairer = BlockingRepairer()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 5)

        XCTAssertNil(LoopEngineRunner.activeLoopId(gitRoot: repoRoot))
        let task = Task {
            await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             loopId: "loop-active", loopName: "Active")
        }
        await repairer.started.wait()
        XCTAssertEqual(LoopEngineRunner.activeLoopId(gitRoot: repoRoot), "loop-active")

        await repairer.release.fire()
        _ = await task.value
        XCTAssertNil(LoopEngineRunner.activeLoopId(gitRoot: repoRoot),
                    "must clear once the run finishes")
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -40`
Expected: BUILD FAILURE — `run(...)` has no `loopId`/`loopName` parameters, `activeLoopId` doesn't exist.

- [ ] **Step 3: Thread loop identity through the runner**

In `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`:

1. Add the parallel active-loop-id guard next to `activeRoots` (after line 56):

```swift
    /// Which loop owns the in-flight run on each `gitRoot`, keyed the same
    /// way `activeRoots` is. Lets any surface's running-indicator (e.g. the
    /// loop-list pane's dot) land on the correct loop regardless of whether
    /// the run was started from this page, another window, or the Auto Task
    /// scheduler — same reasoning `MobileControlManager.buildLoopState()`
    /// already documents for `running` itself.
    @MainActor private static var activeLoopIds: [String: String] = [:]

    /// The loop id owning the in-flight run on `gitRoot`, or `nil` when no
    /// run is active there.
    @MainActor
    static func activeLoopId(gitRoot: URL) -> String? {
        activeLoopIds[gitRoot.resolvingSymlinksInPath().path]
    }
```

2. Extend `RunContext` (around line 93):

```swift
    private struct RunContext {
        let config: LoopEngineConfig
        let faultsRoot: URL
        let gitRoot: URL
        let projectId: String?
        let loopId: String
        let loopName: String
        let goal: String?
        let acceptanceCriteria: String?
        let scopeGlobs: [String]
        let startedAt: Date
    }
```

3. Update `handleAppTerminating()`'s `LoopRunRecord` construction (around line 161):

```swift
        let record = LoopRunRecord(
            id: UUID().uuidString, projectId: ctx.projectId, trigger: trigger,
            gitRoot: ctx.gitRoot.path, startedAt: ctx.startedAt, endedAt: Date(),
            iterationsUsed: iteration, config: LoopRunConfigSnapshot(ctx.config),
            iterations: iterationRecords, statusCode: LoopEngineStatus.aborted.code,
            statusSummary: LoopEngineStatus.aborted.summary,
            loopId: ctx.loopId, loopName: ctx.loopName)
```

4. Replace `run(...)`'s signature and body (lines 199–376) with:

```swift
    /// - Parameters:
    ///   - faultsRoot: project root passed through to the regression sweep, and
    ///     the root the run journal is written beneath.
    ///   - gitRoot: git working tree shell-command stages run in,
    ///     approvals are keyed against, and the concurrency lock key.
    ///   - projectId: recorded in the journal so runs can be attributed to a
    ///     project later. Optional — a missing id degrades analysis, never the run.
    ///   - loopId: which `LoopDefinition` this run executes — recorded on the
    ///     journal and exposed via `activeLoopId(gitRoot:)`. Defaulted so
    ///     every pre-existing caller (and every existing test) is unaffected;
    ///     real callers pass the loop's actual id.
    ///   - loopName: the loop's name at run time, recorded alongside `loopId`.
    ///   - goal: free text describing what this loop is trying to achieve.
    ///     When set, woven into the repair/skill prompts this run builds.
    ///   - acceptanceCriteria: free text describing the observable "done"
    ///     condition. Same treatment as `goal`.
    ///   - scopeGlobs: optional path allowlist. Empty (the default) means
    ///     unrestricted. See `withScopeGuard`.
    @discardableResult
    func run(config: LoopEngineConfig, faultsRoot: URL, gitRoot: URL,
             projectId: String? = nil, loopId: String = "primary", loopName: String = "Loop",
             goal: String? = nil, acceptanceCriteria: String? = nil,
             scopeGlobs: [String] = []) async -> LoopEngineStatus? {
        guard !running else {
            appendLog(.warn, "Loop not started · this runner instance is already running")
            return nil
        }
        let rootKey = gitRoot.resolvingSymlinksInPath().path
        guard !Self.activeRoots.contains(rootKey) else {
            appendLog(.warn, "Loop not started · a run is already in progress for this repo")
            return nil
        }
        Self.activeRoots.insert(rootKey)
        Self.activeLoopIds[rootKey] = loopId
        running = true
        status = nil
        iteration = 0
        iterationRecords = []
        let startedAt = Date()
        currentRunContext = RunContext(config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                       projectId: projectId, loopId: loopId, loopName: loopName,
                                       goal: goal, acceptanceCriteria: acceptanceCriteria,
                                       scopeGlobs: scopeGlobs, startedAt: startedAt)
        defer {
            running = false
            Self.activeRoots.remove(rootKey)
            Self.activeLoopIds.removeValue(forKey: rootKey)
            currentRunContext = nil
        }

        let orderedStages = LoopStage.runOrder(config.stages.filter(\.enabled))
        let disabledCount = config.stages.count - orderedStages.count
        guard !orderedStages.isEmpty else {
            let reason = config.stages.isEmpty
                ? "No stages configured"
                : "Every stage is disabled — enable at least one"
            appendLog(.warn, "Loop not run · \(reason)")
            return await finish(.error(reason),
                                config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                projectId: projectId, loopId: loopId, loopName: loopName,
                                startedAt: startedAt)
        }
        let skippedNote = disabledCount > 0 ? " (\(disabledCount) disabled stage(s) skipped)" : ""
        appendLog(.info, "Loop started · \(orderedStages.count) stage(s), max \(config.maxIterations) iteration(s)\(skippedNote)")

        for stage in orderedStages {
            switch stage.kind {
            case .shellCommand:
                guard let command = Self.validCommand(stage) else {
                    return await finish(.error("Stage \"\(stage.name)\" has no command"),
                                        config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                        projectId: projectId, loopId: loopId, loopName: loopName,
                                        startedAt: startedAt)
                }
                guard approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command) else {
                    appendLog(.warn, "  [\(stage.name)] needs approval: \(command)")
                    return await finish(.needsApproval(stageName: stage.name),
                                        config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                        projectId: projectId, loopId: loopId, loopName: loopName,
                                        startedAt: startedAt)
                }
            case .skill:
                guard let skillId = stage.skillId,
                      !skillId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return await finish(.error("Stage \"\(stage.name)\" has no skill chosen"),
                                        config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                                        projectId: projectId, loopId: loopId, loopName: loopName,
                                        startedAt: startedAt)
                }
            case .regressionSweep:
                break
            }
        }

        var progress = ProgressWatch()
        var repairsUsed: [String: Int] = [:]

        iterationLoop: while iteration < config.maxIterations {
            if Task.isCancelled {
                status = .aborted
                break iterationLoop
            }

            if iteration >= 1, let budget = config.wallClockBudgetSeconds,
               Date().timeIntervalSince(startedAt) > budget {
                appendLog(.warn, "Time budget of \(Int(budget))s exceeded after \(iteration) iteration(s)")
                status = .givenUp(reason: .wallClockExceeded)
                break iterationLoop
            }

            iteration += 1
            iterationRecords.append(LoopIterationRecord(index: iteration))
            appendLog(.info, "Iteration \(iteration)/\(config.maxIterations)")

            for stage in orderedStages {
                let decision: StageDecision
                switch stage.kind {
                case .regressionSweep:
                    decision = await runRegressionStage(
                        stage, config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                        progress: &progress)
                case .shellCommand:
                    decision = await runShellStage(
                        stage, config: config, gitRoot: gitRoot,
                        progress: &progress, repairsUsed: &repairsUsed,
                        goal: goal, acceptanceCriteria: acceptanceCriteria, scopeGlobs: scopeGlobs)
                case .skill:
                    decision = await runSkillStage(stage, config: config, gitRoot: gitRoot,
                                                   goal: goal, acceptanceCriteria: acceptanceCriteria,
                                                   scopeGlobs: scopeGlobs)
                }

                switch decision {
                case .proceed:
                    continue
                case .retryIteration:
                    continue iterationLoop
                case .terminate(let terminal):
                    status = terminal
                    break iterationLoop
                }
            }

            if status == nil {
                status = .success
                break iterationLoop
            }
        }

        if Task.isCancelled, status != .success {
            status = .aborted
        }
        return await finish(status ?? .givenUp(reason: .maxIterations),
                            config: config, faultsRoot: faultsRoot, gitRoot: gitRoot,
                            projectId: projectId, loopId: loopId, loopName: loopName,
                            startedAt: startedAt)
    }
```

5. Update `runShellStage`'s signature (around line 420) to accept and forward the new params — for this step only add the params and thread `scopeGlobs` into `withScopeGuard`'s call (goal/acceptanceCriteria are wired into the repair prompt in Task 5):

```swift
    private func runShellStage(_ stage: LoopStage, config: LoopEngineConfig, gitRoot: URL,
                               progress: inout ProgressWatch,
                               repairsUsed: inout [String: Int],
                               goal: String? = nil, acceptanceCriteria: String? = nil,
                               scopeGlobs: [String] = []) async -> StageDecision {
```

   Inside this function, change the one `withScopeGuard` call site (around line 512) to pass `scopeGlobs`:

```swift
        let guarded = await withScopeGuard(stage: stage, config: config, gitRoot: gitRoot,
                                           scopeGlobs: scopeGlobs) {
            try await stageRepairer.repair(
                stageName: stage.name, command: command,
                failureOutput: outcome.output, evidence: evidence, repoRoot: gitRoot)
        }
```

6. Update `runSkillStage`'s signature (around line 537) the same way:

```swift
    private func runSkillStage(_ stage: LoopStage, config: LoopEngineConfig,
                              gitRoot: URL, goal: String? = nil,
                              acceptanceCriteria: String? = nil,
                              scopeGlobs: [String] = []) async -> StageDecision {
        let skillId = stage.skillId ?? ""
        let message = Self.composeSkillMessage(stage)
        let startedAt = Date()
        appendLog(.info, "  [\(stage.name)] running skill \(skillId.isEmpty ? "(none set)" : skillId) (generate)")

        let guarded = await withScopeGuard(stage: stage, config: config, gitRoot: gitRoot,
                                           scopeGlobs: scopeGlobs) {
            try await skillExecutor.execute(skillId: skillId, targetPath: stage.targetPath, message: message)
        }
```

   (leave the rest of `runSkillStage`'s body — the `switch guarded { ... }` block — unchanged for this step.)

7. Update `withScopeGuard`'s signature (around line 591) to accept `scopeGlobs` and pass it through to `scopeGuard.check` — no scope-allowlist enforcement logic yet (that's Task 6); this step only threads the parameter:

```swift
    private func withScopeGuard(stage: LoopStage, config: LoopEngineConfig, gitRoot: URL,
                                scopeGlobs: [String] = [],
                                edit: () async throws -> Void) async -> GuardedEditResult {
```

   (the body stays exactly as it is today for this step — Task 6 changes the body.)

8. Update `finish(...)`'s signature and its `LoopRunRecord` construction (around line 675):

```swift
    private func finish(_ terminal: LoopEngineStatus, config: LoopEngineConfig,
                        faultsRoot: URL, gitRoot: URL, projectId: String?,
                        loopId: String, loopName: String,
                        startedAt: Date) async -> LoopEngineStatus {
        status = terminal
        appendLog(logLevel(for: terminal), "Loop finished · \(terminal.summary)")

        let record = LoopRunRecord(
            id: UUID().uuidString, projectId: projectId, trigger: trigger,
            gitRoot: gitRoot.path, startedAt: startedAt, endedAt: Date(),
            iterationsUsed: iteration, config: LoopRunConfigSnapshot(config),
            iterations: iterationRecords, statusCode: terminal.code,
            statusSummary: terminal.summary, loopId: loopId, loopName: loopName)
        if let reason = journal.write(record, root: faultsRoot) {
            appendLog(.warn, "Run journal not written: \(reason)")
        }
        if config.writeSummaryNote {
            switch await summaryWriter.write(record, root: faultsRoot) {
            case .written(let path):
                appendLog(.info, "Run summary note written: \(path)")
            case .failed(let reason):
                appendLog(.warn, "Run summary note not written: \(reason)")
            }
        }
        return terminal
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -60`
Expected: build succeeds. (`swift test` no-ops per the environment note; read the new tests against the implementation to confirm correctness.)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift
git commit -m "$(cat <<'EOF'
feat(mac): LoopEngineRunner records which loop a run belongs to

run(...) gains loopId/loopName/goal/acceptanceCriteria/scopeGlobs,
all defaulted so every existing caller and test is unaffected.
activeLoopId(gitRoot:) lets any surface's running-indicator identify
which loop owns an in-flight run, however it was started.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Weave `goal`/`acceptanceCriteria` into repair and skill prompts

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`
- Modify: `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift` (append)

No changes to `LoopStageRepairer`/`LoopSkillExecuting` or their production/test conformers — both already take a fully-composed `String` (`failureOutput`/`message`), so the context is prepended to that string entirely inside `LoopEngineRunner`.

- [ ] **Step 1: Write the failing tests**

Append to `LoopEngineRunnerTests.swift`:

```swift
    // MARK: - Goal/acceptance context

    /// The repair agent must see the loop's goal/acceptance, not just the
    /// bare failure output — that's the whole point of the fields.
    func testRepairFailureOutputIncludesGoalAndAcceptanceCriteriaWhenSet() async {
        let repairer = StubRepairer()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             goal: "Stabilize auth", acceptanceCriteria: "swift test passes")
        XCTAssertEqual(repairer.receivedFailureOutputs.count, 1)
        let seen = repairer.receivedFailureOutputs[0]
        XCTAssertTrue(seen.contains("Stabilize auth"))
        XCTAssertTrue(seen.contains("swift test passes"))
        XCTAssertTrue(seen.contains("boom"), "the real failure output must still be present")
    }

    /// No goal/acceptance set (every loop before this feature, and every
    /// existing test above) must produce BYTE-IDENTICAL failure output to
    /// what the repairer received before this feature existed.
    func testRepairFailureOutputIsUnchangedWhenGoalAndAcceptanceAreNotSet() async {
        let repairer = StubRepairer()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(repairer.receivedFailureOutputs, ["boom"])
    }

    func testSkillMessageIncludesGoalAndAcceptanceCriteriaWhenSet() async {
        let skill = StubSkillExecutor()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: skill,
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Fix", kind: .skill, command: nil, order: 0,
                      skillId: "skills/fix", targetPath: nil, prompt: nil),
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                             goal: "Ship the refactor", acceptanceCriteria: "no behavior change")
        XCTAssertEqual(skill.receivedMessages.count, 1)
        XCTAssertTrue(skill.receivedMessages[0].contains("Ship the refactor"))
        XCTAssertTrue(skill.receivedMessages[0].contains("no behavior change"))
    }
```

`StubRepairer` and `StubSkillExecutor` need to capture what they were called with. Update their declarations (near the top of `LoopEngineRunnerTests.swift`):

```swift
    private final class StubRepairer: LoopStageRepairer {
        private(set) var repairCount = 0
        private(set) var evidence: [RepairEvidence?] = []
        private(set) var receivedFailureOutputs: [String] = []
        func repair(stageName: String, command: String?, failureOutput: String,
                    evidence: RepairEvidence?, repoRoot: URL) async throws {
            repairCount += 1
            self.evidence.append(evidence)
            receivedFailureOutputs.append(failureOutput)
        }
    }
```

```swift
    private struct SkillError: Error {}
    private final class StubSkillExecutor: LoopSkillExecuting {
        private(set) var callCount = 0
        private(set) var receivedMessages: [String] = []
        var throwOnEveryCall: Bool = false
        func execute(skillId: String, targetPath: String?, message: String) async throws {
            callCount += 1
            receivedMessages.append(message)
            if throwOnEveryCall { throw SkillError() }
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -40`
Expected: BUILD FAILURE — `receivedFailureOutputs`/`receivedMessages` compile (they're new stub members), but the assertions fail once run: the prompt/message text won't yet contain the goal/acceptance strings.

Run: the two tests directly once building succeeds, confirm they fail on the `XCTAssertTrue(seen.contains(...))` lines specifically (not on a build error) before moving to Step 3.

- [ ] **Step 3: Compose the context**

In `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`, add a static helper near `composeSkillMessage` (around line 725):

```swell
    /// Prefixes `goal`/`acceptanceCriteria` (when either is set) onto text the
    /// repair agent or a skill stage will see, so a loop's "done" signal is
    /// more than "the command exited 0". Returns `text` unchanged when both
    /// are `nil`/empty — every loop before this feature, and every migrated
    /// loop that never sets them, sees byte-identical prompts to before.
    private static func prependGoalContext(_ text: String, goal: String?, acceptanceCriteria: String?) -> String {
        var lines: [String] = []
        if let goal, !goal.isEmpty { lines.append("Goal: \(goal)") }
        if let acceptanceCriteria, !acceptanceCriteria.isEmpty {
            lines.append("Acceptance criteria: \(acceptanceCriteria)")
        }
        guard !lines.isEmpty else { return text }
        return lines.joined(separator: "\n") + "\n\n" + text
    }
```

(Note: fix the accidental "```swell" language tag above to "```swift" when creating the file — it is a plain Swift code block.)

Change `runShellStage`'s call into `stageRepairer.repair(...)` (the one inside the `withScopeGuard` closure, around line 512–516) to wrap `failureOutput`:

```swift
        let guarded = await withScopeGuard(stage: stage, config: config, gitRoot: gitRoot,
                                           scopeGlobs: scopeGlobs) {
            try await stageRepairer.repair(
                stageName: stage.name, command: command,
                failureOutput: Self.prependGoalContext(outcome.output, goal: goal,
                                                       acceptanceCriteria: acceptanceCriteria),
                evidence: evidence, repoRoot: gitRoot)
        }
```

Important: leave every OTHER use of `outcome.output` in `runShellStage` (the `record(...)` calls, the log line, the hash input) untouched — only the text handed to the repairer changes. The journal must keep recording the raw command output, not the goal-prefixed version.

Change `runSkillStage`'s message composition (around line 540):

```swift
        let skillId = stage.skillId ?? ""
        let message = Self.prependGoalContext(Self.composeSkillMessage(stage), goal: goal,
                                              acceptanceCriteria: acceptanceCriteria)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -40`
Expected: build succeeds; re-read the two new assertions against the implementation — `prependGoalContext` puts `"Goal: ..."`/`"Acceptance criteria: ..."` lines before the original text, so `.contains(...)` on both the new strings and the original failure text (`"boom"`) holds.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift
git commit -m "$(cat <<'EOF'
feat(mac): weave a loop's goal/acceptance criteria into repair prompts

No protocol changes needed — LoopStageRepairer.repair and
LoopSkillExecuting.execute already take a fully-composed String, so
the context is prepended there. Unset (every loop before this
feature) produces byte-identical prompts.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Scope allowlist inside `withScopeGuard`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`
- Modify: `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift` (append)

Deliberately contained to `LoopEngineRunner.withScopeGuard` — `RepairScopeGuard.swift`, `GitRepairScopeGuard`, and `RepairScopeGuardTests.swift` are NOT touched. Swift protocol method requirements cannot carry default argument values, and `RepairScopeGuarding.check(...)` already has 14+ call sites in `RepairScopeGuardTests.swift`; folding the allowlist check into the runner's own post-processing of `check`'s result avoids all of that churn while producing the identical observable behavior the spec describes.

- [ ] **Step 1: Write the failing tests**

First, read the existing protected-path tests in `LoopEngineRunnerTests.swift` around "MARK: - Protected-path guard" (the section starting near what was originally line 1009) to see the exact `StubScopeGuard`/`StubVerifier` setup they use — the new tests below follow the same shape. Append after that section:

```swift
    // MARK: - Scope allowlist

    /// A changed path OUTSIDE every `scopeGlobs` entry must be blocked the
    /// same way a protected-path violation is — even though the scope guard
    /// itself reported `.clean` (no denylist hit).
    func testChangeOutsideScopeAllowlistIsBlockedEvenWhenNotProtected() async {
        let scopeGuard = StubScopeGuard(result: .clean(changedPaths: ["src/other/File.swift"]))
        let repairer = StubRepairer()
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 5, protectedPathPolicy: .revert)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                                      scopeGlobs: ["src/auth/**"])
        guard case .blocked(let reason) = result else {
            return XCTFail("expected .blocked, got \(String(describing: result))")
        }
        guard case .repairOutOfScope(_, let paths) = reason else {
            return XCTFail("expected .repairOutOfScope, got \(reason)")
        }
        XCTAssertEqual(paths, ["src/other/File.swift"])
        XCTAssertEqual(scopeGuard.revertedPaths, ["src/other/File.swift"])
    }

    /// A changed path INSIDE the allowlist is clean, same as today.
    func testChangeInsideScopeAllowlistIsClean() async {
        let scopeGuard = StubScopeGuard(result: .clean(changedPaths: ["src/auth/Login.swift"]))
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                                      scopeGlobs: ["src/auth/**"])
        XCTAssertNotEqual(result, .blocked(reason: .repairOutOfScope(stageName: "Test", paths: [])))
        XCTAssertTrue(scopeGuard.revertedPaths.isEmpty)
    }

    /// An empty `scopeGlobs` (the default — every loop before this feature,
    /// and any loop that never sets one) must change nothing: a denylist-only
    /// `.clean` result stays clean.
    func testEmptyScopeGlobsChangesNothing() async {
        let scopeGuard = StubScopeGuard(result: .clean(changedPaths: ["src/anywhere/File.swift"]))
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertNotEqual(result, .blocked(reason: .repairOutOfScope(stageName: "Test", paths: [])))
    }

    /// A path that is BOTH out-of-scope and denylist-protected reports the
    /// union of both violation sets — no path is silently dropped.
    func testViolationsFromDenylistAndScopeAllowlistAreMerged() async {
        let scopeGuard = StubScopeGuard(result: .violated(
            paths: ["mac/Tests/Some.swift"], allChangedPaths: ["mac/Tests/Some.swift", "src/other/File.swift"]))
        let runner = makeRunner(
            verifier: StubVerifier { _ in VerifyOutcome(exitCode: 1, output: "boom") },
            stageRepairer: StubRepairer(),
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            skillExecutor: StubSkillExecutor(),
            approvals: makeApprovals(approve: [("t1", "swift test")]),
            scopeGuard: scopeGuard
        )
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 5, protectedPathPolicy: .revert)
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot,
                                      scopeGlobs: ["src/auth/**"])
        guard case .blocked(let reason) = result, case .repairOutOfScope(_, let paths) = reason else {
            return XCTFail("expected .blocked/.repairOutOfScope, got \(String(describing: result))")
        }
        XCTAssertEqual(Set(paths), Set(["mac/Tests/Some.swift", "src/other/File.swift"]))
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -40`
Expected: build succeeds (no new API surface needed yet — the test failures will be assertion failures, e.g. `testChangeOutsideScopeAllowlistIsBlockedEvenWhenNotProtected` getting `.success`/`.givenUp` instead of `.blocked`, since `withScopeGuard` doesn't check `scopeGlobs` yet).

- [ ] **Step 3: Implement the allowlist check inside `withScopeGuard`**

Replace `withScopeGuard`'s body (the function signature was already updated in Task 4; this step replaces everything from the `guard config.protectedPathPolicy != .off else { ... }` line through the end of the function, around lines 592–629):

```swift
    private func withScopeGuard(stage: LoopStage, config: LoopEngineConfig, gitRoot: URL,
                                scopeGlobs: [String] = [],
                                edit: () async throws -> Void) async -> GuardedEditResult {
        guard config.protectedPathPolicy != .off else {
            do { try await edit() } catch { return .failed(error) }
            return .completed(.notChecked, violations: [], changed: [])
        }

        let before = await scopeGuard.snapshot(gitRoot: gitRoot)
        do { try await edit() } catch { return .failed(error) }

        switch await scopeGuard.check(since: before, gitRoot: gitRoot,
                                      protectedGlobs: config.protectedGlobs) {
        case .clean(let changed):
            let outOfScope = Self.outOfScopePaths(changed, scopeGlobs: scopeGlobs)
            guard outOfScope.isEmpty else {
                return await handleViolation(outOfScope, changed: changed, stage: stage, config: config)
            }
            return .completed(.clean, violations: [], changed: changed)

        case .indeterminate(let reason):
            appendLog(.warn, "  [\(stage.name)] protected-path check could not run: \(reason)")
            return .completed(.indeterminate, violations: [], changed: [])

        case .violated(let paths, let changed):
            let outOfScope = Self.outOfScopePaths(changed, scopeGlobs: scopeGlobs)
            let merged = Array(Set(paths).union(outOfScope)).sorted()
            return await handleViolation(merged, changed: changed, stage: stage, config: config)
        }
    }

    /// `changed` paths that match none of `scopeGlobs` — `[]` whenever
    /// `scopeGlobs` is empty, so an unset allowlist (every loop before this
    /// feature, and any loop that never sets one) flags nothing.
    private static func outOfScopePaths(_ changed: [String], scopeGlobs: [String]) -> [String] {
        guard !scopeGlobs.isEmpty else { return [] }
        return changed.filter { path in
            !scopeGlobs.contains { GlobMatch.matches(path: path, pattern: $0) }
        }
    }

    /// Shared violation handling for both a denylist hit and an out-of-scope
    /// change — logs, and under `.revert` attempts to undo exactly `paths`.
    /// Factored out of the old inline `.violated` branch so the scope-allowlist
    /// path (which can reach a violation from a `.clean` scope-guard result)
    /// gets identical policy handling instead of a second copy of it.
    private func handleViolation(_ paths: [String], changed: [String], stage: LoopStage,
                                 config: LoopEngineConfig) async -> GuardedEditResult {
        appendLog(.error, "  [\(stage.name)] repair edited protected/out-of-scope path(s): \(paths.joined(separator: ", "))")
        guard config.protectedPathPolicy == .revert else {
            return .completed(.violated, violations: paths, changed: changed)
        }
        if let error = await scopeGuard.revert(paths: paths, gitRoot: gitRoot) {
            appendLog(.error, "  [\(stage.name)] could not revert protected/out-of-scope path(s): \(error)")
            return .completed(.violated, violations: paths, changed: changed)
        }
        appendLog(.info, "  [\(stage.name)] reverted \(paths.count) protected/out-of-scope path(s)")
        return .completed(.violatedReverted, violations: paths, changed: changed)
    }
```

Note the `gitRoot` used inside `handleViolation`'s `scopeGuard.revert(paths:gitRoot:)` call must be the same `gitRoot` `withScopeGuard` received — since `handleViolation` is a method on `self` (not a nested closure), add `gitRoot: URL` as its own parameter rather than capturing a stale value:

```swift
    private func handleViolation(_ paths: [String], changed: [String], stage: LoopStage,
                                 config: LoopEngineConfig, gitRoot: URL) async -> GuardedEditResult {
```

and update both call sites inside `withScopeGuard` to pass `gitRoot: gitRoot`:

```swift
                return await handleViolation(outOfScope, changed: changed, stage: stage,
                                             config: config, gitRoot: gitRoot)
```

```swift
            return await handleViolation(merged, changed: changed, stage: stage,
                                         config: config, gitRoot: gitRoot)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -60`
Expected: build succeeds. Re-check each new test's expectation against the implementation:
- Out-of-scope-but-`.clean` → `outOfScopePaths` non-empty → `handleViolation` → `.revert` policy → `.blocked(.repairOutOfScope)`. ✓.
- In-scope `.clean` → `outOfScopePaths` empty → `.completed(.clean, ...)` → run proceeds, never `.blocked`. ✓.
- Empty `scopeGlobs` → `outOfScopePaths` always `[]` → behavior identical to before Task 6. ✓.
- Denylist `.violated` ∪ out-of-scope → merged, sorted, deduplicated set. ✓.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift
git commit -m "$(cat <<'EOF'
feat(mac): enforce a loop's optional path-scope allowlist

Checked entirely inside LoopEngineRunner.withScopeGuard against the
scope guard's already-computed changed-paths set — RepairScopeGuard.
swift and its protocol are untouched, since Swift protocol
requirements can't carry default arguments and this avoids updating
every existing call site in RepairScopeGuardTests.swift for a check
that belongs to the runner's policy layer, not the guard itself.
Empty scopeGlobs (every loop before this feature) changes nothing.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Mechanical call-site updates (Auto Task sweep, chat command, mobile bridge)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift`
- Modify: `mac/Tests/LlmIdeMacTests/MobileLoopStateTests.swift`

No UI, setting, or user-visible behavior changes here — each site keeps working exactly as today, now resolved against the Primary loop instead of "the" config.

- [ ] **Step 1: Update `MobileLoopStateTests.swift` (breaks first, so fix first)**

Read `mac/Tests/LlmIdeMacTests/MobileLoopStateTests.swift` in full before editing (it's short — two call sites at lines 74 and 92, per the earlier grep). Both currently do:

```swift
let saved = LoopEngineConfig(stages: [custom], maxIterations: 7)
LoopEngineConfigStore.save(saved, projectRoot: projectRoot, projectId: projectId)
```

Change each to wrap the config as a Primary loop before saving:

```swift
let saved = LoopEngineConfig(stages: [custom], maxIterations: 7)
LoopEngineConfigStore.save(
    LoopEngineProjectStore(loops: [LoopDefinition(name: "Main Loop", isPrimary: true, config: saved)]),
    projectRoot: projectRoot, projectId: projectId)
```

The second call site (a `saved` built from a different stage list, saved via `LoopEngineConfigStore.save(saved, projectRoot: projectRoot, projectId: projectId)` at line 92) gets the identical transformation — replace that one line with:

```swift
LoopEngineConfigStore.save(
    LoopEngineProjectStore(loops: [LoopDefinition(name: "Main Loop", isPrimary: true, config: saved)]),
    projectRoot: projectRoot, projectId: projectId)
```

leaving that test's own `saved` variable and its stage list construction (lines 88–91) untouched.

- [ ] **Step 2: Run the mobile tests to verify they compile**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -40`
Expected: BUILD FAILURE still, from the two production call sites below (not yet updated) — this step only fixes the test file so Step 4's build check isolates the remaining production errors.

- [ ] **Step 3: Update `AutoCodeUpdateService+PipelineTasks.swift`**

In `runLoopEngineeringSweep` (around lines 671–697), replace:

```swift
        let raw: LoopEngineConfig
        if let saved = LoopEngineConfigStore.load(projectRoot: faultsRoot, projectId: projectId,
                                                  defaults: defaults) {
            raw = saved
        } else {
            let detectedStages = LoopStageDetector.detectDefaultStages(gitRoot: gitRootURL)
            let detected = LoopEngineDefaults.newConfig(stages: detectedStages)
            if LoopEngineConfig.shouldPersist(detectedStages) {
                LoopEngineConfigStore.save(detected, projectRoot: faultsRoot, projectId: projectId,
                                           defaults: defaults)
            }
            raw = detected
        }
        var projectConfig = LoopStageDetector.ensureDefaultStages(in: raw, gitRoot: gitRootURL)
        if let onlyStageId {
            guard let soloed = LoopStage.soloing(projectConfig.stages, id: onlyStageId) else {
                taskErrors[AutoTask.loopEngineering.rawValue] =
                    "Loop skipped — the requested stage no longer exists."
                logStore.append(.loopEngineering,
                                "Loop skipped — single-stage run asked for a stage that no longer exists.",
                                level: .error)
                return
            }
            projectConfig.stages = soloed
        }
```

with:

```swift
        var resolvedLoop: LoopDefinition
        if let primary = LoopEngineConfigStore.primaryLoop(projectRoot: faultsRoot, projectId: projectId,
                                                            defaults: defaults) {
            resolvedLoop = primary
        } else {
            let detectedStages = LoopStageDetector.detectDefaultStages(gitRoot: gitRootURL)
            let detected = LoopEngineDefaults.newConfig(stages: detectedStages)
            let newLoop = LoopDefinition(name: "Main Loop", isPrimary: true, config: detected)
            if LoopEngineConfig.shouldPersist(detectedStages) {
                LoopEngineConfigStore.save(LoopEngineProjectStore(loops: [newLoop]),
                                           projectRoot: faultsRoot, projectId: projectId,
                                           defaults: defaults)
            }
            resolvedLoop = newLoop
        }
        resolvedLoop.config = LoopStageDetector.ensureDefaultStages(in: resolvedLoop.config, gitRoot: gitRootURL)
        if let onlyStageId {
            guard let soloed = LoopStage.soloing(resolvedLoop.config.stages, id: onlyStageId) else {
                taskErrors[AutoTask.loopEngineering.rawValue] =
                    "Loop skipped — the requested stage no longer exists."
                logStore.append(.loopEngineering,
                                "Loop skipped — single-stage run asked for a stage that no longer exists.",
                                level: .error)
                return
            }
            resolvedLoop.config.stages = soloed
        }
        let projectConfig = resolvedLoop.config
```

(the last line keeps every subsequent reference to `projectConfig` in this function — the enabled-count guard, the `runner.run(...)` call, the success/skipped-note logging — working unchanged.)

Then update the `runner.run(...)` call (around line 740) to pass the resolved loop's identity:

```swift
        let result = await runner.run(config: projectConfig, faultsRoot: faultsRoot,
                                      gitRoot: gitRootURL, projectId: projectId,
                                      loopId: resolvedLoop.id, loopName: resolvedLoop.name,
                                      goal: resolvedLoop.goal, acceptanceCriteria: resolvedLoop.acceptanceCriteria,
                                      scopeGlobs: resolvedLoop.scopeGlobs)
```

- [ ] **Step 4: Update `CodeAssistantPanel+LoopEngine.swift`**

In `runLoopEngineeringFromChat` (around lines 142–153), replace:

```swift
        let raw = LoopEngineConfigStore.load(projectRoot: faultsRoot, projectId: projectId) ?? {
            let detectedStages = LoopStageDetector.detectDefaultStages(gitRoot: gitRoot)
            let detected = LoopEngineDefaults.newConfig(stages: detectedStages)
            if LoopEngineConfig.shouldPersist(detectedStages) {
                LoopEngineConfigStore.save(detected, projectRoot: faultsRoot, projectId: projectId)
            }
            return detected
        }()
        let loopConfig = LoopStageDetector.ensureDefaultStages(in: raw, gitRoot: gitRoot)
```

with:

```swift
        let resolvedLoop = LoopEngineConfigStore.primaryLoop(projectRoot: faultsRoot, projectId: projectId) ?? {
            let detectedStages = LoopStageDetector.detectDefaultStages(gitRoot: gitRoot)
            let detected = LoopEngineDefaults.newConfig(stages: detectedStages)
            let newLoop = LoopDefinition(name: "Main Loop", isPrimary: true, config: detected)
            if LoopEngineConfig.shouldPersist(detectedStages) {
                LoopEngineConfigStore.save(LoopEngineProjectStore(loops: [newLoop]),
                                           projectRoot: faultsRoot, projectId: projectId)
            }
            return newLoop
        }()
        let loopConfig = LoopStageDetector.ensureDefaultStages(in: resolvedLoop.config, gitRoot: gitRoot)
```

Then update the `runner.run(...)` call (around line 198):

```swift
        let result = await runner.run(config: loopConfig, faultsRoot: faultsRoot,
                                      gitRoot: gitRoot, projectId: projectId,
                                      loopId: resolvedLoop.id, loopName: resolvedLoop.name,
                                      goal: resolvedLoop.goal, acceptanceCriteria: resolvedLoop.acceptanceCriteria,
                                      scopeGlobs: resolvedLoop.scopeGlobs)
```

- [ ] **Step 5: Update `MobileControlManager.swift`**

Replace `resolveLoopConfig` (around lines 1008–1015):

```swift
    nonisolated static func resolveLoopConfig(projectRoot: URL?, projectId: String,
                                              gitRoot: URL?) -> LoopEngineConfig? {
        if let primary = LoopEngineConfigStore.primaryLoop(projectRoot: projectRoot, projectId: projectId) {
            return LoopStageDetector.ensureDefaultStages(in: primary.config, gitRoot: gitRoot)
        }
        guard let gitRoot else { return nil }
        return LoopEngineDefaults.newConfig(stages: LoopStageDetector.detectDefaultStages(gitRoot: gitRoot))
    }
```

This function's signature and return type are unchanged, so its one call site inside `buildLoopState()` (`let loopConfig = Self.resolveLoopConfig(...)`) needs no edit.

`buildLoopState()` has a SECOND direct call to the old `load` API (around line 952) that also needs updating:

```swift
        let saved = LoopEngineConfigStore.load(projectRoot: context.projectRoot, projectId: projectId)
        let savedStageIds = Set(saved?.stages.map(\.id) ?? [])
```

becomes:

```swift
        let savedPrimary = LoopEngineConfigStore.primaryLoop(projectRoot: context.projectRoot, projectId: projectId)
        let savedStageIds = Set(savedPrimary?.config.stages.map(\.id) ?? [])
```

- [ ] **Step 6: Run the full build to verify every call site compiles**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -80`
Expected: build succeeds with no remaining references to the old `LoopEngineConfigStore.load(...) -> LoopEngineConfig?` shape. Grep to confirm no stragglers:

Run: `grep -rn "LoopEngineConfigStore\.load\b" mac/Sources mac/Tests`
Expected: every remaining hit is inside `LoopEngineConfigStore.swift` itself (the `primaryLoop`/migration internals) — zero hits in `AutoCodeUpdateService+PipelineTasks.swift`, `CodeAssistantPanel+LoopEngine.swift`, or `MobileControlManager.swift`.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift \
        mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift \
        mac/Sources/LlmIdeMac/Services/MobileControlManager.swift \
        mac/Tests/LlmIdeMacTests/MobileLoopStateTests.swift
git commit -m "$(cat <<'EOF'
fix(mac): the scheduled sweep, chat command, and phone target the Primary loop

Mechanical adaptation to LoopEngineConfigStore's new multi-loop
shape — no UI, setting, or user-visible behavior change on any of
the three surfaces. Each now resolves the project's Primary loop
(the migrated single loop for every existing project) instead of
"the" config, and threads its goal/acceptanceCriteria/scopeGlobs
into the runner.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `LoopEngineView` becomes a per-loop workspace

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift`

`LoopEngineView` already holds exactly one loop's worth of state (`stages`, budgets, log, past runs) — this task retargets its identity, load, and save from "the project's one config" to "this specific `LoopDefinition` within the project," and adds the new Goal/Acceptance/Scope state. The "New Loop" toolbar button and its sheet move up to the new `LoopEngineHomeView` (Task 10), since creating a loop is now a list-level action, not a per-loop one.

- [ ] **Step 1: Add `loopId`/`isPrimary` identity and the new contract fields**

In `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift`, change the struct's stored properties (around lines 42–47) to add the loop identity:

```swift
struct LoopEngineView: View {
    let api: LlmIdeAPIClient
    /// Which `LoopDefinition` within the active project this instance is the
    /// workspace for — set once by `LoopEngineHomeView` for the selected row
    /// in its loop list. Everything below that used to key off only
    /// `activeProjectId` now keys off `(activeProjectId, loopId)`.
    let loopId: String

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @EnvironmentObject var logStore: TaskLogStore
```

Add new `@State` for the loop's contract (near the other budget-related `@State`, e.g. after `writeSummaryNote` around line 134):

```swift
    /// This loop's free-text goal/acceptance-criteria — `nil`/empty for
    /// every loop that has never set one, which is byte-identical to
    /// pre-multi-loop behavior. Edited in the OVERVIEW section.
    @State var goal: String = ""
    @State var acceptanceCriteria: String = ""
    /// Optional path allowlist, edited in the SETTINGS section. Empty means
    /// unrestricted — see `LoopDefinition.scopeGlobs`.
    @State var scopeGlobs: [String] = []
    /// Whether the loop this page represents is CURRENTLY the project's
    /// Primary loop — read fresh on every `loadConfig()`, since Primary can
    /// be reassigned from the loop-list pane while this page stays mounted.
    /// Used only to attribute legacy (pre-migration) journal entries — whose
    /// `loopId` is `nil` — to the Primary loop's Past Runs list.
    @State var isPrimaryLoop = false
```

- [ ] **Step 2: Update the init to accept `loopId`**

Change `init(api:)` (around line 145):

```swift
    init(api: LlmIdeAPIClient, loopId: String) {
        self.api = api
        self.loopId = loopId
        let approvals = VerifyApprovalStore()
```

(leave the rest of `init`'s body — the `prompter`/`regressionRunner`/`_runner` construction — unchanged.)

- [ ] **Step 3: Key the reload `.task` on the loop, not just the project**

Change the `activeProjectId` computed property's role: add a combined identity, and change the `.task(id:)` modifier. Around line 193:

```swift
        .task(id: reloadKey) {
            selectedStageId = nil
            runner.clearLog()
            lastStatus = nil
            didRejectLastRun = false
            loadConfig()
            Task { await loadSkillsIfNeeded() }
        }
```

Add the new computed property near `activeProjectId` (around line 763):

```swift
    /// Combines project and loop identity so switching EITHER — a project
    /// switch, or the home view moving the selection to a different loop
    /// within the same project — triggers a reload. A plain `activeProjectId`
    /// alone would leave a project-switch-only `.task(id:)` blind to a loop
    /// switch within the same project.
    private var reloadKey: String {
        "\(activeProjectId ?? "none")::\(loopId)"
    }
```

- [ ] **Step 4: Retarget `loadConfig`/`saveConfig`/`scheduleAutosave`/`flushPendingAutosave` to the per-loop API**

Replace `currentConfig` (around line 787) to also compose the loop-level fields — but keep it returning a `LoopEngineConfig` (the budgets part), and add a parallel accessor for the full `LoopDefinition`:

```swift
    /// The config this page currently represents — unchanged in shape; still
    /// just the budgets/stages half of the loop.
    private var currentConfig: LoopEngineConfig {
        LoopEngineConfig(
            stages: stages,
            maxIterations: maxIterations,
            consecutiveFailureStop: consecutiveFailureStop,
            wallClockBudgetSeconds: LoopBudgetsEditor.seconds(fromMinutes: wallClockMinutes),
            maxRepairsPerStage: maxRepairsPerStage,
            protectedPathPolicy: protectedPathPolicy,
            extraProtectedGlobs: extraProtectedGlobs,
            writeSummaryNote: writeSummaryNote)
    }

    /// The full `LoopDefinition` this page currently represents — `currentConfig`
    /// plus this loop's identity and contract fields. The single builder used
    /// by every save/autosave/run path, so a field added to `LoopDefinition`
    /// can't be silently dropped by one call site forgetting to thread it —
    /// same rationale `currentConfig`'s own doc comment gives for its half.
    private var currentLoop: LoopDefinition {
        LoopDefinition(id: loopId, name: loopName, isPrimary: isPrimaryLoop,
                       goal: goal.isEmpty ? nil : goal,
                       acceptanceCriteria: acceptanceCriteria.isEmpty ? nil : acceptanceCriteria,
                       scopeGlobs: scopeGlobs, config: currentConfig)
    }
```

Add `@State var loopName: String = ""` alongside the other new `@State` from Step 1 (the loop's own display name — editable, see Task 9) and reconcile `PendingAutosave` to carry a `LoopDefinition` instead of a bare config (around line 115):

```swift
    struct PendingAutosave {
        let loop: LoopDefinition
        let projectId: String
        let projectRoot: URL?
    }
```

Replace `loadConfig()` (around lines 799–856) — the migration/detection fallback logic now goes through `LoopEngineConfigStore.load`'s FULL list and finds/creates the entry for `loopId`:

```swift
    private func loadConfig() {
        flushPendingAutosave()
        appliedTemplateHadNoTooling = false
        guard let projectId = activeProjectId else {
            resetStagesToDefaults()
            return
        }
        loadPastRuns()
        let store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        if let existing = store?.loops.first(where: { $0.id == loopId }) {
            let ensuredConfig = LoopStageDetector.ensureDefaultStages(in: existing.config, gitRoot: activeGitRootURL)
            stages = ensuredConfig.stages
            maxIterations = ensuredConfig.maxIterations
            consecutiveFailureStop = ensuredConfig.consecutiveFailureStop
            wallClockMinutes = LoopBudgetsEditor.minutes(fromSeconds: ensuredConfig.wallClockBudgetSeconds)
            maxRepairsPerStage = ensuredConfig.maxRepairsPerStage
            protectedPathPolicy = ensuredConfig.protectedPathPolicy
            extraProtectedGlobs = ensuredConfig.extraProtectedGlobs
            writeSummaryNote = ensuredConfig.writeSummaryNote
            loopName = existing.name
            isPrimaryLoop = existing.isPrimary
            goal = existing.goal ?? ""
            acceptanceCriteria = existing.acceptanceCriteria ?? ""
            scopeGlobs = existing.scopeGlobs
            // Baseline set from currentLoop (not `existing`) so a lossy
            // round-trip cannot register as an edit and rewrite the file on
            // open — same reasoning the pre-multi-loop version documented.
            persistedLoop = currentLoop
        } else if let gitRoot = activeGitRootURL {
            let detected = LoopStageDetector.detectDefaultStages(gitRoot: gitRoot)
            resetStagesToDefaults(stages: detected)
            loopName = "Main Loop"
            if LoopEngineConfig.shouldPersist(detected) {
                saveConfig()
            } else {
                persistedLoop = nil
            }
        } else {
            resetStagesToDefaults()
        }
    }
```

Replace every reference to `persistedConfig` in the file with `persistedLoop: LoopDefinition?` (rename the `@State private var persistedConfig: LoopEngineConfig?` declared around line 113 to `@State private var persistedLoop: LoopDefinition?`), and update `isSafeToPersistImplicitly`/`scheduleAutosave`/`flushPendingAutosave`/`saveConfig` accordingly:

```swift
    private func isSafeToPersistImplicitly(_ loop: LoopDefinition) -> Bool {
        guard !loop.config.stages.isEmpty else { return false }
        return LoopEngineConfig.shouldPersist(loop.config.stages) || persistedLoop != nil
    }

    private func scheduleAutosave(_ loop: LoopDefinition) {
        guard let projectId = activeProjectId else { return }
        guard loop != persistedLoop else { return }
        guard isSafeToPersistImplicitly(loop) else { return }
        if let pending = pendingAutosave, pending.projectId != projectId {
            flushPendingAutosave()
        }
        autosaveTask?.cancel()
        pendingAutosave = PendingAutosave(loop: loop, projectId: projectId,
                                          projectRoot: workspaceContext?.projectRoot)
        autosaveTask = Task {
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            flushPendingAutosave()
        }
    }

    func flushPendingAutosave() {
        guard let pending = pendingAutosave else { return }
        pendingAutosave = nil
        autosaveTask?.cancel()
        autosaveTask = nil
        writeLoop(pending.loop, projectRoot: pending.projectRoot, projectId: pending.projectId)
        if pending.projectId == activeProjectId {
            persistedLoop = pending.loop
        }
    }

    func saveConfig() {
        guard let projectId = activeProjectId else { return }
        pendingAutosave = nil
        autosaveTask?.cancel()
        autosaveTask = nil
        writeLoop(currentLoop, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        persistedLoop = currentLoop
    }

    /// Writes `loop` into this project's full loop list — replacing the
    /// existing entry with the same id, or appending when this is the first
    /// save of a brand-new loop (e.g. one just created by the home view).
    /// Read-modify-write is required here because `LoopEngineConfigStore`
    /// persists the WHOLE list per project, not one loop at a time.
    private func writeLoop(_ loop: LoopDefinition, projectRoot: URL?, projectId: String) {
        var store = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId)
            ?? LoopEngineProjectStore(loops: [])
        if let index = store.loops.firstIndex(where: { $0.id == loop.id }) {
            store.loops[index] = loop
        } else {
            store.loops.append(loop)
        }
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId)
    }
```

Change the `.onChange(of: currentConfig)` autosave trigger (around line 213) to watch the full loop instead:

```swift
        .onChange(of: currentLoop) { _, updated in
            scheduleAutosave(updated)
        }
```

(`LoopDefinition` is already `Equatable`, from Task 1 — this compiles unchanged in shape.)

**Do not stop here** — `resetStagesToDefaults(stages:)` (around line 871) still writes to the OLD `persistedConfig` property name and never touches the new loop-identity state, both of which break the build or leave stale text on screen. Replace its body:

```swift
    private func resetStagesToDefaults(stages newStages: [LoopStage] = []) {
        let seed = LoopEngineDefaults.newConfig(stages: newStages)
        stages = seed.stages
        maxIterations = seed.maxIterations
        consecutiveFailureStop = seed.consecutiveFailureStop
        wallClockMinutes = LoopBudgetsEditor.minutes(fromSeconds: seed.wallClockBudgetSeconds)
        maxRepairsPerStage = seed.maxRepairsPerStage
        protectedPathPolicy = seed.protectedPathPolicy
        extraProtectedGlobs = seed.extraProtectedGlobs
        writeSummaryNote = seed.writeSummaryNote
        // Reset the loop-identity/contract state too — without this, closing
        // a project that had a loop with a Goal set and opening one with no
        // config yet would leave that Goal text displayed against the new,
        // unrelated project.
        loopName = "Main Loop"
        goal = ""
        acceptanceCriteria = ""
        scopeGlobs = []
        isPrimaryLoop = false
        pastRuns = []
        lastSummaryNoteName = nil
        persistedLoop = nil
    }
```

- [ ] **Step 5: Filter Past Runs by this loop**

Replace `loadPastRuns()` (around line 1009):

```swift
    private func loadPastRuns() {
        guard let root = workspaceContext?.projectRoot else {
            pastRuns = []
            return
        }
        // Read more than the display limit — a project journal interleaves
        // every loop's runs, so filtering down to this loop must not starve
        // the list.
        let recent = journal.recentRuns(root: root, limit: 60)
        pastRuns = Array(recent.filter { $0.loopId == loopId || ($0.loopId == nil && isPrimaryLoop) }.prefix(15))
        lastSummaryNoteName = Self.newestSummaryNoteName(projectRoot: root)
    }
```

- [ ] **Step 6: Thread this loop's identity/contract into `runLoop`**

Change the `runner.run(...)` call inside `runLoop(only:)` (around line 1137):

```swift
        let result = await runner.run(config: runConfig, faultsRoot: context.projectRoot,
                                      gitRoot: gitRoot, projectId: projectId,
                                      loopId: loopId, loopName: loopName,
                                      goal: goal.isEmpty ? nil : goal,
                                      acceptanceCriteria: acceptanceCriteria.isEmpty ? nil : acceptanceCriteria,
                                      scopeGlobs: scopeGlobs)
```

Also update the `isSafeToPersistImplicitly`/`saveConfig` call inside `runLoop` (around line 1120, `if isSafeToPersistImplicitly(currentConfig) { saveConfig() }`) to use `currentLoop`:

```swift
        if isSafeToPersistImplicitly(currentLoop) {
            saveConfig()
        }
```

- [ ] **Step 7: Remove the "New Loop" toolbar button and sheet**

In the `toolbar` computed property (around lines 481–520), remove the `Button { isPresentingNewLoopWizard = true } label: { Label("New Loop", ...) }` and the `Divider().frame(height: 16)` immediately after it — Run/Stop/status stay. Remove the `@State private var isPresentingNewLoopWizard = false` declaration (around line 101) and the `.sheet(isPresented: $isPresentingNewLoopWizard) { NewLoopWizardView(...) }` modifier (around lines 223–229) from `body` — that flow moves to `LoopEngineHomeView` in Task 10. Also remove `applyNewLoopConfig(_:)` (around lines 1083–1087) — no longer called from this view once the sheet is gone (the home view builds a `LoopDefinition` directly and calls `writeLoop`-equivalent logic itself in Task 10; nothing here needs to expose an apply-and-save entry point for a NEW loop, only for the CURRENT one, which `saveConfig()` already does).

- [ ] **Step 8: Compile**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -100`
Expected: build errors pointing at the two remaining call sites — `AppShell.swift`'s `LoopEngineView(api: api)` (missing `loopId:`) and any leftover reference to `applyNewLoopConfig`/`isPresentingNewLoopWizard`/`persistedConfig` this task's edits missed. Fix each until only the `AppShell.swift` error remains (Task 11 fixes that one) and no other error remains.

- [ ] **Step 9: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift
git commit -m "$(cat <<'EOF'
refactor(mac): LoopEngineView becomes a single loop's workspace

Takes loopId at construction; load/save/autosave retarget from "the
project's one config" to this specific LoopDefinition inside the
project's loop list. Adds goal/acceptanceCriteria/scopeGlobs state
and filters Past Runs to this loop. The New Loop toolbar button and
wizard sheet move up to the new loop-list home view — creating a
loop is now a list-level action.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: OVERVIEW gains Goal/Acceptance; SETTINGS gains a Scope editor

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView+DetailPane.swift`

- [ ] **Step 1: Add Goal/Acceptance Criteria fields to `overviewSection`**

In `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView+DetailPane.swift`, add a new block to `overviewSection` (around line 28, right after `SectionLabel("OVERVIEW")`):

```swift
    @ViewBuilder
    var overviewSection: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionLabel("OVERVIEW")

            TextField("Loop name", text: $loopName)
                .textFieldStyle(.roundedBorder)
                .font(Typography.bodyStrong)

            VStack(alignment: .leading, spacing: 4) {
                Text("Goal — what is this loop trying to achieve?").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("e.g. Stabilize the auth test suite", text: $goal)
                    .textFieldStyle(.roundedBorder)
                Text("Acceptance criteria — what observable condition means done?").font(Typography.caption).foregroundStyle(t.textMuted)
                TextField("e.g. swift test passes 3 times in a row", text: $acceptanceCriteria, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                Text("Optional. When set, both are given to the repair agent and any generate stage alongside the raw failure output — so a fix stays aimed at what this loop is for, not just at making a command exit 0.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 2)

            if stages.isEmpty {
```

(the `if stages.isEmpty { ... } else { ... }` block and everything after it in the function stays exactly as it is today — this step only inserts the new name/goal/acceptance block above it.)

- [ ] **Step 2: Add a Scope editor to `settingsSection`**

In the same file, add a Scope section to `settingsSection` (around line 278, right after the protected-path `Picker`/explanation block and before the `HStack` containing the Save button):

```swift
            Divider().background(t.border).padding(.vertical, 2)

            Text("Scope — restrict this loop to specific paths (optional)")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
            if scopeGlobs.isEmpty {
                Text("Unrestricted — this loop's repairs may touch any path not otherwise protected.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
            ForEach(Array(scopeGlobs.enumerated()), id: \.offset) { index, glob in
                HStack(spacing: 4) {
                    TextField("e.g. src/auth/**", text: Binding(
                        get: { scopeGlobs[index] },
                        set: { scopeGlobs[index] = $0 }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11, design: .monospaced))
                    Button {
                        scopeGlobs.remove(at: index)
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                }
            }
            Button {
                scopeGlobs.append("")
            } label: {
                Label("Add path", systemImage: "plus")
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)
            Text("When set, a repair that changes a path matching none of these is treated as an out-of-scope violation, under the same policy as the protected-path setting above.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .fixedSize(horizontal: false, vertical: true)
```

- [ ] **Step 3: Compile**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -60`
Expected: build succeeds (the new fields bind to `@State` properties Task 8 already declared: `loopName`, `goal`, `acceptanceCriteria`, `scopeGlobs`).

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView+DetailPane.swift
git commit -m "$(cat <<'EOF'
feat(mac): Loop OVERVIEW gets name/goal/acceptance, SETTINGS gets scope

Editable Loop name, Goal, and Acceptance Criteria fields at the top
of OVERVIEW; an optional path-scope allowlist editor in SETTINGS
beside the existing protected-path policy.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `LoopEngineHomeView` — the loop-list pane

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineHomeView.swift`

Mirrors `AutoCodeView`'s left-list/right-detail split (`AutoCodeView.swift:36-70` for the outer `HStack`/`leftPane`/`rightPane` shape). Owns the project's `[LoopDefinition]` list, the selection, and creating/renaming/duplicating/deleting/promoting loops; hosts `LoopEngineView(api:loopId:)` for whichever loop is selected.

- [ ] **Step 1: Implement the view**

Create `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineHomeView.swift`:

```swift
// Loop Engineering home — the loop-list pane in front of the per-loop
// workspace, mirroring AutoCodeView's left-list/right-detail split
// (AutoCodeView.swift). This view owns which loops exist for the active
// project (create/duplicate/delete/set Primary); LoopEngineView (unchanged
// internally, see its own file header) owns everything about running and
// configuring ONE selected loop.

import SwiftUI

struct LoopEngineHomeView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore

    @State private var loops: [LoopDefinition] = []
    @State private var selectedLoopId: String?
    @State private var isPresentingNewLoopWizard = false
    @State private var skillCatalog: [LlmIdeAPIClient.SkillLibraryEntry] = []
    @StateObject private var templateStore = LoopTemplateStore()
    @State private var loopPendingDelete: LoopDefinition?

    private var activeProjectId: String? { projectStore.activeProject?.bundle.id }
    private var workspaceContext: WorkspaceRoot.Context? {
        WorkspaceRoot.context(config: config, projectStore: projectStore)
    }

    var body: some View {
        HStack(spacing: 0) {
            loopListPane
                .frame(width: 220)
            Divider()
            if let selectedLoopId {
                LoopEngineView(api: api, loopId: selectedLoopId)
                    .id(selectedLoopId)
            } else {
                emptyState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(theme.current.body)
        .navigationTitle("Loop")
        .task(id: activeProjectId) {
            reloadLoops()
        }
        .sheet(isPresented: $isPresentingNewLoopWizard) {
            NewLoopWizardView(
                templateStore: templateStore,
                skillCatalog: skillCatalog,
                gitRoot: workspaceContext?.gitRoot,
                onCreate: createLoop)
        }
        .alert("Delete this loop?", isPresented: Binding(
            get: { loopPendingDelete != nil },
            set: { if !$0 { loopPendingDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { loopPendingDelete = nil }
            Button("Delete", role: .destructive) {
                if let loop = loopPendingDelete { deleteLoop(loop) }
                loopPendingDelete = nil
            }
        } message: {
            Text("Its stages, budgets, and run history stay on disk under this project's loop.json, but it will no longer appear here.")
        }
    }

    // MARK: - Loop list

    private var loopListPane: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                SectionLabel("LOOPS")
                Spacer()
                Button { isPresentingNewLoopWizard = true } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)
                .help("New loop")
                .accessibilityLabel("New loop")
            }
            .padding(.horizontal, Spacing.md)
            .padding(.top, Spacing.sm)
            .padding(.bottom, 4)

            List(selection: $selectedLoopId) {
                ForEach(loops) { loop in
                    loopRow(loop).tag(Optional(loop.id))
                }
            }
            .listStyle(.sidebar)
        }
        .background(t.surface)
    }

    @ViewBuilder
    private func loopRow(_ loop: LoopDefinition) -> some View {
        let t = theme.current
        HStack(spacing: 6) {
            Circle()
                .fill(isRunning(loop) ? t.success : Color.clear)
                .frame(width: 6, height: 6)
            Text(loop.name)
                .font(Typography.filename)
                .lineLimit(1)
                .truncationMode(.middle)
            if loop.isPrimary {
                Image(systemName: "star.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(t.accent)
                    .help("Primary — the loop the scheduled Auto Task and phone run")
            }
            Spacer(minLength: 4)
            Menu {
                if !loop.isPrimary {
                    Button("Set as Primary") { setPrimary(loop) }
                }
                Button("Duplicate") { duplicateLoop(loop) }
                if loops.count > 1 {
                    Button("Delete", role: .destructive) { loopPendingDelete = loop }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(t.textMuted)
            }
            .buttonStyle(.borderless)
        }
    }

    private func isRunning(_ loop: LoopDefinition) -> Bool {
        guard let gitRoot = workspaceContext?.gitRoot else { return false }
        return LoopEngineRunner.activeLoopId(gitRoot: gitRoot) == loop.id
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.sm) {
            Text("No loops yet")
                .font(Typography.title)
                .foregroundStyle(theme.current.textMuted)
            Button("New Loop") { isPresentingNewLoopWizard = true }
                .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Loading

    private func reloadLoops() {
        guard let projectId = activeProjectId else {
            loops = []
            selectedLoopId = nil
            return
        }
        let store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store?.loops ?? []
        if selectedLoopId == nil || !loops.contains(where: { $0.id == selectedLoopId }) {
            selectedLoopId = loops.first(where: \.isPrimary)?.id ?? loops.first?.id
        }
        Task { await loadSkillsIfNeeded() }
    }

    private func loadSkillsIfNeeded() async {
        guard skillCatalog.isEmpty else { return }
        if let skills = try? await api.skillLibrary() {
            skillCatalog = skills
        }
    }

    // MARK: - Mutations

    /// Creates a new loop from the wizard's finished config, appends it to
    /// this project's loop list, saves immediately (finishing the wizard IS
    /// the confirmation — same reasoning `LoopEngineView.applyNewLoopConfig`
    /// used to document before this task moved that flow up here), and
    /// selects it.
    private func createLoop(_ config: LoopEngineConfig) {
        guard let projectId = activeProjectId else { return }
        let newLoop = LoopDefinition(name: "New Loop \(loops.count + 1)",
                                     isPrimary: loops.isEmpty, config: config)
        var store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
            ?? LoopEngineProjectStore(loops: [])
        store.loops.append(newLoop)
        LoopEngineConfigStore.save(store, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store.loops
        selectedLoopId = newLoop.id
    }

    private func duplicateLoop(_ loop: LoopDefinition) {
        guard let projectId = activeProjectId else { return }
        var copy = loop
        copy.id = UUID().uuidString
        copy.name = "\(loop.name) copy"
        copy.isPrimary = false
        var store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
            ?? LoopEngineProjectStore(loops: [])
        store.loops.append(copy)
        LoopEngineConfigStore.save(store, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store.loops
        selectedLoopId = copy.id
    }

    /// Refuses when `loop` is the last one — a project must always have at
    /// least one loop, matching the invariant that used to be implicit
    /// ("every project has a config"). The row's ⋯ menu already hides
    /// Delete in that case; this is the belt-and-suspenders check.
    private func deleteLoop(_ loop: LoopDefinition) {
        guard let projectId = activeProjectId, loops.count > 1 else { return }
        var store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
            ?? LoopEngineProjectStore(loops: [])
        store.loops.removeAll { $0.id == loop.id }
        // Deleting the Primary loop promotes the next one — a project must
        // always have exactly one Primary once it has any loop at all.
        if loop.isPrimary, var next = store.loops.first {
            next.isPrimary = true
            store.loops[0] = next
        }
        LoopEngineConfigStore.save(store, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store.loops
        if selectedLoopId == loop.id {
            selectedLoopId = loops.first(where: \.isPrimary)?.id ?? loops.first?.id
        }
    }

    /// Moves the ★ to `loop`, clearing it everywhere else — a project has
    /// exactly one Primary loop at a time.
    private func setPrimary(_ loop: LoopDefinition) {
        guard let projectId = activeProjectId else { return }
        var store = LoopEngineConfigStore.load(projectRoot: workspaceContext?.projectRoot, projectId: projectId)
            ?? LoopEngineProjectStore(loops: [])
        store.loops = store.loops.map { entry in
            var copy = entry
            copy.isPrimary = (entry.id == loop.id)
            return copy
        }
        LoopEngineConfigStore.save(store, projectRoot: workspaceContext?.projectRoot, projectId: projectId)
        loops = store.loops
    }
}
```

- [ ] **Step 2: Compile**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -100`
Expected: the only remaining error should be `AppShell.swift` still instantiating the old `LoopEngineView(api: api)` without `loopId:` — fixed in Task 11. Everything else must compile cleanly, including this new file.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineHomeView.swift
git commit -m "$(cat <<'EOF'
feat(mac): add LoopEngineHomeView — the Loop page's loop-list pane

Owns which loops exist for the active project: create (via the
existing New Loop wizard), duplicate, delete, and Set as Primary.
Hosts LoopEngineView for whichever loop is selected. Mirrors
AutoCodeView's list+detail layout for the UI pattern only — Auto
Tasks itself is untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Wire `LoopEngineHomeView` into navigation

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift`

- [ ] **Step 1: Swap the instantiation**

In `mac/Sources/LlmIdeMac/Views/AppShell.swift`, change line 632:

```swift
        case .loopEngine: LoopEngineHomeView(api: api)
```

- [ ] **Step 2: Full build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -100`
Expected: BUILD SUCCEEDED, with zero remaining errors anywhere in the target.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/AppShell.swift
git commit -m "$(cat <<'EOF'
feat(mac): route the Loop section to LoopEngineHomeView

Completes the switch from one shared pipeline per project to
independently configured, run, and tracked named loops.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Manual verification

**Files:** none — this task runs the built app.

- [ ] **Step 1: Build and launch**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20 && open .build/debug/LlmIdeMac.app` (or run via Xcode/`./build_app.sh` per this repo's usual dev flow — whichever the executor's environment already uses).

- [ ] **Step 2: Migration check**

Open a project that already had a Loop config configured before this change (a `system/loop.json` holding the old bare-config schema, or a project whose config still lives only in UserDefaults from before `system/loop.json` existed). Open the Loop section. Confirm:
- The loop list shows exactly one loop named "Main Loop" with a ★.
- Its stages, budgets, and past runs are identical to before this change.
- `system/loop.json` now contains a `"loops"` key (inspect the file directly).

- [ ] **Step 3: Independent loops check**

In the same or a fresh project:
- Click `+` in the loop list, go through the New Loop wizard, name/create a second loop.
- Confirm it appears in the list, unstarred, alongside "Main Loop".
- Add a distinct stage to it, run it, and confirm its log/Past Runs are independent of "Main Loop"'s (switch between the two rows and see each keep its own log/history).
- Use the row ⋯ menu to "Set as Primary" on the new loop; confirm the ★ moves and "Main Loop" loses it.
- Try deleting the last remaining loop (temporarily reduce to one) — confirm Delete is hidden/refused.

- [ ] **Step 4: Goal/Acceptance/Scope check**

On any loop, set a Goal and Acceptance Criteria in OVERVIEW and an entry in the SETTINGS Scope editor. Run the loop against a deliberately failing stage. Confirm (via the run log or by temporarily logging the outgoing prompt) that the repair/skill prompt includes the Goal/Acceptance text. Confirm a repair that edits a path outside the Scope entry is blocked/reverted the same way a protected-path violation is.

- [ ] **Step 5: Auto Task untouched check**

Open Auto Tasks. Confirm the task list, custom tasks, and scheduling UI look and behave exactly as before this change — no new picker, no new task, no layout change. Trigger a manual run of the `.loopEngineering` Auto Task (if configured) and confirm it runs the Primary loop, same as before.

- [ ] **Step 6: Regression gate**

Run: `cd /Users/dinesh.malla/llm-ide && make regression`
Expected: passes (mac build succeeds; extension tests are unaffected by this change).

- [ ] **Step 7: Report**

Summarize what was verified and any deviations found, so the user can decide whether to merge as-is or file follow-ups before Spec B (mobile/scheduler) begins.
