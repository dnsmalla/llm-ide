import Foundation

/// A node in the Library's nested CODE tree: either a directory (with
/// `children`) or a file leaf (with `item`). Built from `LibraryItem.treePath`
/// so a repo renders as its real directory hierarchy rather than a flat list.
struct CodeEntry: Identifiable {
    let id: String              // unique key within the tree
    let name: String
    let item: LibraryItem?      // non-nil → file leaf
    var children: [CodeEntry]?  // non-nil → directory

    /// Build the top-level forest from a flat list of `.code` items. Files
    /// with no `treePath` (or an empty one) land at the top level; otherwise
    /// each path component becomes a nesting level. Directories sort before
    /// files, both alphabetically (case-insensitive).
    static func build(from items: [LibraryItem]) -> [CodeEntry] {
        // Adjacency keyed by parent directory path ("" = top level).
        var childDirNames: [String: [String]] = [:]
        var seenChild: [String: Set<String>] = [:]
        var dirFiles: [String: [LibraryItem]] = [:]

        for item in items {
            var parent = ""
            for comp in item.treePath ?? [] {
                if seenChild[parent, default: []].insert(comp).inserted {
                    childDirNames[parent, default: []].append(comp)
                }
                parent = parent.isEmpty ? comp : parent + "/" + comp
            }
            dirFiles[parent, default: []].append(item)
        }

        func make(dirKey: String) -> [CodeEntry] {
            var out: [CodeEntry] = []
            for name in (childDirNames[dirKey] ?? [])
                .sorted(by: { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }) {
                let key = dirKey.isEmpty ? name : dirKey + "/" + name
                out.append(CodeEntry(id: "dir:" + key, name: name,
                                     item: nil, children: make(dirKey: key)))
            }
            for item in (dirFiles[dirKey] ?? [])
                .sorted(by: { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) {
                out.append(CodeEntry(id: "file:" + item.path, name: item.name,
                                     item: item, children: nil))
            }
            return out
        }
        return make(dirKey: "")
    }
}
