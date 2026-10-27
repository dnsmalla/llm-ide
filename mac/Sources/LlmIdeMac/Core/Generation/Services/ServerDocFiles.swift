import Foundation
import os.log

private let logger = Logger(subsystem: "com.llmide.macapp", category: "ServerDocFiles")

/// Doc Gen's project template and command files, through the `/kb/docs/*`
/// routes (docs-kit K1b). Behind `docGenUseServerStore`.
///
/// Gating, in order: the preference must be on, a project must be active, the
/// root asked about must be that active project's folder, and the folder must
/// not have been refused this session. Only then does a request go out. With
/// the preference off `serves` is false for every root, so this class makes no
/// network call at all.
///
/// Failures are the caller's to handle: `DocFilesWithFallback` answers from
/// `LocalDocFiles` for any call this class throws on.
///
/// Ordering: the stores are synchronous, so their writes and refreshes are
/// queued on `enqueue` and run one at a time, in the order the user made them.
/// A refresh queued after a write therefore sees that write.
@MainActor
final class ServerDocFiles {
    private let api: LlmIdeAPIClient
    private let preference: DocGenServerStorePreference
    /// The project the app has open: its id and folder. Set by `activate`.
    private var active: (projectId: String, root: URL)?
    /// The last (id, folder) pair the server accepted. Cleared on a 404
    /// `PROJECT_NOT_REGISTERED`, so the next call registers again.
    private var registered: (projectId: String, root: String)?
    /// Folders the server refused this session (`INVALID_ROOT`, or the
    /// registration cap). They stay on the local path until the app restarts.
    private var refusedRoots: Set<String> = []
    /// Messages already logged, so a server that is down logs once, not per call.
    private var logged: Set<String> = []
    /// The end of the operation queue. Each new operation waits for it.
    private var tail: Task<Void, Never>?
    /// Operations queued and not yet finished, including any queued by an operation.
    private var pending = 0

    init(api: LlmIdeAPIClient, preference: DocGenServerStorePreference = DocGenServerStorePreference()) {
        self.api = api
        self.preference = preference
    }

    // MARK: - Gating

    /// Records the open project. No network call: registration happens on
    /// the first server operation (or `prepare`).
    func activate(projectId: String, root: URL) {
        guard Self.isServerProjectId(projectId) else {
            // The server would refuse this id on every call, so keep the project local.
            active = nil
            logOnce("badProjectId", "Doc Gen: this project's id is not one the server accepts, so its files stay local.")
            return
        }
        active = (projectId, root)
    }

    /// The id shape the server accepts (`PROJECT_ID_RE`, extension/kb/project-roots.mjs).
    static func isServerProjectId(_ id: String) -> Bool {
        id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
    }

    /// Whether the server answers for `root` right now.
    func serves(_ root: URL) -> Bool {
        guard preference.isOn,
              let active,
              active.root.path == root.path,
              !refusedRoots.contains(root.path) else { return false }
        return true
    }

    /// The backend to use for `root`, or nil when the local path should run
    /// inline (the preference is off, or the root is not the active project).
    func backend(for root: URL) -> DocFilesBackend? {
        guard serves(root) else { return nil }
        return DocFilesWithFallback(server: self, local: LocalDocFiles())
    }

    /// Registers the active project ahead of its first call, so a refused
    /// folder is known before the user acts. Never throws; a refusal is
    /// logged once and the folder stays local for this session.
    func prepare(_ root: URL) async {
        guard serves(root), let projectId = active?.projectId else { return }
        do {
            try await ensureRegistered(projectId: projectId, root: root)
        } catch {
            noteFallback("register", error)
        }
    }

    // MARK: - Queue

    /// Runs `op` after every operation queued before it.
    func enqueue(_ op: @escaping @MainActor () async -> Void) {
        let previous = tail
        pending += 1
        tail = Task { @MainActor [weak self] in
            await previous?.value
            await op()
            self?.pending -= 1
        }
    }

    /// Waits until everything queued so far, and everything those operations
    /// queue in turn, has finished. Tests use this; the app never waits.
    func drain() async {
        while pending > 0 {
            await tail?.value
            await Task.yield()
        }
    }

    // MARK: - Fallback bookkeeping

