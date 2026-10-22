import Foundation

final class NotesFolderConfig {
    enum SyncProvider: Equatable {
        case icloudDrive, dropbox, googleDrive, oneDrive
        var label: String {
            switch self {
            case .icloudDrive: return "Synced via iCloud Drive"
            case .dropbox:     return "Synced via Dropbox"
            case .googleDrive: return "Synced via Google Drive"
            case .oneDrive:    return "Synced via OneDrive"
            }
        }
    }

    private let defaults: UserDefaults
    private let bookmarkKey  = "MEETNOTES_NOTES_FOLDER_BOOKMARK"
    private let pathKey      = "MEETNOTES_NOTES_FOLDER_PATH"

    init(userDefaults: UserDefaults = .standard) {
        self.defaults = userDefaults
    }

    var currentFolder: URL {
        if let data = defaults.data(forKey: bookmarkKey) {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data,
                                  options: [.withSecurityScope],
                                  relativeTo: nil,
                                  bookmarkDataIsStale: &stale),
               // A bookmark follows the folder wherever it goes — including
               // the Trash. Resolving there would silently write new notes
               // into ~/.Trash while the stored path still names the old
               // location, so fall through to that path instead.
               !Self.isInTrash(url) {
                if stale { refreshBookmark(for: url) }
                return url
            }
        }
        if let p = defaults.string(forKey: pathKey) {
            return URL(fileURLWithPath: p, isDirectory: true)
        }
        return defaultFolder()
    }

    /// True for a URL inside a user or volume Trash (`.Trash` / `.Trashes`).
    static func isInTrash(_ url: URL) -> Bool {
        url.pathComponents.contains { $0 == ".Trash" || $0 == ".Trashes" }
    }

    /// A stale bookmark still resolved, but keeps going stale and its recorded
    /// path no longer matches (folder moved/renamed). Re-save both from the
    /// resolved location so later reads agree with where the folder really is.
    private func refreshBookmark(for url: URL) {
        guard let bm = try? url.bookmarkData(options: [.withSecurityScope],
                                             includingResourceValuesForKeys: nil,
                                             relativeTo: nil) else { return }
        defaults.set(bm, forKey: bookmarkKey)
        defaults.set(url.path, forKey: pathKey)
    }

    func setFolder(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let bm = try url.bookmarkData(options: [.withSecurityScope],
                                      includingResourceValuesForKeys: nil,
                                      relativeTo: nil)
        defaults.set(bm, forKey: bookmarkKey)
        defaults.set(url.path, forKey: pathKey)
    }

    /// Like `setFolder` but tolerant of bookmark-creation failure.
    /// Called from Settings → Paths, where the user supplies a
    /// path string (not an NSOpenPanel click). The app is currently
    /// non-sandboxed (see LlmIdeMac.entitlements), so the
    /// path-only fallback in `currentFolder` works fine without a
    /// security-scoped bookmark. If sandbox is ever turned on,
    /// callers should drive the change from an NSOpenPanel click
    /// instead — `setFolder` will then succeed at bookmark creation.
    func setFolderFromPath(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        if let bm = try? url.bookmarkData(options: [.withSecurityScope],
                                          includingResourceValuesForKeys: nil,
                                          relativeTo: nil) {
            defaults.set(bm, forKey: bookmarkKey)
        } else {
            // Wipe a stale bookmark so currentFolder doesn't resolve
            // to the old folder via stale bookmark data.
            defaults.removeObject(forKey: bookmarkKey)
        }
        defaults.set(url.path, forKey: pathKey)
    }

    func defaultFolder() -> URL {
        AppIdentity.documentsRoot()
    }

    static func detectSyncProvider(at url: URL) -> SyncProvider? {
        let p = url.path
        if p.contains("/Library/Mobile Documents/com~apple~CloudDocs/") { return .icloudDrive }
        if p.contains("/Dropbox/") || p.contains("/Library/CloudStorage/Dropbox") { return .dropbox }
        if p.contains("/Library/CloudStorage/GoogleDrive-") { return .googleDrive }
        if p.contains("/Library/CloudStorage/OneDrive-") { return .oneDrive }
        return nil
    }
}
