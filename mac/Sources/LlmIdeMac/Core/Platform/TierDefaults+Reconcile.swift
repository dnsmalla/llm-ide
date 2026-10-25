import Foundation

/// What `TierDefaults.reconcile` decided.
struct TierReconcileResult: Equatable {
    var routing: TierRoutingConfig
    /// A tier was left alone because no replacement could be built yet.
    var deferred: Bool
    /// Whether the Standard tier (or its absence) differs from the input.
    var standardChanged: Bool
}

extension TierDefaults {
    /// Clear tiers whose provider cannot run, replacing them in the same step.
    ///
    /// Pure over its inputs. For each of Standard, Strong, Cheap, Image:
    /// 1. a Jev route, a route on a provider this build does not judge
    ///    (`ProviderAvailability.judges`), and a tier in `serverUsable` (the
    ///    server's own verdict, which sees env keys the Mac cannot) are left
    ///    alone;
    /// 2. a route whose provider is not in `available` is replaced: provider =
    ///    Standard's if available, else Claude, else the first available
    ///    built-in (menu order), else the first available custom provider
    ///    (`customProviderIds` order); the Image tier only takes an image
    ///    provider. Model: Claude matches its live list by family (Strong →
    ///    opus, Standard → sonnet, Cheap → haiku, else the first); others take
    ///    their first model;
    /// 3. the replacement is computed FIRST. With none (no model known yet,
    ///    no provider fits) the route is left as is and `deferred` is set, to
    ///    be fixed on a later pass — except when nothing at all is available,
    ///    where the tier is cleared to empty;
    /// 4. an empty Standard is filled the same way (it stays empty when it
    ///    cannot be); a Strong / Cheap / Image tier the user left unset stays
    ///    unset.
    ///
    /// - Parameters:
    ///   - available: wire ids that can run (never nil here: while
    ///     availability is unknown the caller must not reconcile at all).
    ///   - serverUsable: tiers the server reports usable.
    ///   - models: a provider's model list (`custom:<id>` included).
    static func reconcile(_ routing: TierRoutingConfig, available: Set<String>, customProviderIds: [String],
                          serverUsable: Set<RoutingTier> = [],
                          models: (String) -> [AIModel]) -> TierReconcileResult {
        var table = routing
        var deferred = false
        let nothing = ProviderAvailability.nothingAvailable(available)

        for tier in [RoutingTier.standard, .strong, .cheap, .image] {
            let current = table.tier(tier)
            var mustReplace = false
            if let route = current {
                guard !TierRouting.isDecisionOnlyProvider(route.provider),
                      ProviderAvailability.judges(route.provider),
                      !available.contains(route.provider),
                      !serverUsable.contains(tier) else { continue }
                mustReplace = true
            } else if tier != .standard {
                continue   // the user's unset choice
            }

            var replacement: TierRoute?
            let provider: String?
            if tier == .image {
                provider = ImageTierRouting.providerIds.first { available.contains($0) }
            } else {
                provider = fillProvider(standard: table.tier(.standard), available: available,
                                        customProviderIds: customProviderIds)
            }
            if let provider {
                let list = tier == .image ? ImageTierRouting.models(forProvider: provider) : models(provider)
                replacement = fillModel(tier: tier, provider: provider, in: list)
                    .map { TierRoute(provider: provider, model: $0) }
            }

            if let replacement {
                table.tiers[tier.rawValue] = replacement
            } else if nothing {
                table.tiers[tier.rawValue] = nil
            } else if tier != .image && (mustReplace || tier == .standard) {   // image has no model wait
                deferred = true
            }
        }

        return TierReconcileResult(routing: table, deferred: deferred,
                                   standardChanged: table.tier(.standard) != routing.tier(.standard))
    }

    private static func fillProvider(standard: TierRoute?, available: Set<String>,
                                     customProviderIds: [String]) -> String? {
        if let standard, available.contains(standard.provider), canBeStandard(provider: standard.provider) {
            return standard.provider
        }
        if available.contains(ClaudeCLI.provider) { return ClaudeCLI.provider }
        if let builtIn = TierRouting.builtInProviders.first(where: { available.contains($0.wireId) }) {
            return builtIn.wireId
        }
        return customProviderIds.first { available.contains($0) }
    }

    private static func fillModel(tier: RoutingTier, provider: String, in list: [AIModel]) -> String? {
        guard !list.isEmpty else { return nil }
        if provider == ClaudeCLI.provider {
            let family: String?
            switch tier {
            case .strong:   family = "opus"
            case .standard: family = "sonnet"
            case .cheap:    family = "haiku"
            case .image:    family = nil
            }
            if let family, let match = list.first(where: { $0.id.lowercased().contains(family) }) {
                return match.id
            }
        }
        return list[0].id
    }
}
