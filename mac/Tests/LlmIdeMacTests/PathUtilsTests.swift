import XCTest
@testable import LlmIdeMacLib

final class PathUtilsTests: XCTestCase {
    func testRelativeStripsRootPrefix() {
        let root = URL(fileURLWithPath: "/Users/alice/repo")
        XCTAssertEqual(PathUtils.relative("/Users/alice/repo/src/payments", to: root), "src/payments")
    }

    func testRelativeOfRootItselfReturnsDot() {
        // Picking the project root itself is the single most likely pick
        // when scoping a stage to "the whole project" — must stay portable
        // like every other in-root pick, not fall back to an absolute path.
        let root = URL(fileURLWithPath: "/Users/alice/repo")
        XCTAssertEqual(PathUtils.relative("/Users/alice/repo", to: root), ".")
    }

    func testRelativeResolvesSymlinkedRoot() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("PathUtilsTests-\(UUID().uuidString)")
        let real = base.appendingPathComponent("real")
        let link = base.appendingPathComponent("link")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        defer { try? FileManager.default.removeItem(at: base) }

        let file = real.appendingPathComponent("src/payments.swift")
        try FileManager.default.createDirectory(
            at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: file.path, contents: nil)

        // Root given via the symlink, file resolved via the real path (as
        // NSOpenPanel commonly returns) — must still match.
        XCTAssertEqual(PathUtils.relative(file.path, to: link), "src/payments.swift")
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
