import Foundation
import os.log

private let tierDefaultsLogger = Logger(subsystem: "com.llmide.macapp", category: "TierDefaults")

extension TierCustomProviderSummary {
    init(_ provider: CustomProvider) {
        self.init(id: provider.id, isEnabled: provider.isEnabled, firstModelId: provider.models.first?.id,
                  name: provider.name)
    }
}

/// Applies `TierDefaults` to `AppConfig`: Standard is the default and the
/// chat modes are roles. Settings and Chat call these; they never write
/// `activeCLI` / `defaultModelId` themselves.
extension AppConfig {
    /// The chat-mode model policy for a chat on `provider` (a wire id:
    /// `anthropic`, `openai`, …, `custom:<id>`). The single place a mode
    /// becomes a model — panel, quick chat, phone bridge and Auto Tasks all ask
    /// this, never `defaultModelId` directly.
    // OPTIMIZE: decodes the small routing blob per call (SwiftUI bodies call
    // it for the chip label); cache it if profiling ever shows it.
    func purposeModels(forProvider provider: String) -> PurposeModelPolicy {
        TierDefaults.purposePolicy(chatProvider: provider,
                                   routing: TierRoutingConfig.load(from: userDefaults),
                                   legacy: purposeModelIds,
                                   legacyProvider: TierDefaults.providerWireId(forActiveCLI: activeCLI),
                                   defaultModelId: defaultModelId)
    }

    /// Standard was saved: write it through to the legacy default fields —
    /// the side effects the Providers ◉ had.
    ///
    /// - Returns: false when `standard` cannot be written (no model, unknown
    ///   provider); nothing changed then, so the last default keeps working.
    @discardableResult
    func applyStandardTier(_ standard: TierRoute) -> Bool {
        guard let write = TierDefaults.writeThrough(for: standard) else { return false }
        var changed = false
        if let model = write.defaultModelId, model != defaultModelId {
            defaultModelId = model
            changed = true
        }
        if let cli = write.activeCLI, cli != activeCLI {
            // Legacy purpose ids were picked for the previous provider.
            purposeModelIds = [:]
            activeCLI = cli
            changed = true
        }
        if (userDefaults.string(forKey: TierDefaults.composerProviderKey) ?? "") != write.composerProviderId {
            userDefaults.set(write.composerProviderId, forKey: TierDefaults.composerProviderKey)
            changed = true
        }
        // WHY only on a change: re-saving the same Standard must not drop the
        // user's composer pick (the ◉ had the same guard).
        if changed {
            modelPickIsExplicit = false
            explicitModelId = ""
        }
        return true
    }

    /// Launch-time, before Settings or Chat read the config: fill Standard
    /// while it is unset, and (once, flag `tierDefaultMigrated`) move the
    /// purpose models onto chat roles. Writes nothing through — Standard is
    /// built FROM the current default, so the before/after invariant holds, and
    /// a Standard that already existed is never applied over the legacy fields.
    /// Deferred to the next launch when either stored list is unreadable, so an
    /// unreadable blob is never overwritten.
    func migrateToTierDefaults(customProviders: CustomProvider.LoadOutcome) {
        guard case .loaded(let customs) = customProviders else {
            tierDefaultsLogger.error("Custom providers unreadable; tier defaults migration deferred")
            return
        }
        guard case .loaded(let stored) = TierRoutingConfig.loadOutcome(from: userDefaults) else {
            tierDefaultsLogger.error("Tier routing table unreadable; tier defaults migration deferred")
            return
        }
        let purposesDone = userDefaults.bool(forKey: TierDefaults.migratedFlagKey)
        let input = TierMigrationInput(
            routing: stored, activeCLI: activeCLI, defaultModelId: defaultModelId,
            purposeModelIds: purposeModelIds,
            composerProviderId: userDefaults.string(forKey: TierDefaults.composerProviderKey) ?? "",
            customProviders: customs.map(TierCustomProviderSummary.init))
        let result = TierDefaults.migrate(input, includePurposes: !purposesDone)
        if result.routing != stored, !result.routing.save(to: userDefaults) { return }
        guard !purposesDone else { return }
        if result.purposeModelIds != purposeModelIds { purposeModelIds = result.purposeModelIds }
        userDefaults.set(true, forKey: TierDefaults.migratedFlagKey)
        tierDefaultsLogger.info("Tier defaults migrated; legacy purposes left: \(result.purposeModelIds.count, privacy: .public)")
    }
}
