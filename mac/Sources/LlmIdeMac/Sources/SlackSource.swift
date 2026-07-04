import Foundation

/// Ingested Slack. A fetch source: for each configured channel it pulls NEW
/// messages (server owns the forward-only per-channel high-water + seen-ledger)
/// and writes ONE transcript note per channel-window via the meeting pipeline,
/// so it lands in the Library as a `platform: "slack"` source. Twin of
/// `EmailSource`, but loops channels and groups per channel.
struct SlackSource: InputSource {
    let id = "slack"
    let displayName = "Slack"
    let icon = "number"
    let emptyText = "No Slack messages yet"
    let platforms = ["slack"]
    let mode = SourceMode.fetch

    @MainActor
    func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult {
        guard let s = ctx.config.slackSource, s.enabled, !s.channels.isEmpty else { return .noSource }
        return await Self.ingest(
            channels: s.channels,
            lookbackDays: s.lookbackDays,
            fetch: { try await ctx.api.fetchSlack(channelId: $0, lookbackDays: $1) },
            writeNote: { try await Self.makeNote(channelId: $0, messages: $1, ctx: ctx) },
            markSeen: { try await ctx.api.markSlackSeen(channelId: $0, messageTs: $1, lastTs: $2) })
    }

    /// Per-channel ingest loop, split out from `fetchAndIngest` so its control
    /// flow is testable via injectable seams (the real ones hit the API +
    /// meeting pipeline). A channel that fails to fetch or whose note-write
    /// throws is skipped with `continue` — its failure is collected and
    /// surfaced, but the remaining channels are still fetched. (Previously a
    /// single bad channel — e.g. the bot was kicked — aborted the entire run,
    /// so every scheduled run re-hit it first and starved the others.)
    /// The per-channel high-water/overCap logic is unchanged: the seen-ledger
    /// mark only advances (`lastTs`) when the channel drained fully.
    @MainActor
    static func ingest(
        channels: [String],
        lookbackDays: Int,
        fetch: (String, Int) async throws -> LlmIdeAPIClient.SlackFetchResult,
        writeNote: (String, [LlmIdeAPIClient.SlackMessage]) async throws -> Void,
        markSeen: (String, [String], String?) async throws -> Void
    ) async -> SourceIngestResult {
        var totalImported = 0
        var totalMore = 0
        var failures: [String] = []

        for channelId in channels {
            if Task.isCancelled { break }
            let result: LlmIdeAPIClient.SlackFetchResult
            do {
                result = try await fetch(channelId, lookbackDays)
            } catch {
                failures.append("#\(channelId): \(error.localizedDescription)")
                continue
            }
            let msgs = result.messages
            if msgs.isEmpty { continue }
            do {
                try await writeNote(channelId, msgs)
            } catch {
                failures.append("#\(channelId): \(error.localizedDescription)")
                continue
            }
            totalImported += msgs.count
            totalMore += result.skipped.overCap

            let tsList = msgs.map(\.ts)
            let drained = result.skipped.overCap == 0
            let lastTs = drained ? tsList.max(by: { (Double($0) ?? 0) < (Double($1) ?? 0) }) : nil
            try? await markSeen(channelId, tsList, lastTs)
        }

        if !failures.isEmpty {
            return .failure(failures.joined(separator: "; "), imported: totalImported)
        }
        if totalImported == 0 { return .none }
        return .imported(totalImported, moreAvailable: totalMore, oversize: 0)
    }

    @MainActor
    private static func makeNote(channelId: String, messages: [LlmIdeAPIClient.SlackMessage],
                                 ctx: SourceContext) async throws {
        let ordered = messages.sorted { (Double($0.ts) ?? 0) < (Double($1.ts) ?? 0) }
        let firstTs = Double(ordered.first?.ts ?? "0") ?? 0
        let lastTsStr = ordered.last?.ts ?? "\(firstTs)"
        let startedAt = Date(timeIntervalSince1970: firstTs)
        let title = "Slack #\(channelId) — \(AppDateFormatter.dateHourMinuteLocal(startedAt))"
        let id = "slack-\(channelId)-\(lastTsStr)"
        let participants = Array(Set(ordered.map(\.user))).sorted()
        let transcript = ordered.map { "\($0.user): \($0.text)" }.joined(separator: "\n")
        let root = ctx.root
        let notesOutputFolder = ctx.notesOutputFolder
        let api = ctx.api
        let endedAt = Date(timeIntervalSince1970: Double(lastTsStr) ?? firstTs)

        try await Task.detached(priority: .background) {
            let store = MeetingFileStore(root: root)
            let handle = try store.createPartial(
                id: id, startedAt: startedAt, platform: "slack", language: "")
            for m in ordered {
                let when = Date(timeIntervalSince1970: Double(m.ts) ?? firstTs)
                try handle.appendCaption(timestamp: when, speaker: m.user, text: m.text)
            }
            try handle.flush()
            let url = try store.finalize(
                handle: handle, title: title, endedAt: endedAt, participants: participants)

            let dateSlug = AppDateFormatter.dateHourMinuteLocal(startedAt)
            let idSuffix = id.prefix(8)
            let docxURL = notesOutputFolder.appendingPathComponent(
                "\(dateSlug)-\(idSuffix)-slack-notes.docx")
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
