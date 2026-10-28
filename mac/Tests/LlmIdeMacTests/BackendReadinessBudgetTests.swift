import XCTest
@testable import LlmIdeMacLib

/// The /health wait is 20 s normally and 90 s only on a first launch of the
/// system data dir, when the server may be copying the legacy kb before it listens.
final class BackendReadinessBudgetTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-budget-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testRepoKbModeKeepsTheDefault() {
        XCTAssertEqual(BackendManager.readinessBudgetSeconds(dataDir: nil), 20)
    }

    func testFirstLaunchOfTheDataDirGetsTheLongerWait() {
        XCTAssertEqual(BackendManager.readinessBudgetSeconds(dataDir: dir.path), 240)
    }

    func testAnExistingDataDirKeepsTheDefault() throws {
        FileManager.default.createFile(atPath: dir.appendingPathComponent("data.db").path, contents: Data())
        XCTAssertEqual(BackendManager.readinessBudgetSeconds(dataDir: dir.path), 20)
    }
}
