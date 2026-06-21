import Testing
import Foundation
@testable import LlmIdeMac

struct CodeTreeTests {
    private func codeItem(_ path: String, treePath: [String]) -> LibraryItem {
        var i = LibraryItem(name: (path as NSString).lastPathComponent,
                            path: path, category: .code)
        i.treePath = treePath
        return i
    }

    // MARK: - relativeDirComponents

    @Test("relative dir components between a root and a nested file")
    func relativeComponents() {
        let root = URL(fileURLWithPath: "/repo")
        #expect(LibraryItemStore.relativeDirComponents(
            of: URL(fileURLWithPath: "/repo/Sources/App/Foo.swift"), under: root)
            == ["Sources", "App"])
        // File directly in root → no intermediate dirs.
        #expect(LibraryItemStore.relativeDirComponents(
            of: URL(fileURLWithPath: "/repo/README.md"), under: root) == [])
        // File not under root → empty, not a crash.
        #expect(LibraryItemStore.relativeDirComponents(
            of: URL(fileURLWithPath: "/elsewhere/x.swift"), under: root) == [])
    }

    // MARK: - tree building

    @Test("flat files land at the top level as leaves")
    func flatFiles() {
        let items = [codeItem("/p/code/A.swift", treePath: []),
                     codeItem("/p/code/B.swift", treePath: [])]
        let tree = CodeEntry.build(from: items)
        #expect(tree.count == 2)
        #expect(tree.allSatisfy { $0.item != nil && $0.children == nil })
        #expect(tree.map(\.name) == ["A.swift", "B.swift"])  // alpha
    }

    @Test("nested repo paths build correct parent/child nesting")
    func nestedRepo() {
        let items = [
            codeItem("/x/InfiniteBrain/Sources/App/Foo.swift",
                     treePath: ["InfiniteBrain", "Sources", "App"]),
            codeItem("/x/InfiniteBrain/README.md", treePath: ["InfiniteBrain"]),
        ]
        let tree = CodeEntry.build(from: items)
        #expect(tree.count == 1)
        let repo = try! #require(tree.first)
        #expect(repo.name == "InfiniteBrain")
        #expect(repo.item == nil && repo.children != nil)
        // Directory ("Sources") sorts before the file ("README.md").
        #expect(repo.children?.map(\.name) == ["Sources", "README.md"])
        let sources = try! #require(repo.children?.first)
        let app = try! #require(sources.children?.first)
        #expect(app.name == "App")
        #expect(app.children?.first?.name == "Foo.swift")
        #expect(app.children?.first?.item != nil)
    }

    @Test("distinct top-level roots stay separate")
    func separateRoots() {
        let items = [
            codeItem("/x/RepoA/a.swift", treePath: ["RepoA"]),
            codeItem("/y/RepoB/b.swift", treePath: ["RepoB"]),
            codeItem("/p/code/loose.swift", treePath: []),
        ]
        let tree = CodeEntry.build(from: items)
        // Two repo dirs sort before the loose top-level file.
        #expect(tree.map(\.name) == ["RepoA", "RepoB", "loose.swift"])
    }

    // MARK: - FSNode parity (FileTreePanel renders from the SAME nester)

    private func outline(_ entries: [CodeEntry], _ depth: Int = 0) -> [String] {
        entries.flatMap { e -> [String] in
            [String(repeating: "  ", count: depth) + e.name] + outline(e.children ?? [], depth + 1)
        }
    }
    private func outline(_ nodes: [FSNode], _ depth: Int = 0) -> [String] {
        nodes.flatMap { n -> [String] in
            [String(repeating: "  ", count: depth) + n.name] + outline(n.children, depth + 1)
        }
    }

    @Test("FileTreePanel FSNode tree matches the Library CodeEntry tree")
    func fsNodeParity() {
        let items = [
            codeItem("/x/RepoA/Sources/App/Foo.swift", treePath: ["RepoA", "Sources", "App"]),
            codeItem("/x/RepoA/README.md", treePath: ["RepoA"]),
            codeItem("/y/RepoB/b.swift", treePath: ["RepoB"]),
            codeItem("/p/code/loose.swift", treePath: []),
        ]
        // Identical hierarchy from both builders — the consolidation guarantee.
        #expect(outline(CodeEntry.build(from: items)) == outline(buildCodeTrees(items: items)))
    }

    @Test("multiple repos stay separate top-level nodes (no commonAncestor collapse)")
    func fsNodeMultiRepoNotCollapsed() {
        let items = [
            codeItem("/x/RepoA/a.swift", treePath: ["RepoA"]),
            codeItem("/y/RepoB/b.swift", treePath: ["RepoB"]),
        ]
        // The old commonAncestor builder would have nested both under one node;
        // treePath nesting keeps them as distinct repos.
        #expect(buildCodeTrees(items: items).map(\.name) == ["RepoA", "RepoB"])
    }

    @Test("FSNode directory URLs reconstruct the real on-disk path")
    func fsNodeDirURLs() {
        let items = [codeItem("/x/RepoA/Sources/Foo.swift", treePath: ["RepoA", "Sources"])]
        let repo = try! #require(buildCodeTrees(items: items).first)
        #expect(repo.url.path == "/x/RepoA")                                   // Reveal-in-Finder target
        #expect(repo.children.first?.url.path == "/x/RepoA/Sources")
        #expect(repo.children.first?.children.first?.url.path == "/x/RepoA/Sources/Foo.swift")
    }
}
