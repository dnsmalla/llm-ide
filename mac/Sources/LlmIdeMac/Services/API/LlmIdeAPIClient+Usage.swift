import Foundation

// Model usage limits + auto-fallback (see extension/kb/usage.mjs + router.mjs).
// The backend is the source of truth: the "Model & Limits" panel reads
// `usageSummary` for the live dashboard and `usageLimits`/`saveUsageLimits` for
// the caps; the Auto Tasks run loop calls `resolveUsageModel` before each run
// and `recordUsage` after it so subscription-CLI usage counts globally too.
extension LlmIdeAPIClient {

    /// One model's cap in a provider's fallback chain. Codable both ways: the
    /// same shape is read from GET /limits and written back to PUT /limits
    /// (the server ignores the read-only `label`/`custom` fields on write).
    struct ModelLimit: Codable, Identifiable, Hashable {
        var model: String
        var label: String?
        var priority: Int
        var enabled: Bool
        var limitValue: Int          // 0 = no cap
        var unit: String             // "runs" | "tokens"
        var windowKind: String       // "daily" | "monthly"
        var thresholdPct: Int        // proactive switch point, 1–100
        var custom: Bool?

        var id: String { model }

        enum CodingKeys: String, CodingKey {
            case model, label, priority, enabled
            case limitValue = "limit_value"
            case unit
            case windowKind = "window_kind"
            case thresholdPct = "threshold_pct"
            case custom
        }
    }

    struct UsageLimits: Codable { var chains: [String: [ModelLimit]] }

    /// Resolver verdict: which model should run, and why.
    struct UsageResolution: Codable, Hashable {
        var provider: String
        var model: String?           // nil when paused/unconfigured
        var status: String           // "ok" | "degraded" | "paused" | "unconfigured"
        var resetAt: String?
        var reason: String?
        var used: Double?
        var limit: Double?
        var pct: Double?
        var unit: String?
        /// True when a cap is set or a quota flag fired — i.e. the chain is
        /// actually governing this provider. When false the chain is inert and
        /// callers should keep the user's own model choice.
        var engaged: Bool?

        var isPaused: Bool { status == "paused" }
    }

    /// One model's live usage for the dashboard.
    struct UsageModelStat: Codable, Identifiable, Hashable {
        var model: String
        var label: String?
        var enabled: Bool
        var custom: Bool?
        var priority: Int
        var unit: String
        var windowKind: String
        var limit: Int
        var thresholdPct: Int
        var used: Double
        var pct: Double?             // nil when uncapped (limit 0)
        var state: String           // "ok" | "warning" | "exhausted"
        var quota: Bool
        var resetAt: String?

        var id: String { model }

        enum CodingKeys: String, CodingKey {
            case model, label, enabled, custom, priority, unit
            case windowKind = "window_kind"
            case limit
            case thresholdPct = "threshold_pct"
            case used, pct, state, quota, resetAt
        }
    }

    struct ProviderUsage: Codable { var active: UsageResolution; var models: [UsageModelStat] }
    struct UsageSummary: Codable { var providers: [String: ProviderUsage] }

    /// One Anthropic `anthropic-ratelimit-*` bucket (API-key rate limits, not
    /// subscription usage). `reset` is an ISO-8601 timestamp string.
    struct RateLimitBucket: Codable, Hashable {
        var limit: Double?
        var remaining: Double?
        var reset: String?
    }

    /// Latest API rate-limit snapshot captured from a live Anthropic response.
    /// Nil when only CLI/subscription dispatch has run (no headers to read).
    struct RateLimits: Codable, Hashable {
        var capturedAt: String?
        var provider: String?
        var model: String?
        var requests: RateLimitBucket?
        var tokens: RateLimitBucket?
        var inputTokens: RateLimitBucket?
        var outputTokens: RateLimitBucket?
    }

    // MARK: - Reads

    /// Current caps (built-in chains merged with the user's overrides).
    func usageLimits(provider: String? = nil) async throws -> UsageLimits {
        let q = provider.map { "?provider=\($0)" } ?? ""
        return try await get("/kb/usage/limits\(q)", authenticated: true)
    }

    /// Live per-model usage + the resolved active model per provider.
    func usageSummary(provider: String? = nil) async throws -> UsageSummary {
        let q = provider.map { "?provider=\($0)" } ?? ""
        return try await get("/kb/usage/summary\(q)", authenticated: true)
    }

    /// Which model in `provider`'s chain should run next (the auto-switch).
    /// `prefer` is the caller's desired model — kept when healthy, stepped down
    /// only when constrained.
    func resolveUsageModel(provider: String, prefer: String? = nil) async throws -> UsageResolution {
        var q = "?provider=\(provider)"
        if let p = prefer, !p.isEmpty,
           let enc = p.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            q += "&prefer=\(enc)"
        }
        return try await get("/kb/usage/resolve\(q)", authenticated: true)
    }

    /// Latest API rate-limit headers for a provider (nil in subscription/CLI mode).
    func usageRateLimits(provider: String) async throws -> RateLimits? {
        struct Resp: Decodable { let ratelimits: RateLimits? }
        let r: Resp = try await get("/kb/usage/ratelimits?provider=\(provider)", authenticated: true)
        return r.ratelimits
    }

    // MARK: - Writes

    /// Replace the caps for the providers present in `chains`.
    @discardableResult
    func saveUsageLimits(_ chains: [String: [ModelLimit]]) async throws -> UsageLimits {
        struct Req: Encodable { let chains: [String: [ModelLimit]] }
        struct Resp: Decodable { let ok: Bool; let chains: [String: [ModelLimit]] }
        let r: Resp = try await put("/kb/usage/limits", body: Req(chains: chains), authenticated: true)
        return UsageLimits(chains: r.chains)
    }

    /// Record one usage event. Auto Tasks pass source "auto-task" and no tokens
    /// (the CLI can't report them) — the run still counts toward run-based caps.
    @discardableResult
    func recordUsage(provider: String, model: String, source: String,
                     endpoint: String?, runs: Int = 1) async throws -> Bool {
        struct Req: Encodable {
            let provider: String
            let model: String
            let source: String
            let endpoint: String?
            let runs: Int
        }
        struct Resp: Decodable { let ok: Bool }
        let r: Resp = try await post("/kb/usage/record",
                                     body: Req(provider: provider, model: model, source: source,
                                               endpoint: endpoint, runs: runs),
                                     authenticated: true)
        return r.ok
    }
}
