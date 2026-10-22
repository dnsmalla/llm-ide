import Foundation

/// On-disk per-project bundle. Stored at <projectFolder>/system/project.json.
struct Project: Codable, Equatable, Identifiable {
    let schemaVersion: Int
    let id: String
    var displayName: String
    let createdAt: Date
    var settings: ProjectSettings

    static let currentSchemaVersion = 1

    init(id: String, displayName: String, createdAt: Date,
         settings: ProjectSettings, schemaVersion: Int = currentSchemaVersion) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.displayName = displayName
        self.createdAt = createdAt
        self.settings = settings
    }

    enum LoadError: Error {
        case unsupportedSchema(version: Int)
        case invalidJSON(underlying: Error)
    }

    static func fromJSON(_ data: Data) throws -> Project {
        let p: Project
        do { p = try AppJSON.iso8601Decoder.decode(Project.self, from: data) }
        catch { throw LoadError.invalidJSON(underlying: error) }
        guard (1...currentSchemaVersion).contains(p.schemaVersion) else {
            throw LoadError.unsupportedSchema(version: p.schemaVersion)
        }
        return p
    }

    func toJSON() throws -> Data {
        try AppJSON.iso8601Encoder.encode(self)
    }
}

extension Project.LoadError: Equatable {
    // Equatable conformance compares structural identity only:
    // unsupportedSchema versions match; invalidJSON cases are equal
    // when both wrap an underlying error (we don't compare the
    // errors themselves because DecodingError isn't Equatable).
    static func == (lhs: Project.LoadError, rhs: Project.LoadError) -> Bool {
        switch (lhs, rhs) {
        case (.unsupportedSchema(let a), .unsupportedSchema(let b)):
            return a == b
        case (.invalidJSON, .invalidJSON):
            return true
        default:
            return false
        }
    }
}

/// Per-project settings bundle stored in `system/project.json`.
///
/// Only fields that are actually READ back belong here. The file used to also
/// carry `activeCLI`, `regressionLookbackCount`, `enabledPlugins`,
/// `agentPersona`, `notesFolderRelative` and `docTemplatesActive` — snapshots
/// taken at project creation that nothing ever read. They looked authoritative
/// and drifted immediately (a project pinned `activeCLI: "claude_code"` while
/// the live setting had moved on), so they were removed rather than kept in
/// sync with owners that already exist:
/// - CLI + lookback → `AppConfig` / `AutoTaskSettings`
/// - agent persona → server agent persona API
/// - doc templates → seeded on disk under `templates/` by
///   `ProjectDocTemplatesSeeder`, which is the real source
/// - plugins → Library plugin install state
///
/// Decoding ignores those keys where they linger in existing files, and they
/// drop out on the next write. Note the one-way step: an older build reads
/// them with a non-optional `decode`, so it cannot open a file written here.
struct ProjectSettings: Codable, Equatable {
    /// LLM output language for scaffolded project docs. Seeded from
    /// `AppConfig.preferredLanguage` (the local mirror of the server-synced
    /// user pref) — it used to be hard-coded to "" at creation, which is why
    /// every generated README / CLAUDE.md shipped with a blank language.
    var language: String
    var linkedRepo: LinkedRepo?

    // Explicit memberwise init (required because we provide a custom
    // init(from:) which suppresses the synthesized one).
    init(language: String, linkedRepo: LinkedRepo? = nil) {
        self.language = language
        self.linkedRepo = linkedRepo
    }

    enum CodingKeys: String, CodingKey {
        case language, linkedRepo
    }

    /// Tolerant decoder — a missing field falls back to its default, matching
    /// the other saved-config structs, so neither adding nor removing fields
    /// invalidates a file written by another build.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        language = try c.decodeIfPresent(String.self, forKey: .language) ?? ""
        linkedRepo = try c.decodeIfPresent(LinkedRepo.self, forKey: .linkedRepo)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(language, forKey: .language)
        try c.encodeIfPresent(linkedRepo, forKey: .linkedRepo)
    }

    struct LinkedRepo: Codable, Equatable {
        enum Kind: String, Codable {
            case github, gitlab
        }
        let kind: Kind
        let url: String
        let remoteId: String         // "owner/name" for GH, numeric str for GL
        let defaultBranch: String?
    }
}
