import Foundation

/// `pending-deletes.json` (plan 3.5 step 3): the Mac's record of chats the user deleted
/// whose server cleanup has not been confirmed, plus the first time an orphaned server
/// working state was seen (the 7-day grace). It holds TOMBSTONES, not data: losing it
/// loses an intent, never a transcript. Written atomically; every call is serialised.
final class ChatArchivePendingStore: @unchecked Sendable {

    struct DeleteEntry: Codable, Equatable {
        var id: String
        var ownerUserId: String?
        var requestedAt: Date
        var attempts: Int
    }

    private struct File: Codable {
        var deletes: [DeleteEntry] = []
        /// Server chat id -> first time seen as an orphan (seconds since 1970).
        var orphans: [String: Double] = [:]
    }

    private let lock = NSLock()
    private let directory: @Sendable () -> URL?
    private var cached: File?
    private var cachedPath: String?

    /// `directory` is read on every call (a test or an account switch can move it).
    init(directory: @escaping @Sendable () -> URL?) { self.directory = directory }

    private var url: URL? { directory()?.appendingPathComponent("pending-deletes.json") }

    private func load() -> File {
        guard let url else { return File() }
        if let c = cached, cachedPath == url.path { return c }
        let f = (try? Data(contentsOf: url)).flatMap { try? AppJSON.decoder.decode(File.self, from: $0) } ?? File()
        cached = f; cachedPath = url.path
        return f
    }

    private func store(_ f: File) {
        guard let url else { return }
        cached = f; cachedPath = url.path
        if let data = try? AppJSON.encoder.encode(f) { try? data.write(to: url, options: .atomic) }
    }

    /// Record the user's intent to delete `id`. Idempotent (a second delete keeps the first entry).
    func addDelete(id: UUID, owner: String?, now: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        var f = load()
        guard !f.deletes.contains(where: { $0.id == id.uuidString }) else { return }
        f.deletes.append(DeleteEntry(id: id.uuidString, ownerUserId: owner, requestedAt: now, attempts: 0))
        store(f)
    }

    func containsDelete(_ id: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return load().deletes.contains { $0.id == id.uuidString }
    }

    /// The tombstones `owner` still owes (entries recorded with no owner are owed by anyone).
    func deletes(for owner: String?) -> [DeleteEntry] {
        lock.lock(); defer { lock.unlock() }
        return load().deletes.filter { $0.ownerUserId == nil || $0.ownerUserId == owner }
    }

    func removeDelete(_ id: UUID) { removeDelete(rawId: id.uuidString) }

    func removeDelete(rawId: String) {
        lock.lock(); defer { lock.unlock() }
        var f = load()
        let before = f.deletes.count
        f.deletes.removeAll { $0.id == rawId }
        if f.deletes.count != before { store(f) }
    }

    func bumpAttempt(_ id: UUID) {
        lock.lock(); defer { lock.unlock() }
        var f = load()
        guard let i = f.deletes.firstIndex(where: { $0.id == id.uuidString }) else { return }
        f.deletes[i].attempts += 1
        store(f)
    }

    /// First time `id` was seen as an orphan; records `now` when it is new.
    func orphanFirstSeen(_ id: String, now: Date) -> Date {
        lock.lock(); defer { lock.unlock() }
        var f = load()
        if let t = f.orphans[id] { return Date(timeIntervalSince1970: t) }
        f.orphans[id] = now.timeIntervalSince1970
        store(f)
        return now
    }

    /// Forget orphans the server no longer reports (or that were purged).
    func retainOrphans(_ ids: Set<String>) {
        lock.lock(); defer { lock.unlock() }
        var f = load()
        let kept = f.orphans.filter { ids.contains($0.key) }
        if kept.count != f.orphans.count { f.orphans = kept; store(f) }
    }
}
