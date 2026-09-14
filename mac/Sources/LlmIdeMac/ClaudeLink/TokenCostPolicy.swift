import Foundation

/// How a turn's token counts convert into something comparable across turns.
///
/// Lives in `ClaudeLink/` because the multipliers are a property of Anthropic's
/// prompt-caching mechanism, not of this app's UI — same reason every other
/// piece of Claude wire knowledge lives here.
///
/// Public because `chat-contract-lab` asserts it; deliberately a policy enum
/// over plain `Int`s rather than a method on the wire struct, so asserting it
/// does not force `AgentV2Usage` itself public (widening a wire type silently
/// drops its implicit `Sendable` conformance — that bit us once already today).
public enum TokenCostPolicy {

    /// A cache WRITE bills above a normal input token: the prefix is stored
    /// as well as processed. (5-minute TTL; the 1-hour TTL is 2×, which this
    /// app never requests.)
    public static let cacheWriteMultiplier = 1.25

    /// A cache READ bills a tenth of a normal input token — the whole point
    /// of caching, and the reason a warm turn costs a fraction of a cold one
    /// that processed the same number of tokens.
    public static let cacheReadMultiplier = 0.1

    /// One turn as fresh-input-equivalent tokens, so two turns showing the
    /// same number really did cost about the same.
    ///
    /// Prompt caching is a pre-payment, not a discount. Summing the three
    /// input kinds flat reports a cold turn (everything written at 1.25×) and
    /// a warm turn (everything read at 0.1×) as the same size when the warm
    /// one costs roughly a tenth — measured on this install, two turns both
    /// summing to ~52K differed by 9.5× in billable terms.
    ///
    /// `cacheWrite` is optional because an older server sends no such field:
    /// nil means UNKNOWN and contributes nothing, which is not the same claim
    /// as a zero-cost turn.
    ///
    /// Output stays at 1× rather than its real ~5× ratio: that ratio is a
    /// per-model price table, which this install deliberately does not carry
    /// (dollar cost comes from the SDK's own `total_cost_usd`, never computed
    /// here). The two cache multipliers are uniform across models, so applying
    /// them needs no such table. Output is a small share of a chat turn, so
    /// leaving it unweighted keeps the number honest about what dominates —
    /// the prompt.
    public static func billableTokens(input: Int, output: Int,
                                      cacheRead: Int, cacheWrite: Int?) -> Int {
        let weighted = Double(cacheWrite ?? 0) * cacheWriteMultiplier
            + Double(cacheRead) * cacheReadMultiplier
        return input + output + Int(weighted.rounded())
    }
}
