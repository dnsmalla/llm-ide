import AppKit
import Foundation

@MainActor
final class DocGenViewModel: ObservableObject {
    @Published var selectedSources: Set<DocGenSource> = []
    @Published var selectedTemplate: DocTemplate?
    /// A reusable instruction. Either a template or a command is enough to
    /// generate; both may be selected together.
    @Published var selectedCommand: DocCommand?
    /// The short, per-run instruction typed in the prompt bar.
    @Published var prompt: String = ""
    /// The instruction typed after pressing Edit — describes the revision to
    /// make, not free-form document text. Consumed (and cleared) by
    /// `applyEdit(api:)`.
    @Published var editPrompt: String = ""
    /// The generated document. Owned here, NOT by the editor panel, because
    /// Save and Edit live in the prompt bar and must act on this text. The
    /// document is always read-only in the UI — the only way it changes is a
    /// fresh `generate` or an `applyEdit` round-trip through the model.
    @Published var editedContent: String = ""
    @Published private(set) var generationState: GenerationState = .idle
    /// Source display names that could not be read before the last generate attempt.
    @Published private(set) var unreadableSourceNames: Set<String> = []
    /// True once the current document has been written to disk by `save`;
    /// false whenever a new document lands (a fresh generation or an applied
    /// edit). Drives disabling Edit/Save after a successful save (pressing
    /// Save twice used to silently write a second `-1` file) and drives the
    /// "Start another" discard confirmation (confirm only when there is a
    /// genuinely unsaved document).
    @Published private(set) var isSaved = false

    enum GenerationState {
        case idle
        case generating
        /// Content is ready. `skipped` lists any source file names that couldn't be read.
        case done(String, skipped: [String])
        case error(String)
    }

    private var generationTask: Task<Void, Never>?

    var canGenerate: Bool {
        (selectedTemplate != nil || selectedCommand != nil) && !selectedSources.isEmpty
    }

    /// True while a run (fresh generate or applied edit) is in flight. Drives
    /// a single `.disabled` on the left panel's container so Setup, Template &
    /// Command, and Sources can't desync from the run — see `DocGenSourcePanel`.
    var isBusy: Bool {
        if case .generating = generationState { return true }
        return false
    }

    /// Base filename for a save: template name, else command name, else a
    /// generic fallback. `.md` is appended by `exportMarkdown`.
    var outputFilename: String {
        if let template = selectedTemplate { return "\(template.name)-doc" }
        if let command = selectedCommand { return "\(command.name)-doc" }
        return "generated-doc"
    }

    func generate(api: LlmIdeAPIClient) {
        guard canGenerate else { return }
        let template = selectedTemplate
        let command = selectedCommand
        let userPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        generationTask?.cancel()
        generationState = .generating
        unreadableSourceNames = []

        generationTask = Task {
            do {
                var sources: [(name: String, content: String)] = []
                var skippedSources: [String] = []
                for source in selectedSources {
                    guard !Task.isCancelled else { return }
                    switch source {
                    case .meeting(let id, let title):
                        if let detail = try? await api.getMeeting(id: id) {
                            var content = detail.transcript ?? ""
                            if let entities = detail.entities, !entities.isEmpty {
                                let summary = entities
                                    .map { "[\($0.kind)] \($0.text)" }
                                    .joined(separator: "\n")
                                content += "\n\n" + summary
                            }
                            sources.append((name: title, content: content))
                        } else {
                            skippedSources.append(title)
                        }
                    case .file(let url, let name):
                        if let content = try? String(contentsOf: url, encoding: .utf8) {
                            sources.append((name: name, content: content))
                        } else {
                            skippedSources.append(name)
                        }
                    }
                }
                guard !Task.isCancelled else { return }
                unreadableSourceNames = Set(skippedSources)
                guard !sources.isEmpty else {
                    generationState = .error(
                        skippedSources.isEmpty
                            ? "No readable source content. Select .md or .txt files from the Library."
                            : "Could not read any selected sources: \(skippedSources.joined(separator: ", "))")
                    return
                }
                let result = try await api.generateDoc(
                    templateName: template?.name,
                    sections: template?.sections,
                    command: command?.instruction,
                    prompt: userPrompt.isEmpty ? nil : userPrompt,
                    sources: sources)
                editedContent = result
                isSaved = false
                generationState = .done(result, skipped: skippedSources)
            } catch {
                if !Task.isCancelled {
                    generationState = .error(error.localizedDescription)
                }
            }
        }
    }

    /// Prompt-driven revision: sends the CURRENT document back through the
    /// existing `/generate-doc` endpoint as the source material, with the
    /// user's instruction as the request's `prompt`, and replaces the
    /// document with the result. Reuses the currently selected
    /// template/command exactly as `generate` does, so the document keeps
    /// its shape (headings/sections) across the revision.
    ///
    /// No server change: this is the same endpoint `generate(api:)` calls,
    /// just with the document-so-far as the (only) source instead of the
    /// original meeting/file sources.
    func applyEdit(api: LlmIdeAPIClient) {
        let instruction = editPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { return }
        let currentDocument = editedContent
        let template = selectedTemplate
        let command = selectedCommand

        // Framed so the model treats this as a revision of the attached
        // document rather than a fresh draft, and returns the whole thing —
        // both the source name and the prompt say so, since either alone
        // could read as "write something new" or "describe the change".
        let revisionPrompt = """
        Revise the existing document below (attached as the source named \
        "Current document") according to this instruction. Return the FULL \
        revised document as your entire output — not a diff, not just the \
        changed section, and no commentary before or after it.

        Instruction: \(instruction)
        """
        let sourceName = "Current document (existing draft to revise — " +
            "return the complete revised document, not a diff or fragment)"

        generationTask?.cancel()
        generationState = .generating
        unreadableSourceNames = []

        generationTask = Task {
            do {
                let result = try await api.generateDoc(
                    templateName: template?.name,
                    sections: template?.sections,
                    command: command?.instruction,
                    prompt: revisionPrompt,
                    sources: [(name: sourceName, content: currentDocument)])
                editedContent = result
                editPrompt = ""
                isSaved = false
                generationState = .done(result, skipped: [])
            } catch {
                if !Task.isCancelled {
                    generationState = .error(error.localizedDescription)
                }
            }
        }
    }

    func cancelGeneration() {
        generationTask?.cancel()
        generationState = .idle
        unreadableSourceNames = []
    }

    func resetToIdle() {
        generationState = .idle
        unreadableSourceNames = []
        editPrompt = ""
        editedContent = ""
        isSaved = false
    }

    /// Write the generated markdown to the configured output folder. Unlike the
    /// old export flow there is no location prompt — the folder is chosen once
    /// in the Setup section.
    ///
    /// `revealInFinder` defaults to `true` (real production behavior is
    /// unchanged — every call site in the app still gets the Finder
    /// reveal). It exists solely so a unit test can drive a real save
    /// (still writing a real file, so `isSaved`/dedupe behavior stay
    /// genuinely covered) without popping a Finder window from a headless
    /// test run.
    func save(content: String, api: LlmIdeAPIClient,
              config: DocGenOutputConfig, projectRoot: URL? = nil,
              revealInFinder: Bool = true) {
        do {
            let url = try api.exportMarkdown(
                content: content,
                filename: outputFilename,
                projectRoot: projectRoot,
                directory: config.resolvedDirectory(projectRoot: projectRoot))
            isSaved = true
            if revealInFinder {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            // A doc saved into the project is a new Library file; nudge the
            // sidebar to rescan (the de-facto "library changed" signal) so it
            // appears immediately instead of only after the next index event.
            if projectRoot != nil {
                NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Save Failed"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
