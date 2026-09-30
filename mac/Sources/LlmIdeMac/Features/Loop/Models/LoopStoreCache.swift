import Foundation

/// One ensured `LoopEngineProjectStore` per project, shared by every surface
/// that resolves loops through `LoopEngineConfigStore.loops` (Loop page,
/// scheduled sweep, phone, chat).
///
/// An entry is valid only while `system/loop.json` is unchanged (mtime + size +
/// inode, so a `git pull` or another process's write is noticed), the
/// detection-relevant files in the git root are unchanged, and it is younger
/// than `maxAge`. Every write through `LoopEngineConfigStore.save` drops the
/// project's entries, so the cache is never stale after our own edits.
final class LoopStoreCache: @unchecked Sendable {
    static let shared = LoopStoreCache()

    struct Key: Hashable {
        let projectRoot: String
        let projectId: String
        let gitRoot: String?
        let defaults: ObjectIdentifier
    }

    private struct Entry {
        let store: LoopEngineProjectStore
        let signature: [String]
        let at: Date
    }

    /// Files whose content feeds `LoopStageDetector`'s answers.
    /// Inputs that come from UserDefaults (the schedule opt-in hint, loop
    /// defaults) and the many test files System Check probes are NOT watched:
    /// they rely on the `maxAge` expiry.
    static let markers = ["Package.swift", "Makefile", "package.json", "pyproject.toml",
                          "pytest.ini", "setup.cfg", "Cargo.toml", "go.mod", "mac/Package.swift",
                          "extension/package.json", "extension/tests"]
    var maxAge: TimeInterval = 30

    private let lock = NSLock()
    private var entries: [Key: Entry] = [:]
    private var generations: [String: Int] = [:]

    /// Snapshot to take BEFORE a load; hand it back to `store` so a write that
    /// lands mid-load is never cached under a newer signature.
    struct Ticket { let generation: Int; let signature: [String] }

    func ticket(projectRoot: String, file: URL, gitRoot: URL?) -> Ticket {
        lock.lock(); defer { lock.unlock() }
        return Ticket(generation: generations[projectRoot, default: 0],
                      signature: Self.signature(file: file, gitRoot: gitRoot))
    }

    func value(for key: Key, file: URL, gitRoot: URL?) -> LoopEngineProjectStore? {
        lock.lock(); defer { lock.unlock() }
        guard let e = entries[key] else { return nil }
        guard Date().timeIntervalSince(e.at) < maxAge,
              e.signature == Self.signature(file: file, gitRoot: gitRoot) else {
            entries[key] = nil
            return nil
        }
        return e.store
    }

    /// Caches `store` only when nothing invalidated the project since `ticket`
    /// (a load that wrote the file itself just misses once on the next read,
    /// then caches the stable result).
    func store(_ store: LoopEngineProjectStore, for key: Key, ticket: Ticket, file: URL, gitRoot: URL?) {
        lock.lock(); defer { lock.unlock() }
        guard generations[key.projectRoot, default: 0] == ticket.generation else { return }
        entries[key] = Entry(store: store, signature: ticket.signature, at: Date())
    }

    func invalidate(projectRoot: String) {
        lock.lock(); defer { lock.unlock() }
        generations[projectRoot, default: 0] += 1
        entries = entries.filter { $0.key.projectRoot != projectRoot }
    }

    func invalidateAll() {
        lock.lock(); defer { lock.unlock() }
        for k in generations.keys { generations[k]! += 1 }
        entries.removeAll()
    }

    private static func stamp(_ url: URL) -> String {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path) else { return "-" }
        let m = (a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let s = (a[.size] as? NSNumber)?.intValue ?? 0
        let i = (a[.systemFileNumber] as? NSNumber)?.intValue ?? 0
        return "\(m)/\(s)/\(i)"
    }

    private static func signature(file: URL, gitRoot: URL?) -> [String] {
        var sig = [stamp(file)]
        if let gitRoot { sig += markers.map { stamp(gitRoot.appendingPathComponent($0)) } }
        return sig
    }
}
