import Foundation

/// Hands the System view the project's code graph without it naming the
/// Graph feature, or GraphCore: Core is built without the graph product in the
/// reduced builds. Shell installs the provider (`FeatureCatalog.installFeatureSeams`)
/// under `FEATURE_GRAPH`: it returns the graph the Graph view already cached for
/// the project's repo, encoded as graph-kit's canonical `GraphDocument` JSON, and
/// never triggers a scan. When nothing is installed, or the provider answers nil,
/// the caller falls back to `ProjectGraphFile` (`<repo>/system/graph/graph.json`).
///
/// Contract:
/// - `install(_:)`
///   - Pre: main actor.
///   - Post: replaces any previous provider (last install wins).
/// - `graph(forProjectRoot:)`
///   - Post: the provider's `GraphDocument` JSON bytes for that project root, or
///     nil when none is installed or it has nothing cached (or could not encode
///     it). Never throws.
@MainActor
final class ProjectGraphRegistry {
    static let shared = ProjectGraphRegistry()

    private var provider: (@MainActor (URL) async -> Data?)?

    /// Internal (not private) so tests can use an isolated instance of their own
    /// instead of mutating `shared`, which the running app also reads.
    init() {}

    var isInstalled: Bool { provider != nil }

    func install(_ provider: @escaping @MainActor (URL) async -> Data?) {
        self.provider = provider
    }

    func graph(forProjectRoot root: URL) async -> Data? {
        guard let provider else { return nil }
        return await provider(root)
    }
}
