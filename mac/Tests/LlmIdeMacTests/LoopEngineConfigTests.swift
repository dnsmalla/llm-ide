import XCTest
@testable import LlmIdeMacLib

final class LoopEngineConfigTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "loop-engine-config-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testLoadReturnsNilWhenNothingSaved() {
        XCTAssertNil(LoopEngineConfig.load(for: "proj-1", defaults: suite))
    }

    func testSaveThenLoadRoundTrips() {
        let config = LoopEngineConfig(
            stages: [LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0)],
            maxIterations: 7,
            consecutiveFailureStop: 3
        )
        config.save(for: "proj-1", defaults: suite)
        let loaded = LoopEngineConfig.load(for: "proj-1", defaults: suite)
        XCTAssertEqual(loaded, config)
    }

    /// Drift guard for the hand-written `encode(to:)`. `testSaveThenLoadRoundTrips`
    /// leaves most fields at their defaults, so deleting an `encode` line would
    /// still compare equal there — the decoded value would simply fall back to the
    /// same default. Every field here is set to a NON-default value, so a dropped
    /// or mis-keyed line makes this fail. Add a field to `LoopEngineConfig` ⇒ set it
    /// here too.
    func testEveryFieldSurvivesARoundTripAtNonDefaultValues() {
        let config = LoopEngineConfig(
            stages: [
                LoopStage(id: "s1", name: "Lint", kind: .shellCommand, command: "make lint",
                          order: 0, severity: .advisory, timeoutSeconds: 45),
                LoopStage(id: "s2", name: "Fix", kind: .skill, order: 1,
                          skillId: "skills/fix", targetPath: "src/", prompt: "go")
            ],
            maxIterations: 7,
            consecutiveFailureStop: 5,
            wallClockBudgetSeconds: 900,
            maxRepairsPerStage: 1,
            protectedPathPolicy: .warn,
            extraProtectedGlobs: ["fixtures/**"],
            writeSummaryNote: true)

        config.save(for: "proj-all", defaults: suite)
        let loaded = LoopEngineConfig.load(for: "proj-all", defaults: suite)

        // Whole-value equality, so this covers the nested LoopStage fields too.
        XCTAssertEqual(loaded, config)
        // Spot-check the two most easily lost, since equality alone would not say
        // WHICH field drifted if this ever fails.
        XCTAssertEqual(loaded?.writeSummaryNote, true)
        XCTAssertEqual(loaded?.extraProtectedGlobs, ["fixtures/**"])
        XCTAssertEqual(loaded?.stages.first?.severity, .advisory)
        XCTAssertEqual(loaded?.stages.first?.timeoutSeconds, 45)
    }

    func testDifferentProjectsDoNotShareConfig() {
        let a = LoopEngineConfig(stages: [], maxIterations: 5, consecutiveFailureStop: 2)
        a.save(for: "proj-a", defaults: suite)
        XCTAssertNil(LoopEngineConfig.load(for: "proj-b", defaults: suite))
        XCTAssertEqual(LoopEngineConfig.load(for: "proj-a", defaults: suite), a)
    }

    func testUserDefaultsKeyIsNamespacedByProjectId() {
        let config = LoopEngineConfig(stages: [])
        config.save(for: "abc-123", defaults: suite)
        XCTAssertNotNil(suite.data(forKey: "loopEngineConfig_abc-123"))
    }

    /// "No time limit" (`nil`) is both the default and a value the user can pick,
    /// so it has to survive a save. Historically this was the bug the explicit
    /// encoder exists for: the synthesized encoder omitted a nil optional, and an
    /// omitted key meant "written before this field existed" ⇒ 3600, so choosing
    /// no limit came back as 60 minutes. Absent now decodes as nil as well, but
    /// the round trip still has to hold.
    func testNoTimeLimitSurvivesASaveAndLoad() {
        var config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ])
        config.wallClockBudgetSeconds = nil
        config.save(for: "proj-notime", defaults: suite)
        XCTAssertNil(LoopEngineConfig.load(for: "proj-notime", defaults: suite)?.wallClockBudgetSeconds)
    }

    /// A config written before the field existed now decodes as "no limit" too.
    ///
    /// This used to assert 3600: absent and present-null had to be told apart,
    /// because absent meant "old build, apply the one-hour default". That default
    /// is gone — a run that is progressing should not be abandoned at the hour
    /// mark and reported as `.wallClockExceeded` — so both shapes mean unlimited
    /// and the distinction no longer carries any weight.
    func testConfigFromBeforeTheFieldExistedDecodesAsUnlimited() throws {
        let legacy = #"{"stages":[],"maxIterations":10,"consecutiveFailureStop":2}"#
        let decoded = try JSONDecoder().decode(LoopEngineConfig.self, from: Data(legacy.utf8))
        XCTAssertNil(decoded.wallClockBudgetSeconds)
    }

    /// An explicit null is "no limit" — the shape the current encoder writes.
    func testExplicitNullBudgetDecodesAsNoLimit() throws {
        let json = #"{"stages":[],"wallClockBudgetSeconds":null}"#
        let decoded = try JSONDecoder().decode(LoopEngineConfig.self, from: Data(json.utf8))
        XCTAssertNil(decoded.wallClockBudgetSeconds)
    }

    func testDefaultsAreTenAndTwo() {
        let config = LoopEngineConfig(stages: [])
        XCTAssertEqual(config.maxIterations, 10)
        XCTAssertEqual(config.consecutiveFailureStop, 2)
    }

    func testEnsurePinsRegressionAndPreservesCommand() throws {
        // Legacy config: stages saved before isDefault — both unpinned.
        let config = LoopEngineConfig(stages: [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0),
            LoopStage(name: "My Tests", kind: .shellCommand, command: "custom-runner", order: 1)
        ])
        // tempDir has no project markers → no Test default expected; Regression is the only default.
        let ensured = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: nil)
        // Regression pinned in place…
        XCTAssertEqual(ensured.stages.first { $0.kind == .regressionSweep }?.isDefault, true)
        // …and the user's shell stage is left UNpinned (no tooling → no pinned Test) and unchanged.
        let shell = ensured.stages.first { $0.kind == .shellCommand }
        XCTAssertEqual(shell?.command, "custom-runner")
        XCTAssertEqual(shell?.isDefault, false)
    }

    func testEnsureAddsRegressionIfMissing() {
        let config = LoopEngineConfig(stages: [
            LoopStage(name: "My Tests", kind: .shellCommand, command: "x", order: 0)
        ])
        let ensured = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: nil)
        XCTAssertTrue(ensured.stages.contains { $0.kind == .regressionSweep && $0.isDefault })
    }

    func testEnsurePinsExistingTestWhenToolingDetected() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ensure-tooling-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "Package.swift".write(to: dir.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)

        let config = LoopEngineConfig(stages: [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0),
            LoopStage(name: "My Tests", kind: .shellCommand, command: "npm test", order: 1)  // user's own command
        ])
        let ensured = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: dir)
        XCTAssertEqual(ensured.stages.first { $0.kind == .regressionSweep }?.isDefault, true)
        // Tooling detected → the existing shell stage is pinned in place; its command is NOT overwritten.
        let shell = ensured.stages.first { $0.kind == .shellCommand }
        XCTAssertEqual(shell?.isDefault, true)
        XCTAssertEqual(shell?.command, "npm test")
    }

    func testEnsureAddsTestIfToolingButMissing() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ensure-add-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "Package.swift".write(to: dir.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)

        let config = LoopEngineConfig(stages: [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ])
        let ensured = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: dir)
        XCTAssertTrue(ensured.stages.contains { $0.kind == .shellCommand && $0.isDefault })
    }

    func testEnsureIsIdempotent() {
        let config = LoopEngineConfig(stages: [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ])
        let once = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: nil)
        let twice = LoopStageDetector.ensureDefaultStages(in: once, gitRoot: nil)
        XCTAssertEqual(once.stages.count, twice.stages.count)
    }
}
