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
}
