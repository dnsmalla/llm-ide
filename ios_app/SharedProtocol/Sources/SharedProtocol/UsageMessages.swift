import Foundation

// MARK: - Usage & limits
//
// A read-only projection of what the Mac's "Model & Limits" panel shows: per-model meters for the
// active provider, the Claude subscription windows, and the Mac's current edit-permission mode.
// Only numbers and short labels cross the wire — never the Claude OAuth token, and never the
// limit CONFIGURATION (saving limits stays on the Mac).

/// One bar: a model's cap, or a subscription window.
public struct UsageMeter: Codable, Equatable, Identifiable, Hashable {
    public let name: String
    /// 0–100, or nil when uncapped / unknown.
    public let pct: Double?
    /// "ok" | "warning" | "exhausted".
    public let state: String
    /// Short human text, e.g. "42 of 100 runs · Daily".
    public let detail: String
    /// Seconds since 1970 when the window resets.
    public let resetsAt: Double?
    public var id: String { name }
    public init(name: String, pct: Double?, state: String, detail: String, resetsAt: Double? = nil) {
        self.name = name
        self.pct = pct
        self.state = state
        self.detail = detail
        self.resetsAt = resetsAt
    }
}

public struct UsageGet: Codable, Equatable {
    public let type = MobileProtocol.Tag.usageGet
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

public struct UsageState: Codable, Equatable {
    public let type = MobileProtocol.Tag.usageState
    public let provider: String?
    /// "ok" | "degraded" | "paused" | "unconfigured".
    public let status: String?
    public let statusReason: String?
    public let activeModel: String?
    public let models: [UsageMeter]
    public let subscription: [UsageMeter]
    /// Why the subscription windows are absent (no login, session expired…), if they are.
    public let subscriptionNote: String?
    /// The Mac's edit-permission chip: "review" (Ask) | "acceptEdits" | "auto" (Bypass).
    public let permissionMode: String
    public let error: String?
    public init(provider: String?, status: String?, statusReason: String?, activeModel: String?,
                models: [UsageMeter], subscription: [UsageMeter], subscriptionNote: String?,
                permissionMode: String, error: String?) {
        self.provider = provider
        self.status = status
        self.statusReason = statusReason
        self.activeModel = activeModel
        self.models = models
        self.subscription = subscription
        self.subscriptionNote = subscriptionNote
        self.permissionMode = permissionMode
        self.error = error
    }
    private enum CodingKeys: String, CodingKey {
        case type, provider, status, statusReason, activeModel, models, subscription
        case subscriptionNote, permissionMode, error
    }
}
