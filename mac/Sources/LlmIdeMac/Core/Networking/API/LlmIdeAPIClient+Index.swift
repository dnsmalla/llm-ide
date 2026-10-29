import Foundation

// Derived note index routes (live-then-archive Phase 2, plan 3.8). Wire shapes:
// schema/http/index.schema.json. The index is rebuildable from the Mac note
// files and holds no unique data, so every call here is best-effort: callers
// (Core/Notes NoteIndexReconciler) treat any failure as "retry later".

extension LlmIdeAPIClient {

    /// One note in `POST /kb/index/notes`. `hidden: true` asks the server to
    /// remove a previously indexed row; its other fields are then ignored.
    struct IndexNoteInput: Encodable, Equatable {
        let noteKey: String
        let kind: String?
        let title: String
        let date: String
        let durationSec: Int?
        let participants: [String]?
        let body: String?
        let contentHash: String
        let mtimeMs: Int64?
        let hidden: Bool?
        let meta: [String: String]?
    }

    public struct IndexManifestEntry: Codable, Equatable {
        public let noteKey: String
        public let contentHash: String
    }

    struct IndexUpsertRequest: Encodable {
        let projectId: String
        let notes: [IndexNoteInput]
    }

    struct IndexReconcileRequest: Encodable {
        let projectId: String
        let manifest: [IndexManifestEntry]
        let keep: [String]
        let prune: Bool
        let allowEmpty: Bool
    }

    public struct IndexUpsertResult: Codable, Equatable {
        public let upserted: Int
        public let unchanged: Int
        public let skippedHidden: Int
        public let truncated: Int
        public let removed: Int
    }

    public struct IndexReconcileResult: Codable, Equatable {
        public let missing: [String]
        public let stale: [String]
        public let extra: [String]
        public let pruned: Int
    }

    public struct IndexDeleteResult: Codable, Equatable {
        public let deleted: Bool
    }

    public struct IndexStatusResult: Codable, Equatable {
        public let notes: Int
        public let ftsRows: Int
        public let consistent: Bool
        public let lastIndexedAt: String?
    }

    /// `POST /kb/index/notes`: upsert up to 50 notes (server bounds: 1 MB body).
    func indexUpsertNotes(projectId: String, notes: [IndexNoteInput]) async throws -> IndexUpsertResult {
        try await post("/kb/index/notes",
                       body: IndexUpsertRequest(projectId: projectId, notes: notes),
                       authenticated: true)
    }

    /// `POST /kb/index/reconcile`: compare a manifest with the index. `prune`
    /// deletes the indexed rows the manifest does not name; callers send
    /// `prune: true` only after a complete, successful scan.
    func indexReconcile(projectId: String, manifest: [IndexManifestEntry], keep: [String],
                        prune: Bool, allowEmpty: Bool) async throws -> IndexReconcileResult {
        try await post("/kb/index/reconcile",
                       body: IndexReconcileRequest(projectId: projectId, manifest: manifest, keep: keep,
                                                   prune: prune, allowEmpty: allowEmpty),
                       authenticated: true)
    }

    /// One chunk of a chunked scan (`POST /kb/index/scan`). Non-final chunks classify
    /// their keys; the final chunk (complete: true) may prune when prune is true.
    struct IndexScanRequest: Encodable {
        let projectId: String
        let scanId: String
        let index: Int
        let total: Int
        let complete: Bool
        let prune: Bool
        let entries: [IndexManifestEntry]
        /// Final chunk only: the entries the whole scan carries (the server compares the sum).
        let totalEntries: Int?
        /// Final chunk only: keys never pruned.
        let keep: [String]?
        /// Final chunk only: an all-empty scan prunes only when true.
        let allowEmpty: Bool?
    }

    public struct IndexScanResult: Codable, Equatable {
        public let missing: [String]
        public let stale: [String]
        public let extra: [String]
        public let pruned: Int
        public let received: Int
        public let total: Int
        public let complete: Bool
    }

    /// `POST /kb/index/scan`: one chunk of a library too large for one reconcile.
    func indexScan(projectId: String, scanId: String, index: Int, total: Int,
                   complete: Bool, prune: Bool, entries: [IndexManifestEntry],
                   totalEntries: Int?, keep: [String]?, allowEmpty: Bool?) async throws -> IndexScanResult {
        try await post("/kb/index/scan",
                       body: IndexScanRequest(projectId: projectId, scanId: scanId, index: index, total: total,
                                              complete: complete, prune: prune, entries: entries,
                                              totalEntries: totalEntries, keep: keep, allowEmpty: allowEmpty),
                       authenticated: true)
    }

    /// `DELETE /kb/index/notes/:key`.
    func indexDeleteNote(projectId: String, noteKey: String) async throws -> IndexDeleteResult {
        try await delete(
            "/kb/index/notes/\(percentEncoded(noteKey))?projectId=\(percentEncoded(projectId))",
            authenticated: true)
    }

    /// `GET /kb/index/status`. A nil projectId reports every project of the user.
    func indexStatus(projectId: String? = nil) async throws -> IndexStatusResult {
        let query = projectId.map { "?projectId=\(percentEncoded($0))" } ?? ""
        return try await get("/kb/index/status\(query)", authenticated: true)
    }
}
