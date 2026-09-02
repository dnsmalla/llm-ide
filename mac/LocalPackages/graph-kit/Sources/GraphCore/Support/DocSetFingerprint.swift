import Foundation
import CryptoKit

/// Stat-only signature of a document set, so an unchanged re-generate can be
/// skipped for near-free.
///
/// Shared by every engine because the rule is the same everywhere: the walk
/// MUST mirror what the generator actually ingests — same extension set, same
/// size cap, same file cap, same `ExcludedDirs` pruning. The two engines each
/// carried their own copy of this walk, which is exactly how the rules drift:
/// history shows what happens then. When the fingerprint once covered files the
/// generator never reads, the cache broke in both directions — every regen
/// rewrote generated notes (all doc-extension files) so the fingerprint changed
/// on EVERY run and never hit, while `node_modules` READMEs filled the file cap
/// before the walk reached a real doc, so an actual edit left the fingerprint
/// unchanged and the graph went stale.
public enum DocSetFingerprint {

    /// Compute the signature for `roots`, honouring the engine's own document
    /// extension set. Caps default to `MemoryGenerator`'s ingestion window.
    public static func compute(roots: [URL],
                               extensions: Set<String> = DocExtensions.markdownAndText,
                               maxFiles: Int = 500,
                               maxFileBytes: Int = 2_000_000) -> String {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey,
                                      .isRegularFileKey]
        var entries: [String] = []
        outer: for root in roots {
            // `skipsPackageDescendants` matters: a doc inside a `.bundle` would
            // otherwise flip the fingerprint without ever changing output.
            guard let walker = fm.enumerator(
                at: root, includingPropertiesForKeys: keys,
                options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in walker {
                if let name = url.pathComponents.last, ExcludedDirs.names.contains(name) {
                    walker.skipDescendants(); continue
                }
                guard extensions.contains(url.pathExtension.lowercased()) else { continue }
                let values = try? url.resourceValues(forKeys: Set(keys))
                guard values?.isRegularFile == true else { continue }
                let size = values?.fileSize ?? 0
                guard size <= maxFileBytes else { continue }
                let modified = values?.contentModificationDate?.timeIntervalSince1970 ?? 0
                entries.append("\(url.path)|\(size)|\(modified)")
                if entries.count >= maxFiles { break outer }
            }
        }
        entries.sort()
        return Fingerprint.hash(of: Data(entries.joined(separator: "\n").utf8))
    }
}
