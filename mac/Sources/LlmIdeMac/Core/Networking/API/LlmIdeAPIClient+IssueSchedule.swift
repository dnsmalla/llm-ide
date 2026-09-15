import Foundation

// Issue scheduling overlay (gantt parity for GitHub). The backend stores the
// start/due/estimate/dependency metadata GitHub issues lack, keyed by
// (provider, repo, issueNumber). The gantt reads these and merges them onto
// the provider's issues client-side. See extension/kb/issue-schedule.mjs +
// routes/issue-schedule.mjs and docs/spec/knowledge-base.md.
extension LlmIdeAPIClient {

    /// One issue's scheduling overlay. `nil` date/estimate means "unset";
    /// writing nil clears that field on the server.
    struct IssueSchedule: Codable, Identifiable, Hashable {
        var provider: String          // "github" | "gitlab"
        var repo: String              // "owner/name"
        var issueNumber: Int
        var startDate: String?        // YYYY-MM-DD
        var dueDate: String?          // YYYY-MM-DD
        var estimateDays: Double?
        var dependsOn: [Int]          // issue numbers
        var updatedAt: String?

        // Identity within a repo is the issue number — used for list merges.
        var id: Int { issueNumber }

        init(provider: String, repo: String, issueNumber: Int,
             startDate: String? = nil, dueDate: String? = nil,
             estimateDays: Double? = nil, dependsOn: [Int] = [], updatedAt: String? = nil) {
            self.provider = provider; self.repo = repo; self.issueNumber = issueNumber
            self.startDate = startDate; self.dueDate = dueDate
            self.estimateDays = estimateDays; self.dependsOn = dependsOn; self.updatedAt = updatedAt
        }
    }

    /// All schedule overlays for a repo, keyed by issue number for easy merge.
    func listIssueSchedules(provider: String, repo: String) async throws -> [Int: IssueSchedule] {
        struct Resp: Decodable { let schedules: [IssueSchedule] }
        guard let repoEnc = repo.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let providerEnc = provider.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            throw APIError.invalidURL
        }
        let r: Resp = try await get("/kb/issue-schedule?provider=\(providerEnc)&repo=\(repoEnc)", authenticated: true)
        return Dictionary(uniqueKeysWithValues: r.schedules.map { ($0.issueNumber, $0) })
    }

    /// Create or replace one issue's schedule overlay. Each field is fully
    /// replaced — pass the complete desired value (nil clears).
    @discardableResult
    func upsertIssueSchedule(provider: String, repo: String, issueNumber: Int,
                             startDate: String?, dueDate: String?,
                             estimateDays: Double?, dependsOn: [Int]) async throws -> IssueSchedule {
        struct Req: Encodable {
            let provider: String
            let repo: String
            let issueNumber: Int
            let startDate: String?
            let dueDate: String?
            let estimateDays: Double?
            let dependsOn: [Int]
        }
        return try await send(
            path: "/kb/issue-schedule",
            method: "PUT",
            body: Req(provider: provider, repo: repo, issueNumber: issueNumber,
                      startDate: startDate, dueDate: dueDate,
                      estimateDays: estimateDays, dependsOn: dependsOn),
            authenticated: true,
        )
    }

    /// Remove one issue's schedule overlay. Returns true if a row was deleted.
    @discardableResult
    func deleteIssueSchedule(provider: String, repo: String, issueNumber: Int) async throws -> Bool {
        struct Req: Encodable { let provider: String; let repo: String; let issueNumber: Int }
        struct Resp: Decodable { let deleted: Bool }
        let r: Resp = try await send(
            path: "/kb/issue-schedule",
            method: "DELETE",
            body: Req(provider: provider, repo: repo, issueNumber: issueNumber),
            authenticated: true,
        )
        return r.deleted
    }
}
