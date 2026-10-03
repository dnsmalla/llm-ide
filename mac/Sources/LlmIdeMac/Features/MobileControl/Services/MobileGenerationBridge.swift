import Foundation
import SharedProtocol

/// Serves the `generation_*` and `llmdoc_*` slices of the mobile protocol on
/// behalf of `MobileControlManager` (held behind `MobileFeatureBridge`, like
/// the Loop and Auto Task bridges).
///
/// Doc Gen and Visual are one generator: this runs `generateDoc` directly with
/// the phone's own sources and NOT through `GenerationRegistry.shared`, whose
/// view models the Mac's Doc Gen / Visual tabs observe — driving those would
/// overwrite what the user is looking at and trip their `isBusy`.
///
/// Every phone run is saved on the Mac under `<project>/llm-doc/generated/`
/// (never the Doc Gen output folder, which defaults to `data/`), so the same
/// folder the phone can browse is where results land.
@MainActor
final class MobileGenerationBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?
    private let templates: DocTemplateStore
    private let commands: DocCommandStore

    /// Subfolder of `llm-doc/` phone runs are saved into.
    static let saveSubfolder = "generated"

    init(manager: MobileControlManager, templates: DocTemplateStore, commands: DocCommandStore) {
        self.manager = manager
        self.templates = templates
        self.commands = commands
    }

    // MARK: - MobileFeatureBridge

    func handle(type: String, data: Data?) -> Bool {
        switch type {
        case MobileProtocol.Tag.generationOptionsList:
            manager?.reply(buildOptions())
            return true

        case MobileProtocol.Tag.generationRun:
            guard let run = try? manager?.decoder.decode(GenerationRun.self, from: data ?? Data()) else {
                // Answer under the phone's OWN commandId — it keys the pending run on it,
                // so a literal "generation_run" would leave the spinner running.
                let id = Self.envelopeValue("commandId", in: data) ?? "generation_run"
                manager?.reply(GenerationResult(commandId: id, ok: false,
                    error: "The Mac could not read this generation request. Update LLM-IDE on both devices to matching versions."))
                return true
            }
            guard manager?.phoneAccess.isAllowed(.generationRun) == true else {
                manager?.reply(GenerationResult(commandId: run.commandId, ok: false,
                                                error: PhoneAccess.generationRun.deniedMessage))
                return true
            }
            manager?.registerMobileInflightTask(commandId: run.commandId) { [weak self] in
                await self?.execute(run)
            }
            return true

        case MobileProtocol.Tag.llmDocList:
            guard let req = try? manager?.decoder.decode(LlmDocList.self, from: data ?? Data()) else {
                manager?.reply(LlmDocListing(path: Self.envelopeValue("path", in: data) ?? "", entries: [],
                                             error: "The Mac could not read this request."))
                return true
            }
            guard let root = notesDir else {
                manager?.reply(LlmDocListing(path: req.path, entries: [], error: "Open a project on the Mac first."))
                return true
            }
            Task { [weak self] in
                let listing = await Task.detached { LlmDocBrowser.list(root: root, relative: req.path) }.value
                self?.manager?.reply(listing)
            }
            return true

        case MobileProtocol.Tag.llmDocRead:
            guard let req = try? manager?.decoder.decode(LlmDocRead.self, from: data ?? Data()) else {
                manager?.reply(LlmDocFile(path: Self.envelopeValue("path", in: data) ?? "", text: nil,
                                          error: "The Mac could not read this request."))
                return true
            }
            guard let root = notesDir else {
                manager?.reply(LlmDocFile(path: req.path, text: nil, error: "Open a project on the Mac first."))
                return true
            }
            Task { [weak self] in
                let file = await Task.detached { LlmDocBrowser.read(root: root, relative: req.path) }.value
                self?.manager?.reply(file)
            }
            return true

        default:
            return false
        }
    }

    func installPushObservers() {}
    func removePushObservers() {}

    // MARK: - Helpers

    private var projectRoot: URL? {
        guard let config = manager?.config, let store = manager?.projectStore else { return nil }
        return WorkspaceRoot.context(config: config, projectStore: store)?.projectRoot
    }

    private var notesDir: URL? { projectRoot.map { ProjectLayout(root: $0).notesDir } }

    private func buildOptions() -> GenerationOptions {
        let folder = "llm-doc/\(Self.saveSubfolder)"
        guard projectRoot != nil else {
            return GenerationOptions(available: false, projectName: nil, templates: [], commands: [], saveFolder: folder)
        }
        func choices<T>(_ items: [T], id: (T) -> UUID, name: (T) -> String, surface: TemplateSurface) -> [GenerationChoice] {
            items.map { GenerationChoice(id: id($0).uuidString, name: name($0), surface: surface.rawValue) }
        }
        var templateChoices: [GenerationChoice] = []
        var commandChoices: [GenerationChoice] = []
        for surface in TemplateSurface.allCases {
            templateChoices += choices(templates.templates(for: surface), id: { $0.id }, name: { $0.name }, surface: surface)
            commandChoices += choices(commands.commands(for: surface), id: { $0.id }, name: { $0.name }, surface: surface)
        }
        return GenerationOptions(available: true,
                                 projectName: manager?.projectStore?.activeProject?.bundle.displayName,
                                 templates: templateChoices, commands: commandChoices, saveFolder: folder)
    }

    private func fail(_ run: GenerationRun, _ message: String) {
        manager?.reply(GenerationResult(commandId: run.commandId, ok: false, error: message))
    }

    private func execute(_ run: GenerationRun) async {
        guard let manager else { return }
        guard let notes = notesDir else { return fail(run, "Open a project on the Mac first.") }
        guard let api = manager.api else { return fail(run, "The Mac isn't ready to generate yet — its backend isn't connected.") }
        let surface = TemplateSurface(rawValue: run.surface) ?? .doc
        let template = run.templateId.flatMap { id in templates.templates(for: surface).first { $0.id.uuidString == id } }
        let command = run.commandRefId.flatMap { id in commands.commands(for: surface).first { $0.id.uuidString == id } }
        // A stale id (the project or its templates changed since the phone listed them) must
        // say so, not quietly run with whichever of the two still resolves.
        if run.templateId != nil && template == nil {
            return fail(run, "That template is no longer available. Reopen Generate to refresh the list.")
        }
        if run.commandRefId != nil && command == nil {
            return fail(run, "That command is no longer available. Reopen Generate to refresh the list.")
        }
        guard template != nil || command != nil else {
            return fail(run, "Pick a template or a command first.")
        }
        let sources = run.sources.filter { !$0.text.isEmpty }.map { (name: $0.name, content: $0.text) }
        guard !sources.isEmpty else { return fail(run, "Attach at least one text file to generate from.") }

        manager.append(.info, "generation_run \(surface.rawValue) (\(sources.count) source(s))")
        let prompt = run.prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let result = try await api.generateDoc(
                templateName: template?.name, sections: template?.sections,
                command: command?.instruction,
                prompt: (prompt?.isEmpty ?? true) ? nil : prompt,
                sources: sources)
            // A phone-side Stop already answered "Cancelled"; stay silent.
            guard !Task.isCancelled else { return }
            let base = Self.safeFileBase(template.map { "\($0.name)-doc" } ?? command.map { "\($0.name)-doc" } ?? "generated-doc")
            var savedPath: String?
            var saveError: String?
            do {
                let dir = notes.appendingPathComponent(Self.saveSubfolder, isDirectory: true)
                let url = try api.exportMarkdown(content: result.content, filename: base, directory: dir)
                savedPath = Self.relativePath(of: url, under: notes)
                if savedPath == nil {
                    saveError = "Generated and saved, but the file isn't inside llm-doc, so the phone can't open it."
                }
            } catch {
                saveError = "Generated, but saving on the Mac failed: \(error.localizedDescription)"
            }
            manager.reply(GenerationResult(
                commandId: run.commandId, ok: true, title: base, markdown: result.content,
                savedPath: savedPath, skipped: [],
                notice: GenerationViewModel.sourceFitNotice(for: result, sentCount: sources.count),
                error: saveError))
        } catch {
            guard !Task.isCancelled else { return }
            fail(run, error.localizedDescription)
        }
    }

    /// One JSON string field from a raw frame — enough to answer a request whose full body
    /// didn't decode (version skew) under the id/path the phone is waiting on.
    nonisolated static func envelopeValue(_ key: String, in data: Data?) -> String? {
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = obj[key] as? String, !value.isEmpty else { return nil }
        return value
    }

    /// A file base name that is safe to write AND visible to the phone's listing: no control
    /// characters, no leading dots (hidden files are skipped by `LlmDocBrowser.list`), no path
    /// separators, and short enough for the filesystem (255 bytes incl. `-NN.md`).
    nonisolated static func safeFileBase(_ raw: String) -> String {
        var s = String(raw.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
        s = s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        s = String(s.drop(while: { $0 == "." || $0 == " " }))
        while s.utf8.count > 200 { s.removeLast() }
        s = s.trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? "generated-doc" : s
    }

    /// `url`'s path relative to `root`, symlink-insensitive (the saved file is
    /// built from `root`, but `/var` vs `/private/var` must not break the cut).
    nonisolated static func relativePath(of url: URL, under root: URL) -> String? {
        let base = root.resolvingSymlinksInPath().standardizedFileURL.path + "/"
        let full = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard full.hasPrefix(base) else { return nil }
        return String(full.dropFirst(base.count))
    }
}
