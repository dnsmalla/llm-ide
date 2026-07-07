// Graph storage layer: typed file I/O for the `.llm-ide/graph/` directory.
//
// Swift mirror of `extension/graphkit/storage/graph-storage.ts` (Task 4).
//
// - All writes are atomic: write to a unique temp file in the same directory,
//   then swap into place via FileManager. The swap uses `moveItem` for a new
//   file and `replaceItem` for an existing file (moveItem refuses to overwrite).
//   Both are same-filesystem renames, giving the same atomic-overwrite guarantee
//   as the TS layer's `fs.rename`.
// - All failures surface as `GraphStorageError` with a specific `code` so
//   callers (migration, service layer) can branch on cause.
// - A missing `graph.json` is NOT an error: `readGraphFile` returns an empty
//   graph and `readDocFingerprint` returns nil, mirroring the TS layer's
//   graceful degradation for fresh repos.

import Foundation
import GraphKit

/// Typed error for graph storage operations.
///
/// `code` mirrors the TS `GraphStorageError.code` field
/// (`'NOT_FOUND' | 'PERMISSION_DENIED' | 'CORRUPTED'`) so Swift and TS callers
/// share one error vocabulary. `readGraphFile` never raises `.notFound` (a
/// missing graph.json returns an empty graph); the case is provided for
/// contract completeness and consumers that wrap this layer.
public enum GraphStorageError: Error, LocalizedError, Equatable, Sendable {
    case notFound(path: String)
    case permissionDenied(path: String)
    case corrupted(path: String, underlyingDescription: String)

    /// Stable string code matching the TS `GraphStorageError.code` field.
    public var code: String {
        switch self {
        case .notFound: return "NOT_FOUND"
        case .permissionDenied: return "PERMISSION_DENIED"
        case .corrupted: return "CORRUPTED"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .notFound(let path):
            return "Graph file not found: \(path)"
        case .permissionDenied(let path):
            return "Permission denied accessing: \(path)"
        case .corrupted(let path, let underlyingDescription):
            return "Graph file corrupted: \(path) - \(underlyingDescription)"
        }
    }
}

/// File-backed graph storage for a repo's `.llm-ide/graph/` directory.
///
/// Stateless: every operation takes the repo root explicitly, so a single
/// shared instance is safe to use from any actor (hence `Sendable`). Methods
/// are `async` to match the TS contract even though the current bodies are
/// synchronous file I/O; this leaves room for genuinely async I/O later
/// without breaking callers.
public final class GraphStorage: Sendable {

    public init() {}

    /// The canonical graph directory for a repo: `<repoRoot>/.llm-ide/graph`.
    public func getGraphDir(repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent(".llm-ide").appendingPathComponent("graph")
    }

    /// Read `graph.json`. Returns an empty graph when the file is absent so
    /// callers can treat a fresh repo uniformly without a separate existence
    /// check (mirrors TS `readGraphFile`).
    ///
    /// Decoding is lenient about `layers`/`tour`: Swift's `CGData` carries
    /// those fields but the TS `GraphData` schema only writes `nodes`/`edges`.
    /// A graph.json produced by the TS layer therefore omits them, and a plain
    /// `JSONDecoder().decode(CGData.self, ...)` would throw `keyNotFound` on
    /// such files. We decode through a tolerant intermediate so both the
    /// Swift (four-field) and TS (two-field) on-disk forms parse. Genuinely
    /// invalid JSON still throws and is mapped to `.corrupted`.
    public func readGraphFile(repoRoot: URL) async throws -> CGData {
        let graphDir = getGraphDir(repoRoot: repoRoot)
        let fileURL = graphDir.appendingPathComponent("graph.json")

        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch let err as CocoaError {
            switch err.code {
            case .fileReadNoSuchFile, .fileNoSuchFile:
                return CGData.empty // Empty graph if not found (graceful).
            case .fileReadNoPermission, .fileWriteNoPermission:
                throw GraphStorageError.permissionDenied(path: fileURL.path)
            default:
                throw GraphStorageError.corrupted(
                    path: fileURL.path, underlyingDescription: err.localizedDescription)
            }
        } catch {
            throw GraphStorageError.corrupted(
                path: fileURL.path, underlyingDescription: error.localizedDescription)
        }

        do {
            return try Self.decodeGraph(data)
        } catch {
            throw GraphStorageError.corrupted(
                path: fileURL.path, underlyingDescription: error.localizedDescription)
        }
    }

