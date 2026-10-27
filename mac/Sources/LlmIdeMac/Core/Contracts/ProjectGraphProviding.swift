import Foundation
import GraphCore

/// Hands the System view the project's code graph without it naming the
/// Graph feature. Shell installs the provider (`FeatureCatalog.installFeatureSeams`)
/// under `FEATURE_GRAPH`: it returns the graph the Graph view already cached for
/// the project's repo, and never triggers a scan. When nothing is installed, or
/// the provider answers nil, the caller falls back to `ProjectGraphFile`.
///
/// Contract:
/// - `install(_:)`
///   - Pre: main actor.
///   - Post: replaces any previous provider (last install wins).
/// - `graph(forProjectRoot:)`
///   - Post: the provider's graph for that project root, or nil when none is
///     installed or it has nothing cached. Never throws.
@MainActor
final class ProjectGraphRegistry {
    static let shared = ProjectGraphRegistry()

    private var provider: (@MainActor (URL) async -> CGData?)?

    /// Internal (not private) so tests can use an isolated instance instead
    /// of mutating `shared`, which the running app also reads.
    init() {}

    var isInstalled: Bool { provider != nil }

    func install(_ provider: @escaping @MainActor (URL) async -> CGData?) {
        self.provider = provider
    }

    func graph(forProjectRoot root: URL) async -> CGData? {
        guard let provider else { return nil }
        return await provider(root)
    }
}
