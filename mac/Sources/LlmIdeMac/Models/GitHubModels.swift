import Foundation

// MARK: - Wire types

/// A repository as returned by `GET /repos/{owner}/{name}` or
/// `GET /repos/{owner}/{name}/...`. Only the fields the settings UI
/// actually surfaces; we can grow this as features land.
struct GitHubRepo: Identifiable, Codable, Hashable {
    let id: Int
    let name: String
    let fullName: String       // "owner/name"
    let htmlUrl: String
    let cloneUrl: String       // https://github.com/owner/name.git
    let defaultBranch: String?
    let description: String?
    let openIssuesCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, description
        case fullName        = "full_name"
        case htmlUrl         = "html_url"
        case cloneUrl        = "clone_url"
        case defaultBranch   = "default_branch"
        case openIssuesCount = "open_issues_count"
    }
}

struct GitHubUser: Codable, Hashable {
    let id: Int
    let login: String          // username
    let name: String?
    let avatarUrl: String?

    enum CodingKeys: String, CodingKey {
        case id, login, name
        case avatarUrl = "avatar_url"
    }
}

// MARK: - Persisted user-side model

/// Mirrors `SavedGitLabProject` but for GitHub. Persisted in `AppConfig`.
struct SavedGitHubRepo: Codable, Identifiable, Equatable {
    var id: String
    var url: String              // user-typed URL or `owner/name`
    var displayName: String
    var resolvedId: Int?
    var isActive: Bool
    /// Absolute path to the local git clone, set after the user clones.
    var localPath: String?
    /// Default branch, captured at clone time.
    var defaultBranch: String?

    init(url: String = "", displayName: String = "", resolvedId: Int? = nil, isActive: Bool = false) {
        self.id = UUID().uuidString
        self.url = url
        self.displayName = displayName
        self.resolvedId = resolvedId
        self.isActive = isActive
    }

    var isCloned: Bool { localPath != nil }
    var localURL: URL? { localPath.map { URL(fileURLWithPath: $0) } }
}
