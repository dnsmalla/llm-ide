// Disk-cache for the most recent understand-anything run per target folder.
// Stable directory hash keyed by absolute path; re-run overwrites.

import Foundation
import CryptoKit

public struct RunMetadata: Codable, Equatable, Sendable {
    public let timestamp: Date
    public let nodeCount: Int
    public let edgeCount: Int
    public let toolVersion: String
}

public final class UAStore {
    private let baseDirectory: URL
    private let fm = FileManager.default

    public init(baseDirectory: URL? = nil) {
        if let b = baseDirectory {
            self.baseDirectory = b
        } else {
            let appSupport = (try? FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true))
                ?? URL(fileURLWithPath: NSTemporaryDirectory())
            self.baseDirectory = appSupport
                .appendingPathComponent("MeetNotesMac", isDirectory: true)
                .appendingPathComponent("CodeGraph", isDirectory: true)
        }
    }

    public static func directoryName(for target: URL) -> String {
        let path = target.standardizedFileURL.path
        let digest = SHA256.hash(data: Data(path.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func dir(for target: URL) throws -> URL {
        let d = baseDirectory.appendingPathComponent(Self.directoryName(for: target), isDirectory: true)
        try fm.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    public func save(graphJSON: Data, for target: URL, nodeCount: Int, edgeCount: Int, toolVersion: String) throws {
        let d = try dir(for: target)
        try graphJSON.write(to: d.appendingPathComponent("knowledge-graph.json"), options: .atomic)
        let meta = RunMetadata(timestamp: Date(), nodeCount: nodeCount, edgeCount: edgeCount, toolVersion: toolVersion)
        let metaData = try AppJSON.encoder.encode(meta)
        try metaData.write(to: d.appendingPathComponent("meta.json"), options: .atomic)
    }

    public func loadGraphJSON(for target: URL) -> Data? {
        let url = baseDirectory
            .appendingPathComponent(Self.directoryName(for: target), isDirectory: true)
            .appendingPathComponent("knowledge-graph.json")
        return try? Data(contentsOf: url)
    }

    /// Wipe the cached graph + meta for `target`. Called when a repo is
    /// moved or re-cloned at a different path so the next open of
    /// Understand-Anything doesn't hydrate the stale graph (which bakes in
    /// absolute fileURLs from the old location and makes the detail panel
    /// show paths that no longer exist).
    public func invalidate(for target: URL) {
        let cacheDir = baseDirectory
            .appendingPathComponent(Self.directoryName(for: target), isDirectory: true)
        try? fm.removeItem(at: cacheDir)
    }

    public func lastRun(for target: URL) -> RunMetadata? {
        let url = baseDirectory
            .appendingPathComponent(Self.directoryName(for: target), isDirectory: true)
            .appendingPathComponent("meta.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? AppJSON.decoder.decode(RunMetadata.self, from: data)
    }
}
