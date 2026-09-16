import Foundation
import os.log

private let logger = Logger(subsystem: "com.llmide.macapp", category: "DocCommandStore")

/// Owns Doc Gen commands. Mirrors `DocTemplateStore`: project `commands/` when
/// a project is open, shipped built-ins otherwise.
@MainActor
final class DocCommandStore: ObservableObject {
    @Published private(set) var projectCommands: [DocCommand] = []

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
        write(
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
        reloadProjectCommands(at: root)
        return projectCommands.first { $0.folderName == slug }
    }

    func delete(id: UUID) {
        guard let root = currentProjectRoot,
              let command = projectCommands.first(where: { $0.id == id }),
              let folder = command.folderName else { return }
        try? FileManager.default.removeItem(at: ProjectLayout(root: root).commandDir(named: folder))
        reloadProjectCommands(at: root)
    }

    // MARK: - Project disk I/O

    private func scanProjectCommands(at root: URL) -> [DocCommand] {
        let layout = ProjectLayout(root: root)
        let fm = FileManager.default
        guard fm.fileExists(atPath: layout.commandsDir.path),
              let entries = try? fm.contentsOfDirectory(
                at: layout.commandsDir,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]) else {
            return []
        }

        var commands: [DocCommand] = []
        for entry in entries {
            guard (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
                continue
            }
            let folderName = entry.lastPathComponent
            guard let mdURL = commandMarkdownURL(in: entry),
                  let content = try? String(contentsOf: mdURL, encoding: .utf8) else {
                continue
            }
            commands.append(DocCommand(
                id: DocCommand.stableID(forFolder: folderName),
                name: DocCommand.displayName(from: content, folderName: folderName),
                instruction: DocCommand.instruction(from: content),
                rawContent: content,
                folderName: folderName,
                isProjectCommand: true,
                surface: DocCommand.surface(from: content)))
        }
        return commands.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func commandMarkdownURL(in folder: URL) -> URL? {
        let preferred = folder.appendingPathComponent("command.md")
        if FileManager.default.fileExists(atPath: preferred.path) { return preferred }
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]) else { return nil }
        return files.first { $0.pathExtension.lowercased() == "md" }
    }

    private func write(_ command: DocCommand, at root: URL, folderName: String) {
        let dir = ProjectLayout(root: root).commandDir(named: folderName)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            // `renderedMarkdown()` — the same call `writeProjectTemplate` makes —
            // rather than rebuilding the body here: the local version dropped
            // `surface`, so a command written without raw content came back
            // from the next scan as a Doc Gen command and vanished from the
            // Visual menu. Unreachable today (every caller passes stamped
            // content), which is exactly why it would have gone unnoticed.
            try command.renderedMarkdown().write(
                to: dir.appendingPathComponent("command.md"),
                atomically: true, encoding: .utf8)
        } catch {
            logger.error("write command \(folderName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Append `-2`, `-3`, … until the folder name is free.
    private func uniqueFolderSlug(base: String, root: URL) -> String {
        let layout = ProjectLayout(root: root)
        var slug = base
        var n = 2
        while FileManager.default.fileExists(atPath: layout.commandDir(named: slug).path) {
            slug = "\(base)-\(n)"
            n += 1
        }
        return slug
    }
}
