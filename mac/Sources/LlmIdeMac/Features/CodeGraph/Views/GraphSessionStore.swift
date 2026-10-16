import Foundation
import GraphCore

/// Process-lifetime cache for the Code Graph view's generated graphs.
///
/// `UAGraphView` is rebuilt from scratch every time the user navigates away
/// and back (AppShell switches `case .codeGraph: UAGraphView()`), which wipes
/// all of its `@State` — so a freshly generated graph vanished and had to be
/// regenerated each visit. This store lives at the app level (injected as an
/// `@EnvironmentObject`), so the generated graphs outlive the view and the
/// view can rehydrate from it on appear.
///
/// Entries are keyed by `repoPath#mode` so switching projects never shows a
/// stale graph from a different repo, and each mode (Code / InfiniteBrain /
/// All) keeps its own result. In-memory only — cross-launch persistence is the
/// auto-updater's job (it writes `system/graph/` + the memory artifact to disk).
@MainActor
final class GraphSessionStore: ObservableObject {
    struct Entry {
        var graph: CGData
        var chunks: [MemoryChunk]
        var docCount: Int
        /// Whether `graph` has display positions. The view's own generate paths
        /// store post-layout graphs (`laidOut == true`); the background
        /// `GraphAutoUpdater` stores RAW graphs from `KnowledgeGraphService`
        /// (all node positions at `.zero`, `laidOut == false`) so the view can
        /// lay them out with its own pipeline on hydrate. Without the flag the
        /// view would render an auto-stored graph as a pile of nodes at the
        /// origin.
        var laidOut: Bool
        /// Doc-set fingerprint (`KnowledgeGraphService.docSetFingerprint`) of the
        /// docs this graph was built from. Lets a manual InfiniteBrain re-generate
        /// be skipped when the doc set is unchanged. nil = unknown → always
        /// regenerate.
        var docFingerprint: String?
        /// Position-independent structure hash of `graph` (see
        /// `structuralSignature`). Lets an unchanged background re-store be
        /// dropped instead of resetting `laidOut` and forcing a full relayout.
        var signature: Int
    }

    @Published private var entries: [String: Entry] = [:]

    /// Repos (standardized paths) most-recently stored first. Not `@Published`:
    /// bookkeeping only, and changing it must not re-render the view.
    private var recentRepos: [String] = []

    /// How many repos keep cached graphs. Each repo holds up to three full
    /// graphs (code / data / all) plus doc chunks, and nothing else ever
    /// evicted them, so switching through projects grew memory without bound.
    /// The active repo is always the most recent store, so it is never evicted.
    static let maxCachedRepos = 4

    private func key(repo: URL?, mode: String) -> String {
        "\(repo?.standardizedFileURL.path ?? "∅")#\(mode)"
    }

    func entry(repo: URL?, mode: String) -> Entry? {
        entries[key(repo: repo, mode: mode)]
    }

