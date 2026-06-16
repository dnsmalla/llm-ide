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
        case imported(Int, pending: Int)   // N turned into notes; pending left (cap)
        case none                          // fetched, but nothing new
        case noSource                      // no configured/enabled email source
        case failure(String)               // fetch or ingest error
    }

    /// Fetch mail newer than the source's high-water mark, skip any already
    /// imported, and turn each new one into a meeting note. Runs sequentially
    /// so we don't hammer the summarizer with parallel calls.
    func importNewEmails() async -> Result {
        guard let source = config.emailSource, source.enabled else {
            return .noSource
        }

        // Forward-only window: fetch since the high-water mark, but never
        // further back than `lookbackDays` (so a long-dormant source doesn't
        // suddenly pull weeks of mail). The fetch moment becomes the next
        // high-water mark once we've fully drained it.
        let fetchStart = Date()
        let clamp = fetchStart.addingTimeInterval(-Double(max(1, source.lookbackDays)) * 86_400)
        let since = max(source.lastFetchedAt ?? clamp, clamp)
        let sinceISO = AppDateFormatter.isoString(since)

        let messages: [EmailMessage]
        do {
            messages = try await api.fetchEmails(source, sinceISO: sinceISO)
        } catch {
            return .failure(error.localizedDescription)
        }

        // Dedup against the bounded seen-ids list. The server always supplies
        // a stable messageId (real Message-ID, else a synthesized
        // "email-uid-<uid>"), so every message dedups reliably.
        let seen = Set(config.emailSeenMessageIds)
        let fresh = messages.filter { !seen.contains($0.messageId) }
        guard !fresh.isEmpty else {
            advanceHighWater(to: fetchStart)   // nothing new — window is drained
            return .none
        }

        // Import newest-first, capped. `fresh` is already newest-first
        // (server sorts desc), so prefix keeps the most recent.
        let batch = Array(fresh.prefix(Self.maxPerRun))
        let capped = fresh.count > batch.count

        var importedIds: [String] = []
        for msg in batch {
            do {
                try await makeNote(from: msg)
                importedIds.append(msg.messageId)
            } catch {
                // Record what we managed before bailing so a mid-run failure
                // doesn't re-import the successes. Do NOT advance the
                // high-water mark — the window is retried next time.
                config.recordSeenEmailIds(importedIds)
                await rescanAndNotify()
                return .failure(error.localizedDescription)
            }
        }

        config.recordSeenEmailIds(importedIds)
        await rescanAndNotify()
        // Only advance the high-water mark when the window is fully drained;
        // if capped, leave it so the remainder re-fetches next run.
        if !capped { advanceHighWater(to: fetchStart) }
        return .imported(importedIds.count, pending: fresh.count - batch.count)
    }

    /// Move the source's forward-only high-water mark, persisting it.
    private func advanceHighWater(to date: Date) {
        guard var s = config.emailSource else { return }
        s.lastFetchedAt = date
        config.emailSource = s
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
