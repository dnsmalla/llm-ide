import Foundation
import GraphCore

/// The contract between the app and whatever produces its graphs.
///
/// Everything the app needs from a graph *engine* is named here, and nothing
/// else in the app refers to a producer type. That is what makes the engine
/// removable: `BuiltinGraphEngine` is the single file that imports `GraphKit`,
/// so deleting it plus one line of `mac/Package.swift` leaves the app building,
/// with the Graph view reporting that no engine is installed while still
/// rendering any graph already on disk — because the model and the layout
/// engine live in `GraphCore`, which is always present.
///
/// Three verbs, matching the two production tracks and their join:
/// code → graph, docs → graph, and the merge that cross-links them.
public protocol GraphEngine: Sendable {
    /// Stable identifier — `"builtin"`, or an installed plugin's name.
    var identifier: String { get }
    /// Name for the UI.
    var displayName: String { get }
    /// Document extensions this engine can chunk. The app uses it to route
    /// files between the code and doc tracks, so it must not assume a set.
    var supportedDocExtensions: Set<String> { get }

    /// Scan a repository's code.
    ///
    /// Markdown must be excluded from the returned graph: markdown belongs to
    /// the doc track, and including it double-counts every document once the
    /// tracks are merged. The raw scan and the changed-file set come back too —
    /// the code-notes writer needs them to render symbols and to rewrite only
    /// what changed.
    func scanCode(repoRoot: URL) async throws -> CodeScan

    /// Chunk the documents under `roots` into a graph plus ordered chunks.
    func generateDocMemory(roots: [URL]) async throws -> GeneratedMemory

    /// Chunk an explicit file list — the caller already knows which docs it
    /// wants, so no folder walk is needed.
    func generateDocMemory(files: [URL]) async throws -> GeneratedMemory

    /// Combine the code and doc graphs, adding doc→code cross-links.
    func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) async throws -> CGData

    /// Cheap change-detection signature for a document set, so an unchanged
    /// re-generate can be skipped.
    func docSetFingerprint(roots: [URL]) -> String
}

/// Why no engine is usable, in words the UI can show directly.
public enum GraphEngineUnavailable: Error, LocalizedError, Equatable {
    /// No engine is compiled in and none is installed.
    case notInstalled
    /// An engine was found but could not run.
    case failed(engine: String, reason: String)

    public var errorDescription: String? {
        switch self {
        case .notInstalled:
            return "No graph engine is installed. Install one from Library → "
                + "Plugins to generate graphs. Graphs already on disk still open."
        case let .failed(engine, reason):
            return "The \(engine) graph engine failed: \(reason)"
        }
    }
}

/// Resolving an engine without holding an observable registry.
///
/// Services constructed outside the view hierarchy (`CodeNoteService`,
/// `KnowledgeGraphService`) need an engine as a plain default argument, which
/// cannot come from a `@MainActor` `ObservableObject`. This gives them one, and
/// keeps the `GRAPHKIT_BUILTIN` decision in a single place.
public enum GraphEngines {

    /// The engine to use when a caller does not inject one: a plugin's if one
    /// is installed, otherwise the compiled-in engine, otherwise nil.
    ///
    /// Resolved once and cached. Discovery walks three directories and JSON-
    /// decodes a manifest per plugin, and `UAGraphView` held the result in a
    /// stored property of a `View` **struct** — so SwiftUI re-ran the whole
    /// scan on the main thread every time it re-instantiated the view, which is
    /// on essentially every navigation.
    ///
    /// Call `invalidate()` after installing or removing a plugin.
    public static func resolveDefault() -> GraphEngine? {
        cacheLock.lock()
        if let cached {
            cacheLock.unlock()
            return cached.engine
        }
        cacheLock.unlock()
        // Discovery runs OUTSIDE the lock: it enumerates directories and
        // decodes a manifest per plugin, and `NSLock` is not recursive, so
        // holding it across that would deadlock the moment discovery ever
        // called back in. A duplicate concurrent discovery is harmless — the
        // work is idempotent and the first result to be stored wins.
        let resolved = discover()
        cacheLock.lock()
        if let cached {
            cacheLock.unlock()
            return cached.engine
        }
        cached = Resolved(engine: resolved)
        cacheLock.unlock()
        return resolved
    }

    /// Drop the cached engine so the next resolve re-discovers.
    public static func invalidate() {
        cacheLock.lock(); defer { cacheLock.unlock() }
        cached = nil
    }

    /// Box so "resolved, and there is no engine" stays distinguishable from
    /// "not resolved yet" — otherwise a machine with no engine re-ran the
    /// directory scan on every call.
    private struct Resolved { let engine: GraphEngine? }

    private static let cacheLock = NSLock()
    private nonisolated(unsafe) static var cached: Resolved?

    private static func discover() -> GraphEngine? {
        if let plugin = GraphEngineLocator().installedEngines().first { return plugin }
        #if GRAPHKIT_BUILTIN
        return BuiltinGraphEngine()
        #else
        return nil
        #endif
    }
}

/// Resolves which engine the app should use.
///
/// A plugin-provided engine wins over the compiled-in one when both are
/// present, so installing a newer engine takes effect without a rebuild. The
/// `GRAPHKIT_BUILTIN` guard is what lets the builtin disappear cleanly: with
/// that define removed from `mac/Package.swift`, the branch compiles away
/// instead of breaking the build.
@MainActor
public final class GraphEngineRegistry: ObservableObject {

    /// The engine in use, or nil when none is available.
    @Published public private(set) var active: GraphEngine?
    /// Every engine found, for the Settings/Library listing.
    @Published public private(set) var discovered: [GraphEngine] = []

    private let locator: GraphEngineLocator

    public init(locator: GraphEngineLocator = GraphEngineLocator()) {
        self.locator = locator
        refresh()
    }

    /// Re-discover engines. Call after a plugin is installed or removed.
    public func refresh() {
        GraphEngines.invalidate()
        var found: [GraphEngine] = []

        // Plugin-provided engines first — an installed engine is a deliberate
        // user choice and should win over whatever shipped in the binary.
        found.append(contentsOf: locator.installedEngines())

        #if GRAPHKIT_BUILTIN
        found.append(BuiltinGraphEngine())
        #endif

        discovered = found
        active = found.first
    }

    /// The active engine, or a descriptive error the UI can render.
    public func require() throws -> GraphEngine {
        guard let active else { throw GraphEngineUnavailable.notInstalled }
        return active
    }
}
