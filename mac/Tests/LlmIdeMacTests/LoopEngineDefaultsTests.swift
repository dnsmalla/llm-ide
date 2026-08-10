import XCTest
@testable import LlmIdeMacLib

/// These defaults are the ONLY chance to influence a project's Loop config: once
/// a project has a saved config it is never re-derived, so a default that fails to
/// apply is a value the user can never set again except project by project.
final class LoopEngineDefaultsTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        try super.setUpWithError()
        defaults = UserDefaults(suiteName: "loop-engine-defaults-\(UUID().uuidString)")!
    }

    // MARK: - Load

    /// With nothing saved, the defaults must be `LoopEngineConfig`'s own — not
    /// zeros, which would produce a loop that gives up before doing anything.
    func testUnsetDefaultsMatchTheConfigsOwnValues() {
        let loaded = LoopEngineDefaults.load(defaults: defaults)
        let fresh = LoopEngineConfig(stages: [])
        XCTAssertEqual(loaded.maxIterations, fresh.maxIterations)
        XCTAssertEqual(loaded.consecutiveFailureStop, fresh.consecutiveFailureStop)
        XCTAssertEqual(loaded.wallClockBudgetSeconds, fresh.wallClockBudgetSeconds)
        XCTAssertEqual(loaded.maxRepairsPerStage, fresh.maxRepairsPerStage)
        XCTAssertEqual(loaded.protectedPathPolicy, fresh.protectedPathPolicy)
        XCTAssertFalse(loaded.writeSummaryNote)
    }

    func testCorruptStoredDataFallsBackToTheConfigsOwnValues() {
        defaults.set(Data("not json".utf8), forKey: "loopEngineDefaults")
        XCTAssertEqual(LoopEngineDefaults.load(defaults: defaults).maxIterations, 10)
    }

    // MARK: - Save / round trip

    func testSavedValuesRoundTrip() {
        var config = LoopEngineConfig(stages: [])
        config.maxIterations = 4
        config.consecutiveFailureStop = 5
        config.wallClockBudgetSeconds = 900
        config.maxRepairsPerStage = 1
        config.protectedPathPolicy = .stop
        config.writeSummaryNote = true
        LoopEngineDefaults.save(config, defaults: defaults)

        let loaded = LoopEngineDefaults.load(defaults: defaults)
        XCTAssertEqual(loaded.maxIterations, 4)
        XCTAssertEqual(loaded.consecutiveFailureStop, 5)
        XCTAssertEqual(loaded.wallClockBudgetSeconds, 900)
        XCTAssertEqual(loaded.maxRepairsPerStage, 1)
        XCTAssertEqual(loaded.protectedPathPolicy, .stop)
        XCTAssertTrue(loaded.writeSummaryNote)
    }

    /// `nil` is "no time limit", and must survive the round trip as `nil` rather
    /// than decoding back to the 3600 default — otherwise a user cannot turn the
    /// time budget off.
    func testNilTimeBudgetRoundTripsAsNil() {
        var config = LoopEngineConfig(stages: [])
        config.wallClockBudgetSeconds = nil
        LoopEngineDefaults.save(config, defaults: defaults)
        XCTAssertNil(LoopEngineDefaults.load(defaults: defaults).wallClockBudgetSeconds)
    }

    /// Stages are per-project, detected from that repo's test tooling. An app-wide
    /// default stage list would be wrong for most projects and would override that
    /// detection, so `save` drops it and `load` never returns one.
    func testStagesAreNeverStoredOrReturned() {
        let config = LoopEngineConfig(stages: [
            LoopStage(name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ])
        LoopEngineDefaults.save(config, defaults: defaults)
        XCTAssertTrue(LoopEngineDefaults.load(defaults: defaults).stages.isEmpty)
    }

    // MARK: - newConfig

    func testNewConfigTakesStagesFromDetectionAndEverythingElseFromDefaults() {
        var stored = LoopEngineConfig(stages: [])
        stored.maxIterations = 3
        stored.protectedPathPolicy = .warn
        stored.writeSummaryNote = true
        LoopEngineDefaults.save(stored, defaults: defaults)

        let detected = [
            LoopStage(name: "Regression", kind: .regressionSweep, order: 0),
            LoopStage(name: "Test", kind: .shellCommand, command: "npm test", order: 1)
        ]
        let config = LoopEngineDefaults.newConfig(stages: detected, defaults: defaults)

        XCTAssertEqual(config.stages.map(\.name), ["Regression", "Test"])
        XCTAssertEqual(config.maxIterations, 3)
        XCTAssertEqual(config.protectedPathPolicy, .warn)
        XCTAssertTrue(config.writeSummaryNote)
    }

    func testNewConfigWithNoStoredDefaultsStillProducesAUsableConfig() {
        let config = LoopEngineDefaults.newConfig(
            stages: [LoopStage(name: "Regression", kind: .regressionSweep, order: 0)],
            defaults: defaults)
        XCTAssertEqual(config.stages.count, 1)
        XCTAssertEqual(config.maxIterations, 10)
        XCTAssertEqual(config.protectedPathPolicy, .revert)
    }

    /// Defaults are a starting point, never an override: a project that already has
    /// a saved config must keep its own values even when the defaults differ.
    func testSavedProjectConfigIsUnaffectedByLaterDefaultChanges() {
        let projectId = "proj-\(UUID().uuidString)"
        var projectConfig = LoopEngineConfig(stages: [
            LoopStage(name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ])
        projectConfig.maxIterations = 7
        projectConfig.save(for: projectId, defaults: defaults)

        var newDefaults = LoopEngineConfig(stages: [])
        newDefaults.maxIterations = 2
        LoopEngineDefaults.save(newDefaults, defaults: defaults)

        XCTAssertEqual(LoopEngineConfig.load(for: projectId, defaults: defaults)?.maxIterations, 7)
    }

    /// The defaults key must not collide with any per-project config key, or
    /// changing the defaults would rewrite a project's config (or vice versa).
    func testDefaultsKeyIsDistinctFromPerProjectConfigKeys() {
        LoopEngineDefaults.save(LoopEngineConfig(stages: []), defaults: defaults)
        XCTAssertNotNil(defaults.data(forKey: "loopEngineDefaults"))
        // `LoopEngineConfig` keys itself `loopEngineConfig_<projectId>`.
        XCTAssertNil(LoopEngineConfig.load(for: "", defaults: defaults))
    }
}
