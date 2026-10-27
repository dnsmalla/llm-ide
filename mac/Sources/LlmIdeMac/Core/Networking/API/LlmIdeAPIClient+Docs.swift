import Foundation

// docs-kit K1: the Doc Gen project-file routes (`/kb/projects/register`,
// `/kb/docs/*`). Wire shapes: schema/http/docs.schema.json. Every call takes a
// registered project id (never a path), and every HTTP failure is mapped to
// `DocFilesServerError` so the caller can tell "fall back to local" from
// "show the user this message".

/// A non-2xx answer from the Doc Gen routes, named by what it means.
public enum DocFilesServerError: LocalizedError, Equatable {
    /// 404 `feature_disabled` (flat body): the server has doc_gen turned off.
    case featureDisabled
    /// 404 `PROJECT_NOT_REGISTERED`: the server does not hold this id for the user.
    case projectNotRegistered
    /// 400 `INVALID_ROOT`: the folder was refused (one answer for every reason).
    case invalidRoot
    /// 409 `TOO_MANY_PROJECTS`: the user already holds the registration cap.
    case tooManyProjects
    /// 409 or 400 `RESERVED_FOLDER`: an ingest layout or a reserved name.
    case reservedFolder(String)
    /// 400 `UNSAFE_PATH`: a path that would leave the project folder.
    case unsafePath
    /// 400 `INVALID_FOLDER`: a folder name the server does not allow.
    case invalidFolder
    /// 404 `NOT_FOUND`: no such template or command folder.
    case notFound
    /// 413 `TOO_LARGE`: the body or the file is over the server's cap.
    case tooLarge
    /// The listing hit the server's scan cap, so it is partial. Never shown:
    /// the caller falls back to the full local listing.
    case truncated
    /// The server is not serving this project right now (preference off, or
    /// the folder was refused for this session). Never sent to the server.
    case notServing
    /// Any other answer, with the server's own (redacted) message.
    case other(status: Int, code: String, message: String)

    public var errorDescription: String? {
        switch self {
        case .featureDisabled: return "The connected server has Doc Gen turned off."
        case .projectNotRegistered: return "The server does not know this project yet."
        case .invalidRoot: return "The server refused this project folder."
        case .tooManyProjects: return "The server already holds the maximum number of registered projects."
        case .reservedFolder(let message): return message
        case .unsafePath: return "The server refused a path outside the project folder."
        case .invalidFolder: return "The server does not allow that folder name."
        case .notFound: return "No such Doc Gen file on the server."
        case .tooLarge: return "The file is too large for the server."
        case .truncated: return "The server listing was truncated."
        case .notServing: return "The server is not serving this project."
        case .other(_, _, let message): return message
        }
    }

    /// Maps one `APIError.http` answer. Anything else is returned unchanged.
    static func from(status: Int, code: String, message: String) -> DocFilesServerError {
        if status == 404, message == "feature_disabled" { return .featureDisabled }
        switch code {
        case "PROJECT_NOT_REGISTERED": return .projectNotRegistered
        case "INVALID_ROOT": return .invalidRoot
        case "TOO_MANY_PROJECTS": return .tooManyProjects
        case "RESERVED_FOLDER": return .reservedFolder(message)
        case "UNSAFE_PATH": return .unsafePath
        case "INVALID_FOLDER": return .invalidFolder
        case "NOT_FOUND": return .notFound
        case "TOO_LARGE": return .tooLarge
        default: return .other(status: status, code: code, message: message)
        }
    }
}

extension LlmIdeAPIClient {

    // MARK: - Wire types

    /// `POST /kb/projects/register` body.
    public struct DocProjectRegistrationRequest: Codable, Equatable {
        public let id: String
        public let root: String
        public init(id: String, root: String) {
            self.id = id
            self.root = root
        }
    }

    /// `POST /kb/projects/register` answer.
    public struct DocProjectRegistration: Codable, Equatable {
        public let id: String
        public let root: String
    }

    /// `GET /kb/docs/templates` answer. `truncated` is true when the folder had
    /// more entries than the server examines; the listing is then partial.
    public struct DocTemplatesPage: Codable {
        let templates: [DocTemplate]
        let count: Int
        let truncated: Bool
        let scannedFolders: Int