    /// Write `graph.json` atomically (temp file + rename in the same directory).
    public func writeGraphFile(repoRoot: URL, graph: CGData) async throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(graph)
        try await writeAtomically(
            repoRoot: repoRoot, filename: "graph.json", data: data)
    }

    /// Read `doc-fingerprint.txt` for change detection. Returns nil when the
    /// file is absent so callers can compare against the current fingerprint to
    /// decide whether a re-index is needed (mirrors TS `readDocFingerprint`).
    public func readDocFingerprint(repoRoot: URL) async throws -> String? {
        let graphDir = getGraphDir(repoRoot: repoRoot)
        let fileURL = graphDir.appendingPathComponent("doc-fingerprint.txt")

        do {
            return try String(contentsOf: fileURL, encoding: .utf8)
        } catch let err as CocoaError {
            switch err.code {
            case .fileReadNoSuchFile, .fileNoSuchFile:
                return nil
            case .fileReadNoPermission, .fileWriteNoPermission:
                throw GraphStorageError.permissionDenied(path: fileURL.path)
            default:
                throw GraphStorageError.corrupted(
                    path: fileURL.path, underlyingDescription: err.localizedDescription)
            }
        } catch {
            throw GraphStorageError.corrupted(
                path: fileURL.path, underlyingDescription: error.localizedDescription)
        }
    }

    /// Write `doc-fingerprint.txt` atomically (temp file + rename), matching
    /// `writeGraphFile`'s durability guarantee: a crash mid-write can never
    /// leave a truncated fingerprint on disk.
    public func writeDocFingerprint(repoRoot: URL, fingerprint: String) async throws {
        let data = Data(fingerprint.utf8)
        try await writeAtomically(
            repoRoot: repoRoot, filename: "doc-fingerprint.txt", data: data)
    }

    // MARK: - Internal

    /// Atomic write shared by `writeGraphFile` and `writeDocFingerprint`:
    /// create the graph dir, stage bytes in a unique temp file in the SAME
    /// directory (same filesystem => atomic rename), then swap into place via
    /// `replaceItem` (existing file) or `moveItem` (new file). On any failure
    /// the temp file is removed and the error surfaces as `GraphStorageError`.
    private func writeAtomically(
        repoRoot: URL, filename: String, data: Data
    ) async throws {
        let graphDir = getGraphDir(repoRoot: repoRoot)
        try FileManager.default.createDirectory(at: graphDir, withIntermediateDirectories: true)

        let fileURL = graphDir.appendingPathComponent(filename)
        // Unique temp name in the SAME directory (same filesystem => atomic rename).
        let tempURL = graphDir.appendingPathComponent(".\(filename).tmp.\(UUID().uuidString)")

        do {
            // Plain write to temp; the swap below is the atomicity guarantee
            // (mirrors TS `fs.writeFile(tempPath)` + `fs.rename(tempPath, final)`).
            try data.write(to: tempURL)

            // `moveItem` refuses to overwrite an existing file; use `replaceItem`
            // when one exists so re-writes are atomic too (matches `fs.rename`).
            if FileManager.default.fileExists(atPath: fileURL.path) {
                // `resultingItemURL` is required by this SDK's signature; pass nil
                // (we don't need the backup/replaced URL back).
                _ = try FileManager.default.replaceItem(
                    at: fileURL, withItemAt: tempURL, backupItemName: nil,
                    options: [], resultingItemURL: nil)
            } else {
                try FileManager.default.moveItem(at: tempURL, to: fileURL)
            }
        } catch let err as CocoaError {
            try? FileManager.default.removeItem(at: tempURL)
            switch err.code {
            case .fileWriteNoPermission, .fileReadNoPermission:
                throw GraphStorageError.permissionDenied(path: fileURL.path)
            default:
                throw GraphStorageError.corrupted(
                    path: fileURL.path, underlyingDescription: err.localizedDescription)
            }
        } catch {
            try? FileManager.default.removeItem(at: tempURL)
            throw GraphStorageError.corrupted(
                path: fileURL.path, underlyingDescription: error.localizedDescription)
        }
    }

    /// Decode `CGData` tolerating the TS layer's smaller schema:
    ///   - `GraphData` carries only `nodes`/`edges` (no `layers`/`tour`), and
    ///   - `GraphEdge` carries only `fromId`/`toId`/`kind` (no `confidence`).
    /// Swift's `CGData`/`CGEdge` add those as non-optional fields, so a plain
    /// `decode(CGData.self, ...)` throws `keyNotFound` on TS-written files.
    /// We try the fast path first (Swift's own four-field output) and fall back
    /// to a tolerant intermediate that defaults the missing fields. Genuinely
    /// invalid JSON still throws. See `readGraphFile` for context.
    private static func decodeGraph(_ data: Data) throws -> CGData {
        if let graph = try? JSONDecoder().decode(CGData.self, from: data) {
            return graph
        }
        struct LenientEdge: Decodable {
            let fromId: String
            let toId: String
            let kind: CGEdgeKind
            let confidence: CGEdgeConfidence?
        }
        struct LenientGraph: Decodable {
            let nodes: [CGNode]
            let edges: [LenientEdge]
            let layers: [UALayer]?
            let tour: [UATourStep]?
        }
        let lenient = try JSONDecoder().decode(LenientGraph.self, from: data)
        let edges = lenient.edges.map {
            CGEdge(fromId: $0.fromId, toId: $0.toId, kind: $0.kind,
                   confidence: $0.confidence ?? .extracted)
        }
        return CGData(
            nodes: lenient.nodes,
            edges: edges,
            layers: lenient.layers ?? [],
            tour: lenient.tour ?? []
        )
    }
}
