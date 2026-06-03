import Foundation

/// Incremental scan cache. Persists each file's content hash + extracted
/// structure at `<repo>/.code-notes/scan-cache.json`. On a re-scan the
/// scanner reuses cached structures for files whose hash is unchanged,
/// re-parsing only changed/new files — so the cost scales with the diff,
/// not the whole repo.
public struct ScanCache: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let hash: String
        public let structure: RawFileStructure
        public init(hash: String, structure: RawFileStructure) {
            self.hash = hash; self.structure = structure
        }
    }

    public var version: String
    /// relative path -> cached entry
    public var entries: [String: Entry]

    public init(version: String = "1", entries: [String: Entry] = [:]) {
        self.version = version
        self.entries = entries
    }

    // MARK: - Persistence

    public static func url(forRepo repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent(".code-notes/scan-cache.json")
    }

    public static func load(forRepo repoRoot: URL) -> ScanCache {
        let url = Self.url(forRepo: repoRoot)
        guard let data = try? Data(contentsOf: url),
              let cache = try? AppJSON.decoder.decode(ScanCache.self, from: data),
              cache.version == "1"
        else { return ScanCache() }
        return cache
    }

    public func save(forRepo repoRoot: URL) {
        let url = Self.url(forRepo: repoRoot)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? AppJSON.encoder.encode(self) {
            try? data.write(to: url, options: .atomic)
        }
    }
}
