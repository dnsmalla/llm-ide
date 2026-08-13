import XCTest
@testable import LlmIdeMacLib

final class LoopStageDetectorTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-stage-detector-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        super.tearDown()
    }

    private func write(_ name: String, _ contents: String = "") throws {
        try contents.write(to: tempDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    func testAlwaysIncludesRegressionStageFirst() {
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.first?.kind, .regressionSweep)
        XCTAssertEqual(stages.first?.order, 0)
    }

    func testNoRecognizedProjectFileYieldsRegressionOnly() {
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.count, 1)
    }

    func testPackageSwiftYieldsSwiftTest() throws {
        try write("Package.swift")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "swift test")
    }

    func testPackageJSONWithTestScriptYieldsNpmTest() throws {
        try write("package.json", #"{"scripts": {"test": "vitest"}}"#)
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "npm test")
    }

    func testPackageJSONWithoutTestScriptYieldsRegressionOnly() throws {
        try write("package.json", #"{"scripts": {"build": "vite build"}}"#)
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.count, 1)
    }

    func testPackageJSONWithTestKeywordButNoTestScriptYieldsRegressionOnly() throws {
        try write("package.json", #"{"name": "test", "keywords": ["test"], "scripts": {"build": "vite build"}}"#)
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.count, 1)
    }

    func testMakefileWithTestTargetYieldsMakeTest() throws {
        try write("Makefile", "test:\n\techo hi\n")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "make test")
    }

    func testMakefileWithoutTestTargetYieldsRegressionOnly() throws {
        try write("Makefile", "build:\n\techo hi\n")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.count, 1)
    }

    func testPyprojectTomlYieldsPytest() throws {
        try write("pyproject.toml", "[tool.pytest.ini_options]\n")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "pytest")
    }

    func testDefaultStagesAlwaysIncludeARegressionSweepStage() {
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        // Even with no detectable test tooling, a fresh project must get a
        // regression-sweep stage so Loop Engineering can "run regression
        // and loop until all pass" out of the box.
        XCTAssertTrue(stages.contains { $0.kind == .regressionSweep },
                      "default stages must always include a regressionSweep stage")
    }

    func testDetectorMarksRegressionAsDefault() {
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.first?.isDefault, true)
    }

    func testDetectorMarksTestAsDefaultWhenToolingDetected() throws {
        try write("Package.swift")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        let testStage = stages.first { $0.kind == .shellCommand }
        XCTAssertNotNil(testStage)
        XCTAssertEqual(testStage?.isDefault, true)
    }

    // MARK: - System Check markers (llm-ide's own layout, gated per-check)

    private func writeNested(_ relativePath: String, _ contents: String = "") throws {
        let url = tempDir.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: url, atomically: true, encoding: .utf8)
    }

    func testNoSystemCheckMarkersYieldsNoExtraStages() {
        // A repo with none of llm-ide's own files must see exactly what it saw
        // before this existed — this is what makes it safe for the check to
        // live in the GLOBAL detector rather than a special case.
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.count, 1)
    }

    func testSkillsMarkerAddsSkillsStage() throws {
        try writeNested("extension/tests/agent-skills.test.mjs")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        let skills = stages.first { $0.name == "Skills" }
        XCTAssertNotNil(skills)
        XCTAssertEqual(skills?.kind, .shellCommand)
        XCTAssertEqual(skills?.isDefault, true)
        XCTAssertTrue(skills?.command?.contains("agent-skills.test.mjs") ?? false)
    }

    func testPluginsMarkerAddsPluginsStage() throws {
        try writeNested("extension/tests/plugins-loader.test.mjs")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertNotNil(stages.first { $0.name == "Plugins" })
    }

    func testConnectorsMarkerAddsConnectorsStage() throws {
        try writeNested("extension/tests/box-connector.test.mjs")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertNotNil(stages.first { $0.name == "Connectors" })
    }

    func testDispatchMarkerAddsGitHubDispatchStage() throws {
        try writeNested("extension/tests/dispatch-preview.test.mjs")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertNotNil(stages.first { $0.name == "GitHub dispatch" })
    }

    func testExtensionPackageJSONAddsBackendStage() throws {
        try writeNested("extension/package.json", "{}")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        let backend = stages.first { $0.name == "Backend" }
        XCTAssertEqual(backend?.command, "cd extension && npm test")
    }

    func testSharedProtocolMakeTargetAddsProtocolStage() throws {
        try write("Makefile", "test-shared-protocol:\n\techo hi\n")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        let stage = stages.first { $0.name == "iOS ↔ Mac shared protocol" }
        XCTAssertEqual(stage?.command, "make test-shared-protocol")
    }

    func testMacPackageSwiftAddsMacAppStage() throws {
        try writeNested("mac/Package.swift")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        let stage = stages.first { $0.name == "Mac app" }
        XCTAssertEqual(stage?.command, "cd mac && swift test")
    }

    func testAllSystemCheckMarkersTogetherYieldEveryStageExactlyOnce() throws {
        try writeNested("extension/tests/agent-skills.test.mjs")
        try writeNested("extension/tests/plugins-loader.test.mjs")
        try writeNested("extension/tests/box-connector.test.mjs")
        try writeNested("extension/tests/dispatch-preview.test.mjs")
        try writeNested("extension/package.json", "{}")
        try write("Makefile", "test-shared-protocol:\n\techo hi\n")
        try writeNested("mac/Package.swift")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        let names = stages.map(\.name)
        XCTAssertEqual(Set(names).count, names.count, "no duplicate stage names")
        XCTAssertEqual(Set(names), [
            "Regression", "Skills", "Plugins", "Connectors", "GitHub dispatch",
            "Backend", "iOS ↔ Mac shared protocol", "Mac app",
        ])
        XCTAssertTrue(stages.allSatisfy { $0.isDefault })
    }

    /// Regression guard for the bug this change set actually fixed: once there
    /// is more than one `.shellCommand` default, matching by kind alone in
    /// `ensureDefaultStages` would collapse them all into whichever one
    /// `firstIndex` happened to find first. Skills/Plugins/etc. must each be
    /// pinned to THEIR OWN existing stage by name, not the first shell stage
    /// in the list.
    func testEnsureDefaultStagesDoesNotMergeDistinctShellCommandDefaults() throws {
        try writeNested("extension/tests/agent-skills.test.mjs")
        try writeNested("extension/tests/plugins-loader.test.mjs")
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Skills", kind: .shellCommand, command: "custom skills cmd", order: 0),
            LoopStage(id: "s2", name: "Plugins", kind: .shellCommand, command: "custom plugins cmd", order: 1),
        ])
        let ensured = LoopStageDetector.ensureDefaultStages(in: config, gitRoot: tempDir)
        XCTAssertEqual(ensured.stages.count, 3, "Regression must be appended; Skills/Plugins pinned in place, not duplicated")
        let skills = ensured.stages.first { $0.name == "Skills" }
        let plugins = ensured.stages.first { $0.name == "Plugins" }
        XCTAssertEqual(skills?.command, "custom skills cmd", "must be pinned in place, not overwritten")
        XCTAssertEqual(plugins?.command, "custom plugins cmd")
        XCTAssertEqual(skills?.isDefault, true)
        XCTAssertEqual(plugins?.isDefault, true)
    }
}
