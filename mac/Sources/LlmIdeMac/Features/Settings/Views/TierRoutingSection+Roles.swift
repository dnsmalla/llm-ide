import SwiftUI

/// The role rows of "Tiers & Roles": which tier each role uses, and why a
/// role still runs something else. Kept apart from the tier rows so each file
/// stays readable.
extension TierRoutingSection {
    func featureRow(_ feature: RoutedFeature) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Spacing.sm) {
                Text(feature.displayName)
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                Spacer()
                Picker("Tier", selection: featureBinding(feature)) {
                    // What an unset role runs: Standard on this Mac, the
                    // server's own default for server roles. On this Mac unset
                    // IS Standard, so Standard is not listed twice.
                    Text(feature.unsetLabel).tag("")
                    ForEach(tierChoices(feature)) { tier in
                        Text(tier.displayName).tag(tier.rawValue)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: 160)
            }
            .help(TierDefaults.purpose(for: feature).map(TierDefaults.modesHelp) ?? "")
            if let explanation = feature.explanation {
                note(explanation)
            }
            if let reason = featureUnusableReason(feature) {
                note("uses \(fallbackLabel(feature)) — \(reason)")
            } else if feature.group == .chat {
                chatRoleNotes(feature)
            } else if feature == .loop, let reason = agentEngineReason(for: .loop) {
                // The replay takes the route; the agent steps (the bulk of a
                // Loop's cost) run on the Agent SDK and keep the default.
                note("agent steps use \(fallbackLabel(.loop)) — \(reason). Only Claude or a custom provider "
                     + "with an Anthropic-compatible URL can run them.")
            } else if feature == .quickChat, let reason = agentEngineReason(for: .quickChat) {
                note("on Agent-engine chats uses \(fallbackLabel(.quickChat)) — \(reason). Only Claude or a custom provider "
                     + "with an Anthropic-compatible URL can run them.")
            }
        }
    }

    /// The tiers `feature`'s menu offers: on this Mac unset IS Standard, so
    /// Standard is listed for server roles only; a Jev (decision-only) tier
    /// only for Decisions — plus whatever is stored, so the menu never loses
    /// its selection (its row then says why it isn't used).
    private func tierChoices(_ feature: RoutedFeature) -> [RoutingTier] {
        let stored = routing.features[feature.rawValue]
        return RoutingTier.allCases.filter { tier in
            guard feature.group == .server || tier != .standard else { return false }
            guard feature != .decisions, let route = routing.tier(tier),
                  TierRouting.isDecisionOnlyProvider(route.provider) else { return true }
            return stored == tier.rawValue
        }
    }

    /// What a role runs when its route can't be used. Server roles: the
    /// server's built-in default. Chat modes: Standard's model on the chat's
    /// provider. Background roles: `activeCLI` / `defaultModelId` — named,
    /// because with a custom Standard that is NOT Standard (the composer
    /// override, which only chats read, is left out on purpose).
    func fallbackLabel(_ feature: RoutedFeature) -> String {
        switch feature.group {
        case .server: return feature.unsetLabel
        case .chat:   return "Standard"
        case .background:
            return TierDefaults.describeCurrentDefault(activeCLI: config.activeCLI, defaultModelId: config.defaultModelId,
                                                       composerProviderId: "", customProviders: [])
        }
    }

    /// Chat-mode rows: a mode's tier only swaps the MODEL, so it applies to
    /// chats already on the tier's provider; a v2 chat also needs an
    /// Anthropic-compatible one. An unset row names a kept legacy model.
    @ViewBuilder
    private func chatRoleNotes(_ feature: RoutedFeature) -> some View {
        if let tier = routing.tier(for: feature), tier != .standard, let route = routing.tier(tier) {
            note(TierDefaults.chatRoleProviderNote(providerName: providerName(route.provider)))
            if let reason = agentEngineReason(for: feature) {
                note("uses Standard on Agent-engine chats — \(reason)")
            }
        } else if let purpose = TierDefaults.purpose(for: feature),
                  let legacy = config.purposeModelIds[purpose], !legacy.isEmpty {
            note(TierDefaults.legacyNote(purpose: purpose, model: legacy))
        }
    }

    private func providerName(_ provider: String) -> String {
        if let customId = TierRouting.customProviderId(provider) {
            return customProviders.first { $0.id == customId }?.name ?? provider
        }
        if TierRouting.isDecisionOnlyProvider(provider) { return TierRouting.decisionOnlyProviderName }
        return TierRouting.builtInProviders.first { $0.wireId == provider }?.tool.displayName ?? provider
    }

    /// Why `feature`'s Agent-engine work (Loop agent steps via
    /// /kb/loop/agent-run, Agent-engine quick chats) cannot take its route even
    /// though its other calls can — the same local + server checks
    /// `TierRouting.resolve(requiresAgentEngine: true)` applies per call.
    private func agentEngineReason(for feature: RoutedFeature) -> String? {
        guard let tier = TierDefaults.effectiveTier(for: feature, routing: routing,
                                                    composerProviderId: composerProviderId),
              let route = routing.tier(tier) else { return nil }
        if let local = TierRouting.unusableReason(route, customProviders: customProviders, requiresAgentEngine: true) {
            return local
        }
        // Chat roles never reach the server's resolver: only the local check applies.
        guard feature.group != .chat, serverSupported,
              let status = serverState.status?[tier.rawValue], !status.agentCapable else { return nil }
        return "the server can't run it on the Agent engine (\(TierRouting.describeServerReason(status.agentReason)))"
    }

    /// Why a role still runs its fallback: its tier (or, for an unset
    /// Background role, an applied custom Standard — `TierDefaults.effectiveTier`)
    /// can't be used. Auto Tasks run a local CLI, so they get the CLI
    /// constraint (including whether it's installed); the chat surfaces'
    /// Agent-engine constraint depends on each chat and is applied per turn
    /// instead. Server-side refusals come from the last status fetch.
    private func featureUnusableReason(_ feature: RoutedFeature) -> String? {
        // A role newer than the running server is never sent (wireBody); the
        // top note covers a server too old for routing at all.
        if serverSupported, let required = feature.requiredServerApiVersion,
           (serverState.apiVersion ?? 0) < required {
            return decisionsServerNote
        }
        guard let tier = TierDefaults.effectiveTier(for: feature, routing: routing,
                                                    composerProviderId: composerProviderId) else { return nil }
        guard let route = routing.tier(tier) else {
            // A stored "standard" on a Mac row reads as unset (the menu has no
            // separate entry); Standard's own row warns when it is unset.
            return feature.group != .server && tier == .standard ? nil : "the \(tier.displayName) tier is not set"
        }
        let localCLIOnly = feature == .autoTasks
        if let local = TierRouting.unusableReason(route, customProviders: customProviders,
                                                  localCLIOnly: localCLIOnly,
                                                  cliInstalled: TierRouting.isCLIInstalled,
                                                  forDecisions: feature == .decisions) {
            return local
        }
        // Chat roles only pick a model on the Mac — no server status applies.
        guard feature.group != .chat else { return nil }
        if TierDefaults.isMacOnlyProvider(route.provider) {
            // As Standard it is `activeCLI` itself, which these roles run anyway.
            return tier == .standard && feature.group == .background ? nil : TierDefaults.macOnlyProviderNote
        }
        // The version note at the top already covers an old server.
        guard serverSupported else { return nil }
        return TierRouting.serverUnusableReason(tier, server: serverState, localCLIOnly: localCLIOnly)
            ?? TierRouting.serverFeatureUnusableReason(feature, server: serverState)
    }

    func featureBinding(_ feature: RoutedFeature) -> Binding<String> {
        Binding(
            get: {
                let stored = routing.features[feature.rawValue] ?? ""
                // A Mac row has no "Standard" entry (unset is Standard): a
                // stored "standard" shows as the unset row, never a missing tag.
                return feature.group != .server && stored == RoutingTier.standard.rawValue ? "" : stored
            },
            set: { tier in
                var updated = routing
                updated.features[feature.rawValue] = tier.isEmpty ? nil : tier
                // Re-picking the current value must not clear a composer pick.
                guard updated != routing else { return }
                if let purpose = TierDefaults.purpose(for: feature) {
                    // The choice replaces a kept legacy purpose model, and — as
                    // editing a purpose picker did — re-decides the model from
                    // Settings, so a composer pick no longer overrides it.
                    config.purposeModelIds[purpose] = nil
                    config.modelPickIsExplicit = false
                    config.explicitModelId = ""
                }
                apply(updated)
            }
        )
    }
}
