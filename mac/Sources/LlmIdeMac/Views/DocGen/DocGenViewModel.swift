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
    /// Whether the generated document is editable. Set by the prompt bar's
    /// Edit button after a run completes.
    @Published var isEditing = false
    /// The document as edited. Owned here, NOT by the editor panel, because
    /// Save lives in the prompt bar and must write what the user edited.
    @Published var editedContent: String = ""
    @Published private(set) var generationState: GenerationState = .idle
    /// Source display names that could not be read before the last generate attempt.
    @Published private(set) var unreadableSourceNames: Set<String> = []

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
                isEditing = false
                generationState = .done(result, skipped: skippedSources)
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
        isEditing = false
        editedContent = ""
    }

    /// Write the generated markdown to the configured output folder. Unlike the
    /// old export flow there is no location prompt — the folder is chosen once
    /// in the Setup section.
    func save(content: String, api: LlmIdeAPIClient,
              config: DocGenOutputConfig, projectRoot: URL? = nil) {
        do {
            let url = try api.exportMarkdown(
                content: content,
                filename: outputFilename,
                projectRoot: projectRoot,
                directory: config.resolvedDirectory(projectRoot: projectRoot))
            NSWorkspace.shared.activateFileViewerSelecting([url])
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
