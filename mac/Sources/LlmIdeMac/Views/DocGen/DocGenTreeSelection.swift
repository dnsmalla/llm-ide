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

    /// Bottom-up selection state for every node in `roots`, keyed by
    /// `FSNode.id` (the absolute path). Computed once per render so row
    /// bodies can do an O(1) dictionary lookup instead of each calling
    /// `state(for:selected:)`, which walks its own subtree — with a repo-sized
    /// Code tree, doing that per visible folder row on every checkbox click
    /// made the cost O(visible rows × subtree size). This is a single
    /// bottom-up pass over the forest, O(total nodes) regardless of how many
    /// rows are on screen.
    static func states(forForest roots: [FSNode], selected: Set<DocGenSource>) -> [String: State] {
        var result: [String: State] = [:]
        for root in roots {
            _ = accumulate(root, selected: selected, into: &result)
        }
        return result
    }

    /// Post-order visit of `node`: fills `result[node.id]` for `node` and
    /// every descendant, and returns (selected leaf count, total leaf count)
    /// so the parent can fold children's counts without re-walking them.
    private static func accumulate(
        _ node: FSNode, selected: Set<DocGenSource>, into result: inout [String: State]
    ) -> (hits: Int, total: Int) {
        if let item = node.item {
            let isSelected = selected.contains(source(for: item))
            result[node.id] = isSelected ? State.all : State.none
            return (isSelected ? 1 : 0, 1)
        }
        var hits = 0
        var total = 0
        for child in node.children {
            let (childHits, childTotal) = accumulate(child, selected: selected, into: &result)
            hits += childHits
            total += childTotal
        }
        let state: State
        if total == 0 || hits == 0 {
            state = .none
        } else if hits == total {
            state = .all
        } else {
            state = .partial
        }
        result[node.id] = state
        return (hits, total)
    }
}