    /// Logs that `operation` was answered locally, once per distinct failure.
    func noteFallback(_ operation: String, _ error: Error) {
        logOnce("fallback.\(operation).\(error)",
                "Doc Gen \(operation) answered from local files: \(error.localizedDescription)")
    }

    private func logOnce(_ key: String, _ message: String) {
        guard logged.insert(key).inserted else { return }
        logger.notice("\(message, privacy: .public)")
    }

    // MARK: - Registration

    /// Registers (id, folder) unless the server already has this pair from
    /// this session. A refused folder is remembered and reported as `.invalidRoot`
    /// or `.tooManyProjects`; any other failure is thrown and not remembered.
    private func ensureRegistered(projectId: String, root: URL) async throws {
        let path = root.path
        if registered?.projectId == projectId, registered?.root == path { return }
        do {
            _ = try await api.registerProject(id: projectId, root: path)
            registered = (projectId, path)
        } catch let error as DocFilesServerError where error == .invalidRoot || error == .tooManyProjects {
            refusedRoots.insert(path)
            logOnce("refused.\(path)", "Doc Gen: the server refused the project folder, so it stays on local files this session (\(error.localizedDescription)).")
            throw error
        }
    }

    /// Runs one server operation for the active project. A 404
    /// `PROJECT_NOT_REGISTERED` (the server lost the registration) re-registers
    /// and retries once.
    private func withProject<T>(root: URL, _ operation: (String) async throws -> T) async throws -> T {
        guard serves(root), let projectId = active?.projectId else {
            throw DocFilesServerError.notServing
        }
        try await ensureRegistered(projectId: projectId, root: root)
        do {
            return try await operation(projectId)
        } catch DocFilesServerError.projectNotRegistered {
            registered = nil
            try await ensureRegistered(projectId: projectId, root: root)
            return try await operation(projectId)
        }
    }

    // MARK: - Operations (called by DocFilesWithFallback)

