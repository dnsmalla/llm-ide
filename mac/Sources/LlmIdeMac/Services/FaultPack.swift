// Portable fault knowledge. Carries only the reusable signal — prompt,
// response, notes, severity, tags + provenance. Host-specific fields
// (verify command, status, git_head, app_version) are intentionally
// dropped: each importing project regenerates its own verify command
// when it works the fault.

import Foundation

struct FaultPackEntry: Codable, Equatable {
    let prompt: String
    let response: String
    let notes: String
    let severity: String
    let tags: [String]
    let reportedAt: Date
}

struct FaultPack: Codable, Equatable {
    let schemaVersion: Int
    let sourceProject: String
    let exportedAt: Date
    let entries: [FaultPackEntry]
}

struct ImportSummary: Equatable {
    var imported: Int = 0
    var skipped: Int = 0
}

final class FaultPackService {
    private let store: MemoryStore
    init(store: MemoryStore) { self.store = store }

    func export(faults: [FaultReport], sourceProject: String, exportedAt: Date) throws -> Data {
        let entries = faults.map {
            FaultPackEntry(prompt: $0.prompt, response: $0.response, notes: $0.notes,
                           severity: $0.severity.rawValue, tags: $0.tags, reportedAt: $0.reportedAt)
        }
        let pack = FaultPack(schemaVersion: 1, sourceProject: sourceProject,
                             exportedAt: exportedAt, entries: entries)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        enc.dateEncodingStrategy = .iso8601
        return try enc.encode(pack)
    }

    func importPack(data: Data, into repo: URL) throws -> ImportSummary {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        let pack = try dec.decode(FaultPack.self, from: data)
        let existing = Set(store.listFaults(at: repo).compactMap {
            try? store.loadFault(at: $0).prompt
        }.map(Self.normalise))
        var summary = ImportSummary()
        for entry in pack.entries {
            if existing.contains(Self.normalise(entry.prompt)) { summary.skipped += 1; continue }
            var tags = entry.tags
            tags.append("imported:\(pack.sourceProject)")
            let fault = FaultReport(
                prompt: entry.prompt, response: entry.response, notes: entry.notes,
                severity: FaultSeverity(rawValue: entry.severity) ?? .minor,
                reportedAt: entry.reportedAt, gitHead: nil, appVersion: "",
                agent: "imported", status: .open, tags: tags,
                verify: nil, verifyKind: nil)
            _ = try store.writeFault(at: repo, fault)
            summary.imported += 1
        }
        return summary
    }

    private static func normalise(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}
