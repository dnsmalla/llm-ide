import Foundation

/// Ingested email. A fetch source: pulls NEW mail (the server owns the
/// forward-only high-water mark + seen-ledger) and saves each message as a
/// raw file into the `EmailInbox/` folder via `InboxStore`. Note generation
/// itself is decoupled from this fetch step — see `generateNote` below and
/// `InboxGenerationPipeline` — so it runs off whatever is in `EmailInbox/`
/// regardless of how it got there (fetched here, or dropped in by hand).
struct EmailSource: InputSource {
    let id = "email"
    let displayName = "Mail"          // Library SOURCES sub-group label
    let icon = "envelope"
    let emptyText = "No mail yet"
    let platforms = ["email"]
    let mode = SourceMode.fetch

    /// Safety cap on messages saved per fetch (first big drain imports the
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
        let inboxRoot = ctx.root.appendingPathComponent("EmailInbox", isDirectory: true)
        let batch = Array(messages.prefix(Self.maxPerRun))
        let capped = messages.count > batch.count
        let moreAvailable = (messages.count - batch.count) + result.skipped.overCap

        var savedIds: [String] = []
        var saveFailure: String?
        for msg in batch {
            if Task.isCancelled { break }
            do {
                try saveRaw(from: msg, inboxRoot: inboxRoot)
                savedIds.append(msg.messageId)
            } catch {
                saveFailure = error.localizedDescription
                break
            }
        }
        let cancelled = Task.isCancelled
        let drained = !capped && saveFailure == nil && !cancelled
        try? await ctx.api.markEmailSeen(messageIds: savedIds,
                                         lastFetchedAt: drained ? fetchStart : nil)

        if let saveFailure { return .failure(saveFailure, imported: 0) }

        // Generation pass: scans the whole EmailInbox/ folder (not just what
        // was just saved above), so raw files added by hand are picked up
        // too. Dedup is by content hash against existing notes, not DB state.
        let writer = EmailNoteWriter(repoRoot: ctx.root)
        let knownHashes = try? await writer.existingSourceHashes()
        let (processed, failures) = await InboxGenerationPipeline.run(
            inboxRoot: inboxRoot, knownHashes: knownHashes ?? []
        ) { item in
            try await Self.generateNote(item: item, writer: writer, ctx: ctx)
        }

        if !failures.isEmpty {
            return .failure(failures.joined(separator: "; "), imported: processed)
        }
        if processed == 0 { return .none }
        return .imported(processed, moreAvailable: moreAvailable, oversize: result.skipped.oversize)
    }

    /// Saves one fetched message's raw content into `EmailInbox/`. No
    /// classification happens here — that's the generation pass's job.
    @MainActor
    private func saveRaw(from msg: EmailMessage, inboxRoot: URL) throws {
        let startedAt = AppDateFormatter.parseISO(msg.date) ?? Date()
        try InboxStore(root: inboxRoot).write(from: msg.from, date: startedAt, subject: msg.subject, body: msg.text)
    }

    /// The write action chosen for a classified email (pure, unit-testable).
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

    /// Classifies one raw inbox item and writes the resulting note/skip stub
    /// via `EmailNoteWriter` — the `generate` step passed to
    /// `InboxGenerationPipeline.run`. Bulk senders skip the LLM call
    /// entirely, same as before this pipeline split.
    @MainActor
    private static func generateNote(item: RawInboxItem, writer: EmailNoteWriter, ctx: SourceContext) async throws {
        // Build raw file path for tracking (relative from repo root)
        let rawFileName = item.url.lastPathComponent
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy/MM"
        let monthPath = dateFormatter.string(from: item.date)
        let rawFile = "EmailInbox/\(monthPath)/\(rawFileName)"

        if EmailFileStore.isBulkSender(item.from) {
            _ = try await writer.writeSkipped(from: item.from, date: item.date, subject: item.subject,
                                       category: "bulk", originalBody: item.body, sourceHash: item.hash, rawFile: rawFile)
            return
        }

        var classification: LlmIdeAPIClient.EmailClassification?
        var failed = false
        do {
            classification = try await ctx.api.classifyEmail(
                subject: item.subject, from: item.from,
                date: AppDateFormatter.isoString(item.date), body: item.body)
        } catch {
            failed = true
        }

        switch routeDecision(from: item.from, classification: classification, classifyFailed: failed) {
        case .note(let c):
            _ = try await writer.writeNote(from: item.from, date: item.date, subject: item.subject,
                                    classification: c, originalBody: item.body, sourceHash: item.hash, rawFile: rawFile)
        case .skipped(let category):
            _ = try await writer.writeSkipped(from: item.from, date: item.date, subject: item.subject,
                                       category: category, originalBody: item.body, sourceHash: item.hash, rawFile: rawFile)
        }
    }
}
