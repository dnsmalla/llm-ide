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
                                  bookmarkDataIsStale: &stale) {
                return url
            }
        }
        if let p = defaults.string(forKey: pathKey) {
            return URL(fileURLWithPath: p, isDirectory: true)
        }
        return defaultFolder()
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
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LLM IDE", isDirectory: true)
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
