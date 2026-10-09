import Foundation

// The decision-only side of tier routing: the `decisions` role's server gate
// and the Jev tier provider, which answers typed questions with calibrated
// probabilities and cannot chat. Split out of TierRouting.swift (GRID
// 500-line file rule).
extension RoutedFeature {
    /// One-line explanation shown under the role in Settings, or nil when the
    /// name says enough.
    public var explanation: String? {
        switch self {
        case .decisions:
            return "the agent's `decide` tool and other yes/no / pick-one / score decisions — point at a Jev tier "
                + "for calibrated answers, or any LLM tier"
        default:
            return nil
        }
    }

    /// The server API this role first exists on, or nil when it has existed
    /// since tier routing itself (`TierRouting.requiredServerApiVersion`).
    /// An older server would drop it as `unknown_feature`, so it is never
    /// sent there (`TierDefaults.wireBody`).
    public var requiredServerApiVersion: Int? {
        self == .decisions ? TierRouting.decisionsServerApiVersion : nil
    }
}

extension TierRouting {
    /// Server API that knows the `decisions` role and the decision-only `jev`
    /// tier provider. Below it neither is sent (`TierDefaults.wireBody`) and
    /// Settings asks for a server update instead.
    static let decisionsServerApiVersion = 73

    static func serverSupportsDecisions(_ apiVersion: Int?) -> Bool {
        guard let apiVersion else { return false }
        return apiVersion >= decisionsServerApiVersion
    }

    /// The decision-only tier provider (Jev): it answers typed questions with
    /// calibrated probabilities and cannot chat, so only `RoutedFeature.decisions`
    /// may use a tier on it, and it is never Standard (`TierDefaults.canBeStandard`).
    /// Not in `builtInProviders` on purpose: that list maps to an `AICliTool`,
    /// which is what the chat composer and `activeCLI` are made of.
    static let decisionOnlyProvider = ProviderCatalog.jevId
    static let decisionOnlyProviderName = "Jev"

    static func isDecisionOnlyProvider(_ provider: String) -> Bool {
        provider == decisionOnlyProvider
    }

    /// Jev's model menu before (or without) its live list: the two moving
    /// aliases. Pinned versions (`jev-1.13.0`, …) come from the live list.
    static let decisionFallbackModels: [AIModel] = [
        AIModel(id: "jev-latest", displayName: "jev-latest"),
        AIModel(id: "jev-preview", displayName: "jev-preview"),
    ]

    /// Why a decision-only tier serves no role but Decisions (also the
    /// wording for the server's `decision_only`).
    static let decisionOnlyNote = "Jev only answers decisions — use it for the Decisions role"
}
