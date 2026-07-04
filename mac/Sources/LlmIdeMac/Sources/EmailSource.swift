import Foundation

/// Ingested email. A fetch source: pulls NEW mail (the server owns the
/// forward-only high-water mark + seen-ledger), classifies each message
/// (`/kb/email/classify`) and writes a to-do note or a raw skipped stub into
/// the dedicated `Email/` folder via `EmailFileStore`, then advances the mark.
/// Moved out of `SourceIngestService` so the service is a generic driver.
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
            return .failure(error.localizedDescription, imported: 0)
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

        if let failure { return .failure(failure, imported: importedIds.count) }
        let moreAvailable = (messages.count - batch.count) + result.skipped.overCap
        return .imported(importedIds.count, moreAvailable: moreAvailable,
                         oversize: result.skipped.oversize)
    }

    /// The write action chosen for a fetched email (pure, unit-testable).
    enum EmailWriteDecision: Equatable {
        case note(LlmIdeAPIClient.EmailClassification)
        case skipped(category: String)
    }

    /// Decide how to persist an email. Bulk senders skip the LLM entirely; a
    /// classify failure is persisted as a raw stub so nothing is lost.
    static func routeDecision(from: String,
                              classification: LlmIdeAPIClient.EmailClassification?,
                              classifyFailed: Bool = false) -> EmailWriteDecision {
        if EmailFileStore.isBulkSender(from) { return .skipped(category: "bulk") }
        if classifyFailed { return .skipped(category: "unclassified") }
        guard let c = classification else { return .skipped(category: "unclassified") }
        return c.noteWorthy ? .note(c) : .skipped(category: c.category)
    }

    /// Classify the email, then write a structured to-do note (note-worthy) or
    /// a raw stub (skipped/bulk/unclassified) into the dedicated `Email/` folder
    /// via `EmailFileStore`. Bulk senders skip the LLM call. A classify failure
    /// is persisted raw so nothing is lost.
    @MainActor
    private func makeNote(from msg: EmailMessage, ctx: SourceContext) async throws {
        let startedAt = AppDateFormatter.parseISO(msg.date) ?? Date()
        let emailRoot = ctx.root.appendingPathComponent("Email", isDirectory: true)
        let store = EmailFileStore(root: emailRoot)

        // Bulk senders skip the LLM entirely.
        if EmailFileStore.isBulkSender(msg.from) {
            _ = try store.writeSkipped(messageId: msg.messageId, from: msg.from, date: startedAt,
                                       subject: msg.subject, category: "bulk", originalBody: msg.text)
            return
        }

        var classification: LlmIdeAPIClient.EmailClassification?
        var failed = false
        do {
            classification = try await ctx.api.classifyEmail(
                subject: msg.subject, from: msg.from, date: msg.date, body: msg.text)
        } catch {
            failed = true   // classify failed/timed out — persist raw so nothing is lost
        }

        switch Self.routeDecision(from: msg.from, classification: classification, classifyFailed: failed) {
        case .note(let c):
            _ = try store.writeNote(messageId: msg.messageId, from: msg.from, date: startedAt,
                                    subject: msg.subject, classification: c, originalBody: msg.text)
        case .skipped(let category):
            _ = try store.writeSkipped(messageId: msg.messageId, from: msg.from, date: startedAt,
                                       subject: msg.subject, category: category, originalBody: msg.text)
        }
    }
}
