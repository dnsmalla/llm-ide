import Foundation

struct FileChange: Identifiable, Hashable {
    enum Status: String { case added, modified, deleted, renamed, untracked, conflicted }
    var path: String          // repo-relative; for renames, the new path
    var status: Status
    var staged: Bool
    var displayPath: String { path }
    var id: String { (staged ? "S:" : "U:") + path }
}

struct DiffRow: Hashable {
    enum Kind { case context, insert, delete }
    var kind: Kind
    var oldLine: Int?
    var newLine: Int?
    var text: String
}

struct DiffHunk: Hashable {
    var header: String        // the @@ line
    var rows: [DiffRow]
}
