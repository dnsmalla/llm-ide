import Foundation

extension MeetNotesAPIClient {

    struct ReviewItem: Codable, Identifiable {
        let id: String
        let kind: String
        let planId: String?
        let taskId: String?
        let title: String
        let status: String
        let createdAt: String
        let decidedAt: String?
        let reviewerNote: String?
        let payload: AnyCodable?
        let result: AnyCodable?
        let guardrails: GuardrailReport?
    }

    struct GuardrailReport: Codable {
        let passed: Bool
        let blocking: [GuardrailFinding]
        let warnings: [GuardrailFinding]
        let info: [GuardrailFinding]
    }

    struct GuardrailFinding: Codable, Identifiable {
        let ruleId: String
        let severity: String
        let message: String
        var id: String { ruleId + "::" + message }
    }

    enum DispatchTarget: String, Codable, CaseIterable, Identifiable {
        case github, backlog, linear
        var id: String { rawValue }
        var displayName: String {
            switch self {
            case .github:  return "GitHub Issues"
            case .backlog: return "Backlog"
            case .linear:  return "Linear"
            }
        }
    }

    struct DispatchPreviewItem: Codable, Identifiable {
        let taskId: String
        let status: String              // "preview"
        let title: String
        let body: String
        let labels: [String]?
        let assignees: [String]?
        var id: String { taskId }
    }

    struct DispatchPreviewResponse: Codable {
        let target: String
        let plan: PlanRef
        let results: [DispatchPreviewItem]
        struct PlanRef: Codable { let id: String; let title: String }
    }

    /// Hits /kb/dispatch with target=preview — server never calls the
    /// external API; just returns the exact payload it WOULD send.  Used
    /// to populate the dispatch sheet's "this is what each ticket will
    /// look like" preview before the user submits for review.
    struct DispatchPreviewRequest: Encodable {
        let planId: String
        let target: String = "preview"
        let taskIds: [String]?
    }

    /// Provider config carries the few credentials each tracker needs.
    /// Strings only — GitHub `repo`+`token`, Backlog `space`+`projectId`
    /// +`apiKey`+`issueTypeId` (+optional `priorityId`), Linear `teamId`
    /// +`apiKey` (+optional `projectId`).  All values flow through to
    /// the server's dispatcher.mjs adapters unchanged.
    struct DispatchReviewSubmitRequest: Encodable {
        let kind = "dispatch"
        let planId: String
        let title: String
        let payload: DispatchPayload
        struct DispatchPayload: Encodable {
            let planId: String
            let target: String
            let taskIds: [String]?
            let items: [DispatchPreviewItem]    // for guardrails to scan
            let config: [String: String]
        }
    }

    struct CodegenFile: Codable, Identifiable {
        let path: String
        let kind: String                // "create" | "modify"
        let language: String
        let content: String
        var id: String { path }
    }

    struct CodegenResult: Codable {
        let taskId: String
        let summary: String
        let files: [CodegenFile]
        let tests: [CodegenFile]
        let notes: String?
    }

    struct CodegenRequest: Encodable {
        let taskId: String
        let language: String?
        let includeFileContext: Bool?
    }

    /// Submit codegen output to the review queue.  Server overrides any
    /// client-supplied `allowedRepos` with the per-user list before
    /// guardrails run, so we don't have to plumb that field through.
    struct CodegenApplySubmitRequest: Encodable {
        let kind = "codegen-apply"
        let planId: String?
        let taskId: String
        let title: String
        let payload: CodegenApplyPayload
        struct CodegenApplyPayload: Encodable {
            let taskId: String
            let repoPath: String
            let summary: String?
            let files: [CodegenFile]
            let tests: [CodegenFile]
            let pr: PROptions?
            struct PROptions: Encodable {
                let ghRepo: String
                let ghToken: String
                let baseBranch: String?
            }
        }
    }

    func previewDispatch(planId: String, taskIds: [String]? = nil) async throws -> DispatchPreviewResponse {
        try await post("/kb/dispatch",
                       body: DispatchPreviewRequest(planId: planId, taskIds: taskIds),
                       authenticated: true)
    }

    /// Submit a real dispatch to the review queue (status=pending).
    /// The user must approve it in ReviewView before tickets are created.
    func submitDispatchForReview(
        planId: String,
        planTitle: String,
        target: DispatchTarget,
        taskIds: [String]?,
        items: [DispatchPreviewItem],
        config: [String: String],
    ) async throws -> ReviewItem {
        let body = DispatchReviewSubmitRequest(
            planId: planId,
            title: "Dispatch · \(planTitle) → \(target.displayName)",
            payload: .init(
                planId: planId,
                target: target.rawValue,
                taskIds: taskIds,
                items: items,
                config: config,
            ),
        )
        return try await post("/kb/review/submit", body: body, authenticated: true)
    }

    func submitCodegenForReview(
        planId: String?,
        taskId: String,
        taskTitle: String,
        repoPath: String,
        summary: String?,
        files: [CodegenFile],
        tests: [CodegenFile],
        pr: CodegenApplySubmitRequest.CodegenApplyPayload.PROptions? = nil,
    ) async throws -> ReviewItem {
        let body = CodegenApplySubmitRequest(
            planId: planId,
            taskId: taskId,
            title: "Code apply · \(taskTitle)",
            payload: .init(
                taskId: taskId,
                repoPath: repoPath,
                summary: summary,
                files: files,
                tests: tests,
                pr: pr,
            ),
        )
        return try await post("/kb/review/submit", body: body, authenticated: true)
    }

    /// Runs the codegen agent on a single task.  Output is staged in
    /// memory — nothing is written to disk until the user submits AND
    /// approves the codegen-apply review item.  Long-running (LLM call);
    /// caller should show a spinner.
    func generateCode(taskId: String, language: String? = nil) async throws -> CodegenResult {
        try await post("/kb/generate-code",
                       body: CodegenRequest(taskId: taskId, language: language, includeFileContext: true),
                       authenticated: true)
    }
}
