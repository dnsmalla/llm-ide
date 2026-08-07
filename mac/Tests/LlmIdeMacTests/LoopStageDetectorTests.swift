import XCTest
@testable import LlmIdeMacLib

final class LoopStageDetectorTests: XCTestCase {
    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-stage-detector-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        super.tearDown()
    }

    private func write(_ name: String, _ contents: String = "") {
        try? contents.write(to: tempDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
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

    func testPackageSwiftYieldsSwiftTest() {
        write("Package.swift")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "swift test")
    }

    func testPackageJSONWithTestScriptYieldsNpmTest() {
        write("package.json", #"{"scripts": {"test": "vitest"}}"#)
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "npm test")
    }

    func testPackageJSONWithoutTestScriptYieldsRegressionOnly() {
        write("package.json", #"{"scripts": {"build": "vite build"}}"#)
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.count, 1)
    }

    func testMakefileWithTestTargetYieldsMakeTest() {
        write("Makefile", "test:\n\techo hi\n")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "make test")
    }

    func testPyprojectTomlYieldsPytest() {
        write("pyproject.toml", "[tool.pytest.ini_options]\n")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "pytest")
    }
}
