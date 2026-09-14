import AppKit
import Foundation

@MainActor
final class GenerationViewModel: ObservableObject {
    /// Which generation menu this model drives. Doc Gen and Visual share one
    /// template store over one project folder, so the surface is what tells
    /// the shared UI which half of it to show. Set once by
    /// `GenerationRegistry` from the scope it creates the model for; there is
    /// no case where a model changes surface.
    let surface: TemplateSurface

    init(surface: TemplateSurface = .default) {
        self.surface = surface
    }

    @Published var selectedSources: Set<DocGenSource> = []
    /// Lifts `canGenerate`'s template/command + source requirement. Defaults
    /// false (both tabs' behavior with "Use chat" off, unchanged) — set true
    /// by either tab's own "Use chat" toggle (`VisualSourcePanel`'s
    /// `VISUAL_USE_CHAT`, `DocGenSourcePanel`'s `DOCGEN_USE_CHAT`), where the
    /// chat panel is the primary surface and a template/command/source is
    /// merely optional scaffolding rather than a prerequisite. Each tab owns
    /// its own `GenerationViewModel` instance (`VisualView`/`DocGenView`
    /// `@StateObject`), so one tab's toggle never affects the other's.
    @Published var relaxRequirements: Bool = false
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
    /// What the SERVER could not fit into the last run's prompt, already
    /// phrased for display, or nil when everything was sent whole.
    ///
    /// Distinct from `unreadableSourceNames`: those never reached the model at
    /// all, these reached it partially or not at all. Reported rather than
    /// prevented — the client cannot predict the post-sanitization length the
    /// server budgets on, so the server is the only honest source of this.
    /// Also covers the pre-v52 server that says nothing and silently keeps
    /// only the first 20 sources (see `GeneratedDoc.serverReportsFit`).
    @Published private(set) var sourceFitNotice: String?
    /// `sourceFitNotice` as it stood for the document `lastSavedDocument`
    /// names. Snapshotted at save for the same reason
    /// `lastSavedSkippedSources` is: the reset after a save clears the live
    /// value, and the saved notice is then the only thing left that can say
    /// the saved document was built from less than the whole selection.
    @Published private(set) var lastSavedSourceFitNotice: String?
    /// True once the current document has been written to disk by `save`;
    /// false whenever a new document lands (a fresh generation or an applied
    /// edit). Drives disabling Edit/Save after a successful save (pressing
    /// Save twice used to silently write a second `-1` file) and drives the
    /// "Start another" discard confirmation (confirm only when there is a
    /// genuinely unsaved document).
    @Published private(set) var isSaved = false
    /// The document file `save` last wrote, or nil before the first save of
    /// this tab's session. Deliberately NOT cleared by `resetToIdle()`: a
    /// successful save now returns the panel to the setup view immediately,
    /// and this is what the setup view shows so the user still sees WHERE the
    /// document went. Cleared when the next generation starts, so the notice
    /// never outlives the document it describes.
    @Published private(set) var lastSavedDocument: URL?
    /// Sources that could not be read for the document `lastSavedDocument`
    /// names. Snapshotted at save time because `resetToIdle()` clears the live
    /// `unreadableSourceNames`, and the saved notice is then the only place
    /// left that can say the saved document was built from an incomplete set.
    @Published private(set) var lastSavedSkippedSources: [String] = []
    /// The project `lastSavedDocument` was saved into. The model is owned by
    /// `GenerationRegistry`, so it outlives both the view and the active
    /// project; the setup view shows the notice only while this still matches
    /// the open project, rather than offering Open/Reveal on another
    /// project's file. Derived state beats a notification here — a project
    /// can also be re-linked in place (`ProjectStore.setLinkedRepo` posts
    /// `.activeProjectChanged` for the SAME project), which should not make
    /// the notice vanish.
    @Published private(set) var lastSavedProjectRoot: URL?

