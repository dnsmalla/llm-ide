import Foundation
import os.log

private let logger = Logger(subsystem: "com.llmide.macapp", category: "DocCommandStore")

/// Owns Doc Gen commands. Mirrors `DocTemplateStore`: project `commands/` when
/// a project is open, shipped built-ins otherwise.
@MainActor
final class DocCommandStore: ObservableObject {
    @Published private(set) var projectCommands: [DocCommand] = []
    /// The last validation answer the server gave a command write. See `DocTemplateStore.serverError`.
    @Published private(set) var serverError: String?
    /// Bumped on every optimistic mutation. See `DocTemplateStore.epoch`.
    private var epoch = 0
    /// Folders with a queued server write or delete not yet finished. See `DocTemplateStore.pendingFolders`.
    private var pendingFolders: [String: Int] = [:]

    /// Project `commands/` when a project is open; otherwise the built-ins.
    /// Project `commands/` when a project is open; otherwise the kit's
    /// defaults — see `DocTemplateStore.templates` for why these are not
    /// app-local constants any more.
    var commands: [DocCommand] {
        currentProjectRoot != nil ? projectCommands : kitCommands
    }

    private var kitCommands: [DocCommand] {
        GenerationLibraryStore.shared.commands.compactMap { entry in
            let folder = entry.folderName
            guard !folder.isEmpty else { return nil }
            let markdown = TemplateSurfaceMarker.ensure(
                in: entry.body, base: DocCommand.markerComment, surface: entry.templateSurface)
            return DocCommand(
                id: DocCommand.stableID(forFolder: folder),
                name: DocCommand.displayName(from: markdown, folderName: folder),
                instruction: DocCommand.instruction(from: markdown),
                rawContent: markdown,
                isBuiltin: true,
                folderName: folder,
                surface: entry.templateSurface)
        }
    }

    /// Commands belonging to one generation menu — see
    /// `DocTemplateStore.templates(for:)` for why this filter exists.
    func commands(for surface: TemplateSurface) -> [DocCommand] {
        commands.filter { $0.surface == surface }
    }

    private var currentProjectRoot: URL?
    private var hasBootstrapped = false

    /// The server path (docGenUseServerStore), attached by `FeatureCatalog`.
    /// See `DocTemplateStore.server`.
    private var server: ServerDocFiles?

    /// Attaches the server path. See `DocTemplateStore.attachServer`.
    func attachServer(_ server: ServerDocFiles) {
        self.server = server
    }

    init() {
        // Nothing to read at init: commands live in the project tree, which
        // isn't known until `reloadProjectCommands(at:)`. `bootstrap()` exists
        // to match DocTemplateStore's lifecycle so AppShell can call both.
    }

    /// Idempotent lifecycle hook, called from AppShell's first `.task` tick.
    func bootstrap() {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
    }

    /// Scan `<project>/commands/*/command.md` and publish project commands.
    func reloadProjectCommands(at projectRoot: URL?) {
        currentProjectRoot = projectRoot
        guard let root = projectRoot else {
            projectCommands = []
            return
        }
        projectCommands = scanProjectCommands(at: root)
        refreshFromServer(at: root)
    }

    /// Import an `.md` file as a command. Requires an open project — commands
    /// live in the project tree, so with no project this is a no-op.
    @discardableResult
    func importMarkdownFile(at url: URL, surface: TemplateSurface = .default) -> DocCommand? {
        guard let root = currentProjectRoot,
              let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        // See DocTemplateStore.importMarkdownFile — the marker has to be in
        // the file, or the rescan puts this command back in the other menu.
        let content = TemplateSurfaceMarker.ensure(
            in: raw, base: DocCommand.markerComment, surface: surface)
        let name = DocCommand.displayName(
            from: content,
            folderName: url.deletingPathExtension().lastPathComponent)
        let slug = uniqueFolderSlug(base: DocCommand.slug(for: name), root: root)
        persistProjectCommand(
            DocCommand(
                id: DocCommand.stableID(forFolder: slug),
                name: name,
                instruction: DocCommand.instruction(from: content),
                rawContent: content,
                folderName: slug,
                isProjectCommand: true,
                surface: surface),
            at: root,
            folderName: slug)
        return projectCommands.first { $0.folderName == slug }
    }

