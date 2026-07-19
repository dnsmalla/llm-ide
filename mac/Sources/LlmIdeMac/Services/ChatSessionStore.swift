import Foundation
import os.log

/// Multi-session chat persistence. Replaces the legacy single-file
/// `ChatHistoryStore`. Each session is its own JSON file at
/// `~/Library/Application Support/LLM IDE/sessions/<uuid>.json` so we
/// don't rewrite the entire history on every turn — only the touched
/// session's file. The sessions/ directory is enumerated to list.
///
/// Corrupt files are renamed `.corrupt-<unix-ts>` and skipped, mirroring
/// the ChatHistoryStore pattern.
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

    // MARK: - CRUD

    /// List every session sorted by lastUsedAt descending. For <100
    /// sessions a full load is fine; we'll add a metadata-only index
    /// later if we ever cross that threshold.
    static func listSessions() -> [ChatSession] {
        guard let dir = sessionsDir,
              let contents = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil) else { return [] }
        var out: [ChatSession] = []
        for url in contents where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url) else { continue }
            do {
                let s = try AppJSON.decoder.decode(ChatSession.self, from: data)
                out.append(s)
            } catch {
                log.warning("chat_session_decode_failed file=\(url.lastPathComponent, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
                let stamp = Int(Date().timeIntervalSince1970)
                let corrupt = url.deletingPathExtension().appendingPathExtension("corrupt-\(stamp)")
                try? FileManager.default.moveItem(at: url, to: corrupt)
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
            log.warning("chat_session_decode_failed id=\(id.uuidString, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
            let stamp = Int(Date().timeIntervalSince1970)
            let corrupt = url.deletingPathExtension().appendingPathExtension("corrupt-\(stamp)")
            try? FileManager.default.moveItem(at: url, to: corrupt)
            return nil
        }
    }

    /// Atomic write. Caller passes a session; we bump `lastUsedAt` here
    /// so they don't have to remember.
    static func save(_ session: ChatSession) {
        guard let url = fileURL(for: session.id) else { return }
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

    /// Wipe every session — used by Sign Out.
    static func clear() {
        guard let dir = sessionsDir else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    /// Discard ALL persisted chat — every session file, the legacy
    /// single-file history, and the "current session" pointer — so the
    /// app always opens a fresh, empty chat. Called once per launch from
    /// `LlmIdeMacApp.init()`. Destructive by design: old conversations are
    /// intentionally not carried across launches. Removing the legacy file
    /// here (in addition to the sessions dir) stops `migrateLegacy()` from
    /// resurrecting an "Earlier chat" on the next `.onAppear`.
    static func wipeAllForFreshLaunch() {
        if let dir = sessionsDir {
            try? FileManager.default.removeItem(at: dir)
        }
        if let base = baseDir {
            let legacy = base.appendingPathComponent("chat-history.json")
            try? FileManager.default.removeItem(at: legacy)
        }
        UserDefaults.standard.removeObject(forKey: "MEETNOTES_CURRENT_CHAT_SESSION_ID")
    }

    // MARK: - Legacy migration

    /// If the legacy `chat-history.json` file exists, convert it into a
    /// new session titled "Earlier chat", save it, delete the old file,
    /// and return the new session id. Idempotent — if there's no legacy
    /// file (or it's empty / unreadable), returns nil without side
    /// effects beyond removing a broken legacy file.
    @discardableResult
    static func migrateLegacy() -> UUID? {
        guard let base = baseDir else { return nil }
        let legacy = base.appendingPathComponent("chat-history.json")
        guard FileManager.default.fileExists(atPath: legacy.path) else { return nil }
        defer { try? FileManager.default.removeItem(at: legacy) }
        guard let data = try? Data(contentsOf: legacy) else { return nil }
        let turns: [LlmIdeAPIClient.CodeAssistTurn]
        do {
            turns = try AppJSON.decoder.decode([LlmIdeAPIClient.CodeAssistTurn].self, from: data)
        } catch {
            log.warning("legacy_chat_decode_failed err=\(error.localizedDescription, privacy: .public)")
            return nil
        }
        guard !turns.isEmpty else { return nil }
        let session = ChatSession(title: "Earlier chat", history: turns)
        save(session)
        return session.id
    }

    // MARK: - Per-section (scope-keyed) chat

    /// `sessions/<scope>.json`. Named `scopeFileURL` to avoid clashing with
    /// the legacy `fileURL(for id: UUID)` while both coexist.
    private static func scopeFileURL(for scope: ChatScope) -> URL? {
        sessionsDir?.appendingPathComponent("\(scope.rawValue).json")
    }

    /// The one chat for this section, or a fresh empty session if none is
    /// saved yet (first open). Corrupt files are quarantined like the legacy
    /// path and a fresh session is returned.
    static func load(for scope: ChatScope) -> ChatSession {
        guard let url = scopeFileURL(for: scope),
              FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url) else {
            return ChatSession()
        }
        do {
            return try AppJSON.decoder.decode(ChatSession.self, from: data)
        } catch {
            log.warning("chat_session_decode_failed scope=\(scope.rawValue, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
            let stamp = Int(Date().timeIntervalSince1970)
            let corrupt = url.deletingPathExtension().appendingPathExtension("corrupt-\(stamp)")
            try? FileManager.default.moveItem(at: url, to: corrupt)
            return ChatSession()
        }
    }

    /// Persist `session` as this section's chat (`sessions/<scope>.json`).
    /// Bumps `lastUsedAt` so the file reflects the last touch.
    static func save(_ session: ChatSession, for scope: ChatScope) {
        guard let url = scopeFileURL(for: scope) else { return }
        var bumped = session
        bumped.lastUsedAt = Date()
        do {
            let data = try AppJSON.encoder.encode(bumped)
            try data.write(to: url, options: .atomic)
        } catch {
            log.warning("chat_session_save_failed scope=\(scope.rawValue, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        }
    }

    /// Delete one section's chat file — the "Clear chat" action. The on-disk
    /// file goes away; the in-memory history is reset by the caller.
    static func clear(for scope: ChatScope) {
        guard let url = scopeFileURL(for: scope) else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