    /// Drop the setup view's "Saved …" row. Separate from `resetToIdle()`,
    /// which deliberately keeps it.
    func clearSavedDocumentNotice() {
        lastSavedDocument = nil
        lastSavedSkippedSources = []
        lastSavedSourceFitNotice = nil
        lastSavedProjectRoot = nil
    }
    /// The chat reply text last written by `saveChatOutput`, or nil before
    /// the first save. Gates `GenerationSaveChatOutputRow`'s double-press
    /// dedupe: pressing Save again for the SAME reply is a no-op instead of
    /// writing a second `chat-output-1.md` — only a genuinely new reply
    /// re-arms the button. Lives here (on the view model, which survives for
    /// the whole tab's lifetime) rather than as `@State` on
    /// `GenerationSaveChatOutputRow` itself: that row only exists in the view
    /// tree while "Use chat" is on, so `@State` there was destroyed and
    /// recreated (silently re-arming the button for an already-saved reply)
    /// every time the user toggled "Use chat" off and back on.
    @Published var lastSavedChatReply: String?

    /// `Equatable` so a view can `.onChange(of:)` transitions (e.g. Visual's
    /// `VisualCenterPanel`, which resets its own "viewing image" override the
    /// moment a fresh run starts) without hand-rolling a separate phase enum
    /// just to observe it.
    enum GenerationState: Equatable {
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
    ///
    /// MEASURED IN UTF-16 CODE UNITS, not `String.count`. The server counts
    /// JavaScript string length, which is UTF-16 code units; Swift's `count`
    /// is grapheme clusters, so an emoji-heavy 49 000-grapheme document is
    /// 60 000+ there and used to pass this guard and be truncated anyway.
    /// The residual gap — `sanitizeForPrompt` can LENGTHEN text — is caught
    /// after the fact by the server's own `truncated`/`omitted` report in
    /// `applyEdit`, which refuses to apply the result. That backstop needs a
    /// v52+ server; against an older one this guard is all there is.
    private static let maxRevisionSourceChars = 50_000

