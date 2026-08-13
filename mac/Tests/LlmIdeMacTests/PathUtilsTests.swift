import XCTest
@testable import LlmIdeMacLib

final class PathUtilsTests: XCTestCase {
    func testRelativeStripsRootPrefix() {
        let root = URL(fileURLWithPath: "/Users/alice/repo")
        XCTAssertEqual(PathUtils.relative("/Users/alice/repo/src/payments", to: root), "src/payments")
    }

    func testRelativeOfRootItselfReturnsRootPath() {
        // Not under root + "/" (nothing left after stripping), so it falls
        // back to the canonicalised absolute path rather than an empty string.
        let root = URL(fileURLWithPath: "/Users/alice/repo")
        XCTAssertEqual(PathUtils.relative("/Users/alice/repo", to: root), "/Users/alice/repo")
    }

    func testRelativeOutsideRootFallsBackToAbsolutePath() {
        let root = URL(fileURLWithPath: "/Users/alice/repo")
        XCTAssertEqual(PathUtils.relative("/Users/alice/other/file.swift", to: root),
                       "/Users/alice/other/file.swift")
    }

    func testRelativeNormalisesTrailingSlashOnRoot() {
        let root = URL(fileURLWithPath: "/Users/alice/repo/")
        XCTAssertEqual(PathUtils.relative("/Users/alice/repo/src/payments", to: root), "src/payments")
    }
}
