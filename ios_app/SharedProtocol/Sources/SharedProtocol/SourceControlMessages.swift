import Foundation

// MARK: - Source Control (read-only)
//
// A look at the active project's git working tree: branch, ahead/behind, changed files, recent
// commits, and one file's diff. Strictly read-only — nothing here stages, commits, pushes or
// discards, and no git token or remote URL crosses the wire. The Mac only shows a diff for a path
// that is in its OWN current status list (never an arbitrary path from the phone), refuses files
// that look like secrets, and redacts/caps the diff text.

public struct ScmFile: Codable, Equatable, Identifiable, Hashable {
    public let path: String
    /// "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted".
    public let status: String
    public let staged: Bool
    public var id: String { (staged ? "S:" : "W:") + path }
    public init(path: String, status: String, staged: Bool) {
        self.path = path
        self.status = status
        self.staged = staged
    }
}

public struct ScmCommit: Codable, Equatable, Identifiable, Hashable {
    public let sha: String
    public let author: String
    public let relativeDate: String
    public let subject: String
    public var id: String { sha }
    public init(sha: String, author: String, relativeDate: String, subject: String) {
        self.sha = sha
        self.author = author
        self.relativeDate = relativeDate
        self.subject = subject
    }
}

public struct ScmStatusList: Codable, Equatable {
    public let type = MobileProtocol.Tag.scmStatusList
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

public struct ScmState: Codable, Equatable {
    public let type = MobileProtocol.Tag.scmState
    /// False when the project is not a git working tree (or no project is open).
    public let isRepo: Bool
    public let branch: String?
    public let ahead: Int
    public let behind: Int
    public let hasUpstream: Bool
    public let files: [ScmFile]
    /// True when the file list was cut at the Mac's cap.
    public let filesTruncated: Bool
    public let commits: [ScmCommit]
    public let error: String?
    public init(isRepo: Bool, branch: String?, ahead: Int, behind: Int, hasUpstream: Bool, files: [ScmFile],
                filesTruncated: Bool, commits: [ScmCommit], error: String?) {
        self.isRepo = isRepo
        self.branch = branch
        self.ahead = ahead
        self.behind = behind
        self.hasUpstream = hasUpstream
        self.files = files
        self.filesTruncated = filesTruncated
        self.commits = commits
        self.error = error
    }
    private enum CodingKeys: String, CodingKey {
        case type, isRepo, branch, ahead, behind, hasUpstream, files, filesTruncated, commits, error
    }
}

public struct ScmDiffRequest: Codable, Equatable {
    public let type = MobileProtocol.Tag.scmDiff
    public let path: String
    public let staged: Bool
    public init(path: String, staged: Bool) {
        self.path = path
        self.staged = staged
    }
    private enum CodingKeys: String, CodingKey { case type, path, staged }
}

public struct ScmDiffResult: Codable, Equatable {
    public let type = MobileProtocol.Tag.scmDiffResult
    public let path: String
    public let staged: Bool
    public let diff: String?
    public let truncated: Bool
    public let error: String?
    public init(path: String, staged: Bool, diff: String?, truncated: Bool = false, error: String? = nil) {
        self.path = path
        self.staged = staged
        self.diff = diff
        self.truncated = truncated
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, path, staged, diff, truncated, error }
}
