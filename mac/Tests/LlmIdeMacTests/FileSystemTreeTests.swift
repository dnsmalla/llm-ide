import Testing
import Foundation
@testable import LlmIdeMac

@Suite struct FileSystemTreeTests {
    @Test func loadsOneLevelDirsFirstSkippingNoise() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("fst-\(UUID().uuidString)")
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("src"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent(".git"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("node_modules"), withIntermediateDirectories: true)
        try "x".write(to: root.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
        try "y".write(to: root.appendingPathComponent(".hidden"), atomically: true, encoding: .utf8)
        defer { try? fm.removeItem(at: root) }

        let nodes = FileSystemTree.children(of: root)
        let names = nodes.map(\.name)
        #expect(names == ["src", "README.md"])      // dirs first; .git/node_modules/.hidden skipped
        #expect(nodes[0].isDirectory)
        #expect(!nodes[1].isDirectory)
    }
}
