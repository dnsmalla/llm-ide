import Foundation
import os.log

/// Multi-session chat persistence. Each chat is a UUID JSON file under
/// `~/Library/Application Support/llm-ide/sessions/<uuid>.json`, tagged with
/// a `ChatScope` for listing and migration. Legacy one-file-per-scope
/// (`sessions/<scope>.json`) is migrated once on first access. Corrupt files
/// are renamed `.corrupt-<unix-ts>` and skipped, mirroring the prior
/// ChatHistoryStore pattern.
enum ChatSessionStore {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "ChatSessionStore")

    /// Test hook: when set, `baseDir` uses this instead of Application
    /// Support. Production leaves it nil. Lets unit tests run against a
    /// throwaway temp dir.
    static var baseDirectoryOverride: URL?

    /// Live-then-archive ownership (plan Q5, C16). Nil (the default, and what
    /// `lta.mode = off` leaves it) is today's behaviour exactly: nothing is stamped,
    /// nothing is filtered, no sidecar is written. Shell sets it when the mode is not off.
    struct Ownership {
        /// Stamp new/unclaimed files with the signed-in user and keep the tags sidecar.
        var stamp: Bool
        /// Hide a file stamped with a DIFFERENT user from every list (`on` only).
        var filter: Bool
        var currentUserId: @Sendable () -> String?

        init(stamp: Bool, filter: Bool, currentUserId: @escaping @Sendable () -> String?) {
            self.stamp = stamp; self.filter = filter; self.currentUserId = currentUserId
        }
    }
    nonisolated(unsafe) static var ownership: Ownership?

    private static var baseDir: URL? {
        resolveBaseDir(override: baseDirectoryOverride,
                       underTests: isRunningUnderTests,
                       real: { AppIdentity.applicationSupportRoot() })
    }

    /// True inside an XCTest / swift-testing host process.
    static let isRunningUnderTests: Bool = {
        let env = ProcessInfo.processInfo.environment
        return env["XCTestConfigurationFilePath"] != nil
            || env["XCTestBundlePath"] != nil
            || NSClassFromString("XCTestCase") != nil
    }()

    /// Per-process scratch directory used when a test run reaches the store
    /// without having set `baseDirectoryOverride`. Tests that build a
    /// `ChatEngine` and run turns persist sessions as a side effect; before
    /// this they landed in the user's REAL Application Support `sessions/`
    /// (files titled "continue working"). Never the real directory under test.
    static let testFallbackDirectory: URL = FileManager.default.temporaryDirectory
        .appendingPathComponent("llmide-chat-sessions-tests-\(ProcessInfo.processInfo.processIdentifier)",
                                isDirectory: true)

    /// Pure resolution rule: an explicit override wins; otherwise a test run
    /// gets the scratch directory and only a real run gets Application Support.
    static func resolveBaseDir(override: URL?, underTests: Bool, real: () -> URL) -> URL {
        if let override { return override }
        return underTests ? testFallbackDirectory : real()
    }

    private static var sessionsDir: URL? {
        guard let base = baseDir else { return nil }
        let dir = base.appendingPathComponent("sessions", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    /// Explorer session JSON directory — watched for mobile push sync.
    static var explorerSessionsDirectory: URL? { sessionsDir }

    private static func fileURL(for id: UUID) -> URL? {
        sessionsDir?.appendingPathComponent("\(id.uuidString).json")
    }

    private static func legacyScopeFileURL(for scope: ChatScope) -> URL? {
        sessionsDir?.appendingPathComponent("\(scope.rawValue).json")
    }

    /// List sessions for `scope`, newest `lastUsedAt` first. Skips orphans
    /// (decoded files with nil scope) and non-matching scopes.
    static func list(for scope: ChatScope) -> [ChatSession] {
        guard let dir = sessionsDir,
              let contents = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil) else { return [] }
        var out: [ChatSession] = []
        for url in contents where url.pathExtension == "json" {
            // Skip legacy scope filenames — migration owns those.
            let name = url.deletingPathExtension().lastPathComponent
            if ChatScope(rawValue: name) != nil { continue }
            guard let data = try? Data(contentsOf: url) else { continue }
            do {
                var s = try AppJSON.decoder.decode(ChatSession.self, from: data)
                applyTags(&s)
                if s.scope == scope, isVisibleToCurrentUser(s) { out.append(s) }
            } catch {
                quarantine(url, error: error)
            }
        }
        return out.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    /// Sessions for `scope` belonging to `projectId`.
    ///
    /// A session with a nil `projectId` (written before project identity
    /// existed) belongs to NO project rather than to every one: serving it
    /// everywhere is the cross-project bleed this parameter exists to stop.
    static func list(for scope: ChatScope, projectId: String?) -> [ChatSession] {
        list(for: scope).filter { $0.projectId != nil && $0.projectId == projectId }
    }

    /// Explorer sessions shown while `projectId` is open: its own, plus the
    /// unassigned ones (`projectId == nil`). Unlike `.quick`, Explorer chats
    /// predate project stamping and nothing records where they came from, so
    /// hiding them would lose every existing chat; instead the first project
    /// that saves one claims it (`ChatEngine.persistCurrentChat`). A nil
    /// `projectId` here (no project open) shows everything, as before.
    static func list(for scope: ChatScope, visibleInProject projectId: String?) -> [ChatSession] {
        let all = list(for: scope)
        guard let projectId else { return all }
        return all.filter { $0.projectId == nil || $0.projectId == projectId }
    }

    static func load(id: UUID) -> ChatSession? {
        guard let url = fileURL(for: id),
              FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url) else { return nil }
        do {
            var s = try AppJSON.decoder.decode(ChatSession.self, from: data)
            applyTags(&s)
            return s
        } catch {
            quarantine(url, error: error)
            return nil
        }
    }

    /// Write `session`, stamping `lastUsedAt` with now.
    ///
    /// `touch: false` keeps the existing timestamp, for a write that is not
    /// USE: renaming a chat went through the bump and re-sorted it to the top
    /// of a list ordered newest-first, so giving a chat a better name moved it
    /// somewhere the user wasn't looking for it.
    static func save(_ session: ChatSession, touch: Bool = true) {
        do {
            try saveOrThrow(session, touch: touch)
        } catch SaveError.noTarget {
            return
        } catch {
            log.warning("chat_session_save_failed id=\(session.id.uuidString, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        }
    }

    enum SaveError: Error { case noTarget }

    /// `save` for a caller that must KNOW the write landed (the archive service: a receipt or a
    /// server delete follows only a file that is really there). Throws `SaveError.noTarget` for a
    /// session with no scope or no store directory, and the underlying error for a failed write
    /// (disk full, permissions). `save` is this, with the failure logged and swallowed.
    static func saveOrThrow(_ session: ChatSession, touch: Bool = true) throws {
        guard session.scope != nil, let url = fileURL(for: session.id) else { throw SaveError.noTarget }
        var bumped = session
        if touch { bumped.lastUsedAt = Date() }
        if let o = ownership, o.stamp {
            if bumped.ownerUserId == nil { bumped.ownerUserId = o.currentUserId() }
            // The sidecar can hold a tag an old build stripped from the file.
            applyTags(&bumped)
        }
        let data = try AppJSON.encoder.encode(bumped)
        try data.write(to: url, options: .atomic)
        if ownership?.stamp == true { Tags.record(bumped) }
    }

    /// The directory the chat store and its sidecar files live under (nil only if it cannot be made).
    static var supportDirectory: URL? { baseDir }

    /// Called, synchronously and BEFORE the file goes, for a delete the user asked for
    /// (live-then-archive records the tombstone intent here, so no delete path can skip it).
    /// Nil unless `lta.mode` is `on`.
    nonisolated(unsafe) static var onUserDelete: (@Sendable (UUID) -> Void)?

    static func delete(id: UUID) {
        onUserDelete?(id)
        deleteQuietly(id: id)
    }

    /// Remove the file without recording a user delete (the archive service cleaning up after itself).
    static func deleteQuietly(id: UUID) {
        guard let url = fileURL(for: id) else { return }
        try? FileManager.default.removeItem(at: url)
        Tags.remove(id)
    }

    /// Delete every UUID session whose scope matches, plus any legacy scope file.
    static func clear(for scope: ChatScope) {
        for s in list(for: scope) { delete(id: s.id) }
        if let legacy = legacyScopeFileURL(for: scope),
           FileManager.default.fileExists(atPath: legacy.path) {
            try? FileManager.default.removeItem(at: legacy)
        }
    }

    /// Sign-out: wipe the whole sessions directory, and every scope's
    /// "current chat" pointer with it — a pointer outliving its file is how
    /// the next user's panel would resolve (and re-create) a deleted chat.
    static func clear() {
        if let dir = sessionsDir { try? FileManager.default.removeItem(at: dir) }
        Tags.removeAll()
        clearCurrentPointers()
    }

    /// Forget every scope's "current chat" pointer without touching any file. Sign-out
    /// under `lta.mode = on` keeps the files (plan Q5) but must not leave a pointer that
    /// resolves the previous user's chat for the next one.
    static func clearCurrentPointers() {
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("chat.current.") {
            defaults.removeObject(forKey: key)
        }
    }

    // MARK: - Ownership (live-then-archive)

    /// Whether the signed-in user may see `session`. A file with no owner is visible
    /// (it predates tagging, or has not been claimed yet — `stampUnowned` claims it).
    static func isVisibleToCurrentUser(_ session: ChatSession) -> Bool {
        guard let o = ownership, o.filter, let owner = session.ownerUserId else { return true }
        return owner == o.currentUserId()
    }

    /// Claim every unowned chat file for `owner`. Run at sign-in and before sign-out, so a
    /// chat written before tagging cannot be adopted by whoever signs in next.
    /// Returns how many files were stamped.
    @discardableResult
    static func stampUnowned(owner: String) -> Int {
        guard let dir = sessionsDir,
              let contents = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return 0 }
        var n = 0
        for url in contents where url.pathExtension == "json" {
            if ChatScope(rawValue: url.deletingPathExtension().lastPathComponent) != nil { continue }
            guard let data = try? Data(contentsOf: url),
                  var s = try? AppJSON.decoder.decode(ChatSession.self, from: data) else { continue }
            applyTags(&s)
            guard s.ownerUserId == nil else { continue }
            s.ownerUserId = owner
            save(s, touch: false)
            n += 1
        }
        return n
    }

    /// Every chat file regardless of owner or scope, for the archive service's
    /// sweep. Not filtered: the service applies its own owner rule.
    static func allSessionIDs() -> [UUID] {
        guard let dir = sessionsDir,
              let contents = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        return contents.compactMap { url in
            url.pathExtension == "json" ? UUID(uuidString: url.deletingPathExtension().lastPathComponent) : nil
        }
    }

    /// True when `sessions/<id>.json` exists (even if it would not decode).
    static func fileExists(id: UUID) -> Bool {
        guard let url = fileURL(for: id) else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    /// Re-add the tags an old build stripped from the file when it re-saved it.
    private static func applyTags(_ s: inout ChatSession) {
        guard let tag = Tags.tag(for: s.id) else { return }
        if s.ownerUserId == nil { s.ownerUserId = tag.ownerUserId }
        if s.meetingId == nil { s.meetingId = tag.meetingId }
        if s.origin == nil { s.origin = tag.origin }
    }

    /// `chat-tags.json`, a sidecar in the BASE directory (not `sessions/`: every `*.json`
    /// there is read as a chat, and an old build would quarantine this one). It mirrors
    /// the three tags per chat id so an old build's re-save cannot lose them (F14). It is a
    /// derivative: losing it loses nothing the files do not also say.
    enum Tags {
        struct Tag: Codable, Equatable {
            var ownerUserId: String?
            var meetingId: String?
            var origin: String?
        }
        private static let lock = NSLock()
        nonisolated(unsafe) private static var cache: [String: [String: Tag]] = [:]   // base path -> id -> tag

        private static var fileURL: URL? { baseDir?.appendingPathComponent("chat-tags.json") }

        private static func load() -> [String: Tag] {
            guard let url = fileURL else { return [:] }
            if let hit = cache[url.path] { return hit }
            let map = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode([String: Tag].self, from: $0) } ?? [:]
            cache[url.path] = map
            return map
        }

        private static func store(_ map: [String: Tag]) {
            guard let url = fileURL else { return }
            cache[url.path] = map
            if let data = try? JSONEncoder().encode(map) { try? data.write(to: url, options: .atomic) }
        }

        static func tag(for id: UUID) -> Tag? {
            lock.lock(); defer { lock.unlock() }
            return load()[id.uuidString]
        }

        static func record(_ s: ChatSession) {
            let tag = Tag(ownerUserId: s.ownerUserId, meetingId: s.meetingId, origin: s.origin)
            lock.lock(); defer { lock.unlock() }
            var map = load()
            guard map[s.id.uuidString] != tag else { return }
            if tag.ownerUserId == nil, tag.meetingId == nil, tag.origin == nil {
                guard map.removeValue(forKey: s.id.uuidString) != nil else { return }
            } else {
                map[s.id.uuidString] = tag
            }
            store(map)
        }

        static func remove(_ id: UUID) {
            lock.lock(); defer { lock.unlock() }
            var map = load()
            guard map.removeValue(forKey: id.uuidString) != nil else { return }
            store(map)
        }

        static func removeAll() {
            lock.lock(); defer { lock.unlock() }
            guard let url = fileURL else { return }
            cache[url.path] = nil
            try? FileManager.default.removeItem(at: url)
        }

        /// Test hook.
        static func resetCache() { lock.lock(); cache.removeAll(); lock.unlock() }
    }

    /// If `sessions/<scope>.json` exists, convert once to a UUID file with
    /// `scope` set, delete the legacy file, and return the migrated session.
    /// Idempotent when no legacy file remains.
    static func migrateScopeFileIfNeeded(for scope: ChatScope) -> ChatSession? {
        guard let legacy = legacyScopeFileURL(for: scope),
              FileManager.default.fileExists(atPath: legacy.path) else { return nil }
        guard let data = try? Data(contentsOf: legacy) else {
            log.warning("chat_session_legacy_read_failed file=\(legacy.lastPathComponent, privacy: .public)")
            quarantineUnreadable(legacy)
            return nil
        }
        do {
            var session = try AppJSON.decoder.decode(ChatSession.self, from: data)
            session.scope = scope
            save(session)
            do {
                try FileManager.default.removeItem(at: legacy)
            } catch {
                log.warning("chat_session_legacy_delete_failed file=\(legacy.lastPathComponent, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
            }
            if FileManager.default.fileExists(atPath: legacy.path) {
                log.warning("chat_session_legacy_still_present file=\(legacy.lastPathComponent, privacy: .public)")
            }
            return session
        } catch {
            quarantine(legacy, error: error)
            return nil
        }
    }

    private static func quarantine(_ url: URL, error: Error) {
        log.warning("chat_session_decode_failed file=\(url.lastPathComponent, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        quarantineUnreadable(url)
    }

    private static func quarantineUnreadable(_ url: URL) {
        let stamp = Int(Date().timeIntervalSince1970)
        let corrupt = url.deletingPathExtension().appendingPathExtension("corrupt-\(stamp)")
        try? FileManager.default.moveItem(at: url, to: corrupt)
    }
}
