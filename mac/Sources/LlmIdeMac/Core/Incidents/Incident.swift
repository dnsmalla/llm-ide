import Foundation

public enum IncidentSource: String, Codable, CaseIterable, Sendable {
    case ui, log, crash, server
    /// An SDK release whose new surface awaits adoption — a record, not a captured error.
    case sdk

    /// A source written by a newer build must not make the whole incident file unreadable.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = IncidentSource(rawValue: raw) ?? .ui
    }
}

public enum IncidentStatus: String, Codable, Sendable { case new, fixing, proposed, ignored, needsHuman, fixed }

public struct IncidentProposal: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var mainRepo: String
    public var worktreePath: String
    public var branch: String
    public var baseCommit: String

    public var id: String { worktreePath }

    public init(mainRepo: String, worktreePath: String, branch: String, baseCommit: String) {
        self.mainRepo = mainRepo
        self.worktreePath = worktreePath
        self.branch = branch
        self.baseCommit = baseCommit
    }
}

public struct Incident: Codable, Equatable, Identifiable, Sendable {
    /// The signature: two reports with the same signature are the same incident.
    public var id: String
    public var source: IncidentSource
    public var category: String
    public var message: String
    public var stack: String?
    public var firstSeen: Date
    public var lastSeen: Date
    public var count: Int
    public var attempts: Int
    public var status: IncidentStatus
    public var note: String?
    public var proposal: IncidentProposal?

    public init(id: String, source: IncidentSource, category: String, message: String, stack: String?,
                firstSeen: Date, lastSeen: Date, count: Int = 1, attempts: Int = 0,
                status: IncidentStatus = .new, note: String? = nil, proposal: IncidentProposal? = nil) {
        self.id = id
        self.source = source
        self.category = category
        self.message = message
        self.stack = stack
        self.firstSeen = firstSeen
        self.lastSeen = lastSeen
        self.count = count
        self.attempts = attempts
        self.status = status
        self.note = note
        self.proposal = proposal
    }
}
