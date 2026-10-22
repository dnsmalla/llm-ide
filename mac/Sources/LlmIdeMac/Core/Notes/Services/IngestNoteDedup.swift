import Foundation
import Yams

/// Collects dedup keys for ingest notes from `index.json` and from on-disk
/// frontmatter (fallback when the index is empty or was rebuilt without keys).
enum IngestNoteDedup {

    private struct Keys: Decodable {
        var sourceHash: String?
        var rawFile: String?
    }

    static func sourceHashes(repoRoot: URL, type: NoteType) async -> Set<String> {
        let service = NoteService(repoRoot: repoRoot)
        var hashes = Set((try? await service.queryNotes(NoteFilter(type: type)))?.compactMap(\.sourceHash) ?? [])
        hashes.formUnion(scanFrontmatter(repoRoot: repoRoot, type: type).sourceHashes)
        hashes.remove("")
        return hashes
    }

    static func rawFiles(repoRoot: URL, type: NoteType = .meeting) async -> Set<String> {
        let service = NoteService(repoRoot: repoRoot)
        var rawFiles = Set((try? await service.queryNotes(NoteFilter(type: type)))?.compactMap(\.rawFile) ?? [])
        rawFiles.formUnion(scanFrontmatter(repoRoot: repoRoot, type: type).rawFiles)
        rawFiles.remove("")
        return rawFiles
    }

    // MARK: - Private

    private struct ScanResult {
        var sourceHashes: Set<String> = []
        var rawFiles: Set<String> = []
    }

    private static func scanFrontmatter(repoRoot: URL, type: NoteType) -> ScanResult {
        let root = NoteService(repoRoot: repoRoot).getDirForType(type)
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
            return ScanResult()
        }

        var result = ScanResult()
        let decoder = YAMLDecoder()

        while let file = enumerator.nextObject() as? URL {
            guard file.pathExtension.lowercased() == "md" else { continue }
            guard let text = try? String(contentsOf: file, encoding: .utf8),
                  let split = FrontmatterCoder.split(file: text),
                  let keys = try? decoder.decode(Keys.self, from: split.yaml) else { continue }
            if let hash = keys.sourceHash, !hash.isEmpty { result.sourceHashes.insert(hash) }
            if let raw = keys.rawFile, !raw.isEmpty { result.rawFiles.insert(raw) }
        }
        return result
    }
}
