import Foundation

/// Ingested email. A fetch source: pulls NEW mail (the server owns the
/// forward-only high-water mark + seen-ledger), turns each message into a
/// meeting note via the exact meeting pipeline (`MeetingFileStore` +
/// `MeetingSummarizationService`), then advances the mark. Moved out of
/// `SourceIngestService` so the service is a generic driver.
struct EmailSource: InputSource {
    let id = "email"
    let displayName = "Mail"          // Library SOURCES sub-group label
    let icon = "envelope"
    let emptyText = "No mail yet"
    let platforms = ["email"]
    let mode = SourceMode.fetch

    /// Safety cap on notes created per fetch (first big drain imports the
    /// newest N; the high-water is NOT advanced when capped, so the remainder
    /// re-fetches next run rather than being lost).
    private static let maxPerRun = 50

    @MainActor
    func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult {
        guard let source = ctx.config.emailSource, source.enabled else { return .noSource }

        let fetchStart = Date()
        let result: LlmIdeAPIClient.EmailFetchResult
        do {
            result = try await ctx.api.fetchEmails(source)
        } catch {
            return .failure(error.localizedDescription)
        }

        let messages = result.messages
        guard !messages.isEmpty else {
            try? await ctx.api.markEmailSeen(messageIds: [], lastFetchedAt: fetchStart)
            return .none
        }

        let batch = Array(messages.prefix(Self.maxPerRun))
        let capped = messages.count > batch.count

        var importedIds: [String] = []
        var failure: String?
        for msg in batch {
            if Task.isCancelled { break }
            do {
                try await makeNote(from: msg, ctx: ctx)
                importedIds.append(msg.messageId)
            } catch {
                failure = error.localizedDescription
                break
            }
        }
        let cancelled = Task.isCancelled

        let drained = !capped && failure == nil && !cancelled
        try? await ctx.api.markEmailSeen(messageIds: importedIds,
                                         lastFetchedAt: drained ? fetchStart : nil)

        if let failure { return .failure(failure) }
        let moreAvailable = (messages.count - batch.count) + result.skipped.overCap
        return .imported(importedIds.count, moreAvailable: moreAvailable,
                         oversize: result.skipped.oversize)
    }

    /// Create a `.md` transcript via `MeetingFileStore`, finalize it, then run
    /// `MeetingSummarizationService` for the AI summary + `.docx`. The email
    /// body plays the role of the transcript. File + summarize work runs off
    /// the main actor.
    @MainActor
    private func makeNote(from msg: EmailMessage, ctx: SourceContext) async throws {
        let startedAt = AppDateFormatter.parseISO(msg.date) ?? Date()
        let title = msg.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Email" : msg.subject
        let participants = msg.from.isEmpty ? [] : [msg.from]
        let speaker = msg.from.isEmpty ? "Email" : msg.from
        let body = msg.text
        let transcript = """
        From: \(msg.from)
        Subject: \(msg.subject)
        Date: \(msg.date)

        \(body)
        """
        let id = msg.messageId.isEmpty ? UUID().uuidString : msg.messageId
        let root = ctx.root
        let notesOutputFolder = ctx.notesOutputFolder
        let api = ctx.api

        try await Task.detached(priority: .background) {
            let store = MeetingFileStore(root: root)
            let handle = try store.createPartial(
                id: id, startedAt: startedAt, platform: "email", language: "")
            try handle.appendCaption(timestamp: startedAt, speaker: speaker, text: body)
            try handle.flush()
            let url = try store.finalize(
                handle: handle, title: title, endedAt: startedAt, participants: participants)

            let dateSlug = AppDateFormatter.dateHourMinuteLocal(startedAt)
            let idSuffix = id.prefix(8)
            let docxURL = notesOutputFolder.appendingPathComponent(
                "\(dateSlug)-\(idSuffix)-email-notes.docx")
            await MeetingSummarizationService.run(
                api: api,
                transcript: transcript,
                title: title,
                language: "",
                startedAt: startedAt,
                durationSeconds: nil,
                participants: participants,
                transcriptFileURL: url,
                docxOutputURL: docxURL,
                root: root)
        }.value
    }
}
