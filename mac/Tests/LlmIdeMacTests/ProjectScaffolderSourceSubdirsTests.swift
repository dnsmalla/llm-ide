import XCTest
@testable import LlmIdeMacLib

final class ProjectScaffolderSourceSubdirsTests: XCTestCase {
    func testRequiredDirectoriesIncludeSourceSubdirs() {
        // The scaffolder iterates `requiredDirectories` with
        // createDirectory(withIntermediateDirectories: true), so listing the
        // subdirs here is what creates them on every project open.
        let dirs = Set(ProjectScaffolder.requiredDirectories)
        XCTAssertTrue(dirs.contains("source/meetings"))
        XCTAssertTrue(dirs.contains("source/emails"))
        XCTAssertTrue(dirs.contains("source/documents"))
    }
}
