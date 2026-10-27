import Foundation

/// Sets an unreadable user-state file aside before the store starts empty, so
/// the next save cannot overwrite the only copy of the user's data.
enum DamagedFileQuarantine {
    /// Moves `url` to the first free `<name>.corrupt-<epoch seconds>` beside it,
    /// then `<name>.corrupt-<epoch seconds>-2`, `-3`, … so an earlier copy is
    /// never replaced. Throws when the move fails; the original stays in place.
    static func setAside(_ url: URL, now: Date) throws -> URL {
        let fileManager = FileManager.default
        let dir = url.deletingLastPathComponent()
        let base = "\(url.lastPathComponent).corrupt-\(Int(now.timeIntervalSince1970))"
        var name = base
        var suffix = 2
        while fileManager.fileExists(atPath: dir.appendingPathComponent(name).path) {
            name = "\(base)-\(suffix)"
            suffix += 1
        }
        let aside = dir.appendingPathComponent(name)
        try fileManager.moveItem(at: url, to: aside)
        return aside
    }
}
