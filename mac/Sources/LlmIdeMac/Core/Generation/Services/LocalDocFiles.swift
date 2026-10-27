import Foundation
import os.log

private let logger = Logger(subsystem: "com.llmide.macapp", category: "LocalDocFiles")

/// Doc Gen's project-folder files, read and written by Swift. The scan and
/// write bodies are the ones `DocTemplateStore` and `DocCommandStore` always
/// ran; the stores call these helpers on the preference-off path, so that
/// path is unchanged.
///
/// Symlinks: this path follows them (`FileManager` does), which is what users
/// who linked a template folder into a project see today. The server skips
/// them, so `ServerDocFiles` merges the symlinked entries back in from here.
///
/// Delete is the one place this differs from the store's preference-off
/// path. The store still removes the whole folder, as it always did. The
/// fallback used after a server failure removes only `template.md` /
/// `command.md`, then the folder if it is empty, so a fallback never deletes
/// a user's extra files. Both are documented in docs-kit §8.
@MainActor
struct LocalDocFiles: DocFilesBackend {

    // MARK: - Templates

    /// Scan `<project>/templates/*/template.md`. Skips `auto_task/` and the
    /// ingest layouts, as `DocTemplateStore` always has.
    static func scanTemplates(at root: URL) -> [DocTemplate] {
        let layout = ProjectLayout(root: root)
        let fm = FileManager.default
        guard fm.fileExists(atPath: layout.templatesDir.path),
              let entries = try? fm.contentsOfDirectory(
                at: layout.templatesDir,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]) else {
            return []
        }

