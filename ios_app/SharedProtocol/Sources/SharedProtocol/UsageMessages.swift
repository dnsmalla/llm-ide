import Foundation

// MARK: - Usage & limits
//
// A read-only view of the host's usage meters and edit-permission mode, mapped from Host API v1
// `usage.get` by `HostApiReadMapping.usageState`. Only numbers and short labels — never a token, and never
// the limit configuration.

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

public struct UsageState: Codable, Equatable {
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
}
