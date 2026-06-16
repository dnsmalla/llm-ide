import Foundation

/// Turns fetched emails into meeting notes by reusing the EXACT meeting
/// pipeline that live-session note generation uses (`MeetingFileStore`
/// create/finalize + `MeetingSummarizationService.run`). Each imported
/// email lands in the Library indistinguishable from a captured meeting.
///
/// `@MainActor` because it touches `AppConfig` (the dedup list) and posts
/// the Library-refresh notification; the heavy file + summarize work is
/// awaited but is itself off-main inside the services.
@MainActor
struct SourceIngestService {
    let api: LlmIdeAPIClient
    let config: AppConfig
    /// Notes-folder root for `MeetingFileStore` (mirrors AppShell's use of
    /// `appEnv.notesConfig.currentFolder`).
    let root: URL
    /// `<project>/notes/` — where the AI `.docx` note is written.
    let notesOutputFolder: URL
    /// Forces the Library SQLite index to pick up new files immediately
    /// rather than waiting for the kqueue watcher tick.
    let indexer: FolderIndexer

    /// Safety cap on notes created per fetch. Steady-state (forward-only)
    /// fetches return a handful; this only bites on a first big drain, where
    /// we import the newest `maxPerRun` and leave the rest for the next
    /// "Fetch now" (the high-water mark is NOT advanced when capped, so the
    /// remainder is re-fetched and drained incrementally rather than lost).
    private static let maxPerRun = 50

    /// Outcome of one `importNewEmails()` run, surfaced on the Sources card.
    enum Result {
        case imported(Int, moreAvailable: Int, oversize: Int) // N notes; more left; large skipped
        case none                          // fetched, but nothing new
        case noSource                      // no configured/enabled email source
        case failure(String)               // fetch or ingest error
    }

    /// Fetch NEW mail (the server owns the forward-only high-water mark and
    /// the seen-ledger, so what comes back is already deduped and device-
    /// independent), turn each into a meeting note, then tell the server which
    /// ids landed + advance the high-water mark. Sequential so we don't hammer
    /// the summarizer; honors task cancellation between notes.
    func importNewEmails() async -> Result {
        guard let source = config.emailSource, source.enabled else {
            return .noSource
        }

        let fetchStart = Date()
        let result: LlmIdeAPIClient.EmailFetchResult
        do {
            result = try await api.fetchEmails(source)
        } catch {
            return .failure(error.localizedDescription)
        }

        let messages = result.messages
        guard !messages.isEmpty else {
            // Nothing new — advance the high-water mark so the window moves
            // forward (best-effort; a failure just means we re-scan next time).
            try? await api.markEmailSeen(messageIds: [], lastFetchedAt: fetchStart)
            return .none
        }

        // Import newest-first, capped. `messages` is newest-first (server
        // sorts desc), so prefix keeps the most recent.
        let batch = Array(messages.prefix(Self.maxPerRun))
        let capped = messages.count > batch.count

        var importedIds: [String] = []
        var failure: String?
        for msg in batch {
            if Task.isCancelled { break }
            do {
                try await makeNote(from: msg)
                importedIds.append(msg.messageId)
            } catch {
                failure = error.localizedDescription
                break
            }
        }
        let cancelled = Task.isCancelled

        await rescanAndNotify()

        // Record the ids that landed, and advance the high-water mark ONLY on
        // a clean full drain (no cap, no failure, no cancellation) — otherwise
        // leave it so the remainder re-fetches next run. Best-effort: a failed
        // record just risks re-importing (notes are keyed by message-id, so a
        // re-import overwrites on disk rather than duplicating).
        let drained = !capped && failure == nil && !cancelled
        try? await api.markEmailSeen(messageIds: importedIds,
                                     lastFetchedAt: drained ? fetchStart : nil)

        if let failure { return .failure(failure) }
        let moreAvailable = (messages.count - batch.count) + result.skipped.overCap
        return .imported(importedIds.count, moreAvailable: moreAvailable,
                         oversize: result.skipped.oversize)
    }

    /// One full re-index after the batch (not per note — that's up to 50
    /// scans on a drain) + the Library refresh. The scan is run off-main
    /// since it walks the notes folder.
    private func rescanAndNotify() async {
        let indexer = self.indexer
        await Task.detached(priority: .background) { try? indexer.fullScan() }.value
        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
    }

    /// Mirror of `AppShell.generateNoteForLiveSession`: create a `.md`
    /// transcript via `MeetingFileStore`, finalize it, then run
    /// `MeetingSummarizationService` to attach the AI summary + `.docx` note.
    /// The email body plays the role of the transcript. All file + summarize
    /// work runs OFF the main actor (like AppShell does) so importing a batch
    /// doesn't block the UI; only the dedup/notify touches `config` on-main.
    private func makeNote(from msg: EmailMessage) async throws {
        // Resolve everything to Sendable primitives on the main actor first,
        // then hand off to a detached task (capturing no main-actor state).
        let startedAt = AppDateFormatter.parseISO(msg.date) ?? Date()
        let title = msg.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Email"
            : msg.subject
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
        let root = self.root
        let notesOutputFolder = self.notesOutputFolder
        let api = self.api

        try await Task.detached(priority: .background) {
            let store = MeetingFileStore(root: root)
            // Use the message-id as the meeting id so re-runs overwrite on
            // disk rather than duplicating.
            let handle = try store.createPartial(
                id: id, startedAt: startedAt, platform: "email", language: "")
            // Email body as one caption block; sender is the speaker so the
            // markdown viewer renders "**from**: body".
            try handle.appendCaption(timestamp: startedAt, speaker: speaker, text: body)
            try handle.flush()
            let url = try store.finalize(
                handle: handle, title: title, endedAt: startedAt, participants: participants)

            // AI summary + .docx note (non-fatal inside the service).
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
