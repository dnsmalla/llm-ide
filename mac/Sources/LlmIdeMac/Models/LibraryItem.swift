import Foundation

struct LibraryItem: Identifiable, Codable, Hashable {
    var name: String
    var path: String
    var category: Category
    var addedAt: Date = Date()
    /// Group label for flat consumers (LibraryPicker, Doc Gen, category
    /// trees); nil when the file sits directly in its scan root. What it
    /// holds depends on the category: the immediate parent dir name (code /
    /// data / meetings), the "/"-joined relative path (`.notes`, whose
    /// <source>/<YYYY>/<MM>/ nesting makes a bare parent name meaningless),
    /// or the imported root folder's display name (external folder imports).
    var folderOrigin: String? = nil

    /// For categories with `rendersNestedTree` (Code, LLM Doc): directory
    /// components from the category's scan root down to (not including) the
    /// file, used to build the nested tree. `nil` for every other category —
    /// so `treePath != nil` means "tree-rendered", NOT "is a code file";
    /// guard on `category` when code-specific semantics are needed.
    ///
    /// e.g. `<repo>/Sources/App/Foo.swift` → `["InfiniteBrain","Sources","App"]`;
    /// `llm-doc/emails/2026/08/x.md` → `["emails","2026","08"]`;
    /// a file directly in the scan root → `[]`.
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
        /// ingested mail (and, later, Slack). `.notes` is presented as
        /// "LLM Doc" (its on-disk folder is `llm-doc/`). The Codable
        /// `rawValue` stays "Meetings"/"Notes" so persisted items and the
        /// folder scan are unaffected — only the displayed label changes.
        var sectionTitle: String {
            switch self {
            case .meetings: return "Sources"
            case .notes:    return "LLM Doc"
            default:        return rawValue
            }
        }

        var icon: String {
            switch self {
            case .code:     return "chevron.left.forwardslash.chevron.right"
            case .data:     return "tablecells"
            case .notes:    return "note.text"
            case .meetings: return "waveform.and.mic"
            }
        }

        /// Whether this category renders as a real nested directory tree
        /// (built from `LibraryItem.treePath`) rather than a flat one-level
        /// folder grouping. THE single answer to that question — the scan
        /// (populate treePath), the Library sidebar, and FileTreePanel all
        /// key off this, so the membership can't drift between them again.
        /// llm-doc's canonical layout is <source>/<YYYY>/<MM>/ (NoteService),
        /// which a flat grouping collapsed to a bare month ("08").
        var rendersNestedTree: Bool { self == .code || self == .notes }
    }

    // Equality/identity by path (== `id`), consistent with the derived id.
    static func == (lhs: LibraryItem, rhs: LibraryItem) -> Bool { lhs.path == rhs.path }
    func hash(into hasher: inout Hasher) { hasher.combine(path) }
}