    func delete(id: UUID) {
        guard let root = currentProjectRoot,
              let command = projectCommands.first(where: { $0.id == id }),
              let folder = command.folderName else { return }
        if let server, let backend = server.backend(for: root) {
            // Write-through: the entry is removed on disk first, then the server call is queued.
            let snap = LocalDocFiles.snapshotCommandDelete(at: root, folderName: folder)
            try? LocalDocFiles.removeCommandEntry(folderName: folder, at: root)
            projectCommands.removeAll { $0.id == id }
            epoch += 1
            enqueueServerWrite(root, server: server, folder: folder, rollback: snap, isDelete: true) {
                try await backend.deleteCommand(folderName: folder, root: root)
            }
            return
        }
        try? FileManager.default.removeItem(at: ProjectLayout(root: root).commandDir(named: folder))
        reloadProjectCommands(at: root)
    }

    // MARK: - Project disk I/O

    private func scanProjectCommands(at root: URL) -> [DocCommand] {
        LocalDocFiles.scanCommands(at: root)
    }

    private func write(_ command: DocCommand, at root: URL, folderName: String) {
        // `renderedMarkdown()` — the same call `writeProjectTemplate` makes —
        // rather than rebuilding the body here: the local version dropped
        // `surface`, so a command written without raw content came back
        // from the next scan as a Doc Gen command and vanished from the
        // Visual menu. Unreachable today (every caller passes stamped
        // content), which is exactly why it would have gone unnoticed.
        do {
            try LocalDocFiles.writeCommand(command, at: root, folderName: folderName)
        } catch {
            logger.error("write command \(folderName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Server path (docGenUseServerStore)

    /// Writes one command. See `DocTemplateStore.persistProjectTemplate`.
    private func persistProjectCommand(_ command: DocCommand, at root: URL, folderName: String) {
        guard let server, let backend = server.backend(for: root) else {
            write(command, at: root, folderName: folderName)
            reloadProjectCommands(at: root)
            return
        }
        // Write-through: the file is on disk before the call is queued. See DocTemplateStore.
        let snap = LocalDocFiles.snapshotCommandWrite(at: root, folderName: folderName,
                                                      written: command.renderedMarkdown())
        write(command, at: root, folderName: folderName)
        var next = projectCommands.filter { $0.folderName != folderName }
        next.append(command)
        projectCommands = next.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        epoch += 1
        enqueueServerWrite(root, server: server, folder: folderName, rollback: snap, isDelete: false) {
            try await backend.saveCommand(command, folderName: folderName, root: root)
        }
    }

    /// See `DocTemplateStore.enqueueServerWrite`.
    private func enqueueServerWrite(_ root: URL, server: ServerDocFiles, folder: String,
                                    rollback: LocalDocFiles.EntrySnapshot?, isDelete: Bool,
                                    _ write: @escaping @MainActor () async throws -> Void) {
        pendingFolders[folder, default: 0] += 1
        server.enqueue { [weak self] in
            do {
                try await write()
                self?.serverError = nil
            } catch let error as DocFilesServerError where !(isDelete && error == .notFound) {
                if let rollback { LocalDocFiles.restore(rollback) }
                self?.serverError = error.errorDescription
                logger.error("doc command write refused: \(error.localizedDescription, privacy: .public)")
            } catch {
                logger.error("doc command write failed: \(error.localizedDescription, privacy: .public)")
            }
            if let self {
                let left = (self.pendingFolders[folder] ?? 1) - 1
                self.pendingFolders[folder] = left > 0 ? left : nil
            }
            self?.refreshFromServer(at: root)
        }
    }

    /// Replaces the published commands with the server's list for `root`, unless a
    /// mutation ran after this refresh was queued (then a fresh refresh is queued).
    private func refreshFromServer(at root: URL) {
        guard let server, let backend = server.backend(for: root) else { return }
        let queuedEpoch = epoch
        server.enqueue { [weak self] in
            let list: [DocCommand]
            do {
                list = try await backend.listCommands(root: root)
            } catch let error as DocFilesServerError {
                self?.serverError = error.errorDescription
                return
            } catch {
                return
            }
            guard let self, self.currentProjectRoot?.path == root.path else { return }
            guard self.epoch == queuedEpoch else {
                self.refreshFromServer(at: root)
                return
            }
            self.projectCommands = list
        }
    }

    /// Append `-2`, `-3`, … until the folder name is free.
    /// See `DocTemplateStore.uniqueFolderSlug`: with the server path on, a name held by
    /// the optimistic list or a queued write is taken too.
    private func uniqueFolderSlug(base: String, root: URL) -> String {
        let layout = ProjectLayout(root: root)
        let serving = server?.serves(root) == true
        func taken(_ slug: String) -> Bool {
            if FileManager.default.fileExists(atPath: layout.commandDir(named: slug).path) { return true }
            guard serving else { return false }
            return pendingFolders[slug] != nil || projectCommands.contains { $0.folderName == slug }
        }
        var slug = base
        var n = 2
        while taken(slug) {
            slug = "\(base)-\(n)"
            n += 1
        }
        return slug
    }
}
