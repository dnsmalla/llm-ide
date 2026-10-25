import Foundation
import os.log

private let providerAvailabilityLogger = Logger(subsystem: "com.llmide.macapp", category: "ProviderAvailability")

/// A custom provider as availability sees it — the few fields that decide
/// whether it can run, so the pure function below needs no `CustomProvider`.
struct AvailabilityCustomProvider: Equatable {
    let wireId: String
    let isEnabled: Bool
    /// Vault key name holding its API key (`CustomProvider.apiKey`).
    let apiKeyName: String
}

/// Which tier providers can actually run right now. Pure over values (stored
/// vault key names + which CLIs are installed), so tests need no network,
/// UserDefaults or filesystem.
enum ProviderAvailability {
    /// The wire ids this module judges. Anything else (Jev, a provider an
    /// older/newer build knows) is never judged: `isListed` says yes, and
    /// `TierDefaults.reconcile` leaves such a route alone.
    static func judges(_ provider: String) -> Bool {
        if TierRouting.customProviderId(provider) != nil { return true }
        return TierRouting.builtInProviders.contains { $0.wireId == provider }
    }

    /// The wire ids of every judged provider that can run.
    ///
    /// - Parameters:
    ///   - storedKeys: vault key names the user has stored (names only).
    ///   - installedCLIs: which of Claude / Codex / Gemini CLIs are installed
    ///     (`AICliTool.claudeCode` / `.openai` / `.gemini`).
    static func availableProviders(storedKeys: Set<String>, installedCLIs: Set<AICliTool>,
                                   customProviders: [AvailabilityCustomProvider]) -> Set<String> {
        var available = Set<String>()
        if installedCLIs.contains(.claudeCode) || storedKeys.contains(ClaudeCLI.vaultKey) {
            available.insert(ClaudeCLI.provider)
        }
        if storedKeys.contains("openai.apiKey") || installedCLIs.contains(.openai) { available.insert("openai") }
        if storedKeys.contains("google.apiKey") || installedCLIs.contains(.gemini) { available.insert("google") }
        if storedKeys.contains("deepseek.apiKey") { available.insert("deepseek") }
        if storedKeys.contains("custom.apiKey") { available.insert(AICliTool.custom.provider) }
        for provider in customProviders where provider.isEnabled {
            // The server resolves a custom provider only with its vault key
            // (and rejects loopback base URLs), so a key is the one condition.
            if storedKeys.contains(provider.apiKeyName) { available.insert(provider.wireId) }
        }
        return available
    }

    /// Whether a picker should list `provider`. Unknown availability (`nil`)
    /// and providers this module does not judge are always listed.
    static func isListed(_ provider: String, available: Set<String>?) -> Bool {
        guard let available, judges(provider) else { return true }
        return available.contains(provider)
    }

    /// True when availability is known and no judged provider can run.
    static func nothingAvailable(_ available: Set<String>?) -> Bool {
        guard let available else { return false }
        return !available.contains { judges($0) }
    }

    /// Standard's quick-chat verdict: the message to show instead of sending,
    /// or nil to send. Never refuses while availability is unknown.
    ///
    /// - Parameters:
    ///   - serverUsable: the server reports Standard usable (it sees env keys
    ///     the Mac cannot).
    ///   - routeResolves: a tier route for the quick chat already resolved, so
    ///     the send uses it instead of Standard's provider.
    static func noProviderMessage(standard: TierRoute?, available: Set<String>?,
                                  serverUsable: Bool = false, routeResolves: Bool = false) -> String? {
        guard let available, !serverUsable, !routeResolves else { return nil }
        guard let standard else { return Self.noProviderText }
        if judges(standard.provider), !available.contains(standard.provider) { return Self.noProviderText }
        return nil
    }

    static let noProviderText = "No model provider set up. Add one in Settings → Model Providers."
}

/// The app's one answer to "which providers can run", refreshed at startup and
/// whenever keys or custom providers change. `available == nil` means unknown
/// (not fetched yet, backend down, fetch failed): NOTHING is cleared or hidden
/// then, so a down backend can never wipe a user's tiers.
@MainActor
@Observable
final class ProviderAvailabilityStore {
    static let shared = ProviderAvailabilityStore()

