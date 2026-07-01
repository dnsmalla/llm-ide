import Foundation

/// Single source of truth for nesting `.code` `LibraryItem`s into a directory
/// forest, keyed on each item's `treePath`. BOTH the Library/Regression tree
/// (`CodeEntry`) and the CodeGraph/Review/Visual tree (`FSNode` in
/// FileTreePanel) are built from this, so every view renders an identical
/// hierarchy from the same store — no second algorithm to drift against.
///
/// Files with no `treePath` (or an empty one) land at the top level; otherwise
/// each path component is a nesting level. Directories sort before files, both
/// case-insensitive alphabetical.
enum CodeTreeNester {
    /// Build a forest of generic `Node`s.
    /// - makeDir: `(name, dirKey, dirURL, children)` — `dirKey` is the unique
    ///   "/"-joined relative path; `dirURL` is the directory's real on-disk URL
    ///   (reconstructed from a child file's URL, so Reveal-in-Finder works).
    /// - makeFile: `(item)` — builds a leaf from the `LibraryItem`.
    static func forest<Node>(
        from items: [LibraryItem],
        makeDir: (_ name: String, _ dirKey: String, _ dirURL: URL, _ children: [Node]) -> Node,
        makeFile: (_ item: LibraryItem) -> Node
    ) -> [Node] {
        // Adjacency keyed by parent directory path ("" = top level).
        var childDirNames: [String: [String]] = [:]
        var seenChild: [String: Set<String>] = [:]
        var dirFiles: [String: [LibraryItem]] = [:]
        var dirURL: [String: URL] = [:]

        for item in items {
            let tp = item.treePath ?? []
            var parent = ""
            for (i, comp) in tp.enumerated() {
                if seenChild[parent, default: []].insert(comp).inserted {
                    childDirNames[parent, default: []].append(comp)
                }
                let key = parent.isEmpty ? comp : parent + "/" + comp
                // The directory at depth i+1 is the file's URL with the
                // remaining (tp.count - i) trailing components removed.
                if dirURL[key] == nil {
                    var u = item.url
                    for _ in 0..<(tp.count - i) { u = u.deletingLastPathComponent() }
                    dirURL[key] = u
                }
                parent = key
            }
            dirFiles[parent, default: []].append(item)
        }

        func make(_ dirKey: String) -> [Node] {
            var out: [Node] = []
            for name in (childDirNames[dirKey] ?? [])
                .sorted(by: { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }) {
                let key = dirKey.isEmpty ? name : dirKey + "/" + name
                let url = dirURL[key] ?? URL(fileURLWithPath: key)
                out.append(makeDir(name, key, url, make(key)))
            }
            for item in (dirFiles[dirKey] ?? [])
                .sorted(by: { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) {
                out.append(makeFile(item))
            }
            return out
        }
        return make("")
    }
}

/// A node in the Library's nested CODE tree: either a directory (with
/// `children`) or a file leaf (with `item`). Built from `LibraryItem.treePath`
/// so a repo renders as its real directory hierarchy rather than a flat list.
struct CodeEntry: Identifiable {
    let id: String              // unique key within the tree
    let name: String
    let item: LibraryItem?      // non-nil → file leaf
    var children: [CodeEntry]?  // non-nil → directory

    /// Build the top-level forest from a flat list of `.code` items, via the
    /// shared `CodeTreeNester` (so this matches the FileTreePanel FSNode tree).
    static func build(from items: [LibraryItem]) -> [CodeEntry] {
        CodeTreeNester.forest(
            from: items,
            makeDir: { name, dirKey, _, children in
                CodeEntry(id: "dir:" + dirKey, name: name, item: nil, children: children)
            },
            makeFile: { item in
                CodeEntry(id: "file:" + item.path, name: item.name, item: item, children: nil)
            })
    }
}
