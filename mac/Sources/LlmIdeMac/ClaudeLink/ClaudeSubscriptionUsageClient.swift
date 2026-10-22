import Foundation
import Security

/// Reads the Claude Code CLI's own OAuth session — the login Keychain item
/// `claude login` creates (service "Claude Code-credentials"), falling back
/// to `~/.claude/.credentials.json` — and calls Anthropic's own
/// `/api/oauth/usage` endpoint for the REAL subscription usage (session/
/// weekly rate limits, or Enterprise overage credits).
///
/// This is distinct from `LlmIdeAPIClient+Usage.swift`'s `usageLimits`/
/// `usageSummary`, which count this app's own local run ledger, and from
/// `usageRateLimits`, which only ever has data in direct API-key mode.
/// Neither of those can see Anthropic's real subscription quota — this is
/// the same OAuth-usage lookup the team's `statusline.sh` (Claude-code-
/// support / local_quick_setup_scripts) uses for the terminal statusline.
///
/// Read-only: never writes, rotates, or deletes the CLI's own credentials.
///
/// Deliberately NOT `@MainActor`: `SecItemCopyMatching` against a Keychain
/// item this app doesn't own (it's the `claude` CLI's) can pop the system
/// "wants to use your confidential information" prompt on first read, which
/// blocks synchronously until the user answers it. Keeping this off the main
/// actor keeps that block off the UI thread.
final class ClaudeSubscriptionUsageClient {

    enum UsageError: LocalizedError {
        case noCredentials
        case keychainDenied(OSStatus)
        case sessionExpired
        case httpError(Int)
        case invalidResponse

        var errorDescription: String? {
            switch self {
            case .noCredentials:
                return "Sign in with `claude login` in a terminal to see real subscription usage here."
            case .keychainDenied(let status):
                return "macOS blocked reading the Claude Code credentials (OSStatus \(status)). "
                    + "Allow access when prompted, or unlock your keychain."
            case .sessionExpired:
                return "Your `claude login` session has expired — run `claude login` again."
            case .httpError(let code):
                return "Anthropic usage API returned HTTP \(code)."
            case .invalidResponse:
                return "Anthropic usage API returned an unexpected response."
            }
        }
    }

    struct Window {
        let pct: Double?
        let resetsAt: Date?
    }

    /// Enterprise-only overage credit bucket (`extra_usage` in the API).
    struct ExtraUsage {
        let usedCents: Int?
        let limitCents: Int?
        let pct: Double?
    }

    struct Usage {
        /// "subscription" (Pro/Max/Team — session + weekly windows),
        /// "enterprise" (overage credits), or "unknown" (response had
        /// neither shape — mirrors statusline.sh's mode detection).
        let mode: String
        let fiveHour: Window
        let sevenDay: Window
        let extra: ExtraUsage?
    }