        var templates: [DocTemplate] = []
        for entry in entries {
            guard (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
                continue
            }
            let folderName = entry.lastPathComponent
            // `templates/auto_task/` is a flat bag of Auto Task prompts, not a
            // Doc Gen template folder — scanning it would surface whichever
            // prompt sorted first as a bogus document template.
            if folderName == ProjectLayout.autoTaskTemplatesFolderName { continue }
            guard let mdURL = templateMarkdownURL(in: entry),
                  let content = try? String(contentsOf: mdURL, encoding: .utf8) else {
                continue
            }
            // Ingest templates (meeting-note/email-note) are rendered by
            // IngestTemplateRenderer with {{placeholders}} — not Doc Gen
            // material, and their `# {{title}}` heading would surface as a
            // literal "{{title}}" entry in the template picker.
            if content.contains("llmide:ingest-template") { continue }
            templates.append(DocTemplate(
                id: DocTemplate.stableID(forFolder: folderName),
                name: DocTemplate.displayName(from: content, folderName: folderName),
                sections: DocTemplate.sections(from: content),
                rawContent: content,
                folderName: folderName,
                isProjectTemplate: true,
                surface: DocTemplate.surface(from: content)))
        }
        return templates.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The `template.md` in `folder`, or the first `.md` file when there is none.
    static func templateMarkdownURL(in folder: URL) -> URL? {
        let preferred = folder.appendingPathComponent("template.md")
        if FileManager.default.fileExists(atPath: preferred.path) { return preferred }
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]) else { return nil }
        return files.first { $0.pathExtension.lowercased() == "md" }
    }

    /// Write `template.md` under `templates/<folderName>/`, creating the folder.
    /// `renderedMarkdown()` is the same bytes the server writes for `rawContent`.
    static func writeTemplate(_ template: DocTemplate, at root: URL, folderName: String) throws {
        let dir = ProjectLayout(root: root).templateDir(named: folderName)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try template.renderedMarkdown().write(
            to: dir.appendingPathComponent("template.md"),
            atomically: true, encoding: .utf8)
    }

    /// Templates that are symlinked folders. The server never lists these
    /// (it does not follow links), so the server path merges them in from here.
    static func symlinkedTemplates(at root: URL) -> [DocTemplate] {
        let links = Set(symlinkedFolders(in: ProjectLayout(root: root).templatesDir))
        guard !links.isEmpty else { return [] }
        return scanTemplates(at: root).filter { links.contains($0.folderName ?? "") }
    }

    // MARK: - Commands

    /// Scan `<project>/commands/*/command.md`.
    static func scanCommands(at root: URL) -> [DocCommand] {
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

    static func commandMarkdownURL(in folder: URL) -> URL? {
        let preferred = folder.appendingPathComponent("command.md")
        if FileManager.default.fileExists(atPath: preferred.path) { return preferred }
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]) else { return nil }
        return files.first { $0.pathExtension.lowercased() == "md" }
    }

    /// Write `command.md` under `commands/<folderName>/`, creating the folder.
    /// `renderedMarkdown()` — see `writeTemplate`.
    static func writeCommand(_ command: DocCommand, at root: URL, folderName: String) throws {
        let dir = ProjectLayout(root: root).commandDir(named: folderName)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try command.renderedMarkdown().write(
            to: dir.appendingPathComponent("command.md"),
            atomically: true, encoding: .utf8)
    }

    /// Commands that are symlinked folders. See `symlinkedTemplates`.
    static func symlinkedCommands(at root: URL) -> [DocCommand] {
        let links = Set(symlinkedFolders(in: ProjectLayout(root: root).commandsDir))
        guard !links.isEmpty else { return [] }
        return scanCommands(at: root).filter { links.contains($0.folderName ?? "") }
    }

    // MARK: - Delete (fallback rule)

    /// Remove `template.md`, then the folder if that left it empty. Never
    /// recursive: a user's extra files in the folder survive.
    static func removeTemplateEntry(folderName: String, at root: URL) throws {
        try removeEntry(file: "template.md",
                        folder: ProjectLayout(root: root).templateDir(named: folderName))
    }

    /// The command counterpart of `removeTemplateEntry`.
    static func removeCommandEntry(folderName: String, at root: URL) throws {
        try removeEntry(file: "command.md",
                        folder: ProjectLayout(root: root).commandDir(named: folderName))
    }

    private static func removeEntry(file: String, folder: URL) throws {
        let fm = FileManager.default
        let entry = folder.appendingPathComponent(file)
        if fm.fileExists(atPath: entry.path) {
            try fm.removeItem(at: entry)
        }
        // Empty means no entry at all, hidden files included, as rmdir sees it.
        if let rest = try? fm.contentsOfDirectory(atPath: folder.path), rest.isEmpty {
            try fm.removeItem(at: folder)
        }
    }

    // MARK: - Helpers

    /// Folders directly under `dir` that are symlinks (the entry itself is a link).
    private static func symlinkedFolders(in dir: URL) -> [String] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.isSymbolicLinkKey],
            options: [.skipsHiddenFiles]) else { return [] }
        return entries.compactMap { entry in
            let isLink = (try? entry.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true
            let isFolder = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            return isLink && isFolder ? entry.lastPathComponent : nil
        }
    }

    // MARK: - DocFilesBackend

    func listTemplates(root: URL) async throws -> [DocTemplate] {
        Self.scanTemplates(at: root)
    }

    func listCommands(root: URL) async throws -> [DocCommand] {
        Self.scanCommands(at: root)
    }

    func saveTemplate(_ template: DocTemplate, folderName: String, root: URL) async throws {
        try Self.writeTemplate(template, at: root, folderName: folderName)
    }

    func deleteTemplate(folderName: String, root: URL) async throws {
        try Self.removeTemplateEntry(folderName: folderName, at: root)
    }

    func saveCommand(_ command: DocCommand, folderName: String, root: URL) async throws {
        try Self.writeCommand(command, at: root, folderName: folderName)
    }

    func deleteCommand(folderName: String, root: URL) async throws {
        try Self.removeCommandEntry(folderName: folderName, at: root)
    }

    func seed(root: URL,
              templateKit: [LlmIdeAPIClient.GenerationLibraryEntry],
              commandKit: [LlmIdeAPIClient.GenerationLibraryEntry]) async throws {
        ProjectDocTemplatesSeeder.seedIfNeeded(at: root, kit: templateKit)
        ProjectDocCommandsSeeder.seedIfNeeded(at: root, kit: commandKit)
    }
}
