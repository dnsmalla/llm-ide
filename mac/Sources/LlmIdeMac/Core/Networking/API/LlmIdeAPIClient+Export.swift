import Foundation

// MARK: - Export, summarize, outcomes

extension LlmIdeAPIClient {

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

    func refreshOutcomes(taskIds: [String]? = nil, creds: [String: String]? = nil)
    async throws -> OutcomeRefreshSummary {
        try await post("/kb/outcomes/refresh",
                       body: OutcomeRefreshRequest(creds: creds, taskIds: taskIds),
                       authenticated: true)
    }

    // MARK: - Doc Gen

    private struct GenerateDocRequest: Encodable {
        // All optional: the server requires a template (name + sections) OR a
        // command, so a command-only request omits the template fields
        // entirely. Synthesized Encodable uses encodeIfPresent for Optionals,
        // so nil fields are absent from the JSON rather than null.
        let templateName: String?
        let sections: [String]?
        let command: String?
        let prompt: String?
        let sources: [SourceItem]

        struct SourceItem: Encodable {
            let name: String
            let content: String
        }
    }

    private struct GenerateDocResponse: Decodable {
        let content: String
        /// Sources the server's total-character budget forced short, and
        /// sources it could not fit at all
        /// (`export-routes.mjs#packSources`, server API v52). BOTH optional
        /// so a pre-v52 server still decodes — that server silently dropped
        /// everything past the 20th source instead, which is exactly why
        /// their ABSENCE has to stay distinguishable from an empty list.
        let truncated: [String]?
        let truncatedCount: Int?
        let omitted: [String]?
        let omittedCount: Int?
    }

    /// What one `/generate-doc` run produced: the document, plus what the
    /// server had to leave out. Returned as a struct rather than a bare
    /// String so the shortfall reaches the UI instead of being dropped at the
    /// client boundary.
    struct GeneratedDoc {
        let content: String
        /// Names of sources sent only in part — capped by the server at
        /// MAX_REPORTED_NAMES, so this can be SHORTER than `truncatedTotal`.
        let truncatedSources: [String]
        /// Exact number of sources sent only in part, never capped.
        let truncatedTotal: Int
        /// Names of sources not sent at all; capped the same way.
        let omittedSources: [String]
        /// Exact number of sources not sent at all, never capped.
        let omittedTotal: Int
        /// False when the server did not report on source fitting AT ALL
        /// (pre-v52). Such a server applied its own silent `slice(0, 20)`, so
        /// the caller must warn on its own rather than read the empty
        /// `truncatedSources` as "everything was sent".
        let serverReportsFit: Bool
    }

    /// One session for every generation (a fresh `URLSession` per call was
    /// never invalidated, so each one leaked with its delegate queue).
    /// 240 s per request: a long document legitimately takes minutes.
    private static let generateDocSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 240
        return URLSession(configuration: cfg)
    }()

    func generateDoc(
        templateName: String?,
        sections: [String]?,
        command: String?,
        prompt: String?,
        sources: [(name: String, content: String)]
    ) async throws -> GeneratedDoc {
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
            command: command?.isEmpty == false ? command : nil,
            prompt: prompt?.isEmpty == false ? prompt : nil,
            sources: sources.map { GenerateDocRequest.SourceItem(name: $0.name, content: $0.content) })
        req.httpBody = try AppJSON.encoder.encode(body)

        let (data, response) = try await Self.generateDocSession.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            if status == 401 { throw APIError.noSession }
            // The server's (redacted) message, never the raw body: a provider
            // error echoed through can carry a key.
            let server = Self.serverError(fromBody: data)
            throw APIError.http(
                status: status,
                code: server?.code ?? "GENERATE_DOC_FAILED",
                message: server?.message ?? "Document generation failed (HTTP \(status))",
                details: nil)
        }
        let resp = try AppJSON.decoder.decode(GenerateDocResponse.self, from: data)
        let truncated = resp.truncated ?? []
        let omitted = resp.omitted ?? []
        return GeneratedDoc(
            content: resp.content,
            truncatedSources: truncated,
            // Fall back to the name count for a server that sends names but
            // no count — never below what we can actually see.
            truncatedTotal: max(resp.truncatedCount ?? 0, truncated.count),
            omittedSources: omitted,
            omittedTotal: max(resp.omittedCount ?? 0, omitted.count),
            serverReportsFit: resp.truncated != nil)
    }

    /// Write `content` as Markdown. `directory` wins when supplied (Doc Gen's
    /// configured output folder); otherwise `<projectRoot>/data/`; otherwise
    /// Downloads. Existing callers pass neither and keep the old behaviour.
    func exportMarkdown(content: String, filename: String,
                        projectRoot: URL? = nil, directory: URL? = nil) throws -> URL {
        let fm = FileManager.default
        let baseDir: URL
        if let dir = directory {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            baseDir = dir
        } else if let root = projectRoot {
            let plansDir = ProjectLayout(root: root).dataDir
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
                    let (bytes, response) = try await _session.bytes(for: req)
                    // A 401/500 body used to be read as NDJSON, fail to decode
                    // line by line, and finish as a SUCCESSFUL empty export.
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        if http.statusCode == 401 { continuation.finish(throwing: APIError.noSession); return }
                        let body = await Self.readErrorBody(bytes)
                        let server = Self.serverError(fromBody: body)
                        continuation.finish(throwing: APIError.http(
                            status: http.statusCode, code: server?.code ?? "EXPORT_FAILED",
                            message: server?.message ?? "Export failed (HTTP \(http.statusCode))", details: nil))
                        return
                    }
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
