import Testing
import Foundation
@testable import LlmIdeMacLib

/// Installing a plugin from a cloned Git repo or marketplace runs on the Mac, so
/// the repo's contents are untrusted input: a symlink or a hostile manifest name
/// must not reach outside the clone.
@Suite("Plugin install safety", .serialized)
struct PluginInstallSafetyTests {
    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("plugin-safety-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test("zip stores symlinks as links instead of copying their targets")
    func zipDoesNotFollowSymlinks() {
        let args = PluginGitInstaller.zipArgs(URL(fileURLWithPath: "/tmp/x.zip"))
        #expect(args.first == "-rqy", "-y keeps a link a link; without it ~/.ssh could ride along")
        #expect(args.suffix(2) == ["/tmp/x.zip", "."])
    }

    @Test("a plugin path that is a symlink out of the clone is refused")
    func resolveRefusesSymlinkEscape() throws {
        let root = try makeTempDir()
        let outside = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("plugins"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("plugins/leak"), withDestinationURL: outside)
        #expect(throws: PluginMarketplace.MarketplaceError.self) {
            _ = try PluginMarketplace.resolve("plugins/leak", inside: root)
        }
    }

    @Test("a missing plugin path is refused, not waved through")
    func resolveRefusesMissingPath() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(throws: PluginMarketplace.MarketplaceError.self) {
            _ = try PluginMarketplace.resolve("plugins/nope", inside: root)
        }
    }

    @Test("harmless symlinks are dropped so the install is not refused, and their targets are untouched")
    func removeSymlinksKeepsRealFiles() throws {
        let root = try makeTempDir()
        let outside = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        try "keep".write(to: root.appendingPathComponent("AGENTS.md"), atomically: true, encoding: .utf8)
        try "secret".write(to: outside.appendingPathComponent("key"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("CLAUDE.md"), withDestinationURL: root.appendingPathComponent("AGENTS.md"))
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("leak"), withDestinationURL: outside)
        #expect(PluginGitInstaller.removeSymlinks(in: root) == 2)
        #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("AGENTS.md").path))
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("CLAUDE.md").path))
        #expect(FileManager.default.fileExists(atPath: outside.appendingPathComponent("key").path),
                "removing the link must not touch what it pointed at")
    }

    @Test("a real plugin path inside the clone still resolves")
    func resolveAcceptsRealPath() throws {
        let root = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("plugins/real"), withIntermediateDirectories: true)
        let url = try PluginMarketplace.resolve("plugins/real", inside: root)
        #expect(url.lastPathComponent == "real")
    }

    @Test("a hostile manifest name cannot move the zip out of the staging folder")
    func packageIgnoresEntryNameForPath() async throws {
        let parent = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: parent) }
        let repo = parent.appendingPathComponent("repo", isDirectory: true)
        let pluginDir = repo.appendingPathComponent("plugins/p", isDirectory: true)
        try FileManager.default.createDirectory(at: pluginDir, withIntermediateDirectories: true)
        try "{}".write(to: pluginDir.appendingPathComponent("plugin.json"), atomically: true, encoding: .utf8)
        let entry = PluginMarketplace.Entry(name: "../../escape", description: "", version: nil,
                                            relativePath: "plugins/p")
        let staged = PluginMarketplace.Staged(marketplaceName: "m", entries: [entry], skipped: [],
                                              repoRoot: repo, cleanup: {})
        let zip = try await PluginMarketplace.package(entry, from: staged)
        #expect(zip.deletingLastPathComponent().standardizedFileURL.path == parent.standardizedFileURL.path)
        #expect(zip.lastPathComponent.hasPrefix("plugin-") && zip.pathExtension == "zip")
        // `../../escape.zip` from `parent` would land two levels up.
        let twoUp = parent.deletingLastPathComponent().deletingLastPathComponent()
        #expect(!FileManager.default.fileExists(atPath: twoUp.appendingPathComponent("escape.zip").path))
    }
}
