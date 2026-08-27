import Foundation
import CryptoKit

public enum Fingerprint {
    /// SHA-256 hex digest of file content.
    public static func hash(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public struct Classification: Equatable {
        public let unchanged: [String]
        public let changed: [String]   // changed + new
        public let deleted: [String]
    }

    /// Compare previous vs current path->hash maps.
    public static func classify(previous: [String: String],
                                current: [String: String]) -> Classification {
        var unchanged: [String] = []
        var changed: [String] = []
        for (path, hash) in current {
            if previous[path] == hash { unchanged.append(path) }
            else { changed.append(path) }
        }
        let deleted = previous.keys.filter { current[$0] == nil }
        return Classification(unchanged: unchanged.sorted(),
                              changed: changed.sorted(),
                              deleted: deleted.sorted())
    }
}

/// Persisted path->hash map at `<repo>/.code-notes/fingerprints.json`.
public struct FingerprintStore: Codable, Equatable, Sendable {
    public var hashes: [String: String]
    public init(hashes: [String: String] = [:]) { self.hashes = hashes }

    public func encoded() throws -> Data { try AppJSON.encoder.encode(self) }
    public static func decode(_ data: Data) throws -> FingerprintStore {
        try AppJSON.decoder.decode(FingerprintStore.self, from: data)
    }

    public static func load(from url: URL) -> FingerprintStore {
        guard let data = try? Data(contentsOf: url),
              let store = try? decode(data) else { return FingerprintStore() }
        return store
    }
    public func save(to url: URL) throws {
        try encoded().write(to: url, options: .atomic)
    }
}
