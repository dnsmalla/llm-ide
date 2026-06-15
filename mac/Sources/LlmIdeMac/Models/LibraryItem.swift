import Foundation

struct LibraryItem: Identifiable, Codable, Hashable {
    var name: String
    var path: String
    var category: Category
    var addedAt: Date = Date()
    /// Non-nil when this file was imported as part of a folder import.
    /// Stores the display name of the root folder so files can be grouped.
    var folderOrigin: String? = nil

    /// Identity is DERIVED from `path` (not a stored random UUID) so it is
    /// STABLE across rescans.  `items` is now a scan of the project folder,
    /// rebuilt on every `rescan()`; a fresh `UUID()` per construction would
    /// churn identity on each scan, breaking SwiftUI list diffing and
    /// id-based lookups (e.g. `remove(id:)`).  Not a `CodingKey`, so legacy
    /// JSON carrying an "id" key still decodes (the key is simply ignored).
    var id: String { path }

    var url: URL { URL(fileURLWithPath: path) }
    var ext: String { url.pathExtension.lowercased() }

    enum Category: String, Codable, CaseIterable, Identifiable {
        case code     = "Code"
        case data     = "Data"
        case notes    = "Notes"
        case meetings = "Meetings"

        var id: String { rawValue }

        var icon: String {
            switch self {
            case .code:     return "chevron.left.forwardslash.chevron.right"
            case .data:     return "tablecells"
            case .notes:    return "note.text"
            case .meetings: return "waveform.and.mic"
            }
        }

    }

    // Equality/identity by path (== `id`), consistent with the derived id.
    static func == (lhs: LibraryItem, rhs: LibraryItem) -> Bool { lhs.path == rhs.path }
    func hash(into hasher: inout Hasher) { hasher.combine(path) }
}
