import Foundation

struct MeetingSummary: Codable, Equatable {
    struct Action: Codable, Equatable {
        let owner: String?
        let text: String
        let due: String?
    }
    struct Decision: Codable, Equatable {
        let text: String
    }
    struct Blocker: Codable, Equatable {
        let text: String
    }
    let gist: String
    let tldr: [String]
    let full: String
    let actions: [Action]
    let decisions: [Decision]
    let blockers: [Blocker]
    let model: String
    let generatedAt: Date
}
