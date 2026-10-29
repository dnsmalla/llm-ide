import Foundation

/// Per-list request generations for the Library sidebar's async loads. Several
/// triggers (appear, the dirty token, an add/toggle) can start overlapping loads
/// of the same list; without a token a slow, OLDER response landing after a
/// newer one overwrote fresh rows with stale ones (e.g. a just-consented server
/// flipping back to unconsented). Each load takes a token before awaiting and
/// only applies its result while that token is still the latest for its list.
struct LibraryLoadGenerations: Equatable {
    enum List: Hashable {
        case plugins, mcpPlugins, connectors, llmSources
    }

    private var current: [List: Int] = [:]

    /// Starts a load of `list`, superseding any load already in flight for it.
    mutating func begin(_ list: List) -> Int {
        let next = (current[list] ?? 0) + 1
        current[list] = next
        return next
    }

    /// True while no newer load of `list` has started since `token` was taken.
    func isCurrent(_ token: Int, for list: List) -> Bool {
        current[list] == token
    }
}
