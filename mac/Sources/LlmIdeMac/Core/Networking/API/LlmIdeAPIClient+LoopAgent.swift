import Foundation

// POST /kb/loop/agent-run — the Loop's headless, confined agent step (skill
// stages, stage repairs, fault repairs). Wire contract:
// extension/routes/loop-agent.mjs; semantics: extension/llm_agent/sdk/loop-agent.mjs.

extension LlmIdeAPIClient {

    /// Field names are the server contract — `LoopAgentRunRequestEncodingTests`
    /// pins them.
    struct LoopAgentRunRequest: Encodable, Equatable {
        let message: String
        let skills: [String]
        /// Absolute path the agent is confined to. The server rejects (400
        /// `REPO_ROOT_NOT_ALLOWED`) a root outside the user's repo allow-list
        /// or an `.llmide-loop-worktrees/` child of one.
        let repoRoot: String
        /// Project `llm-doc/` directories the agent may also read and edit
        /// (split layout). The server accepts only an existing `llm-doc` whose
        /// parent holds `system/project.json` and is `repoRoot` or at most 3
        /// levels above it (else 400 `EXTRA_ROOT_NOT_ALLOWED`). Omitted when empty.
        let extraRoots: [String]?
        let language: String?
        let model: String?
        /// Omitted → the server's default budget (30 min).
        let timeoutMs: Int?
    }

    struct LoopAgentRunResponse: Decodable, Equatable {
        let reply: String?
        let changedPaths: [String]?
        let changedExtraPaths: [String]?
        let createdPaths: [String]?
        let usage: LoopAgentResult.Usage?
        let resolvedSkills: [String]?
        let unresolvedSkills: [String]?
        let truncatedSkills: [String]?
        let ran: Bool?
        let resultSubtype: String?
        let denied: [LoopAgentResult.Denial]?

        var result: LoopAgentResult {
            LoopAgentResult(
                reply: reply ?? "", changedPaths: changedPaths ?? [],
                changedExtraPaths: changedExtraPaths ?? [], createdPaths: createdPaths ?? [],
                usage: usage,
                resolvedSkills: resolvedSkills ?? [], unresolvedSkills: unresolvedSkills ?? [],
                truncatedSkills: truncatedSkills ?? [],
                // The server always sends `ran`; if it is ever absent, infer it
                // from the one rule we know — unresolved skills mean no run.
                ran: ran ?? (unresolvedSkills ?? []).isEmpty,
                resultSubtype: resultSubtype, denied: denied ?? [])
        }
    }

    /// Headroom above the requested budget so the server's own 504
    /// `AGENT_RUN_TIMEOUT` — not a client-side socket cut — ends an overrun.
    static let loopAgentTimeoutHeadroom: TimeInterval = 60
    /// Mirrors the server's `DEFAULT_LOOP_AGENT_TIMEOUT_MS` / `MAX_…`.
    static let loopAgentDefaultTimeout: TimeInterval = 30 * 60
    static let loopAgentMaxTimeout: TimeInterval = 4 * 60 * 60

    /// Builds the request body. Split out so the encoding is testable without
    /// a network call.
    static func loopAgentRunRequest(message: String, skills: [String], repoRoot: URL,
                                    extraRoots: [URL] = [],
                                    language: String?, model: String?,
                                    timeout: TimeInterval?) -> LoopAgentRunRequest {
        LoopAgentRunRequest(
            message: message, skills: skills,
            repoRoot: repoRoot.standardizedFileURL.path,
            extraRoots: extraRoots.isEmpty ? nil : extraRoots.map(\.standardizedFileURL.path),
            language: language, model: model,
            timeoutMs: timeout.map { Int(($0 * 1000).rounded()) })
    }

    /// The URLRequest timeout for a run with budget `timeout` (nil = server default).
    static func loopAgentRequestTimeout(for timeout: TimeInterval?) -> TimeInterval {
        let budget = min(timeout ?? loopAgentDefaultTimeout, loopAgentMaxTimeout)
        return max(budget, 1) + loopAgentTimeoutHeadroom
    }

    func loopAgentRun(message: String, skills: [String], repoRoot: URL,
                      extraRoots: [URL] = [],
                      language: String?, model: String? = nil,
                      timeout: TimeInterval?) async throws -> LoopAgentResult {
        let body = Self.loopAgentRunRequest(message: message, skills: skills, repoRoot: repoRoot,
                                            extraRoots: extraRoots,
                                            language: language, model: model, timeout: timeout)
        let response: LoopAgentRunResponse = try await post(
            "/kb/loop/agent-run", body: body, authenticated: true,
            timeout: Self.loopAgentRequestTimeout(for: timeout))
        return response.result
    }
}

/// Production `LoopAgentRunning` — one `POST /kb/loop/agent-run` per call.
/// Repair is a multi-file code edit, so no model override: the server uses the
/// user's full chat model, not the sub-model tier.
final class APILoopAgentRunner: LoopAgentRunning {
    private let api: LlmIdeAPIClient
    private let language: String

    init(api: LlmIdeAPIClient, language: String = "en") {
        self.api = api
        self.language = language
    }

    func run(message: String, skills: [String], repoRoot: URL, extraRoots: [URL],
             timeout: TimeInterval?) async throws -> LoopAgentResult {
        try await api.loopAgentRun(message: message, skills: skills, repoRoot: repoRoot,
                                   extraRoots: extraRoots, language: language, timeout: timeout)
    }
}