    // Redirect would otherwise carry `Authorization` off api.anthropic.com —
    // same guard GitHubClient/GitLabClient use for their bearer tokens.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 8
        return URLSession(configuration: config,
                          delegate: AuthRedirectGuard(headersToStrip: ["Authorization"]),
                          delegateQueue: nil)
    }()

    private static let usageURL = URL(string: "https://api.anthropic.com/api/oauth/usage")!
    private static let keychainService = "Claude Code-credentials"
    private static let credentialsFile = ("~/.claude/.credentials.json" as NSString).expandingTildeInPath

    static func fetchUsage() async throws -> Usage {
        let token = try readOAuthToken()

        var req = URLRequest(url: usageURL, timeoutInterval: 8)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw UsageError.invalidResponse }
        if http.statusCode == 401 || http.statusCode == 403 { throw UsageError.sessionExpired }
        guard http.statusCode == 200 else { throw UsageError.httpError(http.statusCode) }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw UsageError.invalidResponse
        }
        return parse(json)
    }

    // MARK: - Token lookup

    private static func readOAuthToken() throws -> String {
        var denial: OSStatus?
        switch readTokenFromKeychain() {
        case .found(let token): return token
        case .denied(let status): denial = status
        case .notFound: break
        }
        // Try the file fallback even after a denied/locked keychain — it's
        // the CLI's own documented fallback location, and a "Deny" click on
        // the keychain prompt shouldn't sink a token that's readable there.
        if let token = readTokenFromCredentialsFile() { return token }
        if let denial { throw UsageError.keychainDenied(denial) }
        throw UsageError.noCredentials
    }

    private enum KeychainTokenRead {
        case found(String)
        case notFound
        case denied(OSStatus)
    }

    /// Matches by service only (no account), same as
    /// `security find-generic-password -s "Claude Code-credentials" -w`.
    /// Keeps "no such item" distinct from "the read failed" (denied/locked
    /// keychain) — collapsing the two into one nil, as a first draft of this
    /// did, surfaces a misleading "sign in" message for a denied/locked
    /// keychain (see `SecItemKeychainAccess.read` in KeychainStore.swift for
    /// the same distinction made there).
    private static func readTokenFromKeychain() -> KeychainTokenRead {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let token = extractAccessToken(from: data) else {
                return .notFound
            }
            return .found(token)
        case errSecItemNotFound:
            return .notFound
        default:
            return .denied(status)
        }
    }

    private static func readTokenFromCredentialsFile() -> String? {
        guard let data = FileManager.default.contents(atPath: credentialsFile) else { return nil }
        return extractAccessToken(from: data)
    }

    private static func extractAccessToken(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let oauth = json["claudeAiOauth"] as? [String: Any],
              let token = oauth["accessToken"] as? String, !token.isEmpty else { return nil }
        return token
    }

    // MARK: - Response parsing (mirrors statusline.sh's jq logic)

    private static func parse(_ json: [String: Any]) -> Usage {
        let extra = json["extra_usage"] as? [String: Any]
        let isEnterprise = (extra?["is_enabled"] as? Bool) ?? false

        // Response shape varies: an org account nests under `rate_limits`,
        // a personal account returns `five_hour`/`seven_day` at top level.
        let rateLimits = json["rate_limits"] as? [String: Any]
        let fiveHourRaw = (rateLimits?["five_hour"] as? [String: Any]) ?? (json["five_hour"] as? [String: Any])
        let sevenDayRaw = (rateLimits?["seven_day"] as? [String: Any]) ?? (json["seven_day"] as? [String: Any])
        let fiveHour = parseWindow(fiveHourRaw)
        let sevenDay = parseWindow(sevenDayRaw)

        let mode: String
        if isEnterprise {
            mode = "enterprise"
        } else if fiveHour.pct != nil || sevenDay.pct != nil {
            mode = "subscription"
        } else {
            mode = "unknown"
        }

        var extraUsage: ExtraUsage?
        if isEnterprise, let extra {
            let used = (extra["used_credits"] as? NSNumber)?.intValue
            let limit = (extra["monthly_limit"] as? NSNumber)?.intValue
            let pct: Double?
            if let utilization = extra["utilization"] as? NSNumber {
                pct = utilization.doubleValue
            } else if let used, let limit, limit > 0 {
                pct = Double(used) / Double(limit) * 100
            } else {
                pct = nil
            }
            extraUsage = ExtraUsage(usedCents: used, limitCents: limit, pct: pct)
        }

        return Usage(mode: mode, fiveHour: fiveHour, sevenDay: sevenDay, extra: extraUsage)
    }

    private static func parseWindow(_ raw: [String: Any]?) -> Window {
        guard let raw else { return Window(pct: nil, resetsAt: nil) }
        let pct = (raw["utilization"] as? NSNumber)?.doubleValue ?? (raw["used_percentage"] as? NSNumber)?.doubleValue
        var resetsAt: Date?
        if let iso = raw["resets_at"] as? String {
            resetsAt = parseISO8601(iso)
        } else if let epoch = raw["resets_at"] as? NSNumber {
            resetsAt = Date(timeIntervalSince1970: epoch.doubleValue)
        }
        return Window(pct: pct, resetsAt: resetsAt)
    }

    /// `ISO8601DateFormatter()`'s default options reject fractional seconds
    /// (`…T18:00:00.000Z`), which this endpoint may send — try with them
    /// first, same fallback order as `ModelLimitsPanel.relativeReset`.
    private static func parseISO8601(_ iso: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}
