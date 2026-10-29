import Foundation

// The per-chat route (K1 Phase 6b, docs/spec/session-router.md): which provider and model
// one chat is pinned to and its session token limit. This file is the PURE half, shared by
// Chat (the control, the engine), ClaudeLink (the wire) and Core/Networking (the client):
// value types and decisions with no I/O, so chat-contract-lab can assert them.
//
// Billable tokens are input + output + cache write, as the server counts them; cache
// reads are shown next to the meter and never counted (answer Q-R1, 2026-10-30).

/// What a chat FILE keeps about its route (all of it optional on disk; `ChatSession.route`).
/// The server's route row is purged at quit and re-created from this on the next open
/// (answer Q-R2: the limit and the tokens used survive a quit).
public struct ChatRouteSettings: Codable, Equatable, Sendable {
    /// Pinned provider (`anthropic` or `custom:<id>`); nil with a nil model = not pinned.
    public var provider: String?
    public var model: String?
    /// Billable-token cap for the chat; nil = no cap.
    public var tokenLimit: Int?
    /// Billable tokens the chat has used, mirrored from the server's counters.
    public var tokensUsed: Int

    public init(provider: String? = nil, model: String? = nil, tokenLimit: Int? = nil, tokensUsed: Int = 0) {
        self.provider = provider
        self.model = model
        self.tokenLimit = tokenLimit
        self.tokensUsed = tokensUsed
    }

    public var isPinned: Bool { (provider ?? "").isEmpty == false && (model ?? "").isEmpty == false }
    /// True when there is nothing worth keeping in the file (so the key is omitted).
    public var isEmpty: Bool { !isPinned && tokenLimit == nil && tokensUsed == 0 }
}

/// The server fields the pure logic needs (a projection of `LlmIdeAPIClient.ChatRouteState`).
public struct ChatRouteSnapshot: Equatable, Sendable {
    public var provider: String
    public var model: String
    public var tokenLimit: Int?
    public var billableUsed: Int
    public var cacheRead: Int
    public var switchSeq: Int

    public init(provider: String, model: String, tokenLimit: Int?, billableUsed: Int, cacheRead: Int = 0, switchSeq: Int) {
        self.provider = provider
        self.model = model
        self.tokenLimit = tokenLimit
        self.billableUsed = billableUsed
        self.cacheRead = cacheRead
        self.switchSeq = switchSeq
    }
}

/// One routed turn's notices, decoded from the stream (`notice` kinds route_switch / session_budget).
public struct ChatRouteSwitchNotice: Equatable, Sendable {
    public struct Endpoint: Equatable, Sendable {
        public let provider: String
        public let model: String
        public init(provider: String, model: String) { self.provider = provider; self.model = model }
    }
    public let from: Endpoint?
    public let to: Endpoint
    public let reason: String
    public let cold: Bool
    public let estimatedPrefillTokens: Int
    public init(from: Endpoint?, to: Endpoint, reason: String, cold: Bool, estimatedPrefillTokens: Int) {
        self.from = from; self.to = to; self.reason = reason; self.cold = cold; self.estimatedPrefillTokens = estimatedPrefillTokens
    }
}

public struct ChatSessionBudgetNotice: Equatable, Sendable {
    public let used: Int
    public let limit: Int
    public let remaining: Int
    /// `warn80` or `reached`.
    public let level: String
    public init(used: Int, limit: Int, remaining: Int, level: String) {
        self.used = used; self.limit = limit; self.remaining = remaining; self.level = level
    }
}

public enum ChatRouteLogic {
    public enum Level: Equatable, Sendable { case none, ok, warn, reached }

    /// What to do when a chat opens, given its file and the server's row.
    public enum OpenAction: Equatable, Sendable {
        /// Nothing to send and nothing to change in the file.
        case none
        /// The server has no row (it was purged at quit, or the chat is new) and the file has
        /// settings: PUT them back, seeding the tokens used (`tokensUsed`).
        case restoreToServer(ChatRouteSettings)
        /// The server's row is the truth: take it into the file.
        case adoptServer(ChatRouteSettings)
    }

    /// Cap presets in the control, in billable tokens.
    public static let presets: [Int] = [50_000, 200_000, 1_000_000, 5_000_000]
    /// The server's own bound; a larger number is refused there, so refuse it here first.
    public static let maxLimit = 1_000_000_000_000

    public static func level(used: Int, limit: Int?) -> Level {
        guard let limit, limit > 0 else { return .none }
        if used >= limit { return .reached }
        return Double(used) >= Double(limit) * 0.8 ? .warn : .ok
    }

