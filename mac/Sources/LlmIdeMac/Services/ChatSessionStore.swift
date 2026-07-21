import Foundation
import os.log

/// Multi-session chat persistence. Each chat is a UUID JSON file under
/// `~/Library/Application Support/LLM IDE/sessions/<uuid>.json`, tagged with
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

    private static var baseDir: URL? {
        if let override = baseDirectoryOverride { return override }
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true) else { return nil }
        let dir = base.appendingPathComponent("LLM IDE", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    private static var sessionsDir: URL? {
        guard let base = baseDir else { return nil }
        let dir = base.appendingPathComponent("sessions", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

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
                let s = try AppJSON.decoder.decode(ChatSession.self, from: data)
                if s.scope == scope { out.append(s) }
            } catch {
                quarantine(url, error: error)
            }
        }
        return out.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    static func load(id: UUID) -> ChatSession? {
        guard let url = fileURL(for: id),
              FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url) else { return nil }
        do {
            return try AppJSON.decoder.decode(ChatSession.self, from: data)
        } catch {
            quarantine(url, error: error)
            return nil
        }
    }

    static func save(_ session: ChatSession) {
        guard session.scope != nil, let url = fileURL(for: session.id) else { return }
        var bumped = session
        bumped.lastUsedAt = Date()
        do {
            let data = try AppJSON.encoder.encode(bumped)
            try data.write(to: url, options: .atomic)
        } catch {
            log.warning("chat_session_save_failed id=\(session.id.uuidString, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        }
    }

    static func delete(id: UUID) {
        guard let url = fileURL(for: id) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Delete every UUID session whose scope matches, plus any legacy scope file.
    static func clear(for scope: ChatScope) {
        for s in list(for: scope) { delete(id: s.id) }
        if let legacy = legacyScopeFileURL(for: scope),
           FileManager.default.fileExists(atPath: legacy.path) {
            try? FileManager.default.removeItem(at: legacy)
        }
    }

    /// Sign-out: wipe the whole sessions directory.
    static func clear() {
        guard let dir = sessionsDir else { return }
        try? FileManager.default.removeItem(at: dir)
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

    // MARK: - TEMP shims (remove in Task 4)

    /// TEMP — remove in Task 4
    static func load(for scope: ChatScope) -> ChatSession {
        _ = migrateScopeFileIfNeeded(for: scope)
        if let first = list(for: scope).first { return first }
        return ChatSession(scope: scope)
    }

    /// TEMP — remove in Task 4
    static func save(_ session: ChatSession, for scope: ChatScope) {
        var s = session
        s.scope = scope
        save(s)
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
