import AppKit
import Foundation

@MainActor
final class GenerationViewModel: ObservableObject {
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
    /// A dismissible inline message for the LAST revision attempt only (too
    /// long to send, request failed, cancelled). NEVER routed through
    /// `.error(...)` the way `generate()`'s failures are — an initial
    /// generation has no prior document to protect, but a revision does:
    /// on failure `applyEdit` leaves `generationState` at
    /// `.done(<pre-edit document>, ...)` and reports the problem here
    /// instead, so the document a revision failed to improve is never lost.
    @Published var editError: String?
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
    /// Snapshot of the document as it stood right before the in-flight
    /// revision started; nil whenever a fresh `generate()` (not an
    /// `applyEdit`) is in flight, or when nothing is in flight at all.
    /// `cancelGeneration()` reads this to know what a Cancel press should
    /// restore: a fresh generation has no prior document (→ `.idle`), a
    /// revision does (→ back to `.done(thatDocument, ...)`).
    private var preRevisionDocument: String?

    /// Mirrors the server's `MAX_SOURCE_CONTENT` cap in
    /// `extension/server/export-routes.mjs` (`/generate-doc` truncates any
    /// single source past this length before building the prompt). Checked
    /// here so a revision of a document past this length is refused up
    /// front with a clear message, instead of silently revising a
    /// truncated copy and overwriting the original with the (now
    /// tail-shorter) result.
    private static let maxRevisionSourceChars = 50_000

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
        preRevisionDocument = nil // this is a fresh generation, not a revision
        editError = nil
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
    ///
    /// Invariant: no revision failure may leave the user with less than
    /// they had before pressing Apply. Unlike `generate()` — which has no
    /// prior document to protect, so `.error(...)` is the right terminal
    /// state for it — a failed or refused revision here always leaves
    /// `generationState` at `.done(<pre-edit document>, ...)` with
    /// `editedContent` untouched, and reports the problem via `editError`
    /// instead. `cancelGeneration()` restores the same way for a cancelled
    /// revision (see `preRevisionDocument`).
    func applyEdit(api: LlmIdeAPIClient) {
        let instruction = editPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { return }
        let currentDocument = editedContent

        // Refuse up front rather than silently revising a truncated copy:
        // the server truncates any source over maxRevisionSourceChars
        // before building the prompt, so a document past that would come
        // back revised-from-a-truncated-copy and overwrite the original
        // with the (silently shorter) result.
        guard currentDocument.count <= Self.maxRevisionSourceChars else {
            editError = "This document is \(currentDocument.count) characters, over the " +
                "\(Self.maxRevisionSourceChars)-character limit for a single revision. " +
                "Save it and start a new document for further changes."
            return
        }

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
        preRevisionDocument = currentDocument
        editError = nil
        generationState = .generating

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
                preRevisionDocument = nil
                generationState = .done(result, skipped: [])
            } catch {
                // Task.isCancelled here means cancelGeneration() already
                // restored generationState synchronously — don't clobber it.
                if !Task.isCancelled {
                    editError = error.localizedDescription
                    generationState = .done(currentDocument, skipped: [])
                    preRevisionDocument = nil
                }
            }
        }
    }

    /// A fresh generation has no prior document, so cancelling it returns to
    /// `.idle` exactly as before. A revision DOES have a prior document
    /// (`preRevisionDocument`, snapshotted at the top of `applyEdit`) —
    /// cancelling it must restore that document rather than dropping to
    /// `.idle`, per the same no-worse-than-before invariant `applyEdit`'s
    /// error path upholds.
    func cancelGeneration() {
        generationTask?.cancel()
        unreadableSourceNames = []
        if let preRevision = preRevisionDocument {
            generationState = .done(preRevision, skipped: [])
        } else {
            generationState = .idle
        }
        preRevisionDocument = nil
    }

    func resetToIdle() {
        generationState = .idle
        unreadableSourceNames = []
        editPrompt = ""
        editError = nil
        editedContent = ""
        isSaved = false
        preRevisionDocument = nil
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