    /// The server's list, plus any template whose `template.md` is a symbolic
    /// link (see `LocalDocFiles.symlinkedTemplates`). A truncated server listing
    /// is an error, so the caller shows the full local listing instead.
    func listTemplates(root: URL) async throws -> [DocTemplate] {
        let page = try await withProject(root: root) { try await api.listDocTemplates(project: $0) }
        guard !page.truncated else { throw DocFilesServerError.truncated }
        let served = Set(page.templates.compactMap(\.folderName))
        let links = LocalDocFiles.symlinkedTemplates(at: root).filter { !served.contains($0.folderName ?? "") }
        return (page.templates + links).sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    /// The command counterpart of `listTemplates`, for a linked `command.md`.
    func listCommands(root: URL) async throws -> [DocCommand] {
        let page = try await withProject(root: root) { try await api.listDocCommands(project: $0) }
        guard !page.truncated else { throw DocFilesServerError.truncated }
        let served = Set(page.commands.compactMap(\.folderName))
        let links = LocalDocFiles.symlinkedCommands(at: root).filter { !served.contains($0.folderName ?? "") }
        return (page.commands + links).sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    /// Sends the exact file text the Mac renders (`renderedMarkdown()`), so the
    /// server writes the same bytes the local path would.
    func saveTemplate(_ template: DocTemplate, folderName: String, root: URL) async throws {
        _ = try await withProject(root: root) { projectId in
            try await api.saveDocTemplate(
                project: projectId, folder: folderName,
                body: LlmIdeAPIClient.DocTemplateWrite(
                    name: template.name, surface: template.surface.rawValue,
                    rawContent: template.renderedMarkdown()))
        }
    }

    func deleteTemplate(folderName: String, root: URL) async throws {
        _ = try await withProject(root: root) { projectId in
            try await api.deleteDocTemplate(project: projectId, folder: folderName)
        }
    }

    func saveCommand(_ command: DocCommand, folderName: String, root: URL) async throws {
        _ = try await withProject(root: root) { projectId in
            try await api.saveDocCommand(
                project: projectId, folder: folderName,
                body: LlmIdeAPIClient.DocCommandWrite(
                    name: command.name, surface: command.surface.rawValue,
                    rawContent: command.renderedMarkdown()))
        }
    }

    func deleteCommand(folderName: String, root: URL) async throws {
        _ = try await withProject(root: root) { projectId in
            try await api.deleteDocCommand(project: projectId, folder: folderName)
        }
    }

    /// The server seeds from its own generation library, which is the source
    /// the Mac's kit cache comes from, so the kits passed in are not sent.
    func seed(root: URL) async throws {
        _ = try await withProject(root: root) { projectId in
            try await api.seedDocFiles(project: projectId)
        }
    }
}

/// Asks the server first and answers from `LocalDocFiles` for any call the
/// server cannot serve (transport failure, 5xx, feature off, refused folder,
/// truncated listing). A validation answer (4xx: TOO_LARGE, INVALID_FOLDER,
/// RESERVED_FOLDER, UNSAFE_PATH, ...) is thrown instead, and nothing is written
/// locally, so the caller can show it. See docs-kit §8 (K1b review).
@MainActor
struct DocFilesWithFallback: DocFilesBackend {
    let server: ServerDocFiles
    let local: DocFilesBackend

    init(server: ServerDocFiles, local: DocFilesBackend? = nil) {
        self.server = server
        self.local = local ?? LocalDocFiles()
    }

    /// Runs the server call; on a failure that `DocFilesServerError.answersLocally`
    /// names, answers from the local files. Any other typed error (a validation
    /// answer) is thrown to the caller with nothing written locally.
    private func attempt<T>(_ operation: String,
                            server serverCall: () async throws -> T,
                            local localCall: () async throws -> T) async throws -> T {
        do {
            return try await serverCall()
        } catch let error as DocFilesServerError where !error.answersLocally {
            throw error
        } catch {
            server.noteFallback(operation, error)
            return try await localCall()
        }
    }

    func listTemplates(root: URL) async throws -> [DocTemplate] {
        try await attempt("listTemplates",
                          server: { try await server.listTemplates(root: root) },
                          local: { try await local.listTemplates(root: root) })
    }

    func listCommands(root: URL) async throws -> [DocCommand] {
        try await attempt("listCommands",
                          server: { try await server.listCommands(root: root) },
                          local: { try await local.listCommands(root: root) })
    }

    func saveTemplate(_ template: DocTemplate, folderName: String, root: URL) async throws {
        try await attempt("saveTemplate",
                          server: { try await server.saveTemplate(template, folderName: folderName, root: root) },
                          local: { try await local.saveTemplate(template, folderName: folderName, root: root) })
    }

    func deleteTemplate(folderName: String, root: URL) async throws {
        try await attempt("deleteTemplate",
                          server: { try await server.deleteTemplate(folderName: folderName, root: root) },
                          local: { try await local.deleteTemplate(folderName: folderName, root: root) })
    }

    func saveCommand(_ command: DocCommand, folderName: String, root: URL) async throws {
        try await attempt("saveCommand",
                          server: { try await server.saveCommand(command, folderName: folderName, root: root) },
                          local: { try await local.saveCommand(command, folderName: folderName, root: root) })
    }

    func deleteCommand(folderName: String, root: URL) async throws {
        try await attempt("deleteCommand",
                          server: { try await server.deleteCommand(folderName: folderName, root: root) },
                          local: { try await local.deleteCommand(folderName: folderName, root: root) })
    }

    func seed(root: URL,
              templateKit: [LlmIdeAPIClient.GenerationLibraryEntry],
              commandKit: [LlmIdeAPIClient.GenerationLibraryEntry]) async throws {
        try await attempt("seed",
                          server: { try await server.seed(root: root) },
                          local: { try await local.seed(root: root, templateKit: templateKit, commandKit: commandKit) })
    }
}

extension DocFilesServerError {
    /// True when the local files should answer a call that failed with this
    /// error: the server is unreachable or failing (a transport error, which is
    /// not a `DocFilesServerError` at all, or 5xx), the feature is off, the
    /// project is not registered, or the folder was refused. Everything else is
    /// a validation answer the caller must see, and it writes nothing locally.
    var answersLocally: Bool {
        switch self {
        case .featureDisabled, .projectNotRegistered, .invalidRoot, .tooManyProjects,
             .notServing, .truncated:
            return true
        case .other(let status, _, _):
            return status >= 500
        case .reservedFolder, .unsafePath, .invalidFolder, .notFound, .tooLarge:
            return false
        }
    }
}
