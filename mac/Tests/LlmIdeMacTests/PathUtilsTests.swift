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

    // MARK: - resolvingSymlinks / containment

    private func makeTempDir() throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("PathUtilsTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testResolvingSymlinksFollowsLinkForNotYetExistingFile() throws {
        let base = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: base) }
        let outside = base.appendingPathComponent("outside")
        let project = base.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: project.appendingPathComponent("link"), withDestinationURL: outside)

        let resolved = PathUtils.resolvingSymlinks(project.path + "/link/new.txt")
        let outsideReal = PathUtils.resolvingSymlinks(outside.path)
        XCTAssertEqual(resolved, outsideReal + "/new.txt")
    }

    func testResolvingSymlinksFollowsDanglingLink() throws {
        let base = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: base) }
        let target = base.appendingPathComponent("elsewhere/file.txt")
        try FileManager.default.createDirectory(
            at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        let link = base.appendingPathComponent("dangling")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

        XCTAssertEqual(PathUtils.resolvingSymlinks(link.path),
                       PathUtils.resolvingSymlinks(target.path))
    }

    func testResolvingSymlinksHandlesSymlinkedRoot() throws {
        let base = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: base) }
        let real = base.appendingPathComponent("real")
        let link = base.appendingPathComponent("link")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)

        // Root via the link and file via the real path must land on one form.
        XCTAssertEqual(PathUtils.resolvingSymlinks(link.path + "/a.txt"),
                       PathUtils.resolvingSymlinks(real.path + "/a.txt"))
    }

    func testResolvingSymlinksAcceptsNotYetExistingFileUnderPrivateRootedDir() throws {
        let base = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: base) }
        // Root and target from the SAME function must agree on prefix even
        // when the target does not exist yet (/var vs /private/var).
        let root = PathUtils.resolvingSymlinks(base.path)
        let target = PathUtils.resolvingSymlinks(base.path + "/sub/dir/new.txt")
        XCTAssertTrue(target.hasPrefix(root + "/"), "\(target) not under \(root)")
        XCTAssertEqual(target, root + "/sub/dir/new.txt")
    }
}