    private(set) var available: Set<String>?
    /// The last reconcile left a tier alone because no replacement could be
    /// built yet (e.g. Claude's live model list not loaded). Lets Shell re-run
    /// when the list lands, and only then — so no loop.
    private(set) var hasDeferredTiers = false
    private var isReconciling = false

    /// Whether a model list landing should trigger another reconcile.
    var shouldRetryWhenModelsLand: Bool { hasDeferredTiers && !isReconciling }

    init(available: Set<String>? = nil) { self.available = available }

    /// Re-read the stored keys + installed CLIs + custom providers. A failed
    /// key fetch leaves availability unknown.
    func refresh(api: LlmIdeAPIClient) async {
        let keys: Set<String>
        do {
            keys = try await api.configuredSecretKeys()
        } catch {
            providerAvailabilityLogger.error("Key list unavailable; availability unknown: \(error.localizedDescription, privacy: .public)")
            available = nil
            return
        }
        // An unreadable custom list is not "no custom providers": stay unknown.
        guard case .loaded(let customs) = CustomProvider.load() else {
            available = nil
            return
        }
        var installed = Set<AICliTool>()
        for tool in [AICliTool.claudeCode, .openai, .gemini] where TierRouting.isCLIInstalled(tool) {
            installed.insert(tool)
        }
        available = ProviderAvailability.availableProviders(
            storedKeys: keys, installedCLIs: installed,
            customProviders: customs.map {
                AvailabilityCustomProvider(wireId: $0.wireId, isEnabled: $0.isEnabled, apiKeyName: $0.apiKey)
            })
    }

    /// Refresh availability, then clear + auto-fill tiers whose provider
    /// cannot run (`TierDefaults.reconcile`), save, and write a changed
    /// Standard through to `activeCLI` / `defaultModelId`. Does NOT push to
    /// the server — the caller's refresh does, after this.
    ///
    /// - Returns: whether the stored table changed.
    @discardableResult
    func reconcile(config: AppConfig, api: LlmIdeAPIClient) async -> Bool {
        isReconciling = true
        defer { isReconciling = false }
        await refresh(api: api)
        guard let available else { return false }
        // Claude's fill needs its live model list (it has no hardcoded one).
        if available.contains(ClaudeCLI.provider), LiveModelCache.models(for: ClaudeCLI.provider) == nil,
           let models = try? await api.listProviderModels(ClaudeCLI.provider), !models.isEmpty {
            LiveModelCache.store(models, for: ClaudeCLI.provider)
        }
        // Unreadable stored data is never overwritten.
        guard case .loaded(let stored) = TierRoutingConfig.loadOutcome(from: config.userDefaults),
              case .loaded(let customs) = CustomProvider.load() else { return false }
        // The server can run providers the Mac cannot see (env keys, CLI
        // overrides): never clear a tier it reports usable. Image and the
        // shared Custom endpoint are Mac-only, so the server says nothing.
        var serverUsable = Set<RoutingTier>()
        if let status = TierRoutingServerCache.shared.state.status {
            for tier in [RoutingTier.standard, .strong, .cheap] where status[tier.rawValue]?.usable == true {
                if let route = stored.tier(tier), !TierDefaults.isMacOnlyProvider(route.provider) {
                    serverUsable.insert(tier)
                }
            }
        }
        let result = TierDefaults.reconcile(
            stored, available: available, customProviderIds: customs.map(\.wireId), serverUsable: serverUsable,
            models: { provider in
                if let customId = TierRouting.customProviderId(provider) {
                    return customs.first { $0.id == customId }?.models ?? []
                }
                return TierRouting.builtInProviders.first { $0.wireId == provider }?.tool.pickerModels ?? []
            })
        hasDeferredTiers = result.deferred
        guard result.routing != stored else { return false }
        guard result.routing.save(to: config.userDefaults) else { return false }
        if result.standardChanged, let standard = result.routing.tier(.standard) {
            config.applyStandardTier(standard)
        }
        providerAvailabilityLogger.info("Tiers reconciled against available providers (standard changed: \(result.standardChanged, privacy: .public))")
        NotificationCenter.default.post(name: .tierRoutingReconciled, object: nil)
        return true
    }
}