    func store(repo: URL?, mode: String, graph: CGData,
               chunks: [MemoryChunk]? = nil, docCount: Int? = nil, laidOut: Bool = true,
               docFingerprint: String? = nil) {
        let k = key(repo: repo, mode: mode)
        touch(repo: repo)
        let signature = Self.structuralSignature(graph)
        if var existing = entries[k] {
            // `GraphAutoUpdater` re-stores a RAW graph on every tick. When its
            // structure is what we already hold, replacing it would throw away
            // the view's layout (laidOut=false → full relayout) and fire
            // objectWillChange for nothing. Keep the entry; only refresh the
            // doc-side fields, and only if they actually differ, because any
            // write to `entries` publishes.
            if !laidOut, existing.signature == signature {
                var changed = false
                if let chunks, chunks != existing.chunks { existing.chunks = chunks; changed = true }
                if let docCount, docCount != existing.docCount { existing.docCount = docCount; changed = true }
                if let docFingerprint, docFingerprint != existing.docFingerprint {
                    existing.docFingerprint = docFingerprint; changed = true
                }
                if changed { entries[k] = existing }
                return
            }
            // Refuse to replace a real graph with an empty one.
            //
            // `GraphAutoUpdater.publishToSession` runs after every tick
            // regardless of outcome, so a run that bailed early — scan-lock
            // contention with a manual generate is the common case, since both
            // are on timers — published `.empty` for all three modes and
            // destroyed the graph the user had just generated. The view's
            // `!entry.graph.nodes.isEmpty` guards then reported "No code graph
            // yet" for a graph that existed seconds earlier.
            //
            // Guarded here rather than only at the caller because this is the
            // last point where the good value still exists.
            guard !graph.nodes.isEmpty || existing.graph.nodes.isEmpty else { return }
            existing.graph = graph
            if let chunks { existing.chunks = chunks }
            if let docCount { existing.docCount = docCount }
            // Preserve an existing fingerprint when this re-store doesn't carry
            // one (settlePhysics re-caches the settled layout; hydrate re-caches
            // after laying out a raw auto-stored graph) — else the reuse
            // fast-path would never find a fingerprint to match.
            if let docFingerprint { existing.docFingerprint = docFingerprint }
            existing.laidOut = laidOut
            existing.signature = signature
            entries[k] = existing
        } else {
            entries[k] = Entry(graph: graph, chunks: chunks ?? [], docCount: docCount ?? 0,
                               laidOut: laidOut, docFingerprint: docFingerprint,
                               signature: signature)
        }
    }

    /// Mark `repo` most-recent and drop the cached graphs of repos beyond
    /// `maxCachedRepos`.
    private func touch(repo: URL?) {
        let repoKey = repo?.standardizedFileURL.path ?? "∅"
        let (order, evicted) = Self.touchRecent(repoKey, in: recentRepos, limit: Self.maxCachedRepos)
        recentRepos = order
        guard !evicted.isEmpty else { return }
        let prefixes = evicted.map { "\($0)#" }
        entries = entries.filter { key, _ in !prefixes.contains { key.hasPrefix($0) } }
    }

    /// Pure LRU step: move `item` to the front, return the order trimmed to
    /// `limit` and the items that fell off.
    nonisolated static func touchRecent(_ item: String, in order: [String],
                                        limit: Int) -> (order: [String], evicted: [String]) {
        var updated = order.filter { $0 != item }
        updated.insert(item, at: 0)
        let bound = max(limit, 1)
        guard updated.count > bound else { return (updated, []) }
        return (Array(updated.prefix(bound)), Array(updated.dropFirst(bound)))
    }

    /// Hash of the graph's structure — nodes (id, title, kind, metadata),
    /// edges and layers/tour — ignoring node POSITIONS, so a raw graph and the
    /// laid-out copy of the same graph compare equal. Order-sensitive like the
    /// generator's output, which is deterministic for unchanged input; a
    /// spurious mismatch only costs one relayout, never a stale graph.
    /// Process-local (`Hasher` is seeded per launch), which matches this
    /// in-memory store.
    nonisolated static func structuralSignature(_ graph: CGData) -> Int {
        var hasher = Hasher()
        hasher.combine(graph.nodes.count)
        for node in graph.nodes {
            hasher.combine(node.id)
            hasher.combine(node.title)
            hasher.combine(node.kind)
            hasher.combine(node.metadata)
        }
        hasher.combine(graph.edges.count)
        for edge in graph.edges {
            hasher.combine(edge.fromId)
            hasher.combine(edge.toId)
            hasher.combine(edge.kind)
            hasher.combine(edge.confidence)
        }
        for layer in graph.layers {
            hasher.combine(layer.id)
            hasher.combine(layer.name)
            hasher.combine(layer.nodeIds)
        }
        for step in graph.tour {
            hasher.combine(step.nodeId)
            hasher.combine(step.title)
        }
        return hasher.finalize()
    }
}
