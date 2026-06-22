import Foundation
import GraphKit

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
    }

    @Published private var entries: [String: Entry] = [:]

    private func key(repo: URL?, mode: String) -> String {
        "\(repo?.standardizedFileURL.path ?? "∅")#\(mode)"
    }

    func entry(repo: URL?, mode: String) -> Entry? {
        entries[key(repo: repo, mode: mode)]
    }

    func store(repo: URL?, mode: String, graph: CGData,
               chunks: [MemoryChunk]? = nil, docCount: Int? = nil) {
        let k = key(repo: repo, mode: mode)
        if var existing = entries[k] {
            existing.graph = graph
            if let chunks { existing.chunks = chunks }
            if let docCount { existing.docCount = docCount }
            entries[k] = existing
        } else {
            entries[k] = Entry(graph: graph, chunks: chunks ?? [], docCount: docCount ?? 0)
        }
    }
}
