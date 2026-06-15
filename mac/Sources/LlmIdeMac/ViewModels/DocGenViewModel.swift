import AppKit
import Foundation

@MainActor
final class DocGenViewModel: ObservableObject {
    @Published var selectedSources: Set<DocGenSource> = []
    @Published var selectedTemplate: DocTemplate?
    @Published private(set) var generationState: GenerationState = .idle

    enum GenerationState {
        case idle
        case generating
        /// Content is ready. `skipped` lists any source file names that couldn't be read.
        case done(String, skipped: [String])
        case error(String)
    }

    private var generationTask: Task<Void, Never>?

    var canGenerate: Bool { !selectedSources.isEmpty && selectedTemplate != nil }

    func generate(api: LlmIdeAPIClient) {
        guard let template = selectedTemplate else { return }
        generationTask?.cancel()
        generationState = .generating

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
                let result = try await api.generateDoc(
                    templateName: template.name,
                    sections: template.sections,
                    sources: sources)
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
    }

    func resetToIdle() {
        generationState = .idle
    }

    /// Export the generated markdown.  When `projectRoot` is supplied the file
    /// is written into `<projectRoot>/plans/` (creating the directory if
    /// needed); otherwise it falls back to the user's Downloads folder.
    func exportMarkdown(content: String, api: LlmIdeAPIClient, projectRoot: URL?) {
        let filename = selectedTemplate.map { "\($0.name)-doc" } ?? "generated-doc"
        do {
            let url = try api.exportMarkdown(content: content, filename: filename, projectRoot: projectRoot)
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            let alert = NSAlert()
            alert.messageText = "Export Failed"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
