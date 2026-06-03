import Foundation

/// Full project export returned by GET /kb/project/:projectId/export.
/// Decoded by MeetNotesAPIClient, then written to the local folder tree
/// by ProjectExporter.
struct ProjectExportBundle: Decodable {
    let projectId: String
    let exportedAt: String
    let meetingCount: Int
    let planCount: Int
    let meetings: [Meeting]
    let plans: [Plan]

    // MARK: - Meeting

    struct Meeting: Decodable {
        let id: String
        let title: String
        let date: String?
        let durationSec: Int?
        let language: String
        let participants: [String]
        let transcript: String
        let entities: [Entity]
    }

    struct Entity: Decodable {
        let id: String
        let kind: String   // "action" | "decision" | "blocker"
        let text: String
        let quote: String?
    }

    // MARK: - Plan

    struct Plan: Codable {
        let id: String
        let meetingId: String?
        let title: String
        let goal: String
        let language: String
        let createdAt: String?
        let updatedAt: String?
        let tasks: [Task]
    }

    struct Task: Codable {
        let id: String
        let position: Int
        let milestone: String?
        let title: String
        let description: String?
        let owner: String?
        let due: String?
        let estimateDays: Int?
        let dependsOn: [String]
        let status: String   // planned | in_progress | done | blocked | cancelled
        let risk: String?
        let riskReason: String?
    }
}
