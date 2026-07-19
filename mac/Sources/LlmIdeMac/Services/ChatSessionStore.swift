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

    /// Wipe every session — used by Sign Out.
    static func clear() {
        guard let dir = sessionsDir else { return }
        try? FileManager.default.removeItem(at: dir)
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
