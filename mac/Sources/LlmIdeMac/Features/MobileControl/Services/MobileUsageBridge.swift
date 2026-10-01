import Foundation
import SharedProtocol

/// Serves `usage_get`: the Mac's per-model usage meters, Claude subscription windows and current
/// edit-permission mode, as a read-only snapshot. Limits are never written from the phone, and the
/// Claude OAuth token stays inside `ClaudeSubscriptionUsageClient`.
@MainActor
final class MobileUsageBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?
    private var cached: (at: Date, state: UsageState)?
    private var inFlight = false
    /// Mirrors `ModelLimitsPanel.subscriptionUsageSuppressed`: after a missing login, a Keychain
    /// refusal or an expired session, stop asking — each retry can re-raise a macOS Keychain prompt.
    private var subscriptionNote: String?
    private var subscriptionSuppressed = false

    static let cacheSeconds: TimeInterval = 30
    static let maxModels = 20

    init(manager: MobileControlManager) { self.manager = manager }

    // MARK: - MobileFeatureBridge

    func handle(type: String, data: Data?) -> Bool {
        guard type == MobileProtocol.Tag.usageGet else { return false }
        Task { @MainActor [weak self] in await self?.respond() }
        return true
    }
    func installPushObservers() {}
    func removePushObservers() {}

    // MARK: - Request

    private func respond() async {
        guard let manager else { return }
        // The permission chip is a UserDefaults read, so it is always fresh even when meters are cached.
        let mode = Self.currentPermissionMode()
        if let cached, Date().timeIntervalSince(cached.at) < Self.cacheSeconds {
            manager.reply(Self.withMode(cached.state, mode))
            return
        }
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }

        guard let api = manager.api, let config = manager.config else {
            manager.reply(Self.emptyState(mode: mode, error: "The Mac isn't ready yet — its backend isn't connected."))
            return
        }
        let provider = (AICliTool(rawValue: config.activeCLI) ?? .claudeCode).provider
        var summary: LlmIdeAPIClient.ProviderUsage?
        var error: String?
        do {
            summary = try await api.usageSummary(provider: provider).providers[provider]
        } catch let failure {
            error = "Couldn't read usage from the Mac: \(failure.localizedDescription)"
        }
        var subscription: ClaudeSubscriptionUsageClient.Usage?
        if provider == ClaudeCLI.provider, !subscriptionSuppressed {
            do {
                subscription = try await ClaudeSubscriptionUsageClient.fetchUsage()
            } catch let usageError as ClaudeSubscriptionUsageClient.UsageError {
                switch usageError {
                case .noCredentials, .keychainDenied, .sessionExpired:
                    subscriptionSuppressed = true
                    subscriptionNote = usageError.errorDescription
                default:
                    subscriptionNote = usageError.errorDescription
                }
            } catch {
                subscriptionNote = "Couldn't read the Claude subscription usage."
            }
        }
        let state = Self.state(provider: provider, summary: summary, subscription: subscription,
                               subscriptionNote: subscription == nil ? subscriptionNote : nil,
                               permissionMode: mode, error: error)
        cached = (Date(), state)
        manager.reply(state)
    }

    // MARK: - Projection (pure, so tests can pin it)

    nonisolated static func currentPermissionMode() -> String {
        let raw = UserDefaults.standard.string(forKey: EditAcceptanceMode.defaultsKey)
        return (raw.flatMap(EditAcceptanceMode.init(rawValue:)) ?? .review).rawValue
    }

    nonisolated static func withMode(_ s: UsageState, _ mode: String) -> UsageState {
        UsageState(provider: s.provider, status: s.status, statusReason: s.statusReason,
                   activeModel: s.activeModel, models: s.models, subscription: s.subscription,
                   subscriptionNote: s.subscriptionNote, permissionMode: mode, error: s.error)
    }

    nonisolated static func emptyState(mode: String, error: String) -> UsageState {
        UsageState(provider: nil, status: nil, statusReason: nil, activeModel: nil, models: [],
                   subscription: [], subscriptionNote: nil, permissionMode: mode, error: error)
    }

    nonisolated static func state(provider: String, summary: LlmIdeAPIClient.ProviderUsage?,
                      subscription: ClaudeSubscriptionUsageClient.Usage?, subscriptionNote: String?,
                      permissionMode: String, error: String?) -> UsageState {
        UsageState(
            provider: provider,
            status: summary?.active.status,
            statusReason: summary?.active.reason.map { String($0.prefix(300)) },
            activeModel: summary?.active.model,
            models: (summary?.models ?? []).filter(\.enabled).prefix(maxModels).map(meter(for:)),
            subscription: subscription.map(meters(for:)) ?? [],
            subscriptionNote: subscriptionNote,
            permissionMode: permissionMode,
            error: error)
    }

    nonisolated static func meter(for m: LlmIdeAPIClient.UsageModelStat) -> UsageMeter {
        let window = m.windowKind == "monthly" ? "Monthly" : "Daily"
        let detail: String
        if let pct = m.pct, m.limit > 0 {
            detail = "\(Int(m.used)) of \(m.limit) \(m.unit) · \(window) · \(Int(pct))%"
        } else {
            detail = "\(Int(m.used)) \(m.unit) · \(window) · no cap"
        }
        return UsageMeter(name: m.label ?? m.model, pct: m.pct, state: m.state, detail: detail,
                          resetsAt: m.resetAt.flatMap(parseISO)?.timeIntervalSince1970)
    }

    nonisolated static func meters(for u: ClaudeSubscriptionUsageClient.Usage) -> [UsageMeter] {
        func windowMeter(_ name: String, _ w: ClaudeSubscriptionUsageClient.Window) -> UsageMeter? {
            guard let pct = w.pct else { return nil }
            let state = pct >= 100 ? "exhausted" : (pct > 80 ? "warning" : "ok")
            return UsageMeter(name: name, pct: pct, state: state, detail: "\(Int(pct))% used",
                              resetsAt: w.resetsAt?.timeIntervalSince1970)
        }
        var out = [windowMeter("Session (5h)", u.fiveHour), windowMeter("Weekly (7d)", u.sevenDay)].compactMap { $0 }
        if let extra = u.extra, let used = extra.usedCents, let limit = extra.limitCents, limit > 0 {
            out.append(UsageMeter(name: "Overage credits", pct: extra.pct,
                                  state: (extra.pct ?? 0) >= 100 ? "exhausted" : "ok",
                                  detail: String(format: "$%.2f of $%.2f", Double(used) / 100, Double(limit) / 100)))
        }
        return out
    }

    private nonisolated static func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
