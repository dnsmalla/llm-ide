import Foundation

// MARK: - Self-Heal
//
// Review of the incidents the Mac recorded and the fixes its Self-Heal loop proposed. Incidents are
// already redacted on the Mac; the free-text `note` and any diff are redacted and capped again
// before they are sent. The phone never supplies a proposal — it names an INCIDENT id and the Mac
// looks the proposal up itself. "Apply" is a Mac-side switch (Phone access) and targets the
// LLM-IDE source checkout, never the user's active project.

public struct SelfHealIncident: Codable, Equatable, Identifiable, Hashable {
    /// The incident signature (16 hex).
    public let id: String
    /// "ui" | "log" | "crash" | "server".
    public let source: String
    public let category: String
    public let message: String
    public let count: Int
    /// "new" | "fixing" | "proposed" | "ignored" | "needsHuman" | "fixed".
    public let status: String
    public let note: String?
    /// Seconds since 1970.
    public let lastSeen: Double
    public let hasProposal: Bool
    public let branch: String?
    public init(id: String, source: String, category: String, message: String, count: Int, status: String,
                note: String?, lastSeen: Double, hasProposal: Bool, branch: String?) {
        self.id = id
        self.source = source
        self.category = category
        self.message = message
        self.count = count
        self.status = status
        self.note = note
        self.lastSeen = lastSeen
        self.hasProposal = hasProposal
        self.branch = branch
    }
}

public struct SelfHealList: Codable, Equatable {
    public let type = MobileProtocol.Tag.selfHealList
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

/// Reply to `selfheal_list` and `selfheal_action` (also pushed when incidents change).
public struct SelfHealState: Codable, Equatable {
    public let type = MobileProtocol.Tag.selfHealState
    public let incidents: [SelfHealIncident]
    /// Whether this Mac currently lets the phone apply a proposal.
    public let canApply: Bool
    /// False when Self-Heal is switched off on the Mac.
    public let enabled: Bool
    /// Result of the last action ("Applied …") or why it was refused.
    public let message: String?
    public let error: String?
    public init(incidents: [SelfHealIncident], canApply: Bool, enabled: Bool,
                message: String? = nil, error: String? = nil) {
        self.incidents = incidents
        self.canApply = canApply
        self.enabled = enabled
        self.message = message
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, incidents, canApply, enabled, message, error }
}

public struct SelfHealAction: Codable, Equatable {
    public enum Kind: String, Codable, Equatable { case ignore, retry, apply, discard }
    public let type = MobileProtocol.Tag.selfHealAction
    public let incidentId: String
    public let action: Kind
    public init(incidentId: String, action: Kind) {
        self.incidentId = incidentId
        self.action = action
    }
    private enum CodingKeys: String, CodingKey { case type, incidentId, action }
}

public struct SelfHealDiffRequest: Codable, Equatable {
    public let type = MobileProtocol.Tag.selfHealDiff
    public let incidentId: String
    public init(incidentId: String) { self.incidentId = incidentId }
    private enum CodingKeys: String, CodingKey { case type, incidentId }
}

public struct SelfHealDiffResult: Codable, Equatable {
    public let type = MobileProtocol.Tag.selfHealDiffResult
    public let incidentId: String
    public let diff: String?
    public let truncated: Bool
    public let error: String?
    public init(incidentId: String, diff: String?, truncated: Bool = false, error: String? = nil) {
        self.incidentId = incidentId
        self.diff = diff
        self.truncated = truncated
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, incidentId, diff, truncated, error }
}
