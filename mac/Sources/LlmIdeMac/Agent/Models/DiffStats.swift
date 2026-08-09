import Foundation

/// Compact line-diff summary for a pending-action preview (see
/// `PendingActionCard`'s `update-file` branch) — added/removed line counts
/// plus a handful of preview lines, computed with the same
/// `CollectionDifference` approach `UpdateFileSheet`'s own diff view uses,
/// kept as a separate small type rather than reusing that view's private
/// `DiffRow` (this only needs counts + a preview, not every row).
struct DiffStats {
    let added: Int
    let removed: Int
    let previewLines: [String]

    static func compute(old: String, new: String, previewLineCount: Int = 3) -> DiffStats {
        let oldLines = old.components(separatedBy: "\n")
        let newLines = new.components(separatedBy: "\n")
        let diff = newLines.difference(from: oldLines)
        var added = 0
        var removed = 0
        var preview: [String] = []
        for change in diff {
            switch change {
            case .insert(_, let line, _):
                added += 1
                if preview.count < previewLineCount { preview.append("+ \(line)") }
            case .remove(_, let line, _):
                removed += 1
                if preview.count < previewLineCount { preview.append("- \(line)") }
            }
        }
        return DiffStats(added: added, removed: removed, previewLines: preview)
    }
}
