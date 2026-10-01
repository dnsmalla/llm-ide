import Foundation

/// Maps a finished Self-Heal run's per-incident verdicts (parsed from
/// `.self-heal/BATCH.md`) onto the incident store: only a `.fixed` verdict on
/// a run whose verify stage actually passed becomes a proposal — a fix the
/// agent claims but that failed verification must not be offered for apply.
public enum SelfHealOutcome {
    public static let maxAttempts = 3

    @MainActor
    @discardableResult
    public static func apply(batch: [Incident], results: [String: SelfHealBatch.Result], runSucceeded: Bool,
                             agentDown: Bool, proposal: IncidentProposal?, store: IncidentStore) -> Int {
        var proposed = 0
        for incident in batch {
            let result = results[incident.id]
            store.update(id: incident.id) { item in
                switch (result?.verdict, runSucceeded, proposal) {
                case (.fixed?, true, let proposal?):
                    item.status = .proposed
                    item.proposal = proposal
                    item.note = result?.reason
                    proposed += 1
                case (.environmental?, _, _):
                    item.status = .ignored
                    item.note = "environment: \(result?.reason ?? "")"
                case _ where agentDown:
                    item.status = .new
                default:
                    item.attempts += 1
                    item.status = item.attempts >= maxAttempts ? .needsHuman : .new
                    item.note = result?.reason
                }
            }
        }
        return proposed
    }
}