    /// Parse the limit field. `.some(nil)` = "no cap" (empty, "none", "off", "0"); `nil` = not a number.
    /// Accepts `50000`, `50,000`, `200k`, `1.5m`; rejects negatives, fractions of a token and absurd sizes.
    public static func parseLimit(_ text: String) -> Int?? {
        let t = text.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: ",", with: "")
        if t.isEmpty || t == "none" || t == "off" || t == "no limit" || t == "0" { return .some(nil) }
        var multiplier = 1.0
        var digits = t
        if t.hasSuffix("k") { multiplier = 1_000; digits = String(t.dropLast()) }
        else if t.hasSuffix("m") { multiplier = 1_000_000; digits = String(t.dropLast()) }
        guard let value = Double(digits), value.isFinite, value > 0 else { return nil }
        // A bare number is whole tokens; only k and m may carry a decimal point.
        if multiplier == 1, value != value.rounded() { return nil }
        let tokens = (value * multiplier).rounded()
        guard tokens >= 1, tokens <= Double(maxLimit) else { return nil }
        return .some(Int(tokens))
    }

    /// "12.3k / 200k" or "12.3k" with no cap; cache reads ride after it ("+ 90k cached reads") when any.
    public static func meterText(used: Int, limit: Int?, cacheRead: Int = 0) -> String {
        var s = compact(used)
        if let limit, limit > 0 { s += " / \(compact(limit))" }
        if cacheRead > 0 { s += " (+\(compact(cacheRead)) cached reads)" }
        return s
    }

    public static func compact(_ n: Int) -> String {
        let v = Double(max(0, n))
        if v >= 1_000_000 { return trimmed(v / 1_000_000) + "m" }
        if v >= 1_000 { return trimmed(v / 1_000) + "k" }
        return String(Int(v))
    }

    private static func trimmed(_ x: Double) -> String {
        let r = (x * 10).rounded() / 10
        return r == r.rounded() ? String(Int(r)) : String(r)
    }

    /// The one-click raise at the cap: 50 percent more, never less than 50k above what is used,
    /// rounded up to a whole thousand, and never past the server's bound.
    public static func raisedLimit(current: Int, used: Int) -> Int {
        let grown = Int((Double(max(current, 1)) * 1.5).rounded(.up))
        let floor = max(used, current) + 50_000
        let raised = max(grown, floor)
        let rounded = ((raised + 999) / 1000) * 1000
        return min(rounded, maxLimit)
    }

    /// The cold-switch warning. Honest about what is lost: the old side's cache, not the conversation.
    public static func coldSwitchWarning(estimatedTokens: Int) -> String {
        let n = estimatedTokens > 0 ? "about \(compact(estimatedTokens)) tokens" : "one full prompt"
        return "Switching loses the prompt cache: the next turn pays \(n) to catch up. The conversation itself is kept."
    }

    /// The cap line shown with the meter: "limit is approximate to one reply".
    public static let approximationNote = "The limit is approximate to one reply."

    /// Decide what to do when a chat opens. The server's row wins when it exists (it holds the
    /// counters, including turns another window ran); the file re-creates a purged row.
    public static func onOpen(file: ChatRouteSettings?, server: ChatRouteSnapshot?) -> OpenAction {
        let existing = server.map { $0.switchSeq > 0 } ?? false
        if let server, existing {
            let adopted = ChatRouteSettings(
                provider: server.provider.isEmpty ? nil : server.provider,
                model: server.model.isEmpty ? nil : server.model,
                tokenLimit: server.tokenLimit, tokensUsed: server.billableUsed)
            return adopted == (file ?? ChatRouteSettings()) ? .none : .adoptServer(adopted)
        }
        guard let file, !file.isEmpty else { return .none }
        return .restoreToServer(file)
    }

    /// Should the next turn carry the chat's history? A pinned non-Claude chat has no server
    /// session to resume, and the first turn after a change needs the handoff material.
    public static func sendsHistory(settings: ChatRouteSettings?, changedSinceLastTurn: Bool) -> Bool {
        guard let settings, settings.isPinned else { return false }
        return changedSinceLastTurn || (settings.provider ?? "") != "anthropic"
    }

    /// Whether the control should be offered at all: the router is on for this install and the
    /// chat runs on the Agent engine (the classic engine never reaches the route).
    public static func isOffered(routerPref: Bool, serverEnabled: Bool?, chatRunsOnAgentEngine: Bool) -> Bool {
        routerPref && chatRunsOnAgentEngine && serverEnabled != false
    }
}

/// The two Mac preferences behind the control (Settings, Providers). The router itself is a SERVER
/// switch (LLMIDE_ROUTER, LLMIDE_ROUTER_CAP, default off); these are what the Mac passes to the
/// backend it launches, applied on the NEXT backend start, and what shows or hides the control.
public enum ChatRoutePreference {
    public static let routerKey = "chat.router"
    public static let capKey = "chat.router.cap"

    public static func routerEnabled(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: routerKey) }
    public static func capEnabled(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: capKey) }

    /// Environment entries for the backend child. Empty (nothing set) when the router pref is off, so
    /// a default install launches the server exactly as before; an inherited value is dropped by the caller.
    public static func backendEnvironment(_ defaults: UserDefaults = .standard) -> [String: String] {
        guard routerEnabled(defaults) else { return [:] }
        var env = ["LLMIDE_ROUTER": "on"]
        if capEnabled(defaults) { env["LLMIDE_ROUTER_CAP"] = "on" }
        return env
    }
}
