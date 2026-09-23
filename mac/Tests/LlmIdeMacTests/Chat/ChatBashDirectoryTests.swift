import Testing
import Foundation
@testable import LlmIdeMacLib

/// Regression (2026-09 chat review): a `bash` proposal with no
/// `workingDirectory` ran in the GUI app's cwd (`/`), and a supplied one was
/// never contained to the project.
@Suite("ChatBashDirectory")
struct ChatBashDirectoryTests {
    private func makeRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("bashdir-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("extension"), withIntermediateDirectories: true)
        return URL(fileURLWithPath: PathUtils.canonicalise(root.path))
    }

    @Test("No directory given runs in the project root, not the app's cwd")
    func defaultsToRoot() throws {
        let root = try makeRoot()
        #expect(try ChatBashDirectory.resolve(nil, repoRoot: root).get().path == root.path)
        #expect(try ChatBashDirectory.resolve("  ", repoRoot: root).get().path == root.path)
    }

    @Test("Relative and absolute directories inside the project are allowed")
    func insideProject() throws {
        let root = try makeRoot()
        let sub = root.appendingPathComponent("extension").path
        #expect(try ChatBashDirectory.resolve("extension", repoRoot: root).get().path == sub)
        #expect(try ChatBashDirectory.resolve(sub, repoRoot: root).get().path == sub)
    }

    @Test("Directories outside the project are refused, including via ..")
    func outsideProjectRefused() throws {
        let root = try makeRoot()
        for dir in ["/", "/tmp", "..", "extension/../../", "~"] {
            guard case .failure(.outsideProject) = ChatBashDirectory.resolve(dir, repoRoot: root) else {
                Issue.record("\(dir) should be refused")
                continue
            }
        }
    }

    @Test("No project open refuses rather than falling back to the app's cwd")
    func noProjectRefused() {
        #expect(ChatBashDirectory.resolve(nil, repoRoot: nil) == .failure(.noProject))
    }
}
