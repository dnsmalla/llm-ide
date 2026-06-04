import Foundation

/// On-disk per-project bundle. Stored at <projectFolder>/.llmide/project.json.
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

/// Per-project settings bundle.
struct ProjectSettings: Codable, Equatable {
    var language: String
    var activeCLI: String
    var linkedRepo: LinkedRepo?
    var notesFolderRelative: String?
    var enabledPlugins: [String]
    var uaBinaryOverride: String
    var regressionLookbackCount: Int
    var agentPersona: String?
    var docTemplatesActive: [String]

    // Explicit memberwise init (required because we provide a custom
    // init(from:) which suppresses the synthesized one).
    init(language: String, activeCLI: String, linkedRepo: LinkedRepo? = nil,
         notesFolderRelative: String? = nil, enabledPlugins: [String],
         uaBinaryOverride: String, regressionLookbackCount: Int,
         agentPersona: String? = nil, docTemplatesActive: [String]) {
        self.language = language
        self.activeCLI = activeCLI
        self.linkedRepo = linkedRepo
        self.notesFolderRelative = notesFolderRelative
        self.enabledPlugins = enabledPlugins
        self.uaBinaryOverride = uaBinaryOverride
        self.regressionLookbackCount = regressionLookbackCount
        self.agentPersona = agentPersona
        self.docTemplatesActive = docTemplatesActive
    }

    // Backward-compatible decoding: existing project.json files on disk
    // still have `graphifyBinaryOverride`. Accept either key name.
    enum CodingKeys: String, CodingKey {
        case language, activeCLI, linkedRepo, notesFolderRelative
        case enabledPlugins, uaBinaryOverride, regressionLookbackCount
        case agentPersona, docTemplatesActive
        // Legacy alias — kept so old project.json files still load.
        case graphifyBinaryOverride
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        language = try c.decode(String.self, forKey: .language)
        activeCLI = try c.decode(String.self, forKey: .activeCLI)
        linkedRepo = try c.decodeIfPresent(LinkedRepo.self, forKey: .linkedRepo)
        notesFolderRelative = try c.decodeIfPresent(String.self, forKey: .notesFolderRelative)
        enabledPlugins = try c.decode([String].self, forKey: .enabledPlugins)
        // Try new key first, fall back to old key, default to empty.
        uaBinaryOverride = (try? c.decode(String.self, forKey: .uaBinaryOverride))
            ?? (try? c.decode(String.self, forKey: .graphifyBinaryOverride))
            ?? ""
        regressionLookbackCount = try c.decode(Int.self, forKey: .regressionLookbackCount)
        agentPersona = try c.decodeIfPresent(String.self, forKey: .agentPersona)
        docTemplatesActive = try c.decode([String].self, forKey: .docTemplatesActive)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(language, forKey: .language)
        try c.encode(activeCLI, forKey: .activeCLI)
        try c.encodeIfPresent(linkedRepo, forKey: .linkedRepo)
        try c.encodeIfPresent(notesFolderRelative, forKey: .notesFolderRelative)
        try c.encode(enabledPlugins, forKey: .enabledPlugins)
        try c.encode(uaBinaryOverride, forKey: .uaBinaryOverride)
        try c.encode(regressionLookbackCount, forKey: .regressionLookbackCount)
        try c.encodeIfPresent(agentPersona, forKey: .agentPersona)
        try c.encode(docTemplatesActive, forKey: .docTemplatesActive)
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
