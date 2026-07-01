import Foundation

struct LibraryItem: Identifiable, Codable, Hashable {
    var name: String
    var path: String
    var category: Category
    var addedAt: Date = Date()
    /// Non-nil when this file was imported as part of a folder import.
    /// Stores the display name of the root folder so files can be grouped.
    var folderOrigin: String? = nil

    /// For `.code` items only: directory components from the CODE-section
    /// root down to (not including) the file, used to build the nested code
    /// tree. `nil` for every other category.
    ///
    /// e.g. `<repo>/Sources/App/Foo.swift` → `["InfiniteBrain","Sources","App"]`;
    /// a file directly in the project's `code/` → `[]`.
    var treePath: [String]? = nil

    /// For `.meetings` items only: the `InputSource.id` this file belongs to
    /// (from `SourceRegistry`, classified by frontmatter `platform`). Drives
    /// the SOURCES sub-grouping. `nil` for every other category.
    var sourceId: String? = nil

    /// File size in bytes, captured once during the (off-main) scan from the
    /// enumerator's prefetched resource values. Lets `LibraryFileRow` show the
    /// size without a synchronous `stat()` per row in its `body`.
    var sizeBytes: Int? = nil

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

        /// Display title for the Library section header. `.meetings` is
        /// presented as "Sources" — it now holds captured meetings plus
        /// ingested mail (and, later, Slack). The Codable `rawValue` stays
        /// "Meetings" so persisted items and the `meetings/` folder scan are
        /// unaffected.
        var sectionTitle: String {
            self == .meetings ? "Sources" : rawValue
        }

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