        /// `truncated` and `scannedFolders` default to false and 0 when absent,
        /// so an older or newer server cannot force a fallback by omitting them.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            templates = try c.decode([DocTemplate].self, forKey: .templates)
            count = try c.decode(Int.self, forKey: .count)
            truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
            scannedFolders = try c.decodeIfPresent(Int.self, forKey: .scannedFolders) ?? 0
        }
    }

    /// `GET /kb/docs/commands` answer. See `DocTemplatesPage`.
    public struct DocCommandsPage: Codable {
        let commands: [DocCommand]
        let count: Int
        let truncated: Bool
        let scannedFolders: Int

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            commands = try c.decode([DocCommand].self, forKey: .commands)
            count = try c.decode(Int.self, forKey: .count)
            truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
            scannedFolders = try c.decodeIfPresent(Int.self, forKey: .scannedFolders) ?? 0
        }
    }

    /// `PUT /kb/docs/templates/:folder` body. `rawContent`, when present, is
    /// written as-is and wins over `name`, `sections` and `surface`.
    public struct DocTemplateWrite: Codable, Equatable {
        public let name: String?
        public let sections: [String]?
        public let surface: String?
        public let rawContent: String?
        public let rewrite: Bool?
        public init(name: String? = nil, sections: [String]? = nil, surface: String? = nil,
                    rawContent: String? = nil, rewrite: Bool? = nil) {
            self.name = name
            self.sections = sections
            self.surface = surface
            self.rawContent = rawContent
            self.rewrite = rewrite
        }
    }

    /// `PUT /kb/docs/commands/:folder` body. `rawContent` wins, as for templates.
    public struct DocCommandWrite: Codable, Equatable {
        public let name: String?
        public let instruction: String?
        public let surface: String?
        public let rawContent: String?
        public init(name: String? = nil, instruction: String? = nil, surface: String? = nil,
                    rawContent: String? = nil) {
            self.name = name
            self.instruction = instruction
            self.surface = surface
            self.rawContent = rawContent
        }
    }

    /// `PUT /kb/docs/templates/:folder` answer.
    public struct DocTemplateSaved: Codable {
        let template: DocTemplate
    }

    /// `PUT /kb/docs/commands/:folder` answer.
    public struct DocCommandSaved: Codable {
        let command: DocCommand
    }

    /// `DELETE` answer for either family. `folderRemoved` is false when user
    /// files remain in the folder.
    public struct DocDeleteResult: Codable, Equatable {
        public let deleted: Bool
        public let folderName: String
        public let folderRemoved: Bool
    }

    /// `POST /kb/docs/seed` answer: the project-relative paths written this call.
    public struct DocSeedResult: Codable, Equatable {
        public let written: [String]
        public let count: Int
    }

    // MARK: - Calls

    /// Register `root` for `id` with the server. Idempotent: the server keeps
    /// one folder per (user, id), so re-registering the same pair is a no-op.
    func registerProject(id: String, root: String) async throws -> DocProjectRegistration {
        try await docsCall {
            try await post("/kb/projects/register",
                           body: DocProjectRegistrationRequest(id: id, root: root),
                           authenticated: true)
        }
    }

    func listDocTemplates(project: String) async throws -> DocTemplatesPage {
        try await docsCall {
            try await get("/kb/docs/templates?project=\(percentEncoded(project))", authenticated: true)
        }
    }

    func listDocCommands(project: String) async throws -> DocCommandsPage {
        try await docsCall {
            try await get("/kb/docs/commands?project=\(percentEncoded(project))", authenticated: true)
        }
    }

    /// Write `templates/<folder>/template.md`. Pass `rawContent` to write the
    /// exact file text (what the Mac renders); the server then ignores the rest.
    @discardableResult
    func saveDocTemplate(project: String, folder: String, body: DocTemplateWrite) async throws -> DocTemplate {
        let saved: DocTemplateSaved = try await docsCall {
            try await put(docPath("templates", folder: folder, project: project), body: body, authenticated: true)
        }
        return saved.template
    }

    /// Write `commands/<folder>/command.md`. See `saveDocTemplate`.
    @discardableResult
    func saveDocCommand(project: String, folder: String, body: DocCommandWrite) async throws -> DocCommand {
        let saved: DocCommandSaved = try await docsCall {
            try await put(docPath("commands", folder: folder, project: project), body: body, authenticated: true)
        }
        return saved.command
    }

    /// Remove `templates/<folder>/template.md`, and the folder when it is empty.
    @discardableResult
    func deleteDocTemplate(project: String, folder: String) async throws -> DocDeleteResult {
        try await docsCall {
            try await delete(docPath("templates", folder: folder, project: project), authenticated: true)
        }
    }

    /// Remove `commands/<folder>/command.md`, and the folder when it is empty.
    @discardableResult
    func deleteDocCommand(project: String, folder: String) async throws -> DocDeleteResult {
        try await docsCall {
            try await delete(docPath("commands", folder: folder, project: project), authenticated: true)
        }
    }

    /// Write the README files and the kit's templates and commands, where
    /// absent. The server seeds from its own generation library, so no kit is sent.
    @discardableResult
    func seedDocFiles(project: String) async throws -> DocSeedResult {
        try await docsCall {
            try await post("/kb/docs/seed?project=\(percentEncoded(project))",
                           body: EmptyBody(), authenticated: true)
        }
    }

    private func docPath(_ family: String, folder: String, project: String) -> String {
        "/kb/docs/\(family)/\(percentEncoded(folder))?project=\(percentEncoded(project))"
    }

    /// Runs one Doc Gen route and maps its HTTP failure to `DocFilesServerError`.
    /// Transport failures and an unrecoverable 401 pass through unchanged.
    private func docsCall<T>(_ call: () async throws -> T) async throws -> T {
        do {
            return try await call()
        } catch APIError.http(let status, let code, let message, _) {
            throw DocFilesServerError.from(status: status, code: code, message: message)
        }
    }
}
