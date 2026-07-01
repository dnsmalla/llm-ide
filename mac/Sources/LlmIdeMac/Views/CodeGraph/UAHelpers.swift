import Foundation
import GraphKit
import CoreGraphics

// Pure helpers for the Code Graph view's "Files & Symbols" panel and
// canvas layout. Extracted from UAGraphView.swift's tail — these are
// all `nonisolated static` functions that don't touch any @State, so
// they sit comfortably in their own file.
//
// Naming: bundled under a caseless enum to namespace the helpers
// without polluting the global scope. Callers use
// `UAHelpers.collectCodeArtifacts(...)` etc.

enum UAHelpers {

    /// File-grouped row in the "Files & Symbols" panel. One per
    /// source_file; carries the file's header node + every code
    /// symbol the understand-anything CLI emitted from that file.
    struct CodeArtifact: Identifiable {
        let fileNode: CGNode
        let symbols: [CodeSymbol]
        var id: String { fileNode.id }
    }

    struct CodeSymbol: Identifiable {
        let node: CGNode
        var id: String { node.id }
    }

    /// Group every node by its `metadata["source_file"]` so the list
    /// shows "<file.swift> ▸ method1, method2…". This is more reliable
    /// than chasing `defines` edges because understand-anything emits class→method
    /// edges (not file→method), but every node still carries the file
    /// path that produced it.
    ///
    /// Pure — safe to call from `Task.detached`.
    static func collectCodeArtifacts(_ g: CGData) -> [CodeArtifact] {
        var bySource: [String: [CodeSymbol]] = [:]
        var fileHeaderByPath: [String: CGNode] = [:]

        for node in g.nodes {
            // Drop noise that's not useful as a Files & Symbols row:
            // orphans (no source_file), code-block snippets understand-anything
            // embeds inside markdown ("code:block1 …"), and bare-dot
            // method names like `.write()` / `.testSomething()` that
            // float without their parent type. The Files & Symbols
            // panel should be a clean index of *files*, not every
            // leaf node the CLI emitted.
            guard let source = node.metadata["source_file"], !source.isEmpty else {
                continue
            }
            if isPanelNoise(node) { continue }
            if node.kind == .file {
                // Prefer the canonical file node as the section header,
                // even if a symbol from the same file was processed first.
                fileHeaderByPath[source] = node
            } else if !isHeadingChunk(node) {
                // Heading-chunks under a doc file (e.g. every CHANGELOG
                // version section) explode the symbols list — 133 of
                // them on InfiniteBrain alone. Drop them; the file row
                // itself is enough. Real code symbols (functions,
                // classes, structs) still surface as before.
                bySource[source, default: []].append(CodeSymbol(node: node))
            }
        }

        // Disambiguating section title: when the basename collides
        // across paths (5x SKILL.md from different sub-dirs), the
        // header shows the relative path so the user can tell them
        // apart. Unique basenames stay just "AGENT_GUIDE.md".
        let allPaths = Set(bySource.keys).union(fileHeaderByPath.keys)
        let basenameCounts = Dictionary(grouping: allPaths, by: { ($0 as NSString).lastPathComponent })
            .mapValues(\.count)

        return allPaths.sorted().compactMap { path -> CodeArtifact? in
            // Dedupe child symbols by (title, line) — understand-anything emits
            // overlapping doc/chunk/file nodes for the same heading
            // anchor inside a markdown file, which surfaced as the
            // user-visible "AGENT_GUIDE.md × 3" repetition.
            let raw = bySource[path] ?? []
            var seen = Set<String>()
            let syms = raw.sorted { $0.node.title < $1.node.title }.filter { sym in
                let line = sym.node.metadata["line"] ?? ""
                let key = "\(sym.node.title)|\(line)"
                if seen.contains(key) { return false }
                seen.insert(key)
                return true
            }
            guard !syms.isEmpty else { return nil }

            // Section title — basename for unique names, full
            // relative path (or its tail) when ambiguous.
            let basename = (path as NSString).lastPathComponent
            let title: String
            if (basenameCounts[basename] ?? 0) > 1 {
                title = path   // already relative-to-repo per parser normalisation
            } else {
                title = basename
            }
            let header = (fileHeaderByPath[path].map { node -> CGNode in
                CGNode(id: node.id, title: title, kind: node.kind,
                       position: node.position, metadata: node.metadata)
            }) ?? CGNode(
                id: "file:" + path,
                title: title,
                kind: .file,
                position: .zero,
                metadata: ["source_file": path]
            )
            return CodeArtifact(fileNode: header, symbols: syms)
        }
    }

    /// True for nodes the user shouldn't see in the Files & Symbols
    /// panel even when they have a source_file. Two patterns:
    /// `code:<...>` snippets understand-anything pulls from markdown fences,
    /// and bare-dot method names (`.testFoo()`, `.write()`) that the
    /// CLI emits without a parent receiver. Both flood the list with
    /// low-signal rows.
    static func isPanelNoise(_ node: CGNode) -> Bool {
        let title = node.title
        if title.hasPrefix("code:") { return true }
        if title.hasPrefix(".") && title.hasSuffix("()") {
            let inner = title.dropFirst().dropLast(2)
            // `.foo()` (no further dots) — the floating-method shape
            // understand-anything emits for tests / helpers. Real receiver-
            // qualified methods like `MyType.foo()` contain an inner
            // dot and are kept.
            return !inner.contains(".")
        }
        return false
    }

    /// True when a node is a markdown heading-chunk rather than a
    /// real file/symbol. Heading-chunks have `source_location` set
    /// to a line offset > L1 inside a `document`-kind file. The
    /// L1-anchored doc-root node is kept (it's the file itself).
    static func isHeadingChunk(_ node: CGNode) -> Bool {
        guard node.kind == .docPage || node.kind == .memoryChunk else { return false }
        guard let line = node.metadata["line"] else { return false }
        return line != "L1"
    }

    /// Layout canvas that scales with node count so 1k+ nodes don't
    /// end up overlapping into illegible arcs. Each ring of the
    /// type-clustered circular layout gets ~16pt of breathing room
    /// per node.
    static func layoutSize(for nodeCount: Int) -> CGSize {
        // Base canvas for small graphs; widen as the node count grows
        // so CodeGraphLayout's concentric rings have room to breathe.
        // The canvas works for the CodeGraphCanvas auto-fit which
        // scales the resulting layout into whatever the actual
        // viewport is.
        let base: CGFloat = 1200
        let extra = CGFloat(max(0, nodeCount - 100)) * 4
        let side = min(base + extra, 8000)
        return CGSize(width: side, height: side * 0.7)
    }

    /// Longest leading path components shared by every input. Used
    /// for folder-origin → root URL resolution in the Files panel.
    static func commonAncestor(_ paths: [String]) -> String {
        guard !paths.isEmpty else { return "" }
        let split = paths.map { $0.split(separator: "/").map(String.init) }
        guard let first = split.first else { return "" }
        var common: [String] = []
        for (idx, comp) in first.enumerated() {
            if split.allSatisfy({ idx < $0.count && $0[idx] == comp }) {
                common.append(comp)
            } else {
                break
            }
        }
        return "/" + common.joined(separator: "/")
    }
}
