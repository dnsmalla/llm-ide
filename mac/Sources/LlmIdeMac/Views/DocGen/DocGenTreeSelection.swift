import Foundation

/// Checkbox maths for Doc Gen's source trees. Pure functions over `FSNode`, so
/// the tri-state folder behaviour is testable without a view.
enum DocGenTreeSelection {

    enum State {
        case none
        case partial
        case all
    }

    /// Every file leaf at or beneath `node`, depth-first.
    static func fileLeaves(of node: FSNode) -> [LibraryItem] {
        if let item = node.item { return [item] }
        return node.children.flatMap { fileLeaves(of: $0) }
    }

    /// Whether none, some, or all of `node`'s leaves are selected. A folder with
    /// no readable leaves reads as `.none`.
    static func state(for node: FSNode, selected: Set<DocGenSource>) -> State {
        let leaves = fileLeaves(of: node)
        guard !leaves.isEmpty else { return .none }
        let hits = leaves.filter { selected.contains(source(for: $0)) }.count
        if hits == 0 { return .none }
        return hits == leaves.count ? .all : .partial
    }

    /// Toggle `node`: a fully selected subtree clears, anything else fills.
    /// Filling from `.partial` selects the remainder rather than inverting, so
    /// one click on a half-ticked folder always means "select everything".
    static func toggled(node: FSNode, selected: Set<DocGenSource>) -> Set<DocGenSource> {
        let leaves = fileLeaves(of: node)
        var result = selected
        if state(for: node, selected: selected) == .all {
            for leaf in leaves { result.remove(source(for: leaf)) }
        } else {
            for leaf in leaves { result.insert(source(for: leaf)) }
        }
        return result
    }

    static func source(for item: LibraryItem) -> DocGenSource {
        .file(url: item.url, name: item.name)
    }
}
