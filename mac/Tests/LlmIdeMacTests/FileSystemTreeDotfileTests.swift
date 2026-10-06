import Testing
import Foundation
@testable import LlmIdeMacLib

@Suite("Explorer tree dotfiles")
struct FileSystemTreeDotfileTests {
    @Test func showsProjectDotfilesButNotOSNoiseOrVCS() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("tree-dot-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        for name in [".gitignore", ".env", ".DS_Store", "Makefile", "a.swift"] {
            try "x".write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        for name in [".github", ".git", ".build", "src"] {
            try fm.createDirectory(at: dir.appendingPathComponent(name), withIntermediateDirectories: true)
        }
        let names = FileSystemTree.children(of: dir).map(\.name)
        #expect(names == [".github", "src", ".env", ".gitignore", "a.swift", "Makefile"])
    }
}
