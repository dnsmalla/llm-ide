import Foundation

/// Global, user-configurable default folder where KB **plans** are written as
/// Markdown. Mirrors `NotesFolderConfig` (security-scoped bookmark + path
/// string) so it survives relaunches and is forward-compatible with sandbox
/// enablement.
///
/// Plans are per-project data, but they are exported to this single global
/// folder (one subfolder per project) so all plan output lives in one
/// browsable place regardless of which project is active. See
/// `ProjectExporter.writePlans(...)`.
final class PlansFolderConfig {

    private let defaults: UserDefaults
    private let bookmarkKey = "MEETNOTES_PLANS_FOLDER_BOOKMARK"
    private let pathKey      = "MEETNOTES_PLANS_FOLDER_PATH"

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

    /// Capture a security-scoped bookmark (from an NSOpenPanel click) so the
    /// folder survives relaunches and stays usable if sandbox is ever enabled.
    /// There is deliberately no `setFolderFromPath` variant: unlike the notes
    /// folder (which follows the active project), the Plans folder is only
    /// ever set from the Settings picker, so a path-only setter has no caller.
    func setFolder(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let bm = try url.bookmarkData(options: [.withSecurityScope],
                                      includingResourceValuesForKeys: nil,
                                      relativeTo: nil)
        defaults.set(bm, forKey: bookmarkKey)
        defaults.set(url.path, forKey: pathKey)
    }

    func defaultFolder() -> URL {
        AppIdentity.documentsRoot()
            .appendingPathComponent("Plans", isDirectory: true)
    }
}
