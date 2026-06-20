import Foundation

// MARK: - Export, summarize, outcomes

extension LlmIdeAPIClient {

    struct Outcome: Codable, Identifiable {
        let id: Int
        let provider: String
        let ref: String
        let state: String
        let isTerminal: Bool
        let meta: AnyCodable?
        let observedAt: String
    }
    struct OutcomesWrap: Codable { let outcomes: [Outcome] }

    struct OutcomeRefreshSummary: Codable {
        let pollCount: Int
        let pollErroredCount: Int
        let changedCount: Int
        let durationMs: Int
        let byState: [String: Int]
    }

    /// Polls every dispatched task (or just the ones in `taskIds`) for
    /// its current state in the external tracker.  Credentials flow
    /// from the vault when present, or the caller can override per-call.
    struct OutcomeRefreshRequest: Encodable {
        let creds: [String: String]?
        let taskIds: [String]?
    }

    private struct SummarizeReq: Encodable {
        let transcript: String
        let title: String
        let language: String
        let started_at: String
        let duration_seconds: Int?
        let participants: [String]
    }
    private struct SummarizeResp: Decodable {
        let gist: String
        let tldr: [String]
        let full: String
        let actions: [MeetingSummary.Action]
        let decisions: [MeetingSummary.Decision]
        let blockers: [MeetingSummary.Blocker]
        let model: String
        let generated_at: Int64
    }

    // --- Export methods ----------------------------------------------

    /// Returns the chronological outcome rows for a single task — newest
    /// first.  Used by PlanView to render the per-task state chip.
    func listOutcomesForTask(taskId: String) async throws -> [Outcome] {
        let r: OutcomesWrap = try await get("/kb/outcomes/task/\(percentEncoded(taskId))", authenticated: true)
        return r.outcomes
    }

    func refreshOutcomes(taskIds: [String]? = nil, creds: [String: String]? = nil)
    async throws -> OutcomeRefreshSummary {
        try await post("/kb/outcomes/refresh",
                       body: OutcomeRefreshRequest(creds: creds, taskIds: taskIds),
                       authenticated: true)
    }

    // MARK: - Doc Gen

    private struct GenerateDocRequest: Encodable {
        let templateName: String
        let sections: [String]
        let sources: [SourceItem]

        struct SourceItem: Encodable {
            let name: String
            let content: String
        }
    }

    private struct GenerateDocResponse: Decodable {
        let content: String
    }

    func generateDoc(
        templateName: String,
        sections: [String],
        sources: [(name: String, content: String)]
    ) async throws -> String {
        guard let url = URL(string: baseURL + "/generate-doc") else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Match the generic send() contract: an authenticated endpoint
        // with no live token throws APIError.noSession instead of
        // silently sending an unauthenticated request and getting a
        // generic 401 back. Pulled to MainActor because SessionStore is
        // @MainActor-isolated.
        guard let store = _sessionStore,
              let token = await MainActor.run(body: { store.accessToken })
        else { throw APIError.noSession }
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let body = GenerateDocRequest(
            templateName: templateName,
            sections: sections,
            sources: sources.map { GenerateDocRequest.SourceItem(name: $0.name, content: $0.content) })
        req.httpBody = try AppJSON.encoder.encode(body)

        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 240
        let oneShot = URLSession(configuration: cfg)
        let (data, response) = try await oneShot.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(
                status: (response as? HTTPURLResponse)?.statusCode ?? -1,
                code: "GENERATE_DOC_FAILED",
                message: text.isEmpty ? "Document generation failed" : text,
                details: nil)
        }
        let resp = try AppJSON.decoder.decode(GenerateDocResponse.self, from: data)
        return resp.content
    }

    /// Write `content` to a `.md` file and return its URL.
    ///
    /// - When `projectRoot` is supplied the file is written into
    ///   `<projectRoot>/data/`, creating the directory if needed.
    /// - When `projectRoot` is nil the file lands in the user's
    ///   Downloads folder (existing behaviour for the no-project case).
    func exportMarkdown(content: String, filename: String, projectRoot: URL? = nil) throws -> URL {
        let fm = FileManager.default
        let baseDir: URL
        if let root = projectRoot {
            let plansDir = root.appendingPathComponent("data", isDirectory: true)
            try fm.createDirectory(at: plansDir, withIntermediateDirectories: true)
            baseDir = plansDir
        } else {
            baseDir = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory())
        }
        let safeName = filename
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        var dest = baseDir.appendingPathComponent("\(safeName).md")
        var n = 1
        while fm.fileExists(atPath: dest.path) {
            dest = baseDir.appendingPathComponent("\(safeName)-\(n).md")
            n += 1
        }
        try content.write(to: dest, atomically: true, encoding: .utf8)
        return dest
    }

    func summarize(transcript: String, title: String, language: String,
                   startedAt: Date, durationSeconds: Int?,
                   participants: [String]) async throws -> MeetingSummary {
        let req = SummarizeReq(
            transcript: transcript, title: title, language: language,
            started_at: AppDateFormatter.isoString(startedAt),
            duration_seconds: durationSeconds,
            participants: participants)
        let resp: SummarizeResp = try await post("/kb/summarize", body: req, authenticated: true)
        return MeetingSummary(
            gist: resp.gist, tldr: resp.tldr, full: resp.full,
            actions: resp.actions, decisions: resp.decisions, blockers: resp.blockers,
            model: resp.model,
            generatedAt: Date(timeIntervalSince1970: TimeInterval(resp.generated_at) / 1000)
        )
    }
}

// MARK: - PR4 legacy export streamer

extension LlmIdeAPIClient {
    /// Cheap pre-check used by the first-launch prompt — we only show
    /// the export dialog when the user actually has legacy meetings.
    func legacyMeetingCount() async -> Int {
        struct StatsResp: Decodable { let totals: Totals? }
        struct Totals: Decodable { let meetings: Int? }
        if let s: StatsResp = try? await get("/kb/stats", authenticated: true) {
            return s.totals?.meetings ?? 0
        }
        return 0
    }

    /// NDJSON stream of /kb/export-all.  Each non-terminal line is a
    /// LegacyExporter.Record; the terminal line is `{"done": true, ...}`
    /// which we drop on the floor.
    func exportAll() -> AsyncThrowingStream<LegacyExporter.Record, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    guard let url = URL(string: baseURL + "/kb/export-all?limit=100") else {
                        continuation.finish(throwing: APIError.invalidURL); return
                    }
                    var req = URLRequest(url: url)
                    guard let store = _sessionStore,
                          let token = await MainActor.run(body: { store.accessToken })
                    else {
                        continuation.finish(throwing: APIError.noSession); return
                    }
                    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    let (bytes, _) = try await _session.bytes(for: req)
                    for try await line in bytes.lines {
                        guard let data = line.data(using: .utf8) else { continue }
                        if let rec = try? AppJSON.decoder.decode(LegacyExporter.Record.self, from: data) {
                            continuation.yield(rec)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}
