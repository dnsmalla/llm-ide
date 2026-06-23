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

        var totalImported = 0
        var totalMore = 0
        var failure: String?

        for channelId in s.channels {
            if Task.isCancelled { break }
            let result: LlmIdeAPIClient.SlackFetchResult
            do {
                result = try await ctx.api.fetchSlack(channelId: channelId, lookbackDays: s.lookbackDays)
            } catch {
                failure = error.localizedDescription
                break
            }
            let msgs = result.messages
            if msgs.isEmpty { continue }
            do {
                try await makeNote(channelId: channelId, messages: msgs, ctx: ctx)
            } catch {
                failure = error.localizedDescription
                break
            }
            totalImported += msgs.count
            totalMore += result.skipped.overCap

            let tsList = msgs.map(\.ts)
            let drained = result.skipped.overCap == 0
            let lastTs = drained ? tsList.max(by: { (Double($0) ?? 0) < (Double($1) ?? 0) }) : nil
            try? await ctx.api.markSlackSeen(channelId: channelId, messageTs: tsList, lastTs: lastTs)
        }

        if let failure { return .failure(failure, imported: totalImported) }
        if totalImported == 0 { return .none }
        return .imported(totalImported, moreAvailable: totalMore, oversize: 0)
    }

    @MainActor
    private func makeNote(channelId: String, messages: [LlmIdeAPIClient.SlackMessage],
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