    var canGenerate: Bool {
        // Chat mode only lifts the template/command requirement — `generate()`
        // still needs at least one readable source to send, and always fails
        // with "No readable source content…" when `selectedSources` is empty
        // (see the guard partway through `generate()`). Arming the button
        // with nothing to generate from used to present a Generate that
        // instantly failed; see VisualSourcePanel's and DocGenSourcePanel's
        // "Use chat" toggles.
        if relaxRequirements { return !selectedSources.isEmpty }
        return (selectedTemplate != nil || selectedCommand != nil) && !selectedSources.isEmpty
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
        // The setup view's "Saved to …" notice describes the PREVIOUS
        // document; a new run replaces it, so drop it here rather than let it
        // sit under an unrelated result.
        clearSavedDocumentNotice()
        generationState = .generating
        unreadableSourceNames = []
        sourceFitNotice = nil

        generationTask = Task {
            do {
                var sources: [(name: String, content: String)] = []
                var skippedSources: [String] = []
                // Sorted, NOT raw Set order: the server drops from the end of
                // this list when the selection overruns its character budget,
                // so an unordered send would make the dropped file vary
                // between identical runs. See `DocGenSource.sendOrderKey`.
                for source in selectedSources.sorted(by: { $0.sendOrderKey < $1.sendOrderKey }) {
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
                editedContent = result.content
                sourceFitNotice = Self.sourceFitNotice(for: result, sentCount: sources.count)
                isSaved = false
                generationState = .done(result.content, skipped: skippedSources)
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
        let documentLength = currentDocument.utf16.count
        guard documentLength <= Self.maxRevisionSourceChars else {
            editError = "This document is \(documentLength) characters, over the " +
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
                // The up-front `maxRevisionSourceChars` guard is NOT
                // sufficient on its own, so the server's own report is what
                // decides here. Two ways a document that passed the guard is
                // still truncated server-side: Swift's `count` is grapheme
                // clusters while the server measures UTF-16 code units (an
                // emoji-heavy document is far longer there), and
                // `sanitizeForPrompt` can LENGTHEN text. Either way the
                // revision was made from a truncated copy, so applying it
                // would overwrite the original with a shorter one — exactly
                // the loss the guard exists to prevent. Refuse, keep the
                // pre-edit document, and say why.
                guard result.truncatedTotal == 0 && result.omittedTotal == 0 else {
                    editError = "The server could only read part of this document " +
                        "(\(documentLength) characters), so the revision would have " +
                        "replaced it with a shortened copy. The document is unchanged. " +
                        "Save it and start a new document for further changes."
                    generationState = .done(currentDocument, skipped: [])
                    preRevisionDocument = nil
                    return
                }
                editedContent = result.content
                // A revision replaces the document the original run's notice
                // described, so that notice no longer applies.
                sourceFitNotice = nil
                editPrompt = ""
                isSaved = false
                preRevisionDocument = nil
                generationState = .done(result.content, skipped: [])
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
        sourceFitNotice = nil
        editPrompt = ""
        editError = nil
        editedContent = ""
        isSaved = false
        preRevisionDocument = nil
    }

    /// `resetToIdle()` plus every RUN INPUT the user picked: sources,
    /// template, command, prompt, and the "Use chat" toggle.
    ///
    /// Called after a successful save, where the run is finished work: the
    /// panel used to return to setup still carrying the previous document's
    /// 42 ticked files and its template, so the next run silently inherited
    /// them. `resetToIdle()` stays as it was for the paths where the inputs
    /// SHOULD survive — "Try Again" after an error, and "Start another",
    /// where the user is re-running over the same selection.
    ///
    /// `lastSavedDocument` deliberately survives, exactly as it does through
    /// `resetToIdle()`: it is the setup view's "Saved to …" row, the only
    /// thing left telling the user where the document went.
    ///
    /// The "Use chat" toggle lives in `@AppStorage` on the panel views rather
    /// than here, so it is reset through `UserDefaults` on this surface's own
    /// key — writing the key republishes to every `@AppStorage` bound to it.
    func resetInputsToDefaults() {
        resetToIdle()
        selectedSources = []
        selectedTemplate = nil
        selectedCommand = nil
        prompt = ""
        relaxRequirements = false
        UserDefaults.standard.set(false, forKey: Self.useChatDefaultsKey(for: surface))
    }

    /// Phrase what the server could not fit, for `sourceFitNotice`.
    ///
    /// `sentCount` is how many sources the client actually put on the wire,
    /// needed only for the stale-server case: a pre-v52 server reports
    /// nothing and silently keeps just the first 20, so past 20 sent sources
    /// the shortfall is real and must be named even though the server said
    /// nothing about it. Static and pure so the wording is testable.
    static func sourceFitNotice(for result: LlmIdeAPIClient.GeneratedDoc,
                                sentCount: Int) -> String? {
        guard result.serverReportsFit else {
            guard sentCount > Self.legacyServerSourceCap else { return nil }
            let dropped = sentCount - Self.legacyServerSourceCap
            return "This server is out of date: it sent only the first " +
                "\(Self.legacyServerSourceCap) of \(sentCount) sources and ignored the " +
                "other \(dropped). Restart the local server to send them all."
        }
        var parts: [String] = []
        if result.omittedTotal > 0 {
            parts.append("\(result.omittedTotal) source\(result.omittedTotal == 1 ? "" : "s") " +
                "did not fit and \(result.omittedTotal == 1 ? "was" : "were") not sent: " +
                nameList(result.omittedSources, total: result.omittedTotal))
        }
        if result.truncatedTotal > 0 {
            parts.append("\(result.truncatedTotal) source\(result.truncatedTotal == 1 ? "" : "s") " +
                "\(result.truncatedTotal == 1 ? "was" : "were") too long to send in full and " +
                "\(result.truncatedTotal == 1 ? "was" : "were") shortened: " +
                nameList(result.truncatedSources, total: result.truncatedTotal))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// Render a name list that the server may have capped. Joining tens of
    /// thousands of names into one `Text` is unreadable (and was what the
    /// uncapped version did), so anything past what the server sent is
    /// summarised as a count.
    private static func nameList(_ names: [String], total: Int) -> String {
        let shown = names.joined(separator: ", ")
        guard total > names.count else { return shown }
        let rest = total - names.count
        return shown.isEmpty
            ? "\(rest) source\(rest == 1 ? "" : "s")"
            : "\(shown) and \(rest) more"
    }

    /// The source cap a pre-v52 server applies silently
    /// (`export-routes.mjs`'s old `body.sources.slice(0, 20)`).
    private static let legacyServerSourceCap = 20

    /// The `@AppStorage` key backing this surface's "Use chat" toggle. Doc Gen
    /// and Visual each own theirs (`DocGenSourcePanel` / `VisualSourcePanel`
    /// and their prompt bars all declare the same two literals) — keep these
    /// in sync with those declarations.
    static func useChatDefaultsKey(for surface: TemplateSurface) -> String {
        switch surface {
        case .doc:    return "DOCGEN_USE_CHAT"
        case .visual: return "VISUAL_USE_CHAT"
        }
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
    ///
    /// Returns whether the write succeeded, so the caller can return the
    /// panel to its setup view on success (and leave the document on screen
    /// when the write failed and the user still has unsaved work).
    @discardableResult
    func save(content: String, api: LlmIdeAPIClient,
              config: DocGenOutputConfig, projectRoot: URL? = nil,
              revealInFinder: Bool = true) -> Bool {
        do {
            let url = try api.exportMarkdown(
                content: content,
                filename: outputFilename,
                projectRoot: projectRoot,
                directory: config.resolvedDirectory(projectRoot: projectRoot))
            isSaved = true
            lastSavedDocument = url
            lastSavedSkippedSources = unreadableSourceNames.sorted()
            lastSavedSourceFitNotice = sourceFitNotice
            lastSavedProjectRoot = projectRoot
            if revealInFinder {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            // A doc saved into the project is a new Library file; nudge the
            // sidebar to rescan (the de-facto "library changed" signal) so it
            // appears immediately instead of only after the next index event.
            if projectRoot != nil {
                NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
            }
            return true
        } catch {
            let alert = NSAlert()
            alert.messageText = "Save Failed"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            return false
        }
    }

    /// Writes a chat reply to disk WITHOUT touching document state.
    ///
    /// `save(content:...)` above is the DOCUMENT save: it flips `isSaved`
    /// (disabling Edit/Save and arming the no-confirmation "Start another"
    /// reset) and names the file from `outputFilename` (the template/command
    /// name). Visual's "Save chat output" used to call that same method,
    /// which meant saving a chat reply silently wrote it under the
    /// document's name, marked an unsaved generated document as saved, and
    /// made "Start another" destroy it with no confirmation. This is a
    /// separate path, deliberately inert with respect to `isSaved`,
    /// `generationState` and `editedContent` — see `GenerationSaveChatOutputRow`,
    /// the only caller, used by both `VisualPromptBar` and `DocGenPromptBar`.
    ///
    /// Filename is fixed and clearly chat-derived (never `outputFilename`),
    /// so it can never collide with — or be mistaken for — the document's
    /// own save. Double-press dedup (never write a spurious `-1.md` for the
    /// SAME reply) is the caller's job: `GenerationSaveChatOutputRow` (used
    /// by both `VisualPromptBar` and `DocGenPromptBar`) disables the button
    /// once the on-screen reply matches the last one actually written here.
    @discardableResult
    func saveChatOutput(content: String, api: LlmIdeAPIClient,
                        config: DocGenOutputConfig, projectRoot: URL? = nil,
                        revealInFinder: Bool = true) -> URL? {
        do {
            let url = try api.exportMarkdown(
                content: content,
                filename: "chat-output",
                projectRoot: projectRoot,
                directory: config.resolvedDirectory(projectRoot: projectRoot))
            if revealInFinder {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
            if projectRoot != nil {
                NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
            }
            return url
        } catch {
            let alert = NSAlert()
            alert.messageText = "Save Failed"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            return nil
        }
    }
}
